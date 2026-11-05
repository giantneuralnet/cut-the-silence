# Cut the Silence

A minimal, open-source video editor for removing silence and unwanted takes.

**[Open the editor](https://giantneuralnet.github.io/cut-the-silence/)**

- Silence detection with threshold, pause length, minimum clip length, and padding.
- Green sections are kept. Tap sections to keep or remove them; drag cut edges.
- Timeline zoom, trackpad pan/pinch, fullscreen preview, and a playhead clip toggle.
- Undo, redo, and clear-manual-edits controls. Manual choices survive slider changes.
- Preview and export either the edited video or the removed clips.
- Dark mode, collapsible sliders, no accounts, and no video uploads to a server on the hosted site.

## Hosted editor

The GitHub Pages version runs FFmpeg in a Web Worker on your computer. Videos
stay in your browser. The processing engine downloads from jsDelivr on first use;
your footage is never sent there. Your latest selected video is cached in
IndexedDB when browser storage is available, and editing choices are saved in
local storage. Uploading another video replaces the cached source.

Browser processing supports files up to **512 MB** and depends on available
memory. Exporting is slower than native FFmpeg, especially for 4K footage.
Use the local version for larger recordings and hardware-accelerated export.

## Run locally

Requires Python 3.10+ and `ffmpeg` / `ffprobe` on PATH. On macOS:

```sh
brew install ffmpeg
git clone https://github.com/giantneuralnet/cut-the-silence.git
cd cut-the-silence
python3 server.py
```

Open **http://127.0.0.1:8000**. No Python or JavaScript package installation is
needed. The local server uses VideoToolbox hardware encoding on supported Macs
and software encoding elsewhere. Sources and renders are cached in `.data/`,
which is excluded from Git. Preview copies are kept small; exports retain the
original resolution.

To try the browser-only implementation locally, open
**http://127.0.0.1:8000/?browser** while the server is running, or serve `public/`
with any static server and append `?browser` to its localhost URL.

## Controls

Silence level classifies audio. Cut pauses longer than removes long pauses;
Remove clips shorter than removes whole remaining clips between cuts, not
individual sounds inside longer speech. Padding keeps space on both sides of
surviving audio. Explicitly kept sections override automatic removal.

Tap a section or use Keep/Cut current clip under the playhead. Drag cut boundaries
to adjust offsets; those offsets follow detected boundaries as settings change.
Pinch over the timeline to zoom, scroll with two fingers to pan, or use the zoom
bar. Double-click the bar to show the full video. Space plays/pauses;
Cmd/Ctrl+Z undoes and Cmd/Ctrl+Shift+Z redoes. Render downloads the edited MP4.
Advanced contains removed-clip preview and export.

## Development and deployment

The UI is plain HTML, CSS and JavaScript with no build step. The optional local
backend uses only Python's standard library. Browser processing uses a pinned
MIT-licensed FFmpeg wrapper and a separately downloaded WebAssembly core.

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
