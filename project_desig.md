Here is the updated technical design and architectural blueprint for the **Audiobook Splitter Application**.

## 1. Architectural Overview

The application is a **Desktop app built with Electron** (not a client-server split). Electron packages the Node.js backend and HTML/JS frontend together into a single distributable — no server to run, no install friction for the user.

- **Frontend (UI):** HTML5, Tailwind CSS, and JavaScript. Handles file selection, waveform display, chapter marker editing, and progress feedback.
- **Backend (Processing Engine):** Node.js with **FFmpeg** via `fluent-ffmpeg`, and **FFprobe** for metadata/chapter extraction. FFmpeg handles lossless audio slicing.
- **Supported Formats:** MP3, M4A, M4B (AAC passthrough). M4B is the dominant audiobook format and must be treated as a first-class input.

## 2. Core Features & User Flow

1. **Ingest:** User drags and drops a large MP3, M4A, or M4B file.
2. **Analysis:** The app runs `ffprobe` to read duration, bitrate, and — critically — any embedded chapter markers.
3. **Split Method Selection** (in priority order):
   - _Chapter-based (Primary):_ If the file has embedded chapter metadata, use those boundaries. This is the most accurate method and should be the default.
   - _Silence-based (Fallback):_ If no chapters exist, detect silence gaps and propose split points. User can adjust markers on the waveform.
   - _Time-based (Last Resort):_ Split at fixed intervals (e.g., every 15 minutes).
4. **Preview:** Split points are shown as draggable markers on the waveform. User can add, remove, or adjust them before committing.
5. **Export:** Files are processed sequentially, named with a user-defined template (e.g., `[BookName] - Part [001]`), ID3/MP4 tags are updated, and output is saved to a local directory.

## 3. Data Flow & Processing Logic

### 3.1 Split Method Hierarchy

```
[ Input File: MP3 / M4A / M4B ]
        │
        ▼
┌──────────────────────────┐
│  Step 0: ffprobe         │
│  Read chapter markers    │
└──────────────────────────┘
        │
        ├── Chapters found? ──YES──► Use chapter timestamps
        │
        └── No chapters?   ──────► Silence detection pass
                                          │
                                          ├── Silences found? ──YES──► Compute midpoints as split points
                                          │
                                          └── No silences? ──────────► Time-based fallback
```

### 3.2 FFmpeg Splitting (Lossless)

All splits use **stream copying** (`-c:a copy`) — slices audio instantly without re-encoding or quality loss.

```
[ Split Points Array ]
        │
        ▼
┌─────────────────────────────────┐
│     FFmpeg Processing Engine    │
│  -ss <start_time>               │
│  -to <end_time>                 │
│  -c:a copy (Lossless Pass)      │
└─────────────────────────────────┘
        │
        ├──► [ Part_001.mp3 ]
        ├──► [ Part_002.mp3 ]
        └──► [ Part_003.mp3 ]
```

## 4. Technical Implementation

### Step 0: Read Embedded Chapters (Primary)

Before any other analysis, probe the file for chapter markers. Many M4B and modern MP3 files have these baked in.

```javascript
const ffmpeg = require('fluent-ffmpeg');

function getChapters(inputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            if (err) return reject(err);
            const chapters = metadata.chapters || [];
            // Each chapter has: id, start_time, end_time, tags.title
            resolve(chapters.map(ch => ({
                title: ch.tags?.title || `Chapter ${ch.id + 1}`,
                start: ch.start_time,
                end: ch.end_time,
            })));
        });
    });
}
```

### Step 1: Detect Silence (Fallback)

Used only when no embedded chapters are found. Captures both `silence_start` and `silence_end` to compute the midpoint as the actual split boundary.

```javascript
function detectSilence(inputPath, minSilenceDb = -40, minSilenceDuration = 2) {
    return new Promise((resolve, reject) => {
        const silences = [];
        let currentStart = null;

        ffmpeg(inputPath)
            .audioFilters(`silencedetect=n=${minSilenceDb}dB:d=${minSilenceDuration}`)
            .on('stderr', (line) => {
                if (line.includes('silence_start')) {
                    const match = line.match(/silence_start: (\d+\.?\d*)/);
                    if (match) currentStart = parseFloat(match[1]);
                }
                if (line.includes('silence_end') && currentStart !== null) {
                    const match = line.match(/silence_end: (\d+\.?\d*)/);
                    if (match) {
                        const end = parseFloat(match[1]);
                        silences.push({
                            start: currentStart,
                            end: end,
                            midpoint: (currentStart + end) / 2, // Use this as the split point
                        });
                        currentStart = null;
                    }
                }
            })
            .on('end', () => resolve(silences))
            .on('error', (err) => reject(err))
            .format('null')   // Cross-platform: no output file needed
            .output('-')
            .run();
    });
}
```

### Step 2: The Splitting Engine (Sequential, with Progress)

**Critical:** All FFmpeg jobs run **sequentially** using async/await — not fired simultaneously. Parallel spawning on a long audiobook causes resource exhaustion.

```javascript
const path = require('path');

/**
 * @param {string} inputPath   - Path to the source file
 * @param {string} outputDir   - Destination folder
 * @param {Array}  splitPoints - Array of { title, start, end } objects
 * @param {Function} onProgress - Called with (partNumber, totalParts, percent)
 */
async function splitAudiobook(inputPath, outputDir, splitPoints, onProgress) {
    const ext = path.extname(inputPath); // Preserve original format (mp3, m4a, m4b)
    const total = splitPoints.length;

    for (let i = 0; i < total; i++) {
        const { title, start, end } = splitPoints[i];
        const pad = String(i + 1).padStart(3, '0');
        const outputPath = path.join(outputDir, `${pad} - ${title}${ext}`);

        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .setStartTime(start)
                .setDuration(end - start)
                .outputOptions('-c:a copy') // Lossless — no re-encoding
                .output(outputPath)
                .on('progress', (progress) => {
                    onProgress(i + 1, total, progress.percent ?? 0);
                })
                .on('end', resolve)
                .on('error', reject)
                .run();
        });
    }
}
```

### Step 3: ID3 / MP4 Tag Injection

After splitting, update each output file's metadata. Use `node-id3` for MP3 and `mp4tag` (or `ffmpeg` metadata remux) for M4A/M4B.

```javascript
const NodeID3 = require('node-id3');

function writeID3Tags(filePath, { trackTitle, trackNumber, totalTracks, artist, album, coverArt }) {
    NodeID3.write({
        title: trackTitle,
        trackNumber: `${trackNumber}/${totalTracks}`,
        artist,
        album,
        image: coverArt ? { mime: 'image/jpeg', type: { id: 3 }, imageBuffer: coverArt } : undefined,
    }, filePath);
}
```

## 5. UI/UX Considerations

- **Waveform Preview:** Use `wavesurfer.js` to render the audio timeline. Overlay chapter/silence markers as draggable handles so users can fine-tune split points before processing.
- **Split Method Indicator:** Clearly show which method was auto-selected (e.g., "✓ 24 chapters detected" vs "No chapters found — using silence detection").
- **Progress Bar:** Show per-file progress and overall batch progress using FFmpeg's `on('progress')` events. Display estimated time remaining.
- **Batch Naming Template:** Text field with tokens: `[BookName] - Part [001]`, `[ChapterTitle]`, `[Author]`, etc.
- **Output Format:** Default to matching the input format. Offer an optional transcode to MP3 for compatibility (with a quality/bitrate selector).
- **Error Recovery:** If a single split fails, log it and continue — don't abort the whole batch.
