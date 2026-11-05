# Third-party software

Cut the Silence's original source code is MIT licensed. Third-party components
retain their own licenses.

- **@ffmpeg/ffmpeg 0.12.15**, the JavaScript worker wrapper, is vendored under
  `public/vendor/ffmpeg/`. Its MIT license is included in that directory.
  Source: https://github.com/ffmpegwasm/ffmpeg.wasm
  Package: https://www.npmjs.com/package/@ffmpeg/ffmpeg/v/0.12.15
- **@ffmpeg/core 0.12.10**, the single-thread WebAssembly runtime, is downloaded
  by the visitor's browser from jsDelivr when video processing first starts.
  The core is GPL-2.0-or-later and is not included in this repository. Its FFmpeg
  and codec dependencies have their respective upstream licenses. Source and
  build scripts: https://github.com/ffmpegwasm/ffmpeg.wasm
  Package: https://www.npmjs.com/package/@ffmpeg/core/v/0.12.10
- The optional local server runs the user's installed **FFmpeg** and **ffprobe**
  executables. Their licenses depend on the installed build:
  https://ffmpeg.org/legal.html

No uploaded video, cached render, or private test screenshot is part of the
public repository or Pages deployment.
