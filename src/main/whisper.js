import { execFile, execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import https from 'https'
import { join } from 'path'

// Candidate names the whisper.cpp CLI ships under across versions / installs.
const BIN_CANDIDATES = ['whisper-cli', 'whisper-cpp', 'whisper', 'main']
const SEARCH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']

// Default model. base.en is English-only, accurate enough to *locate* known
// chapter-opening text, and small/fast on short audio windows.
const DEFAULT_MODEL = 'ggml-base.en.bin'
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${DEFAULT_MODEL}`

/**
 * Locates the whisper.cpp binary, honoring the WHISPER_CPP_PATH override first,
 * then PATH, then common Homebrew/usr locations.
 * @returns {string|null} absolute path or bare command name, or null if missing
 */
export function findWhisperBinary() {
  if (process.env.WHISPER_CPP_PATH && fs.existsSync(process.env.WHISPER_CPP_PATH)) {
    return process.env.WHISPER_CPP_PATH
  }
  for (const name of BIN_CANDIDATES) {
    try {
      const resolved = execFileSync('which', [name], { encoding: 'utf8' }).trim()
      if (resolved) return resolved
    } catch {
      // not on PATH; keep looking
    }
  }
  for (const dir of SEARCH_DIRS) {
    for (const name of BIN_CANDIDATES) {
      const p = join(dir, name)
      if (fs.existsSync(p)) return p
    }
  }
  return null
}

/**
 * Resolves the local model file path inside the given data directory.
 * @param {string} dataDir
 */
export function getModelPath(dataDir) {
  return join(dataDir, 'models', DEFAULT_MODEL)
}

/**
 * Reports whether precise alignment is usable: binary found, and whether the
 * model is already downloaded.
 * @param {string} dataDir
 */
export function checkWhisper(dataDir) {
  const bin = findWhisperBinary()
  const modelPath = getModelPath(dataDir)
  return {
    available: !!bin,
    bin,
    modelPath,
    modelPresent: fs.existsSync(modelPath)
  }
}

/**
 * Downloads the default model into dataDir if it isn't already present,
 * following HTTP redirects (Hugging Face resolve URLs redirect to a CDN).
 * @param {string} dataDir
 * @param {(received:number, total:number)=>void} [onProgress]
 * @returns {Promise<string>} resolved model path
 */
export function ensureModel(dataDir, onProgress) {
  const modelPath = getModelPath(dataDir)
  if (fs.existsSync(modelPath)) return Promise.resolve(modelPath)

  fs.mkdirSync(join(dataDir, 'models'), { recursive: true })

  return new Promise((resolve, reject) => {
    const tmp = modelPath + '.download'

    const get = (url, redirectsLeft = 5) => {
      https
        .get(url, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirectsLeft === 0) return reject(new Error('Too many redirects downloading model.'))
            res.resume()
            return get(res.headers.location, redirectsLeft - 1)
          }
          if (res.statusCode !== 200) {
            res.resume()
            return reject(new Error(`Model download failed (HTTP ${res.statusCode}).`))
          }

          const total = Number(res.headers['content-length']) || 0
          let received = 0
          const out = fs.createWriteStream(tmp)
          res.on('data', (chunk) => {
            received += chunk.length
            if (onProgress) onProgress(received, total)
          })
          res.pipe(out)
          out.on('finish', () => {
            out.close(() => {
              fs.renameSync(tmp, modelPath)
              resolve(modelPath)
            })
          })
          out.on('error', (err) => {
            fs.rm(tmp, { force: true }, () => reject(err))
          })
        })
        .on('error', (err) => {
          fs.rm(tmp, { force: true }, () => reject(err))
        })
    }

    get(MODEL_URL)
  })
}

/**
 * Extracts a window of audio as 16 kHz mono PCM WAV (what whisper.cpp expects)
 * using the ffmpeg binary fluent-ffmpeg is configured to use.
 * @param {object} ffmpeg - the configured fluent-ffmpeg module
 * @param {string} inputPath
 * @param {number} startSec
 * @param {number} durSec
 * @param {string} outWav
 * @returns {Promise<void>}
 */
export function extractWavWindow(ffmpeg, inputPath, startSec, durSec, outWav) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .seekInput(Math.max(0, startSec))
      .duration(durSec)
      .noVideo()
      .outputOptions('-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le')
      .output(outWav)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()
  })
}

/**
 * Runs whisper.cpp on a WAV file and returns its JSON segments, each with
 * millisecond offsets and text.
 * @param {string} binPath
 * @param {string} modelPath
 * @param {string} wavPath
 * @returns {Promise<Array<{from:number,to:number,text:string}>>}
 */
export function transcribeWav(binPath, modelPath, wavPath) {
  return new Promise((resolve, reject) => {
    const outBase = wavPath.replace(/\.wav$/i, '')
    const jsonPath = outBase + '.json'
    const threads = Math.max(2, Math.min(os.cpus().length, 8))

    const args = [
      '-m', modelPath,
      '-f', wavPath,
      '-l', 'en',
      '-t', String(threads),
      '-nt', // no inline timestamps in text; we read offsets from JSON
      '-oj', // output JSON
      '-of', outBase
    ]

    execFile(binPath, args, { maxBuffer: 1024 * 1024 * 64 }, (err) => {
      if (err) return reject(new Error(`whisper.cpp failed: ${err.message}`))
      fs.readFile(jsonPath, 'utf8', (readErr, data) => {
        if (readErr) return reject(new Error(`Could not read whisper output: ${readErr.message}`))
        try {
          const parsed = JSON.parse(data)
          const segments = (parsed.transcription || []).map((seg) => ({
            from: seg.offsets?.from ?? 0, // ms
            to: seg.offsets?.to ?? 0, // ms
            text: (seg.text || '').trim()
          }))
          resolve(segments)
        } catch (parseErr) {
          reject(new Error(`Invalid whisper JSON output: ${parseErr.message}`))
        } finally {
          fs.rm(jsonPath, { force: true }, () => {})
        }
      })
    })
  })
}
