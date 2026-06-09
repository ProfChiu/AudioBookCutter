import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, basename, extname } from 'path'
import fs from 'fs'
import ffmpeg from 'fluent-ffmpeg'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { getAudioMetadata, getSplitPoints } from './analyzer.js'

function createWindow() {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  // Metadata Ingestion IPC Handler
  ipcMain.handle('analyze-file', async (event, filePath) => {
    try {
      const metadata = await getAudioMetadata(filePath)
      return { success: true, metadata }
    } catch (err) {
      console.error('IPC analyze-file error:', err)
      return { success: false, error: err.message }
    }
  })

  // Get Split Points based on method IPC Handler
  ipcMain.handle('get-split-points', async (event, { filePath, method, duration, chapters }) => {
    try {
      const splits = await getSplitPoints(filePath, method, duration, chapters)
      return { success: true, splits }
    } catch (err) {
      console.error('IPC get-split-points error:', err)
      return { success: false, error: err.message }
    }
  })

  // Select Output Directory IPC Handler
  ipcMain.handle('select-output-dir', async (event) => {
    try {
      const window = BrowserWindow.fromWebContents(event.sender)
      const result = await dialog.showOpenDialog(window, {
        title: 'Select Output Directory',
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled) {
        return null
      }
      return result.filePaths[0]
    } catch (err) {
      console.error('IPC select-output-dir error:', err)
      return null
    }
  })

  // Get Default Output Directory IPC Handler
  ipcMain.handle('get-default-output-dir', async () => {
    try {
      const desktopPath = app.getPath('desktop')
      return join(desktopPath, 'Split_Audiobooks')
    } catch (err) {
      console.error('IPC get-default-output-dir error:', err)
      return ''
    }
  })

  // Open Folder IPC Handler
  ipcMain.handle('open-folder', async (event, folderPath) => {
    try {
      await shell.openPath(folderPath)
      return { success: true }
    } catch (err) {
      console.error('IPC open-folder error:', err)
      return { success: false, error: err.message }
    }
  })

  // Sequential Split Audio IPC Handler
  ipcMain.handle('split-audio', async (event, { filePath, splits, outputDir, template, bookName, format = 'copy', bitrate = '128', codec }) => {
    try {
      const window = BrowserWindow.fromWebContents(event.sender)
      
      // Ensure output directory exists
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true })
      }

      const sourceExt = extname(filePath)
      const rawBookName = bookName || basename(filePath, sourceExt)
      const totalTracks = splits.length

      let targetExt = sourceExt
      if (format === 'mp3') {
        targetExt = '.mp3'
      } else if (format === 'm4a') {
        targetExt = '.m4a'
      } else if (format === 'copy') {
        if (codec === 'aac') {
          targetExt = '.m4a'
        } else if (codec === 'mp3') {
          targetExt = '.mp3'
        }
      }

      for (let i = 0; i < totalTracks; i++) {
        const split = splits[i]
        const trackNumber = i + 1
        const start = Number(split.start)
        const end = Number(split.end)
        const duration = end - start
        
        const chapterTitle = split.title || `Part ${trackNumber}`
        
        // Interpolate filename template
        const targetFileName = interpolateTemplate(template, rawBookName, trackNumber, totalTracks, chapterTitle) + targetExt
        const outputPath = join(outputDir, targetFileName)
        
        // Notify renderer of current track processing status
        window.webContents.send('split-progress', {
          status: 'processing',
          current: trackNumber,
          total: totalTracks,
          title: chapterTitle,
          percent: Math.round((i / totalTracks) * 100)
        })

        // Run FFmpeg slice command sequentially
        await new Promise((resolve) => {
          const cmd = ffmpeg(filePath)
            .seekInput(start)
            .duration(duration)
            .noVideo() // Strip video track (attached cover picture) to avoid container errors

          if (format === 'copy') {
            cmd.outputOptions('-c:a', 'copy')
          } else if (format === 'mp3') {
            cmd.outputOptions('-c:a', 'libmp3lame')
               .outputOptions('-b:a', `${bitrate}k`)
          } else if (format === 'm4a') {
            cmd.outputOptions('-c:a', 'aac')
               .outputOptions('-b:a', `${bitrate}k`)
          }

          cmd.outputOptions('-map_metadata', '0') // Copy global metadata tags
             .outputOptions('-metadata', `title=${chapterTitle}`)
             .outputOptions('-metadata', `track=${trackNumber}/${totalTracks}`)
             .outputOptions('-metadata', `album=${rawBookName}`)
             .output(outputPath);

          cmd.on('end', () => resolve())
             .on('error', (err) => {
               console.error(`Error splitting track ${trackNumber}:`, err)
               // Resolve anyway to continue processing the rest of the splits sequentially (robustness)
               resolve()
             })
             .run()
        })
      }

      // Notify completion
      window.webContents.send('split-progress', {
        status: 'complete',
        current: totalTracks,
        total: totalTracks,
        percent: 100
      })

      return { success: true }
    } catch (err) {
      console.error('IPC split-audio error:', err)
      return { success: false, error: err.message }
    }
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

function interpolateTemplate(template, bookName, index, totalTracks, chapterTitle) {
  let name = template;
  name = name.replace(/\[BookName\]/gi, bookName);
  name = name.replace(/\[ChapterTitle\]/gi, chapterTitle || `Part ${index}`);
  name = name.replace(/\[(0*1)\]/g, (match, p1) => {
    const padLength = p1.length;
    return String(index).padStart(padLength, '0');
  });
  // Sanitize filename (remove characters that are invalid in file names)
  name = name.replace(/[\/\\?%*:|"<>]/g, '_');
  return name;
}
