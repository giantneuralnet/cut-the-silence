# Cut the Silence

A minimal, open-source video editor for removing silence and unwanted takes.

**[Open the editor](https://giantneuralnet.github.io/cut-the-silence/)**

- Silence detection with threshold, pause length, minimum clip length, and padding.
- Optional stillness cuts based on video motion, with their own threshold, duration, and padding.
- Green sections are kept. Tap sections to keep or remove them; drag cut edges.
- Timeline zoom, trackpad pan/pinch, fullscreen preview, and a playhead clip toggle.
- Undo, redo, and clear-manual-edits controls. Manual choices survive slider changes.
- Preview and export either the edited video or the removed clips.
- Dark mode, collapsible sliders, no accounts, and no video uploads to a server on the hosted site.

## Hosted editor

The GitHub Pages version uses native WebCodecs for audio analysis and MP4 export
when the browser supports decoding and encoding the source video codec plus AAC audio. Video decoding
and encoding request hardware acceleration, including on supported iPhones.
Safari 26 or newer exposes the audio WebCodecs needed for this path; device,
codec and resolution support still vary, and the browser chooses the actual
hardware implementation. No setting needs to be enabled in the editor.

Unsupported codecs fall back to FFmpeg in a Web Worker. Videos stay in your
browser. The fallback engine downloads from jsDelivr on first use;
your footage is never sent there. Your latest selected video is cached in
IndexedDB when browser storage is available, and editing choices are saved in
local storage. Uploading another video replaces the cached source.

Browser processing supports files up to **512 MB** and depends on available
memory. The compatibility fallback is slower than native codecs, especially for 4K footage.
Use the local version for larger recordings and hardware-accelerated export.

## Run locally

Requires Python 3.10+, Node.js 18+ (for stillness tracking), and `ffmpeg` / `ffprobe` on PATH. On macOS:

```sh
brew install ffmpeg node
git clone https://github.com/giantneuralnet/cut-the-silence.git
cd cut-the-silence
python3 server.py
```

Open **http://127.0.0.1:8000**. No Python or JavaScript package installation is
needed. The local server uses VideoToolbox hardware encoding on supported Macs
and software encoding elsewhere. Sources and renders are cached in `.data/`,
which is excluded from Git. Preview copies are kept small; exports retain the
original resolution. Exports retain the source video codec (including HEVC) and
target the source video bitrate when it is available. Bitrate is an encoder
target, so the measured output average can differ after cuts and re-encoding.
If the source does not declare a video bitrate, an encoder default is used.
Browser codec support varies; an unsupported original codec produces an error
with guidance to use the local app instead of silently converting to H.264.

To try the browser-only implementation locally, open
**http://127.0.0.1:8000/?browser** while the server is running, or serve `public/`
with any static server and append `?browser` to its localhost URL.

## Controls

Silence level classifies audio. Cut pauses longer than removes long pauses;
Remove clips shorter than removes whole remaining clips between cuts, not
individual sounds inside longer speech. Padding keeps space on both sides of
surviving audio. Explicitly kept sections override automatic removal.

Enable **Cut stillness** to remove visually still stretches even when audio is
playing. Disable **Cut silence** to make automatic cuts depend only on motion,
or leave both enabled to cut either kind of inactivity. Stillness level is the
maximum tracked speed in analysis pixels per second: lower it to preserve
subtler movement. Cut stillness longer than sets the minimum stationary duration.
Padding around movement retains footage before and after movement. The first
use analyzes the video; results are cached, so slider changes are immediate.
Manual keeps, cuts, and boundary adjustments take precedence. Older motion
analysis is automatically replaced; the old percentage threshold is reset to
0.5 px/s because the units have changed.

### Motion detector

The detector tracks 7×7 patches using zero-mean normalized cross correlation
(ZNCC), at 320×180 resolution and 5 samples per second. It searches for local
translation, compares 0.2-second and 1-second baselines, and accepts either neighboring
patches that agree or one reliable patch moving consistently across three
consecutive observations. Confirmed movement is kept from its observed onset,
including the earlier frames used to establish consistency. The longer comparison captures small gradual displacement.
Brightness/contrast normalization, mild denoising, and stationary comparisons
at different blur levels reduce exposure and focus false positives. Flat or
isolated unstable patches do not establish movement. Widespread tracking
failure is kept conservatively. Temporal confirmation can retain up to 1.4 extra seconds around slow movement,
in addition to padding. Displacement remains measured in whole analysis pixels.

In browsers the patch search runs through WebGL 2 when floating-point render
targets are available; it falls back to the same CPU algorithm if unavailable
or if the graphics context is lost. WebCodecs independently requests hardware
video decoding. The local Python server streams FFmpeg frames to the shared
Node.js CPU tracker. Compatibility decoding processes ten-second chunks to
bound raw-frame memory. No footage is uploaded by the hosted editor.

This is a lightweight implementation of normalized patch correspondence, not
a bundled OpenCV or neural optical-flow model. We considered
[DIS optical flow](https://docs.opencv.org/4.13.0/de/d4f/classcv_1_1DISOpticalFlow.html),
[RAFT](https://arxiv.org/abs/2003.12039), and
[CUDA Lucas–Kanade](https://docs.opencv.org/doc/doxygen/html/d7/d05/classcv_1_1cuda_1_1SparsePyrLKOpticalFlow.html).
ZNCC was chosen for a small, portable browser implementation with intensity
normalization ([research](https://arxiv.org/abs/1810.04320),
[correlation definition](https://legacy-docs.opencv.org/4.x/df/dfb/group__imgproc__object.html)).
It is not immune to strong shadows, severe blur, repeating patterns, or tiny
untextured objects. Camera motion also counts as movement. Review the removed
preview for critical footage; lower the threshold or keep a section manually.

Tap a section or use Keep/Cut current clip under the playhead. Drag cut boundaries
to adjust offsets; those offsets follow detected boundaries as settings change.
Pinch over the timeline to zoom, scroll with two fingers to pan, or use the zoom
bar. Double-click the bar to show the full video. Space plays/pauses;
Cmd/Ctrl+Z undoes and Cmd/Ctrl+Shift+Z redoes. Render downloads the edited MP4.
Advanced contains removed-clip preview and export. Check **Export as separate
clips** to export each continuous kept section (or each removed section from
Advanced) as an individually numbered MP4 inside one ZIP download. Leave it
unchecked to render a single joined MP4.

## Development and deployment

The UI is plain HTML, CSS and JavaScript with no build step. The optional local
backend uses Python's standard library and Node.js without npm dependencies. Browser processing uses pinned Mediabunny (MPL-2.0), an MIT-licensed FFmpeg
wrapper, and a separately downloaded WebAssembly core.

```sh
node --test test_*.mjs
python3 -m unittest -v test_editor.py
```

GitHub Actions runs the regression tests and deploys only `public/` to GitHub
Pages after pushes to `main`. To fork and deploy, enable GitHub Pages with
**GitHub Actions** as the source, then run the Pages workflow.

## License

Original app source: [MIT](LICENSE). Third-party components retain their own
licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
