import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { extractWavWindow, transcribeWav } from './whisper.js'

/**
 * Normalizes text into a list of comparable lowercase word tokens (punctuation
 * and case removed) so Whisper's imperfect transcript can be matched against
 * EPUB text.
 * @param {string} text
 * @returns {string[]}
 */
export function normalizeTokens(text) {
  if (!text) return []
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
}

/**
 * Flattens whisper segments into a token stream where each token carries an
 * absolute timestamp (seconds), linearly interpolated within its segment.
 * @param {Array<{from:number,to:number,text:string}>} segments - offsets in ms
 * @param {number} windowStartSec - absolute time the window began
 * @returns {Array<{w:string, t:number}>}
 */
export function tokenizeSegments(segments, windowStartSec) {
  const tokens = []
  for (const seg of segments) {
    const words = normalizeTokens(seg.text)
    if (words.length === 0) continue
    const fromSec = windowStartSec + seg.from / 1000
    const toSec = windowStartSec + seg.to / 1000
    const span = Math.max(0, toSec - fromSec)
    for (let i = 0; i < words.length; i++) {
      const frac = words.length > 1 ? i / words.length : 0
      tokens.push({ w: words[i], t: fromSec + frac * span })
    }
  }
  return tokens
}

/**
 * Finds where an anchor phrase best aligns within a transcript token stream.
 *
 * Scoring is anchor-token *recall* inside a sliding window (how many distinct
 * anchor words appear), which tolerates the word drops / substitutions typical
 * of ASR. The returned time is that of the earliest anchor word inside the best
 * window — i.e. where the chapter's opening words are actually spoken.
 *
 * @param {Array<{w:string,t:number}>} tokens
 * @param {string[]} anchorTokens
 * @returns {{ time: number|null, score: number }}
 */
export function locateAnchor(tokens, anchorTokens) {
  if (tokens.length === 0 || anchorTokens.length === 0) return { time: null, score: 0 }

  const anchorSet = new Set(anchorTokens)
  const uniqueAnchor = anchorSet.size
  const L = anchorTokens.length

  let bestScore = 0
  let bestStart = -1
  const lastStart = Math.max(0, tokens.length - L)

  for (let i = 0; i <= lastStart; i++) {
    const seen = new Set()
    for (let j = 0; j < L && i + j < tokens.length; j++) {
      const w = tokens[i + j].w
      if (anchorSet.has(w)) seen.add(w)
    }
    const score = seen.size / uniqueAnchor
    if (score > bestScore) {
      bestScore = score
      bestStart = i
      if (score === 1) break
    }
  }

  if (bestStart === -1) return { time: null, score: 0 }

  // Time of the earliest anchor word within the winning window.
  let time = tokens[bestStart].t
  for (let j = 0; j < L && bestStart + j < tokens.length; j++) {
    if (anchorSet.has(tokens[bestStart + j].w)) {
      time = tokens[bestStart + j].t
      break
    }
  }

  return { time, score: bestScore }
}

/**
 * Snaps a time to the nearest silence midpoint within `window` seconds, but
 * only if it stays strictly between the given lower/upper bounds.
 */
function snapToSilence(time, silences, window, lower, upper) {
  let best = time
  let bestDist = Infinity
  for (const s of silences) {
    const dist = Math.abs(s.midpoint - time)
    if (dist < bestDist) {
      bestDist = dist
      best = s.midpoint
    }
  }
  if (bestDist <= window && best > lower && best < upper) return best
  return time
}

/**
 * Transcribes the whole audio file in sequential chunks, returning one absolute
 * -time token stream. Chunking bounds memory/temp size and lets us report
 * progress; whisper.cpp transcription runs many times faster than realtime.
 * @param {object} opts - { ffmpeg, binPath, modelPath, filePath, duration, chunkSec, tmpDir, onProgress }
 * @returns {Promise<Array<{w:string,t:number}>>}
 */
async function transcribeFull({ ffmpeg, binPath, modelPath, filePath, duration, chunkSec, tmpDir, onProgress }) {
  const tokens = []
  const numChunks = Math.max(1, Math.ceil(duration / chunkSec))
  for (let c = 0; c < numChunks; c++) {
    const start = c * chunkSec
    const dur = Math.min(chunkSec, duration - start)
    if (dur <= 0) break

    if (onProgress) {
      onProgress({ phase: 'transcribing', chunk: c + 1, chunks: numChunks, percent: Math.round((c / numChunks) * 100) })
    }

    const wav = join(tmpDir, `chunk_${c}.wav`)
    try {
      await extractWavWindow(ffmpeg, filePath, start, dur, wav)
      const segments = await transcribeWav(binPath, modelPath, wav)
      for (const tok of tokenizeSegments(segments, start)) tokens.push(tok)
    } catch (e) {
      console.error(`Transcription chunk ${c + 1}/${numChunks} failed:`, e.message)
    } finally {
      fs.rm(wav, { force: true }, () => {})
    }
  }

  if (onProgress) {
    onProgress({ phase: 'transcribing', chunk: numChunks, chunks: numChunks, percent: 100 })
  }
  return tokens
}

/**
 * Repositions chapters Whisper could not locate by interpolating between the
 * nearest located anchors using each chapter's share of the words in between.
 * The book start (index 0 → time 0) and end (→ duration) act as outer anchors,
 * so unmatched chapters track local narration pace rather than a stale global
 * estimate.
 * @param {Array<{start:number}>} splits
 * @param {Set<number>} matchedIdx - indices with a confident Whisper match
 * @param {number[]} cumWords - cumulative words before each chapter
 * @param {number} totalWords
 * @param {number} duration
 */
export function interpolateUnmatched(splits, matchedIdx, cumWords, totalWords, duration) {
  const n = splits.length

  // Known (index, time, words) anchors in ascending index order.
  const anchors = [{ idx: 0, time: 0, words: 0 }]
  for (let i = 1; i < n; i++) {
    if (matchedIdx.has(i)) anchors.push({ idx: i, time: splits[i].start, words: cumWords[i] })
  }
  anchors.push({ idx: n, time: duration, words: totalWords })

  for (let i = 1; i < n; i++) {
    if (matchedIdx.has(i)) continue

    let lo = anchors[0]
    let hi = anchors[anchors.length - 1]
    for (const a of anchors) {
      if (a.idx <= i && a.idx >= lo.idx) lo = a
      if (a.idx > i) {
        hi = a
        break
      }
    }

    const wSpan = hi.words - lo.words
    const frac = wSpan > 0 ? (cumWords[i] - lo.words) / wSpan : (i - lo.idx) / (hi.idx - lo.idx)
    splits[i].start = lo.time + frac * (hi.time - lo.time)
  }
}

/**
 * Enforces strictly increasing chapter starts and rebuilds contiguous end
 * times, so fallback (un-matched) boundaries can never cross matched ones.
 * @param {Array<{start:number,end:number}>} splits
 * @param {number} duration
 */
export function enforceMonotonic(splits, duration) {
  for (let i = 1; i < splits.length; i++) {
    if (splits[i].start <= splits[i - 1].start) {
      const next = i < splits.length - 1 ? splits[i + 1].start : duration
      splits[i].start = Math.min((splits[i - 1].start + next) / 2, duration)
    }
  }
  for (let i = 0; i < splits.length; i++) {
    splits[i].end = i < splits.length - 1 ? splits[i + 1].start : duration
  }
}

/**
 * Refines proportional chapter boundaries using Whisper forced alignment.
 *
 * Transcribes the whole book once into a timestamped token stream, then locates
 * each chapter's opening anchor text within it (forward-only, so chapters stay
 * in order) and moves the boundary to where the chapter is actually spoken —
 * then snaps to nearby silence. Boundaries that can't be confidently located
 * keep their proportional estimate, so the result is never worse than the input.
 *
 * This is pace-independent and robust to large drift between the text-length
 * estimate and the real narration (front matter, variable reading speed).
 *
 * @param {object} opts
 * @param {object} opts.ffmpeg - configured fluent-ffmpeg module
 * @param {string} opts.binPath - whisper.cpp binary
 * @param {string} opts.modelPath
 * @param {string} opts.filePath - source audio
 * @param {Array<{id:number,title:string,start:number,end:number}>} opts.splits
 * @param {Array<{index:number,anchor:string}>} opts.chapters - aligned by index
 * @param {number} opts.duration
 * @param {Array} [opts.silences]
 * @param {number} [opts.chunkSec] - transcription chunk length (seconds)
 * @param {number} [opts.minScore] - confidence threshold (0..1)
 * @param {(p:object)=>void} [opts.onProgress]
 * @returns {Promise<{splits:Array, aligned:number, total:number}>}
 */
export async function alignChapters(opts) {
  const {
    ffmpeg,
    binPath,
    modelPath,
    filePath,
    splits,
    chapters,
    duration,
    silences = [],
    chunkSec = 1800,
    minScore = 0.4,
    onProgress
  } = opts

  const refined = splits.map((s) => ({ ...s }))
  const tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'abc-align-'))
  let aligned = 0
  const interiorCount = Math.max(0, refined.length - 1)

  try {
    // 1) Transcribe the whole book into an absolute-time token stream.
    const tokens = await transcribeFull({
      ffmpeg,
      binPath,
      modelPath,
      filePath,
      duration,
      chunkSec,
      tmpDir,
      onProgress
    })

    // Cumulative chapter words before each chapter starts — used to interpolate
    // any chapters Whisper couldn't locate, between the chapters it could.
    const cumWords = []
    let acc = 0
    for (let i = 0; i < chapters.length; i++) {
      cumWords[i] = acc
      acc += chapters[i]?.words || 0
    }
    const totalWords = acc

    // 2) Locate each chapter's anchor, forward-only so chapters stay ordered.
    const matchedIdx = new Set()
    let lastMatched = 0
    let searchIdx = 0
    for (let i = 1; i < refined.length; i++) {
      const anchor = chapters[i]?.anchor
      const title = refined[i].title

      if (onProgress) {
        onProgress({ phase: 'matching', current: i, total: interiorCount, title })
      }
      if (!anchor) continue

      const slice = tokens.slice(searchIdx)
      const result = locateAnchor(slice, normalizeTokens(anchor))
      const lower = lastMatched + 1

      if (result.time !== null && result.score >= minScore && result.time > lower) {
        const snapped = snapToSilence(result.time, silences, 8, lower, duration)
        refined[i].start = snapped
        matchedIdx.add(i)
        lastMatched = snapped
        while (searchIdx < tokens.length && tokens[searchIdx].t < result.time) searchIdx++
        aligned++
        if (onProgress) {
          onProgress({ phase: 'matched', current: i, total: interiorCount, title, matched: true })
        }
      } else if (onProgress) {
        onProgress({ phase: 'fallback', current: i, total: interiorCount, title, matched: false })
      }
    }

    // 3) Place unmatched boundaries by interpolating between the nearest matched
    // anchors (by word share), so a missed chapter sits correctly relative to
    // its located neighbours instead of keeping a stale global estimate.
    interpolateUnmatched(refined, matchedIdx, cumWords, totalWords, duration)
    enforceMonotonic(refined, duration)
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }, () => {})
  }

  return { splits: refined, aligned, total: interiorCount }
}
