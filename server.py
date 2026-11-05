"""Local video editor. Start with: python3 server.py"""
import array
import atexit
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote

ROOT = Path(__file__).parent.resolve()
DATA = ROOT / ".data"
DATA.mkdir(exist_ok=True)
JOBS = {}
LOCK = threading.Lock()
PROCESSES = set()
ENCODER = "libx264"


def start_process(args, **kwargs):
    proc = subprocess.Popen(args, **kwargs)
    with LOCK:
        PROCESSES.add(proc)
    return proc


def stop_processes():
    with LOCK:
        active = list(PROCESSES)
    for proc in active:
        if proc.poll() is None:
            proc.terminate()
    for proc in active:
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()


atexit.register(stop_processes)


def persist_job(key):
    with LOCK:
        job = JOBS[key].copy()
    file = job.get("source") or job.get("output")
    if not file or not Path(file).is_relative_to(DATA):
        return
    data = {k: str(v) if isinstance(v, Path) else v for k, v in job.items()}
    data["id"] = key
    target = Path(file).parent / ("job.json" if "source" in job else f"{key}.json")
    temporary = target.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(data))
    temporary.replace(target)


for manifest in DATA.glob("*/*.json"):
    try:
        cached = json.loads(manifest.read_text())
        key = cached.pop("id")
        for field in ("source", "preview", "output"):
            if field in cached:
                cached[field] = Path(cached[field])
                if not cached[field].is_relative_to(DATA) or not cached[field].is_file():
                    raise ValueError("Missing cached media")
        if cached.get("status") in ("ready", "error"):
            JOBS[key] = cached
    except (ValueError, OSError, KeyError):
        pass


def choose_encoder():
    if os.sys.platform == "darwin":
        try:
            # An advertised encoder can still be unavailable; exercise the hardware.
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                            "color=size=320x240:rate=30", "-frames:v", "2", "-an",
                            "-c:v", "h264_videotoolbox", "-b:v", "2M", "-f", "null", "-"],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            return "h264_videotoolbox"
        except (subprocess.SubprocessError, OSError):
            pass
    return "libx264"


def encoding_options(width=1920, height=1080, fps=30, preview=False):
    if ENCODER == "h264_videotoolbox":
        bitrate = 2_500_000 if preview else max(3_000_000, min(60_000_000, int(width * height * fps * 0.14)))
        return ["-c:v", ENCODER, "-b:v", str(bitrate), "-profile:v", "high", "-allow_sw", "0"]
    return ["-c:v", "libx264", "-preset", "ultrafast" if preview else "veryfast",
            "-crf", "24" if preview else "18", "-threads", str(min(8, os.cpu_count() or 4))]


def decoding_options():
    return ["-hwaccel", "videotoolbox"] if ENCODER == "h264_videotoolbox" else []


def run(args, **kwargs):
    proc = start_process(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
    try:
        stdout, stderr = proc.communicate()
        if proc.returncode:
            raise subprocess.CalledProcessError(proc.returncode, args, stdout, stderr)
        return subprocess.CompletedProcess(args, proc.returncode, stdout, stderr)
    finally:
        with LOCK:
            PROCESSES.discard(proc)


def patch_job(key, **values):
    with LOCK:
        JOBS[key].update(values)


def prepare_preview(key, native_hevc=False):
    """Remux supported footage; encode a small, seekable proxy only as fallback."""
    started = time.perf_counter()
    job = JOBS[key]
    source = job["source"]
    probe = json.loads(run(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(source)]).stdout)
    video = next(s for s in probe["streams"] if s["codec_type"] == "video")
    audio = next((s for s in probe["streams"] if s["codec_type"] == "audio"), None)
    codec = video.get("codec_name")
    audio_ok = not audio or audio.get("codec_name") in ("aac", "mp3")
    direct = ((source.suffix.lower() in (".mp4", ".m4v") and codec == "h264" and audio_ok) or
              (source.suffix.lower() == ".webm" and codec in ("vp8", "vp9", "av1") and
               (not audio or audio.get("codec_name") in ("opus", "vorbis"))))
    if direct:
        preview, mode = source, "original"
    elif codec == "h264" or (native_hevc and codec == "hevc"):
        preview, mode = source.parent / "preview-native-v2.mp4", "remux"
        if not preview.exists():
            temporary = preview.with_suffix(".partial.mp4")
            args = ["ffmpeg", "-v", "error", "-y", "-i", str(source), "-map", "0:v:0", "-map", "0:a:0?",
                    "-c:v", "copy", "-c:a", "copy" if audio_ok else "aac"]
            if codec == "hevc":
                args += ["-tag:v", "hvc1"]
            run([*args, "-movflags", "+faststart", str(temporary)])
            temporary.replace(preview)
    else:
        preview, mode = source.parent / "preview-lite-v2.mp4", "proxy"
        if not preview.exists():
            temporary = preview.with_suffix(".partial.mp4")
            run(["ffmpeg", "-v", "error", "-y", *decoding_options(), "-i", str(source), "-map", "0:v:0",
                 "-map", "0:a:0?", "-vf", "scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30",
                 *encoding_options(preview=True), "-g", "15", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k",
                 "-movflags", "+faststart", str(temporary)])
            temporary.replace(preview)
    patch_job(key, preview=preview, previewStatus="ready", previewMode=mode,
              previewSeconds=round(time.perf_counter()-started, 3))


def refresh_preview(key, native_hevc):
    try:
        prepare_preview(key, native_hevc)
        persist_job(key)
    except Exception as exc:
        patch_job(key, previewStatus="error", previewError=user_error(exc))


def analyze(key):
    try:
        job = JOBS[key]
        source = job["source"]
        probe = json.loads(run(["ffprobe", "-v", "error", "-show_format",
                                "-show_streams", "-of", "json", str(source)]).stdout)
        video = next((s for s in probe["streams"] if s["codec_type"] == "video"), None)
        if not video:
            raise ValueError("Choose a file containing a video track.")
        duration = float(probe["format"].get("duration") or video.get("duration") or 0)
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError("Could not read this video's duration.")
        audio_stream = next((s for s in probe["streams"] if s["codec_type"] == "audio"), None)
        audio = audio_stream is not None
        patch_job(key, duration=duration, hasAudio=audio, progress=10)
        levels = []
        if audio:
            # 20 ms RMS windows retain enough detail for accurate silence boundaries.
            proc = start_process(["ffmpeg", "-v", "error", "-i", str(source), "-map", "0:a:0", "-vn",
                                     "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"],
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            try:
                while True:
                    chunk = proc.stdout.read(320)
                    if not chunk:
                        break
                    values = array.array("h", chunk[:len(chunk) // 2 * 2])
                    if os.sys.byteorder != "little":
                        values.byteswap()
                    rms = math.sqrt(sum(v * v for v in values) / max(1, len(values))) / 32768
                    levels.append(round(20 * math.log10(max(rms, 0.00001)), 2))
                if proc.wait() != 0:
                    raise ValueError("Couldn't analyze the audio in this file.")
            finally:
                proc.stdout.close()
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
                with LOCK:
                    PROCESSES.discard(proc)
        patch_job(key, progress=65)
        prepare_preview(key, job.get("nativeHevc", False))
        rotation = next((s.get("rotation", 0) for s in video.get("side_data_list", []) if "rotation" in s), 0)
        width, height = video["width"], video["height"]
        if abs(rotation) % 180 == 90:
            width, height = height, width
        rate = video.get("avg_frame_rate", "30/1").split("/")
        fps = float(rate[0]) / max(1, float(rate[1])) if len(rate) == 2 else 30
        patch_job(key, status="ready", progress=100, levels=levels, step=0.02,
                  width=width, height=height, fps=fps)
        persist_job(key)
    except Exception as exc:
        patch_job(key, status="error", error=user_error(exc))


def user_error(exc):
    if isinstance(exc, subprocess.CalledProcessError):
        return "FFmpeg couldn't process this video. Try another file or format."
    return str(exc)


def render(key, output_key, cuts, mode="edited"):
    try:
        started = time.perf_counter()
        job = JOBS[key]
        duration = job["duration"]
        ordered = sorted(cuts, key=lambda c: c["start"])
        merged = []
        for cut in ordered:
            start, end = max(0, cut["start"]), min(duration, cut["end"])
            if end <= start:
                continue
            if merged and start <= merged[-1][1]:
                merged[-1][1] = max(end, merged[-1][1])
            else:
                merged.append([start, end])
        keep, cursor = [], 0
        for start, end in merged:
            if start - cursor > 0.001:
                keep.append((cursor, start))
            cursor = end
        if duration - cursor > 0.001:
            keep.append((cursor, duration))
        if mode == "removed":
            keep = [(start, end) for start, end in merged if end-start > 0.001]
        if not keep:
            if mode == "removed":
                raise ValueError("There are no removed clips to export.")
            raise ValueError("The cuts cover the entire video. Keep a little footage to render.")
        # Feed one video/audio input into the graph. Referencing 0:v separately for
        # every cut makes FFmpeg repeat autorotation and input conversion per cut.
        count = len(keep)
        filters = [f"[0:v:0]split={count}" + "".join(f"[vin{i}]" for i in range(count))]
        if job["hasAudio"]:
            filters.append(f"[0:a:0]asplit={count}" + "".join(f"[ain{i}]" for i in range(count)))
        inputs = []
        for i, (start, end) in enumerate(keep):
            filters.append(f"[vin{i}]trim=start={start:.6f}:end={end:.6f},setpts=PTS-STARTPTS[v{i}]")
            inputs.append(f"[v{i}]")
            if job["hasAudio"]:
                filters.append(f"[ain{i}]atrim=start={start:.6f}:end={end:.6f},asetpts=PTS-STARTPTS[a{i}]")
                inputs.append(f"[a{i}]")
        filters.append("".join(inputs) + f"concat=n={len(keep)}:v=1:a={int(job['hasAudio'])}[vout]" +
                       ("[aout]" if job["hasAudio"] else ""))
        filters.append("[vout]scale=trunc(iw/2)*2:trunc(ih/2)*2[vfinal]")
        graph = job["source"].parent / f"{output_key}.txt"
        graph.write_text(";\n".join(filters))
        output = job["source"].parent / f"{output_key}.mp4"
        args = ["ffmpeg", "-v", "error", "-y", *decoding_options(), "-i", str(job["source"]),
                "-filter_complex_threads", "2", "-filter_complex_script", str(graph),
                "-map", "[vfinal]"]
        if job["hasAudio"]:
            args += ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"]
        args += [*encoding_options(job.get("width",1920), job.get("height",1080), job.get("fps",30)),
                 "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-progress", "pipe:1", str(output)]
        total = sum(b - a for a, b in keep)
        with tempfile.TemporaryFile() as errors:
            proc = start_process(args, stdout=subprocess.PIPE, stderr=errors, text=True)
            try:
                for line in proc.stdout:
                    if line.startswith("out_time_us="):
                        try:
                            patch_job(output_key, progress=max(0, min(99, float(line.split("=")[1]) / 1000000 / total * 100)))
                        except ValueError:
                            pass
                if proc.wait() != 0:
                    raise ValueError("Couldn't render this video. Try fewer cuts or a different file.")
            finally:
                proc.stdout.close()
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
                with LOCK:
                    PROCESSES.discard(proc)
        patch_job(output_key, status="ready", progress=100, output=output, duration=total,
                  elapsedSeconds=round(time.perf_counter()-started, 2), encoder=ENCODER, mode=mode)
        persist_job(output_key)
    except Exception as exc:
        patch_job(output_key, status="error", error=user_error(exc))


class Handler(BaseHTTPRequestHandler):
    def json_response(self, data, status=200):
        raw = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).netloc != self.headers.get("Host"):
            return self.json_response({"error": "Request origin is not allowed."}, 403)
        try:
            if self.path == "/api/upload":
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0:
                    return self.json_response({"error": "Choose a nonempty video file."}, 400)
                key = uuid.uuid4().hex
                folder = DATA / key
                folder.mkdir()
                filename = unquote(self.headers.get("X-Filename", "video.mp4"))
                suffix = Path(filename).suffix.lower()
                if not re.fullmatch(r"\.[a-z0-9]{1,8}", suffix):
                    suffix = ".video"
                source = folder / ("source" + suffix)
                with source.open("wb") as file:
                    remaining = length
                    while remaining:
                        chunk = self.rfile.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise ValueError("Upload was interrupted.")
                        file.write(chunk)
                        remaining -= len(chunk)
                with LOCK:
                    JOBS[key] = {"status": "analyzing", "progress": 0, "source": source,
                                 "filename": filename, "nativeHevc": self.headers.get("X-Native-Hevc") == "1"}
                threading.Thread(target=analyze, args=(key,), daemon=True).start()
                return self.json_response({"id": key})
            if self.path == "/api/preview":
                length = int(self.headers.get("Content-Length", "0"))
                if length > 4096:
                    raise ValueError("Invalid request.")
                body = json.loads(self.rfile.read(length))
                key = body.get("id")
                job = JOBS.get(key, {})
                if job.get("status") != "ready" or "source" not in job:
                    raise ValueError("Choose a video first.")
                if job.get("previewStatus") != "preparing":
                    patch_job(key, previewStatus="preparing")
                    threading.Thread(target=refresh_preview, args=(key, bool(body.get("nativeHevc"))), daemon=True).start()
                return self.json_response({"id": key})
            if self.path == "/api/render":
                length = int(self.headers.get("Content-Length", "0"))
                if length > 2_000_000:
                    raise ValueError("Too many cuts.")
                body = json.loads(self.rfile.read(length))
                key = body.get("id")
                if key not in JOBS or JOBS[key]["status"] != "ready" or "source" not in JOBS[key]:
                    raise ValueError("Choose a video first.")
                cuts = body.get("cuts", [])
                mode = body.get("mode", "edited")
                if mode not in ("edited", "removed"):
                    raise ValueError("Invalid export mode.")
                if not isinstance(cuts, list) or len(cuts) > 2000:
                    raise ValueError("Too many cuts. Increase the minimum silence length.")
                for c in cuts:
                    if not all(isinstance(c.get(x), (int, float)) and math.isfinite(c[x]) for x in ("start", "end")):
                        raise ValueError("Invalid cut timestamps.")
                out = uuid.uuid4().hex
                with LOCK:
                    JOBS[out] = {"status": "rendering", "progress": 0}
                threading.Thread(target=render, args=(key, out, cuts, mode), daemon=True).start()
                return self.json_response({"id": out})
            return self.json_response({"error": "Not found"}, 404)
        except (ValueError, KeyError, TypeError) as exc:
            self.json_response({"error": str(exc)}, 400)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/jobs/"):
            key = path.rsplit("/", 1)[-1]
            with LOCK:
                job = JOBS.get(key)
                data = {k: v for k, v in job.items() if k not in ("source", "preview", "output")} if job else None
            return self.json_response(data or {"error": "Video not found. Choose it again."}, 200 if job else 404)
        if path.startswith("/media/"):
            parts = path.split("/")
            if len(parts) != 4:
                return self.send_error(404)
            key, kind = parts[2:]
            job = JOBS.get(key, {})
            file = job.get("preview" if kind == "preview" else "output" if kind == "output" else "")
            if not file or not file.exists():
                return self.send_error(404)
            return self.send_file(file, download=kind == "output",
                                  filename="removed-clips.mp4" if job.get("mode") == "removed" else "edited-video.mp4")
        file = ROOT / "public" / ("index.html" if path == "/" else path.lstrip("/"))
        if not file.resolve().is_relative_to(ROOT / "public") or not file.is_file():
            return self.send_error(404)
        self.send_file(file)

    def send_file(self, file, download=False, filename="edited-video.mp4"):
        size = file.stat().st_size
        start, end = 0, size - 1
        range_header = self.headers.get("Range")
        if range_header:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header)
            if not match or not any(match.groups()):
                return self.send_error(416)
            left, right = match.groups()
            if left:
                start, end = int(left), min(int(right) if right else end, end)
            else:
                start = max(0, size - int(right))
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
        types = {".html": "text/html; charset=utf-8", ".js": "application/javascript",
                 ".css": "text/css", ".mjs": "application/javascript", ".mp4": "video/mp4", ".mov": "video/quicktime",
                 ".m4v": "video/mp4", ".webm": "video/webm", ".svg": "image/svg+xml"}
        self.send_response(206 if range_header else 200)
        self.send_header("Content-Type", types.get(file.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        if range_header:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if download:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        try:
            with file.open("rb") as stream:
                stream.seek(start)
                remaining = end - start + 1
                while remaining:
                    chunk = stream.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass


if __name__ == "__main__":
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise SystemExit("Install FFmpeg first (macOS: brew install ffmpeg).")
    ENCODER = choose_encoder()
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Local editor: http://127.0.0.1:{port} ({ENCODER})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
