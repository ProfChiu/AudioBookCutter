import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import TimelinePlugin from 'wavesurfer.js/dist/plugins/timeline.esm.js';

// Global state
let currentFile = null;
let currentFilePath = '';
let currentChapters = [];
let fileMetadata = null;
let wavesurfer = null;
let wsRegions = null;

// Initialize when DOM is loaded
window.addEventListener('DOMContentLoaded', () => {
  initApp();
});

function initApp() {
  // Setup Versions display in footer
  if (window.electron && window.electron.process) {
    const versions = window.electron.process.versions;
    document.getElementById('el-ver').innerText = `Electron: v${versions.electron}`;
    document.getElementById('ch-ver').innerText = `Chrome: v${versions.chrome}`;
    document.getElementById('nd-ver').innerText = `Node: v${versions.node}`;
  }

  // Prevent default window drag/drop behavior to avoid Chrome opening files on mis-drops
  window.addEventListener('dragover', (e) => e.preventDefault(), false);
  window.addEventListener('drop', (e) => e.preventDefault(), false);

  // Setup custom modal cancel/close listeners
  const cancelBtn = document.getElementById('modalCancelBtn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      if (cancelBtn.innerText === 'Open Folder') {
        const outputDir = document.getElementById('outputDirDisplay').innerText.trim();
        if (window.api && window.api.openFolder) {
          window.api.openFolder(outputDir);
        }
      } else {
        hideModal();
      }
    });
  }

  const closeBtn = document.getElementById('modalCloseBtn');
  if (closeBtn) {
    closeBtn.addEventListener('click', handleModalConfirmClick);
  }

  // Set default output directory
  if (window.api && window.api.getDefaultOutputDir) {
    window.api.getDefaultOutputDir().then(dir => {
      const display = document.getElementById('outputDirDisplay');
      if (dir && display) {
        display.innerText = dir;
      }
    });
  }

  // Choose directory button
  const selectDirBtn = document.getElementById('selectOutputDirBtn');
  if (selectDirBtn) {
    selectDirBtn.addEventListener('click', async () => {
      if (window.api && window.api.selectOutputDir) {
        const selected = await window.api.selectOutputDir();
        const display = document.getElementById('outputDirDisplay');
        if (selected && display) {
          display.innerText = selected;
        }
      }
    });
  }

  // Setup output format change listener for transcoding options
  const outputFormatSelect = document.getElementById('outputFormat');
  if (outputFormatSelect) {
    outputFormatSelect.addEventListener('change', (e) => {
      const bitrateContainer = document.getElementById('bitrateContainer');
      if (bitrateContainer) {
        if (e.target.value === 'copy') {
          bitrateContainer.classList.add('hidden');
        } else {
          bitrateContainer.classList.remove('hidden');
        }
      }
    });
  }

  // Merge Selected splits button click listener
  const mergeBtn = document.getElementById('mergeSelectedBtn');
  if (mergeBtn) {
    mergeBtn.addEventListener('click', mergeSelectedSplits);
  }

  // Select all splits checkbox change listener
  const selectAllCb = document.getElementById('selectAllSplits');
  if (selectAllCb) {
    selectAllCb.addEventListener('change', (e) => {
      const cbs = document.querySelectorAll('.split-select-cb');
      cbs.forEach(cb => {
        cb.checked = e.target.checked;
      });
      updateMergeButtonState();
    });
  }

  setupDropzone();
  setupWorkspaceControls();
  setupSplitMethodListeners();
}

function setupDropzone() {
  const dropzone = document.getElementById('dropzone');
  const browseBtn = dropzone.querySelector('button');
  
  // Create hidden file input for browsing
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.mp3,.m4a,.m4b';
  fileInput.className = 'hidden';
  document.body.appendChild(fileInput);

  // Browse files click handler
  browseBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // Prevent triggering dropzone click
    fileInput.click();
  });

  dropzone.addEventListener('click', () => {
    fileInput.click();
  });

  // Handle selected file from input
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFileSelection(e.target.files[0]);
    }
  });

  // Drag and drop event listeners
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.remove('border-slate-700/60', 'bg-[#0f1428]/40');
    dropzone.classList.add('border-indigo-500/80', 'bg-indigo-500/5', 'shadow-indigo-500/10');
  });

  dropzone.addEventListener('dragleave', () => {
    resetDropzoneStyling();
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    resetDropzoneStyling();

    if (e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      const ext = file.name.split('.').pop().toLowerCase();
      if (['mp3', 'm4a', 'm4b'].includes(ext)) {
        handleFileSelection(file);
      } else {
        showModal('Unsupported Format', 'Unsupported file format. Please drop an MP3, M4A, or M4B file.');
      }
    }
  });
}

function resetDropzoneStyling() {
  const dropzone = document.getElementById('dropzone');
  dropzone.classList.remove('border-indigo-500/80', 'bg-indigo-500/5', 'shadow-indigo-500/10');
  dropzone.classList.add('border-slate-700/60', 'bg-[#0f1428]/40');
}

function setupWorkspaceControls() {
  const closeFileBtn = document.getElementById('closeFileBtn');
  const processBtn = document.getElementById('processBtn');

  closeFileBtn.addEventListener('click', () => {
    transitionToScreen('dropzone');
    destroyWaveSurfer();
    currentFile = null;
    currentFilePath = '';
    currentChapters = [];
    fileMetadata = null;
  });

  processBtn.addEventListener('click', () => {
    if (currentFile && wsRegions) {
      const sorted = wsRegions.getRegions().sort((a, b) => a.start - b.start);
      const outputSplits = sorted.map((r, i) => ({
        part: i + 1,
        title: r.data?.title || `Part ${String(i + 1).padStart(2, '0')}`,
        start: r.start.toFixed(3),
        end: r.end.toFixed(3),
        duration: (r.end - r.start).toFixed(3)
      }));
      showConfirmSplitsModal(outputSplits);
    }
  });
}

function setupSplitMethodListeners() {
  const radios = document.querySelectorAll('input[name="splitMethod"]');
  radios.forEach(radio => {
    radio.addEventListener('change', async (e) => {
      if (!currentFile || !fileMetadata) return;
      const method = e.target.value;
      await applySplitMethod(method);
    });
  });
}

async function handleFileSelection(file) {
  try {
    currentFile = file;

    // Retrieve absolute file path via Electron's secure webUtils
    currentFilePath = window.api.getPathForFile(file);
    console.log('Ingesting file path:', currentFilePath);

    if (!currentFilePath) {
      throw new Error("Could not retrieve the absolute file path from the file object. Ensure the file is a valid local file.");
    }

    // Transition UI screen
    transitionToScreen('workspace');

    // Load and analyze file
    await loadAndAnalyzeFile(file, currentFilePath);
  } catch (err) {
    showModal('Error Loading File', "Error loading file: " + err.message);
    console.error(err);
  }
}

async function loadAndAnalyzeFile(file, filePath) {
  const loadingOverlay = document.getElementById('waveformLoading');
  const progressText = document.getElementById('loadingProgress');
  
  loadingOverlay.classList.remove('opacity-0', 'pointer-events-none');
  loadingOverlay.classList.add('opacity-100');
  progressText.innerText = 'Analyzing metadata...';
  
  document.getElementById('statusText').innerText = 'Analyzing file...';

  // Invoke backend metadata analysis
  const res = await window.electron.ipcRenderer.invoke('analyze-file', filePath);
  if (!res.success) {
    showModal('Analysis Error', 'Failed to analyze audio file: ' + res.error);
    loadingOverlay.classList.add('opacity-0', 'pointer-events-none');
    transitionToScreen('dropzone');
    return;
  }

  fileMetadata = res.metadata;
  currentChapters = res.metadata.chapters;
  
  // Render details in UI
  const sizeInMB = (res.metadata.size / (1024 * 1024)).toFixed(1);
  const ext = filePath.split('.').pop().toUpperCase();
  const kbps = Math.round(res.metadata.bitrate / 1000);

  document.getElementById('fileName').innerText = file.name;
  document.getElementById('fileSize').innerText = `${sizeInMB} MB`;
  document.getElementById('fileTypeBadge').innerText = ext;
  document.getElementById('fileBitrate').innerText = `${kbps} kbps (${ext})`;
  document.getElementById('fileDuration').innerText = formatDuration(res.metadata.duration);

  // Load wave audio visualizer
  initWaveSurfer(file, res.metadata.duration);
}

function initWaveSurfer(file, duration) {
  destroyWaveSurfer();

  // Create WaveSurfer instance
  wavesurfer = WaveSurfer.create({
    container: '#waveform',
    waveColor: '#334155', // Slate 700
    progressColor: '#6366f1', // Indigo 500
    cursorColor: '#10b981', // Emerald 500
    cursorWidth: 2,
    height: 128,
    barWidth: 2,
    barGap: 2,
    barRadius: 2,
    responsive: true,
    normalize: true,
    plugins: [
      TimelinePlugin.create({
        container: '#timeline',
        height: 18,
        style: {
          color: '#94a3b8', // Slate 400
          fontFamily: 'Inter, sans-serif',
          fontSize: '9px',
          fontWeight: '600'
        }
      })
    ]
  });

  // Register regions plugin
  wsRegions = wavesurfer.registerPlugin(RegionsPlugin.create());

  const loadingOverlay = document.getElementById('waveformLoading');
  const progressText = document.getElementById('loadingProgress');
  
  loadingOverlay.classList.remove('opacity-0', 'pointer-events-none');
  loadingOverlay.classList.add('opacity-100');
  progressText.innerText = '0%';

  // Load the audio Blob URL
  const blobUrl = URL.createObjectURL(file);

  // If the audio duration is longer than 30 minutes (1800 seconds),
  // we pass pre-calculated dummy peaks to prevent wavesurfer from decoding
  // the entire large file in the browser context, avoiding OOM memory crashes.
  if (duration >= 1800) {
    const length = 800;
    const peaks = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const sine = Math.sin((i / length) * Math.PI * 12);
      peaks[i] = (Math.random() * 0.45 + 0.1) * (0.3 + Math.abs(sine) * 0.7);
    }
    // Load with peaks to bypass decoding
    wavesurfer.load(blobUrl, [peaks], duration);
  } else {
    // Load standard Blob URL (wavesurfer will decode automatically)
    wavesurfer.load(blobUrl);
  }

  // WaveSurfer Event Listeners
  wavesurfer.on('loading', (percent) => {
    progressText.innerText = `Decoding waveform... ${percent}%`;
  });

  wavesurfer.on('ready', async () => {
    loadingOverlay.classList.add('opacity-0', 'pointer-events-none');
    document.getElementById('statusText').innerText = 'Audio Loaded';

    // Update duration display
    const duration = wavesurfer.getDuration();
    document.getElementById('fileDuration').innerText = formatDuration(duration);

    // Initial split points calculation based on chapter availability
    const chaptersRadio = document.querySelector('input[value="chapters"]');
    const silenceRadio = document.querySelector('input[value="silence"]');

    let initialMethod = 'chapters';
    
    if (currentChapters.length > 0) {
      initialMethod = 'chapters';
      chaptersRadio.checked = true;
      chaptersRadio.disabled = false;
      chaptersRadio.closest('label').classList.remove('opacity-50', 'pointer-events-none');
    } else {
      // Disable chapters selection since there are none
      chaptersRadio.checked = false;
      chaptersRadio.disabled = true;
      chaptersRadio.closest('label').classList.add('opacity-50', 'pointer-events-none');
      
      // Fallback to silence detection
      initialMethod = 'silence';
      silenceRadio.checked = true;
    }

    await applySplitMethod(initialMethod);
    setupPlaybackControls();
  });

  wavesurfer.on('timeupdate', (time) => {
    const duration = wavesurfer.getDuration();
    document.getElementById('timeDisplay').innerText = `${formatTime(time)} / ${formatTime(duration)}`;
  });

  // Keep adjacent regions contiguous
  wsRegions.on('region-updated', (region) => {
    const sorted = wsRegions.getRegions().sort((a, b) => a.start - b.start);
    const index = sorted.findIndex(r => r.id === region.id);

    if (index !== -1) {
      if (index > 0) {
        const prev = sorted[index - 1];
        if (prev.end !== region.start) {
          prev.setOptions({ end: region.start });
        }
      }
      if (index < sorted.length - 1) {
        const next = sorted[index + 1];
        if (next.start !== region.end) {
          next.setOptions({ start: region.end });
        }
      }
    }
    updateSplitsTable();
  });

  // Double click to split region
  const waveformEl = document.getElementById('waveform');
  waveformEl.addEventListener('dblclick', (e) => {
    if (!wavesurfer) return;
    const rect = waveformEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const progress = x / rect.width;
    const duration = wavesurfer.getDuration();
    const clickTime = progress * duration;

    splitRegionAtTime(clickTime);
  });
}

async function applySplitMethod(method) {
  if (!wavesurfer || !wsRegions || !fileMetadata) return;

  const loadingOverlay = document.getElementById('waveformLoading');
  const progressText = document.getElementById('loadingProgress');
  
  loadingOverlay.classList.remove('opacity-0', 'pointer-events-none');
  loadingOverlay.classList.add('opacity-100');
  
  if (method === 'chapters') {
    progressText.innerText = 'Extracting embedded chapters...';
  } else if (method === 'silence') {
    progressText.innerText = 'Running silence detection filter...';
  } else {
    progressText.innerText = 'Calculating fixed time splits...';
  }

  // Query split points from Main process IPC
  const res = await window.electron.ipcRenderer.invoke('get-split-points', {
    filePath: currentFilePath,
    method,
    duration: fileMetadata.duration,
    chapters: currentChapters
  });

  loadingOverlay.classList.add('opacity-0', 'pointer-events-none');

  if (!res.success) {
    showModal('Calculation Error', 'Failed to calculate split points: ' + res.error);
    return;
  }

  // Clear existing regions
  wsRegions.clearRegions();

  // Populate new regions
  const splits = res.splits;
  
  const statusText = document.getElementById('statusText');
  if (method === 'chapters') {
    statusText.innerText = `✓ ${splits.length} chapters loaded`;
  } else if (method === 'silence') {
    statusText.innerText = `✓ ${splits.length} silence segments computed`;
  } else {
    statusText.innerText = `✓ ${splits.length} time intervals generated`;
  }

  splits.forEach((split) => {
    const r = wsRegions.addRegion({
      start: split.start,
      end: split.end,
      drag: true,
      resize: true
    });
    r.data = { title: split.title };
  });

  updateSplitsTable();
}

function splitRegionAtTime(time) {
  if (!wsRegions) return;
  const sorted = wsRegions.getRegions().sort((a, b) => a.start - b.start);
  const target = sorted.find(r => time > r.start && time < r.end);

  if (target) {
    const originalEnd = target.end;
    
    // Modify current target to end at split boundary and clear its merged status
    if (target.data) {
      if (target.data.merged) {
        delete target.data.merged;
      }
    } else {
      target.data = {};
    }
    target.setOptions({ end: time });

    // Add new region spanning from split boundary to original end
    const r = wsRegions.addRegion({
      start: time,
      end: originalEnd,
      drag: true,
      resize: true
    });
    r.data = { title: `Part ${sorted.length + 1}` };

    updateSplitsTable();
  }
}

function deleteSplit(index) {
  if (!wsRegions) return;
  const sorted = wsRegions.getRegions().sort((a, b) => a.start - b.start);
  if (sorted.length <= 1) {
    showModal('Warning', 'Cannot remove the only remaining track split.');
    return;
  }

  const target = sorted[index];
  if (index < sorted.length - 1) {
    const next = sorted[index + 1];
    next.setOptions({ start: target.start });
    target.remove();
  } else {
    const prev = sorted[index - 1];
    prev.setOptions({ end: target.end });
    target.remove();
  }

  updateSplitsTable();
}

function setupPlaybackControls() {
  const playPauseBtn = document.getElementById('playPauseBtn');
  const playIcon = document.getElementById('playIcon');
  const playText = document.getElementById('playText');
  const stopBtn = document.getElementById('stopBtn');
  const zoomSlider = document.getElementById('zoomSlider');
  const zoomInBtn = document.getElementById('zoomInBtn');
  const zoomOutBtn = document.getElementById('zoomOutBtn');

  // Clone to refresh event listeners
  const newPlayPauseBtn = playPauseBtn.cloneNode(true);
  const newStopBtn = stopBtn.cloneNode(true);
  const newZoomInBtn = zoomInBtn.cloneNode(true);
  const newZoomOutBtn = zoomOutBtn.cloneNode(true);

  playPauseBtn.replaceWith(newPlayPauseBtn);
  stopBtn.replaceWith(newStopBtn);
  zoomInBtn.replaceWith(newZoomInBtn);
  zoomOutBtn.replaceWith(newZoomOutBtn);

  // Play / Pause event
  newPlayPauseBtn.addEventListener('click', () => {
    if (wavesurfer.isPlaying()) {
      wavesurfer.pause();
    } else {
      wavesurfer.play();
    }
  });

  newStopBtn.addEventListener('click', () => {
    wavesurfer.stop();
  });

  // Visual state transitions
  wavesurfer.on('play', () => {
    newPlayPauseBtn.querySelector('#playIcon').innerHTML = `
      <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25v13.5m-7.5-13.5v13.5" />
    `;
    newPlayPauseBtn.querySelector('#playText').innerText = 'Pause';
  });

  wavesurfer.on('pause', () => {
    newPlayPauseBtn.querySelector('#playIcon').innerHTML = `
      <path stroke-linecap="round" stroke-linejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
    `;
    newPlayPauseBtn.querySelector('#playText').innerText = 'Play';
  });

  // Zoom bindings
  zoomSlider.value = 10;
  wavesurfer.zoom(10);
  
  zoomSlider.addEventListener('input', (e) => {
    wavesurfer.zoom(Number(e.target.value));
  });

  newZoomInBtn.addEventListener('click', () => {
    let val = Number(zoomSlider.value) + 30;
    if (val > 250) val = 250;
    zoomSlider.value = val;
    wavesurfer.zoom(val);
  });

  newZoomOutBtn.addEventListener('click', () => {
    let val = Number(zoomSlider.value) - 30;
    if (val < 10) val = 10;
    zoomSlider.value = val;
    wavesurfer.zoom(val);
  });
}

function updateSplitsTable() {
  const tableBody = document.getElementById('splitTracksTableBody');
  if (!tableBody || !wsRegions) return;

  const sorted = wsRegions.getRegions().sort((a, b) => a.start - b.start);
  tableBody.innerHTML = '';

  sorted.forEach((region, i) => {
    const pad = String(i + 1).padStart(2, '0');
    let title = region.data?.title || `Part ${pad}`;
    // Keep Part XX titles sequential even after merges/splits
    if (/^Part \d+$/i.test(title)) {
      title = `Part ${pad}`;
      if (region.data) {
        region.data.title = title;
      }
    }
    const startStr = formatTimeMs(region.start);
    const endStr = formatTimeMs(region.end);
    const duration = formatDuration(region.end - region.start);

    const row = document.createElement('tr');
    row.className = 'border-b border-slate-800/40 bg-slate-900/10 hover:bg-indigo-500/5 transition-colors duration-150 cursor-pointer';
    row.innerHTML = `
      <td class="p-3 text-center">
        <input type="checkbox" class="split-select-cb accent-indigo-500 rounded cursor-pointer" data-index="${i}">
      </td>
      <td class="p-3 font-semibold ${region.data?.merged ? 'merged-track-highlight' : 'text-slate-200'}">${title}</td>
      <td class="p-3 font-mono">${startStr}</td>
      <td class="p-3 font-mono">${endStr}</td>
      <td class="p-3 flex items-center justify-between gap-2">
        <span>${duration}</span>
        <button class="delete-split-btn p-1.5 rounded hover:bg-red-500/10 text-slate-500 hover:text-red-400 transition-all duration-150" data-index="${i}">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </td>
    `;

    // Listen to checkbox click (prevent row selection)
    row.querySelector('.split-select-cb').addEventListener('click', (e) => {
      e.stopPropagation();
      updateMergeButtonState();
    });

    // Listen to delete click
    row.querySelector('.delete-split-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSplit(i);
    });

    // Jump to region start time on row click
    row.addEventListener('click', () => {
      wavesurfer.setTime(region.start);
      wavesurfer.play();
    });

    tableBody.appendChild(row);
  });

  updateMergeButtonState();
}

function destroyWaveSurfer() {
  if (wavesurfer) {
    try {
      wavesurfer.destroy();
    } catch (e) {
      console.error('Error destroying wavesurfer:', e);
    }
    wavesurfer = null;
    wsRegions = null;
  }
}

function transitionToScreen(screen) {
  const dropzoneScreen = document.getElementById('dropzoneScreen');
  const workspaceScreen = document.getElementById('workspaceScreen');

  if (screen === 'workspace') {
    // Hide dropzone
    dropzoneScreen.classList.add('opacity-0', 'pointer-events-none', '-translate-y-4');
    dropzoneScreen.classList.remove('z-20');
    
    // Show workspace
    workspaceScreen.classList.remove('opacity-0', 'pointer-events-none', 'translate-y-4');
    workspaceScreen.classList.add('opacity-100', 'pointer-events-auto', 'translate-y-0', 'z-20');
  } else {
    // Show dropzone
    dropzoneScreen.classList.remove('opacity-0', 'pointer-events-none', '-translate-y-4');
    dropzoneScreen.classList.add('z-20');

    // Hide workspace
    workspaceScreen.classList.add('opacity-0', 'pointer-events-none', 'translate-y-4');
    workspaceScreen.classList.remove('opacity-100', 'pointer-events-auto', 'translate-y-0', 'z-20');
    
    document.getElementById('statusText').innerText = 'Ready';
  }
}

function formatTime(seconds) {
  if (isNaN(seconds)) return '00:00:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatTimeMs(seconds) {
  if (isNaN(seconds)) return '00:00:00.000';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function formatDuration(seconds) {
  if (isNaN(seconds)) return '00s';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  let parts = [];
  if (hrs > 0) parts.push(`${hrs}h`);
  if (mins > 0) parts.push(`${mins}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  return parts.join(' ');
}

function showModal(title, text) {
  const overlay = document.getElementById('modalOverlay');
  const titleEl = document.getElementById('modalTitle');
  const contentEl = document.getElementById('modalContent');
  
  titleEl.innerText = title;
  
  if (typeof text === 'object') {
    contentEl.innerHTML = `<pre class="font-mono text-[10px] text-slate-300 leading-normal bg-slate-950/40 p-4 border border-slate-800/60 rounded-xl overflow-x-auto w-full">${JSON.stringify(text, null, 2)}</pre>`;
  } else {
    contentEl.innerHTML = `<div class="p-4 bg-slate-950/40 border border-slate-800/60 rounded-xl">${text}</div>`;
  }

  overlay.classList.remove('opacity-0', 'pointer-events-none');
  overlay.classList.add('opacity-100', 'pointer-events-auto');
}

function hideModal() {
  const overlay = document.getElementById('modalOverlay');
  overlay.classList.add('opacity-0', 'pointer-events-none');
  overlay.classList.remove('opacity-100', 'pointer-events-auto');
}

let activeSplits = [];
let isProcessing = false;
let cleanupProgress = null;

function showConfirmSplitsModal(splits) {
  activeSplits = splits;
  const overlay = document.getElementById('modalOverlay');
  const titleEl = document.getElementById('modalTitle');
  const contentEl = document.getElementById('modalContent');
  const progressContainer = document.getElementById('modalProgressContainer');
  const actionsContainer = document.getElementById('modalActions');
  const cancelBtn = document.getElementById('modalCancelBtn');
  const closeBtn = document.getElementById('modalCloseBtn');
  
  titleEl.innerText = `Ready to process audiobook with ${splits.length} tracks`;
  
  // Hide progress bar on start
  if (progressContainer) progressContainer.classList.add('hidden');
  
  // Show actions container and make sure buttons are in correct starting state
  if (actionsContainer) actionsContainer.classList.remove('hidden');
  if (cancelBtn) {
    cancelBtn.classList.remove('hidden');
    cancelBtn.innerText = 'Cancel';
    cancelBtn.className = "px-5 py-2.5 rounded-xl font-semibold text-xs border border-slate-800 hover:bg-slate-800 text-slate-300 transition-all duration-200";
  }
  
  if (closeBtn) {
    closeBtn.innerText = 'Start Splitting';
    closeBtn.className = "px-5 py-2.5 rounded-xl font-semibold text-xs bg-indigo-500 hover:bg-indigo-600 text-white transition-all duration-200";
    closeBtn.disabled = false;
  }
  
  // Generate HTML preview list of generated filenames and intervals
  const templateInput = document.getElementById('fileNameTemplate');
  const template = templateInput ? templateInput.value.trim() : '[BookName] - Part [001]';
  const formatSelect = document.getElementById('outputFormat');
  const format = formatSelect ? formatSelect.value : 'copy';
  let fileExt = '';
  if (format === 'copy') {
    const codec = fileMetadata?.codec;
    if (codec === 'aac') {
      fileExt = '.m4a';
    } else if (codec === 'mp3') {
      fileExt = '.mp3';
    } else {
      fileExt = '.' + currentFile.name.split('.').pop();
    }
  } else if (format === 'mp3') {
    fileExt = '.mp3';
  } else if (format === 'm4a') {
    fileExt = '.m4a';
  }
  const rawBookName = currentFile.name.substring(0, currentFile.name.lastIndexOf('.'));
  
  let html = '<div class="space-y-2 pr-1">';
  splits.forEach((split) => {
    const interpolatedName = interpolateTemplateString(template, rawBookName, split.part, splits.length, split.title) + fileExt;
    const durationStr = formatDuration(Number(split.duration));
    html += `
      <div class="flex items-center justify-between p-2.5 rounded-lg bg-slate-950/40 border border-slate-800/60 text-slate-300">
        <div class="min-w-0 flex-grow pr-3">
          <span class="font-semibold text-slate-200 text-xs block truncate" title="${interpolatedName}">${interpolatedName}</span>
          <div class="text-[9px] text-slate-500 font-mono mt-0.5">${formatTimeMs(Number(split.start))} &rarr; ${formatTimeMs(Number(split.end))}</div>
        </div>
        <span class="text-[10px] text-slate-400 font-medium font-mono shrink-0">${durationStr}</span>
      </div>
    `;
  });
  html += '</div>';
  
  contentEl.innerHTML = html;
  
  overlay.classList.remove('opacity-0', 'pointer-events-none');
  overlay.classList.add('opacity-100', 'pointer-events-auto');
}

async function handleModalConfirmClick() {
  const closeBtn = document.getElementById('modalCloseBtn');
  if (!closeBtn) return;
  
  if (closeBtn.innerText === 'Done') {
    hideModal();
    return;
  }
  
  if (closeBtn.innerText === 'Open Folder') {
    const outputDir = document.getElementById('outputDirDisplay').innerText.trim();
    if (window.api && window.api.openFolder) {
      await window.api.openFolder(outputDir);
    }
    return;
  }
  
  // Start splitting process
  if (isProcessing) return;
  isProcessing = true;
  
  const titleEl = document.getElementById('modalTitle');
  const contentEl = document.getElementById('modalContent');
  const progressContainer = document.getElementById('modalProgressContainer');
  const cancelBtn = document.getElementById('modalCancelBtn');
  const progressBar = document.getElementById('splitProgressBar');
  const progressText = document.getElementById('splitProgressText');
  const progressPercent = document.getElementById('splitProgressPercent');
  
  if (titleEl) titleEl.innerText = 'Splitting Audiobook...';
  if (contentEl) {
    contentEl.innerHTML = '<div class="p-6 flex flex-col items-center justify-center text-center"><div class="w-8 h-8 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin mb-4"></div><div class="text-xs text-slate-400">Processing audio slices losslessly. Please wait...</div></div>';
  }
  
  // Hide cancel button to prevent interrupting mid-process
  if (cancelBtn) cancelBtn.classList.add('hidden');
  closeBtn.disabled = true;
  closeBtn.innerText = 'Processing...';

  const formatSelect = document.getElementById('outputFormat');
  const format = formatSelect ? formatSelect.value : 'copy';
  const bitrateSelect = document.getElementById('outputBitrate');
  const bitrate = bitrateSelect ? bitrateSelect.value : '128';

  if (titleEl) {
    titleEl.innerText = format === 'copy' ? 'Splitting Audiobook...' : 'Transcoding Audiobook...';
  }
  if (contentEl) {
    contentEl.innerHTML = `<div class="p-6 flex flex-col items-center justify-center text-center"><div class="w-8 h-8 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin mb-4"></div><div class="text-xs text-slate-400">${format === 'copy' ? 'Processing audio slices losslessly' : 'Re-encoding audio slices to ' + format.toUpperCase() + ' (' + bitrate + ' kbps)'}. Please wait...</div></div>`;
  }
  
  // Show progress bar
  if (progressContainer) progressContainer.classList.remove('hidden');
  if (progressBar) progressBar.style.width = '0%';
  if (progressPercent) progressPercent.innerText = '0%';
  if (progressText) progressText.innerText = 'Initializing...';
  
  const outputDir = document.getElementById('outputDirDisplay').innerText.trim();
  const templateInput = document.getElementById('fileNameTemplate');
  const template = templateInput ? templateInput.value.trim() : '[BookName] - Part [001]';
  const rawBookName = currentFile.name.substring(0, currentFile.name.lastIndexOf('.'));
  
  // Setup progress listener
  if (window.api && window.api.onSplitProgress) {
    cleanupProgress = window.api.onSplitProgress((data) => {
      if (data.status === 'processing') {
        if (progressBar) progressBar.style.width = `${data.percent}%`;
        if (progressPercent) progressPercent.innerText = `${data.percent}%`;
        if (progressText) progressText.innerText = `Track ${data.current} of ${data.total}: ${data.title}`;
      } else if (data.status === 'complete') {
        if (progressBar) progressBar.style.width = '100%';
        if (progressPercent) progressPercent.innerText = '100%';
        if (progressText) progressText.innerText = 'Slicing completed successfully!';
      }
    });
  }
  
  try {
    const res = await window.api.splitAudio({
      filePath: currentFilePath,
      splits: activeSplits,
      outputDir,
      template,
      bookName: rawBookName,
      format,
      bitrate,
      codec: fileMetadata?.codec
    });
    
    if (cleanupProgress) {
      cleanupProgress();
      cleanupProgress = null;
    }
    
    isProcessing = false;
    
    if (res && res.success) {
      if (titleEl) titleEl.innerText = 'Export Successful!';
      if (contentEl) {
        contentEl.innerHTML = `
          <div class="p-6 flex flex-col items-center justify-center text-center">
            <div class="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mb-4 text-emerald-400">
              <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div class="text-sm font-semibold text-slate-200 mb-1">Splitting Complete</div>
            <div class="text-xs text-slate-400 max-w-sm">All ${activeSplits.length} tracks have been losslessly exported to the target directory.</div>
          </div>
        `;
      }
      
      // Update action buttons: one to open folder, one to close modal
      const actionsContainer = document.getElementById('modalActions');
      if (actionsContainer) actionsContainer.classList.remove('hidden');
      
      if (cancelBtn) {
        cancelBtn.innerText = 'Open Folder';
        cancelBtn.className = "px-5 py-2.5 rounded-xl font-semibold text-xs border border-slate-800 hover:bg-slate-800 text-indigo-400 hover:text-indigo-300 transition-all duration-200";
        cancelBtn.classList.remove('hidden');
      }
      
      closeBtn.innerText = 'Done';
      closeBtn.disabled = false;
      closeBtn.className = "px-5 py-2.5 rounded-xl font-semibold text-xs bg-indigo-500 hover:bg-indigo-600 text-white transition-all duration-200";
    } else {
      const errMsg = (res && res.error) ? res.error : 'Unknown error occurred.';
      if (titleEl) titleEl.innerText = 'Export Failed';
      if (contentEl) {
        contentEl.innerHTML = `<div class="p-4 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-xl">${errMsg}</div>`;
      }
      
      if (cancelBtn) cancelBtn.classList.add('hidden');
      closeBtn.innerText = 'Close';
      closeBtn.disabled = false;
      closeBtn.className = "px-5 py-2.5 rounded-xl font-semibold text-xs bg-red-500 hover:bg-red-600 text-white transition-all duration-200";
    }
  } catch (err) {
    if (cleanupProgress) {
      cleanupProgress();
      cleanupProgress = null;
    }
    isProcessing = false;
    
    if (titleEl) titleEl.innerText = 'Export Error';
    if (contentEl) {
      contentEl.innerHTML = `<div class="p-4 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-xl">${err.message}</div>`;
    }
    
    if (cancelBtn) cancelBtn.classList.add('hidden');
    closeBtn.innerText = 'Close';
    closeBtn.disabled = false;
    closeBtn.className = "px-5 py-2.5 rounded-xl font-semibold text-xs bg-red-500 hover:bg-red-600 text-white transition-all duration-200";
  }
}

function interpolateTemplateString(template, bookName, index, totalTracks, chapterTitle) {
  let name = template;
  name = name.replace(/\[BookName\]/gi, bookName);
  name = name.replace(/\[ChapterTitle\]/gi, chapterTitle || `Part ${index}`);
  name = name.replace(/\[(0*1)\]/g, (match, p1) => {
    const padLength = p1.length;
    return String(index).padStart(padLength, '0');
  });
  name = name.replace(/[\/\\?%*:|"<>]/g, '_');
  return name;
}

function updateMergeButtonState() {
  const mergeBtn = document.getElementById('mergeSelectedBtn');
  if (!mergeBtn) return;
  
  const cbs = document.querySelectorAll('.split-select-cb:checked');
  const count = cbs.length;
  
  mergeBtn.innerText = `Merge Selected (${count})`;
  mergeBtn.disabled = count <= 1;
}

function mergeSelectedSplits() {
  if (!wsRegions) return;
  
  const cbs = document.querySelectorAll('.split-select-cb:checked');
  if (cbs.length <= 1) return;
  
  // Get sorted indices of checked splits
  const indices = Array.from(cbs).map(cb => Number(cb.dataset.index)).sort((a, b) => a - b);
  
  // Verify if they are a single contiguous range
  const isContiguous = indices[indices.length - 1] === indices[0] + indices.length - 1;
  if (!isContiguous) {
    showModal('Invalid Selection', 'Only contiguous tracks can be merged. Please select a continuous sequence of tracks (without gaps).');
    return;
  }
  
  // Get all regions sorted by start time
  const sortedRegions = wsRegions.getRegions().sort((a, b) => a.start - b.start);
  
  // Identify the target regions to merge
  const targetRegions = indices.map(idx => sortedRegions[idx]);
  
  const minStart = targetRegions[0].start;
  const maxEnd = targetRegions[targetRegions.length - 1].end;
  
  // Retain the title of the first region in the group
  const title = targetRegions[0].data?.title || `Part ${String(indices[0] + 1).padStart(2, '0')}`;
  
  // Remove all target regions
  targetRegions.forEach(region => region.remove());
  
  // Add new merged region
  const reg = wsRegions.addRegion({
    start: minStart,
    end: maxEnd,
    drag: true,
    resize: true
  });
  reg.data = { title: title, merged: true };
  
  // Clear select-all checkbox
  const selectAll = document.getElementById('selectAllSplits');
  if (selectAll) selectAll.checked = false;
  
  // Update UI splits table
  updateSplitsTable();
}
