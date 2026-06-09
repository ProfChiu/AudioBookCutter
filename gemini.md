## Project Summary

**AudioBookCutter** is an Electron-based desktop application designed to split large audiobook files (`MP3`, `M4A`, `M4B`) into smaller, individual tracks or chapters cleanly, quickly, and losslessly.

- **Frontend:** HTML5, Tailwind CSS v3, JavaScript, and `wavesurfer.js` for interactive waveform visualization.
- **Backend:** Node.js with FFmpeg/FFprobe via `fluent-ffmpeg`.
- **Tooling:** Built and bundled using Vite via `electron-vite` for modern hot-reloading and asset management.
- **Key Capability:** Splitting is performed losslessly using stream copying (`-c:a copy`) without re-encoding, prioritizing embedded chapter markers, falling back to silence detection, and using fixed time splits as a last resort.

## Important Folders

- `/src` - Source code directory
  - `/src/main` - Electron main process code (backend, FFmpeg integrations)
  - `/src/renderer` - Electron renderer process (Vite + Tailwind CSS v3 + wavesurfer.js)
  - `/src/preload` - Preload scripts exposing IPC boundaries securely
- `/out` or `/dist` - Production build outputs and installers

## Development Principles

- **Lossless Stream Copying**: Always use `-c:a copy` for splits by default to preserve quality and speed.
- **Sequential Processing**: Execute all audio splitting tasks sequentially using async/await. Avoid parallel execution of FFmpeg tasks to prevent system resource exhaustion.
- **User-Centric Previews**: Allow user adjustment of split markers on the waveform before any split action is committed.
- **Robustness**: Log errors on individual split failures and proceed with the rest of the batch instead of crashing.

## Milestones

- **Milestone 1: Project Scaffolding & Initial UI Layout**
  - Setup Electron project structure using `electron-vite` and Tailwind CSS v3.
  - Create the main application window and drop-zone interface.
- **Milestone 2: Waveform Visualization & Marker Interactive UI**
  - Integrate `wavesurfer.js` to render the loaded audiobook waveform.
  - Implement draggable, interactive timeline markers for split boundaries.
- **Milestone 3: Metadata Ingestion & Split Point Detection**
  - Use `ffprobe` to read embedded chapter markers.
  - Implement silence detection filter as a fallback split mechanism.
- **Milestone 4: Lossless Splitting Engine & Metadata Tagging**
  - Build the sequential splitting queue.
  - Implement ID3/MP4 metadata tagging on split outputs.
- **Milestone 5: Advanced Options & Cross-Platform Packaging**
  - Support naming templates and optional audio format transcoding.
  - Package/distribute installer packages for macOS, Windows, and Linux.

## Do Not Do

- Do not build any code until I give the go ahead. 
- Do not make broad project-wide refactors unless they directly support the current milestone.
- Do not work on or implement tasks outside the current active milestone.
- Always assume planning mode until I give the go ahead to create code and assets.