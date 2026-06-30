import yauzl from 'yauzl'
import { posix } from 'path'

/**
 * Reads every text-like entry (xml / html / xhtml / ncx / opf) of an EPUB zip
 * into memory. Binary assets (images, fonts) are skipped to keep things light.
 * @param {string} epubPath
 * @returns {Promise<Map<string, string>>} map of zip entry path -> utf8 contents
 */
function readEpubTextEntries(epubPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(epubPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err)

      const entries = new Map()
      const textExt = /\.(x?html?|xml|ncx|opf|xhtml)$/i

      zipfile.on('entry', (entry) => {
        // Directories end with '/', and we only want text documents.
        if (/\/$/.test(entry.fileName) || !textExt.test(entry.fileName)) {
          return zipfile.readEntry()
        }

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr) return reject(streamErr)
          const chunks = []
          readStream.on('data', (c) => chunks.push(c))
          readStream.on('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks).toString('utf8'))
            zipfile.readEntry()
          })
          readStream.on('error', reject)
        })
      })

      zipfile.on('end', () => resolve(entries))
      zipfile.on('error', reject)
      zipfile.readEntry()
    })
  })
}

/**
 * Strips HTML tags / entities and returns readable plain text.
 * @param {string} html
 * @returns {string}
 */
function extractText(html) {
  if (!html) return ''
  return decodeEntities(
    html
      .replace(/<head[\s\S]*?<\/head>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Word count of a chapter's text, used as a proxy for narration time.
 * @param {string} text
 * @returns {number}
 */
function countWords(text) {
  if (!text) return 0
  return text.split(' ').filter(Boolean).length
}

/**
 * Builds the opening "anchor" phrase for a chapter — the first N words of its
 * body text — used to locate the chapter in a Whisper transcript.
 * @param {string} text
 * @param {number} wordCount
 * @returns {string}
 */
function extractAnchor(text, wordCount = 30) {
  if (!text) return ''
  return text.split(' ').filter(Boolean).slice(0, wordCount).join(' ')
}

/**
 * Pulls the ordered navMap (title + content src) out of an NCX document using
 * tolerant regex parsing (NCX structure is simple and consistent).
 * @param {string} ncx
 * @returns {Array<{ title: string, src: string }>}
 */
function parseNcxNavPoints(ncx) {
  const points = []
  const navPointRe = /<navPoint\b[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<content\b[^>]*\bsrc="([^"]+)"/gi
  let match
  while ((match = navPointRe.exec(ncx)) !== null) {
    const title = decodeEntities(match[1]).replace(/\s+/g, ' ').trim()
    const src = match[2].split('#')[0].trim()
    if (title && src) points.push({ title, src })
  }
  return points
}

function decodeEntities(str) {
  return str
    .replace(/&#8217;|&#x2019;/gi, '’')
    .replace(/&#8216;|&#x2018;/gi, '‘')
    .replace(/&#8212;|&#x2014;/gi, '—')
    .replace(/&#8211;|&#x2013;/gi, '–')
    .replace(/&#8230;/gi, '…')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

/**
 * Returns true when a TOC title looks like a real, numbered chapter heading,
 * e.g. "1 - THE MANIONITES" or "Chapter 12". Filters out front/back matter and
 * structural dividers like "PART ONE", "PREFACE", "Notes", "Bibliography".
 * @param {string} title
 */
function isNumberedChapter(title) {
  return /^\s*(chapter\s+)?\d+\s*[-–—:.\s]/i.test(title) || /^\s*\d+\s*$/.test(title)
}

/**
 * Parses an EPUB and returns its numbered chapters with narrated-length proxies.
 * @param {string} epubPath
 * @returns {Promise<{ title: string, chapters: Array<{ index: number, title: string, words: number }> }>}
 */
export async function parseEpubChapters(epubPath) {
  const entries = await readEpubTextEntries(epubPath)

  // Locate the NCX (table of contents) document.
  let ncxName = null
  for (const name of entries.keys()) {
    if (/\.ncx$/i.test(name)) {
      ncxName = name
      break
    }
  }
  if (!ncxName) {
    throw new Error('No NCX table of contents found in EPUB. Cannot auto-detect chapters.')
  }

  const ncx = entries.get(ncxName)
  const docTitleMatch = ncx.match(/<docTitle>[\s\S]*?<text>([\s\S]*?)<\/text>/i)
  const bookTitle = docTitleMatch ? decodeEntities(docTitleMatch[1]).replace(/\s+/g, ' ').trim() : ''

  const navPoints = parseNcxNavPoints(ncx)
  if (navPoints.length === 0) {
    throw new Error('EPUB table of contents is empty or unreadable.')
  }

  const ncxDir = posix.dirname(ncxName)

  const chapters = []
  for (const point of navPoints) {
    if (!isNumberedChapter(point.title)) continue

    // Resolve the chapter's content document relative to the NCX location.
    const resolved = posix.normalize(posix.join(ncxDir, point.src))
    let html = entries.get(resolved)
    if (html === undefined) {
      // Fallback: match by basename in case of path quirks.
      const base = posix.basename(resolved)
      for (const [name, content] of entries) {
        if (posix.basename(name) === base) {
          html = content
          break
        }
      }
    }

    const text = extractText(html)
    chapters.push({
      index: chapters.length,
      title: point.title,
      words: countWords(text),
      anchor: extractAnchor(text, 30)
    })
  }

  if (chapters.length === 0) {
    throw new Error(
      'No numbered chapters were found in the EPUB table of contents. ' +
        'This book may use an unusual chapter-naming scheme.'
    )
  }

  return { title: bookTitle, chapters }
}
