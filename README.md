# AudioBookCutter (v1.2.0)

**AudioBookCutter** is a premium, high-performance desktop application designed to split large audiobooks (`.mp3`, `.m4a`, `.m4b`) into smaller tracks quickly, cleanly, and **losslessly**.

Built on **Electron** using **Vite**, **wavesurfer.js** for timeline visualization, and **FFmpeg** for lossless stream copying, it offers a seamless experience for parsing chapters, detecting silences, and customizing track segment boundaries.

---

## Key Features

- **📖 Auto Mode (EPUB → Chapters):** Point the app at the book's `.epub` file and it reads the table of contents, then automatically names and places every chapter onto the audio timeline. Boundaries are estimated from each chapter's share of the total text (a proxy for narration time) and snapped to the nearest detected silence, so you skip the manual point-by-point setup. Estimated boundaries load into the editor for a quick review before exporting.
- **🎯 Precise Alignment (Whisper):** Optionally upgrade the estimate to true forced alignment. The app transcribes the audiobook with a local **whisper.cpp** model and matches the transcript against each chapter's opening words from the EPUB — moving every boundary to where the chapter is actually spoken (typically within ~1 second), independent of narration pace or front matter. Fully offline; boundaries it can't confidently match keep the proportional estimate.
- **⚡ Lossless Slicing:** Uses direct stream copying (`-c:a copy`) to split tracks in milliseconds without re-encoding, preserving original audio quality.
- **📈 Interactive Waveform:** Visualize long audiobook tracks using an optimized waveform visualizer powered by `wavesurfer.js`.
- **🔗 Smart Track Merging:** Select multiple contiguous track segments using checkboxes and merge them into a single track directly from the sidebar. Merged tracks are highlighted in emerald green.
- **🔢 Auto-Sequential Numbering:** Automatically keeps track names formatted and numbered sequentially (e.g. *Part 01*, *Part 02*, *Part 03*) even after complex splits or merges.
- **⚙️ Dynamic Codec Detection:** Probes the underlying audio stream codec (like AAC or MP3) using `ffprobe` to automatically output matching containers (e.g. `.m4a` for AAC, `.mp3` for MP3) to avoid exit code 234 crashes.
- **🎨 Modern Dark Mode UI:** High-fidelity Glassmorphic styling with a responsive workspace, drag-and-drop file imports, and real-time split progress tracking.

---

## Using Auto Mode

On the start screen:

1. Add the **audiobook** (`.mp3` / `.m4a` / `.m4b`) and the **EPUB** of the same book — drag-and-drop or click each card to browse.
2. Optionally tick **Precise alignment (Whisper)** for exact, transcription-matched cuts (see below). The screen shows a good-faith **estimated processing time** based on the audio length and this choice.
3. Click **Start Processing**. A progress bar tracks the work — silence detection, chapter mapping, and (if enabled) Whisper transcription and alignment.
4. When it finishes, the workspace opens with the chapters laid out on the waveform. Review, nudge any boundary if needed, then **Process Audiobook** to export.

The app parses the EPUB's table of contents (numbered chapters only — front/back matter and "Part" dividers are skipped) and maps each chapter onto the audio timeline. The Auto panel in the workspace sidebar lets you re-map or tweak the options afterwards.

### Auto-mode options

- **Snap to silence** — how far (in seconds) a chapter boundary may move to land on the nearest detected silence. Choose a tighter window (±30s) to keep boundaries close to the text estimate, a wider one (±180s) to favour clean cuts, or **Off** to place boundaries purely by text proportion (fastest — no audio scan). Silence detection is cached per file, so changing this re-maps instantly after the first scan.
- **Precise alignment (Whisper)** — when ticked, the proportional boundaries are refined by transcribing the audiobook and matching the transcript to each chapter's opening text, moving each cut to where the chapter is actually narrated. Requires a local whisper.cpp install (see below). The first run downloads the `base.en` model (~150 MB). This is the slowest option — whisper.cpp runs many times faster than realtime (roughly a minute of processing per hour of audio on Apple Silicon), so expect a few minutes for a typical book and ~20–30 min for a very long one — but it is by far the most accurate, and it runs once per file.
- **Split immediately (skip review)** — when ticked, mapping (and alignment, if enabled) is followed straight away by export to the output folder, with no editor review step. Leave it off to inspect and adjust the chapters first (recommended).

### Enabling Whisper alignment

Precise alignment shells out to a local [whisper.cpp](https://github.com/ggerganov/whisper.cpp) binary, mirroring how the app uses FFmpeg.

```bash
# macOS (Homebrew)
brew install whisper-cpp
```

The app auto-detects the binary on your `PATH` / Homebrew (`whisper-cli`, `whisper-cpp`, or `main`), or you can point it at a specific build with the `WHISPER_CPP_PATH` environment variable. The `base.en` model is downloaded automatically into the app's data directory on first use. Toggle **Precise alignment (Whisper)** in the Auto panel — a status line shows whether whisper.cpp is detected.

> **How alignment works:** The app transcribes the whole book once (in chunks, with word-level timestamps) into a single timestamped token stream, then fuzzy-matches each chapter's first ~30 words from the EPUB against it — forward-only, so chapters stay in order and tolerant of the misspellings ASR produces. Each boundary moves to the first spoken anchor word and snaps to nearby silence. Because it searches the entire transcript rather than a window around a guess, it is robust to large drift between the text-length estimate and real narration (front matter, variable reading speed). Anything below the confidence threshold keeps its proportional estimate, so alignment is never worse than Auto mode alone.

> **How timing is estimated:** EPUB files contain chapter *titles* and *text*, but not audio timestamps. AudioBookCutter estimates each chapter's start by its proportional share of the book's total word count (assuming roughly constant narration pace) and refines it by snapping to the nearest silence gap. The first chapter is pinned to the start and the last extends to the end, so the whole file is covered with no gaps. Because pace varies, always give the boundaries a quick look before exporting. Silence scanning reads the entire file once, so the first mapping of a long book can take a minute or two.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v18+.
- **FFmpeg/FFprobe** — auto-detected if installed via Homebrew (`brew install ffmpeg`) on macOS, or available on your system `PATH`.
- **whisper.cpp** *(optional, for Precise Alignment only)* — `brew install whisper-cpp` on macOS. See [Enabling Whisper alignment](#enabling-whisper-alignment).

### Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/ProfChiu/AudioBookCutter.git
cd AudioBookCutter
npm install
```

### One-click launch (macOS)

Double-click **`Start AudioBookCutter.command`** in the project folder to launch the app without using the terminal (drag it to your Dock or Desktop for quick access). On first launch macOS Gatekeeper may warn about an unidentified developer — right-click → **Open** once to allow it.

### Development Mode

Run the hot-reloading dev environment:

```bash
npm run dev
```

### Building for Distribution

To compile production bundles and installers for your operating system:

```bash
# Build for macOS (.dmg and .zip)
npm run build:mac

# Build for Windows (.exe installer)
npm run build:win

# Build for Linux (.AppImage, .deb)
npm run build:linux
```

All compiled binaries will be exported to the `/dist` directory. The macOS build is **unsigned** unless you supply a valid Developer ID, so recipients open it the first time via right-click → **Open**.

---

## Project Structure

```text
├── src
│   ├── main                 # Electron main process
│   │   ├── index.js         #   App lifecycle + IPC handlers (split, auto-map, align)
│   │   ├── analyzer.js      #   FFmpeg/ffprobe: metadata, silence detection, proportional splits
│   │   ├── epub.js          #   Parses EPUB table of contents → chapter titles, word counts, anchors
│   │   ├── whisper.js       #   whisper.cpp detection, model download, WAV windowing, transcription
│   │   └── align.js         #   Whisper forced alignment: match chapter anchors → exact cut points
│   ├── preload              # Secure IPC bridge (contextBridge)
│   └── renderer             # UI (HTML, Tailwind CSS, wavesurfer.js)
├── resources                # App icons and static assets
├── Start AudioBookCutter.command  # macOS one-click launcher
└── electron-builder.yml     # App distribution packaging config
```
