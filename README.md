# AudioBookCutter (v1.0.1)

**AudioBookCutter** is a premium, high-performance desktop application designed to split large audiobooks (`.mp3`, `.m4a`, `.m4b`) into smaller tracks quickly, cleanly, and **losslessly**.

Built on **Electron** using **Vite**, **wavesurfer.js** for timeline visualization, and **FFmpeg** for lossless stream copying, it offers a seamless experience for parsing chapters, detecting silences, and customizing track segment boundaries.

---

## Key Features

- **⚡ Lossless Slicing:** Uses direct stream copying (`-c:a copy`) to split tracks in milliseconds without re-encoding, preserving original audio quality.
- **📈 Interactive Waveform:** Visualize long audiobook tracks using an optimized waveform visualizer powered by `wavesurfer.js`.
- **🔗 Smart Track Merging:** Select multiple contiguous track segments using checkboxes and merge them into a single track directly from the sidebar. Merged tracks are highlighted in emerald green.
- **🔢 Auto-Sequential Numbering:** Automatically keeps track names formatted and numbered sequentially (e.g. *Part 01*, *Part 02*, *Part 03*) even after complex splits or merges.
- **⚙️ Dynamic Codec Detection:** Probes the underlying audio stream codec (like AAC or MP3) using `ffprobe` to automatically output matching containers (e.g. `.m4a` for AAC, `.mp3` for MP3) to avoid exit code 234 crashes.
- **🎨 Modern Dark Mode UI:** High-fidelity Glassmorphic styling with a responsive workspace, drag-and-drop file imports, and real-time split progress tracking.

---

## Getting Started

### Prerequisites

Ensure you have [Node.js](https://nodejs.org/) installed (v18+ recommended). FFmpeg/FFprobe will be auto-detected if installed via Homebrew (`brew install ffmpeg`) on macOS or added to your system PATH.

### Installation

Clone the repository and install dependencies:

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/AudioBookCutter.git
cd AudioBookCutter

# Install dependencies
npm install
```

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

All compiled binaries will be exported to the `/dist` directory.

---

## Project Structure

```text
├── src
│   ├── main       # Electron main process (FFmpeg slicing, codec probe)
│   ├── preload    # Preload scripts defining secure IPC boundaries
│   └── renderer   # Webpage UI (HTML, Tailwind CSS, wavesurfer.js)
├── resources      # App icons and static assets
└── electron-builder.yml # App distribution packaging config
```
