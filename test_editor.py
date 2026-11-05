"""Real FFmpeg integration checks: python3 -m unittest -v test_editor.py"""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import server


class VideoPipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory(prefix="editor-test-")
        cls.source = Path(cls.folder.name) / "known-silence.mp4"
        # Speech substitutes at 0–1, 2–3, 4–5 seconds, with digital silence between.
        server.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                    "testsrc2=size=640x360:rate=30:duration=5", "-f", "lavfi", "-i",
                    "aevalsrc=if(between(t\\,1\\,2)+between(t\\,3\\,4)\\,0\\,0.3*sin(2*PI*440*t)):s=8000:d=5",
                    "-c:v", "libx264", "-preset", "ultrafast", "-threads", "2",
                    "-c:a", "aac", "-shortest", str(cls.source)])
        cls.key = "test-audio"
        server.JOBS[cls.key] = {"source": cls.source, "status": "analyzing"}
        server.analyze(cls.key)

    @classmethod
    def tearDownClass(cls):
        cls.folder.cleanup()

    def test_analysis_finds_real_silence(self):
        job = server.JOBS[self.key]
        self.assertEqual(job["status"], "ready", job.get("error"))
        self.assertTrue(job["hasAudio"])
        self.assertAlmostEqual(job["duration"], 5, delta=0.05)
        self.assertGreater(job["levels"][25], -20)
        self.assertLess(job["levels"][75], -60)
        self.assertGreater(job["levels"][125], -20)
        self.assertLess(job["levels"][175], -60)

    def render_clip(self, cuts, out):
        server.JOBS[out] = {"status": "rendering", "progress": 0}
        server.render(self.key, out, cuts)
        job = server.JOBS[out]
        self.assertEqual(job["status"], "ready", job.get("error"))
        probe = json.loads(server.run(["ffprobe", "-v", "error", "-show_format",
                                      "-show_streams", "-of", "json", str(job["output"])]).stdout)
        self.assertTrue(any(s["codec_name"] == "h264" for s in probe["streams"]))
        return probe

    def test_export_removes_two_silent_sections_and_keeps_audio(self):
        probe = self.render_clip([{"start": 1.04, "end": 1.96}, {"start": 3.04, "end": 3.96}], "test-export")
        self.assertAlmostEqual(float(probe["format"]["duration"]), 3.16, delta=0.08)
        self.assertTrue(any(s["codec_name"] == "aac" for s in probe["streams"]))

    def test_overlapping_cuts_are_merged(self):
        probe = self.render_clip([{"start": 1, "end": 3}, {"start": 2, "end": 4}], "test-overlap")
        self.assertAlmostEqual(float(probe["format"]["duration"]), 2, delta=0.08)

    def test_no_cuts_exports_full_video(self):
        probe = self.render_clip([], "test-no-cuts")
        self.assertAlmostEqual(float(probe["format"]["duration"]), 5, delta=0.08)

    def test_all_cut_is_rejected(self):
        server.JOBS["test-all"] = {"status": "rendering"}
        server.render(self.key, "test-all", [{"start": 0, "end": 5}])
        self.assertEqual(server.JOBS["test-all"]["status"], "error")

    def test_export_removed_contains_only_the_cut_audio_sections(self):
        out="test-removed"
        server.JOBS[out]={"status":"rendering"}
        server.render(self.key,out,[{"start":1.04,"end":1.96},{"start":3.04,"end":3.96}],"removed")
        job=server.JOBS[out]
        self.assertEqual(job["status"],"ready",job.get("error"))
        self.assertEqual(job["mode"],"removed")
        probe=json.loads(server.run(["ffprobe","-v","error","-show_format","-of","json",str(job["output"])]).stdout)
        self.assertAlmostEqual(float(probe["format"]["duration"]),1.84,delta=0.08)
        pcm=server.run(["ffmpeg","-v","error","-i",str(job["output"]),"-vn","-ac","1","-ar","8000","-f","s16le","-"]).stdout
        samples=server.array.array("h",pcm)
        rms=(sum(value*value for value in samples)/len(samples))**0.5/32768
        self.assertLess(rms,0.005)

    def test_removed_export_merges_overlapping_cuts(self):
        server.JOBS["test-removed-overlap"]={"status":"rendering"}
        server.render(self.key,"test-removed-overlap",[{"start":1,"end":3},{"start":2,"end":4}],"removed")
        job=server.JOBS["test-removed-overlap"]
        self.assertEqual(job["status"],"ready",job.get("error"))
        self.assertAlmostEqual(job["duration"],3)

    def test_empty_removed_export_is_rejected(self):
        server.JOBS["test-removed-empty"]={"status":"rendering"}
        server.render(self.key,"test-removed-empty",[],"removed")
        self.assertEqual(server.JOBS["test-removed-empty"]["status"],"error")

    def test_removed_export_accepts_a_full_video_cut(self):
        server.JOBS["test-removed-full"]={"status":"rendering"}
        server.render(self.key,"test-removed-full",[{"start":0,"end":5}],"removed")
        self.assertEqual(server.JOBS["test-removed-full"]["status"],"ready")

    def test_video_without_audio(self):
        source = self.source.parent / "no-audio.mp4"
        server.run(["ffmpeg", "-v", "error", "-y", "-i", str(self.source), "-an", "-c:v", "copy", str(source)])
        server.JOBS["test-silent"] = {"status": "analyzing", "source": source}
        server.analyze("test-silent")
        job = server.JOBS["test-silent"]
        self.assertEqual(job["status"], "ready")
        self.assertFalse(job["hasAudio"])
        self.assertEqual(job["levels"], [])
        server.JOBS["test-silent-out"] = {"status": "rendering"}
        server.render("test-silent", "test-silent-out", [{"start": 1, "end": 4}])
        self.assertEqual(server.JOBS["test-silent-out"]["status"], "ready")

    def test_rotated_phone_video_preserves_portrait_orientation(self):
        source = self.source.parent / "rotated" / "source.mov"
        source.parent.mkdir()
        server.run(["ffmpeg", "-v", "error", "-y", "-display_rotation", "90", "-i", str(self.source),
                    "-c", "copy", str(source)])
        server.JOBS["test-rotated"] = {"status": "analyzing", "source": source}
        server.analyze("test-rotated")
        job = server.JOBS["test-rotated"]
        self.assertEqual(job["status"], "ready", job.get("error"))
        self.assertEqual((job["width"], job["height"]), (360, 640))
        server.JOBS["test-rotated-out"] = {"status": "rendering"}
        server.render("test-rotated", "test-rotated-out", [{"start": 1, "end": 2}, {"start": 3, "end": 4}])
        result = server.JOBS["test-rotated-out"]
        self.assertEqual(result["status"], "ready", result.get("error"))
        probe = json.loads(server.run(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(result["output"])]).stdout)
        video = next(s for s in probe["streams"] if s["codec_type"] == "video")
        self.assertEqual((video["width"], video["height"]), (360, 640))

    def test_supported_mov_preview_uses_lossless_remux_and_cache(self):
        source = self.source.parent / "remux" / "source.mov"
        source.parent.mkdir()
        server.run(["ffmpeg", "-v", "error", "-y", "-i", str(self.source), "-c", "copy", str(source)])
        server.JOBS["test-remux"] = {"source": source}
        server.prepare_preview("test-remux")
        job = server.JOBS["test-remux"]
        self.assertEqual(job["previewMode"], "remux")
        before = job["preview"].stat().st_mtime_ns
        # Decoded frame hashes must match: preview preparation did not re-encode.
        def hashes(path):
            return server.run(["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:v:0", "-f", "framemd5", "-"]).stdout
        self.assertEqual(hashes(source), hashes(job["preview"]))
        server.prepare_preview("test-remux")
        self.assertEqual(job["preview"].stat().st_mtime_ns, before)


if __name__ == "__main__":
    unittest.main()
