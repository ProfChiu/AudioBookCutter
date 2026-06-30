import { contextBridge, webUtils, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  getPathForFile: (file) => webUtils.getPathForFile(file),
  selectEpubFile: () => ipcRenderer.invoke('select-epub-file'),
  analyzeEpub: (epubPath) => ipcRenderer.invoke('analyze-epub', epubPath),
  getAutoSplitPoints: (params) => ipcRenderer.invoke('auto-split-points', params),
  checkWhisper: () => ipcRenderer.invoke('check-whisper'),
  alignChapters: (params) => ipcRenderer.invoke('align-chapters', params),
  onAlignProgress: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('align-progress', listener);
    return () => {
      ipcRenderer.removeListener('align-progress', listener);
    };
  },
  selectOutputDir: () => ipcRenderer.invoke('select-output-dir'),
  getDefaultOutputDir: () => ipcRenderer.invoke('get-default-output-dir'),
  splitAudio: (params) => ipcRenderer.invoke('split-audio', params),
  onSplitProgress: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('split-progress', listener);
    return () => {
      ipcRenderer.removeListener('split-progress', listener);
    };
  },
  openFolder: (path) => ipcRenderer.invoke('open-folder', path)
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
try {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('api', api)
} catch (error) {
  console.error('contextBridge failed, falling back to direct global assignments:', error)
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
