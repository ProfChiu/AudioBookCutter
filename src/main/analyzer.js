import ffmpeg from 'fluent-ffmpeg';
import { execSync } from 'child_process';

// Auto-detect brew paths for ffmpeg/ffprobe on macOS if not in default PATH
try {
  execSync('which ffmpeg');
} catch (e) {
  if (process.platform === 'darwin') {
    ffmpeg.setFfmpegPath('/opt/homebrew/bin/ffmpeg');
    ffmpeg.setFfprobePath('/opt/homebrew/bin/ffprobe');
  }
}

/**
 * Probes the file to retrieve metadata (duration, size, bitrate, and chapters).
 * @param {string} filePath 
 * @returns {Promise<object>}
 */
export function getAudioMetadata(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      
      const duration = metadata.format?.duration || 0;
      const size = metadata.format?.size || 0;
      const bitrate = metadata.format?.bit_rate || 0;
      const chapters = metadata.chapters || [];
      
      const parsedChapters = chapters.map((ch, i) => ({
        id: i,
        title: ch.tags?.title || `Chapter ${i + 1}`,
        start: Number(ch.start_time) || 0,
        end: Number(ch.end_time) || duration
      }));
      
      resolve({
        duration: Number(duration),
        size: Number(size),
        bitrate: Number(bitrate),
        chapters: parsedChapters,
        codec: metadata.streams?.find(s => s.codec_type === 'audio')?.codec_name || ''
      });
    });
  });
}

/**
 * Runs silence detection filter via ffmpeg and returns start, end, and computed midpoints.
 * @param {string} filePath 
 * @param {number} minSilenceDb 
 * @param {number} minSilenceDuration 
 * @returns {Promise<Array>}
 */
export function detectSilenceGaps(filePath, minSilenceDb = -40, minSilenceDuration = 2) {
  return new Promise((resolve, reject) => {
    const silences = [];
    let currentStart = null;
    
    const command = ffmpeg(filePath)
      .audioFilters(`silencedetect=n=${minSilenceDb}dB:d=${minSilenceDuration}`)
      .format('null')
      .output('-');
      
    command.on('stderr', (line) => {
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
            midpoint: (currentStart + end) / 2
          });
          currentStart = null;
        }
      }
    });
    
    command.on('end', () => {
      resolve(silences);
    });
    
    command.on('error', (err) => {
      reject(err);
    });
    
    command.run();
  });
}

/**
 * Maps EPUB chapters onto the audio timeline. Each chapter's start time is
 * estimated from its share of the total narrated text (word count as a proxy
 * for narration time), then optionally snapped to the nearest detected silence
 * so cuts land between sentences instead of mid-word.
 *
 * The first chapter is pinned to 0 and the last extends to the full duration so
 * any un-tracked front/back matter audio is absorbed into the adjacent chapter
 * and the whole file is tiled without gaps.
 *
 * @param {Array<{title: string, words: number}>} chapters
 * @param {number} duration - total audio duration in seconds
 * @param {Array} [silences] - silence gaps from detectSilenceGaps (with midpoints)
 * @param {number} [snapWindow] - max seconds a boundary may move to reach silence
 * @returns {Array<{id:number,title:string,start:number,end:number}>}
 */
export function computeChapterSplits(chapters, duration, silences = [], snapWindow = 90) {
  if (!chapters || chapters.length === 0) return [];

  const totalWords = chapters.reduce((sum, ch) => sum + (ch.words || 0), 0);

  // Proportional start time for each chapter based on cumulative word share.
  const starts = [];
  let cumulative = 0;
  for (let i = 0; i < chapters.length; i++) {
    if (i === 0) {
      starts.push(0);
    } else if (totalWords > 0) {
      starts.push((cumulative / totalWords) * duration);
    } else {
      // Fallback to even spacing if word counts are unavailable.
      starts.push((i / chapters.length) * duration);
    }
    cumulative += chapters[i].words || 0;
  }

  // Snap interior boundaries to the nearest silence midpoint within the window,
  // keeping boundaries strictly increasing so neighbours never cross.
  const sortedSilences = [...silences].sort((a, b) => a.midpoint - b.midpoint);
  for (let i = 1; i < starts.length; i++) {
    if (sortedSilences.length === 0) break;

    const target = starts[i];
    let best = null;
    let bestDist = Infinity;
    for (const s of sortedSilences) {
      const dist = Math.abs(s.midpoint - target);
      if (dist < bestDist) {
        bestDist = dist;
        best = s.midpoint;
      }
    }

    if (best !== null && bestDist <= snapWindow) {
      const lowerBound = starts[i - 1] + 0.5;
      const upperBound = i < starts.length - 1 ? starts[i + 1] : duration;
      if (best > lowerBound && best < upperBound) {
        starts[i] = best;
      }
    }
  }

  // Build contiguous, tiled segments.
  const splits = [];
  for (let i = 0; i < chapters.length; i++) {
    const start = starts[i];
    const end = i < chapters.length - 1 ? starts[i + 1] : duration;
    splits.push({
      id: i,
      title: chapters[i].title,
      start: Number(start),
      end: Number(end)
    });
  }

  return splits;
}

/**
 * Formulates contiguous track partitions based on the selected method.
 * @param {string} filePath 
 * @param {string} method - 'chapters' | 'silence' | 'time'
 * @param {number} duration - total audio duration in seconds
 * @param {Array} chapters - pre-parsed chapters array
 * @returns {Promise<Array>}
 */
export async function getSplitPoints(filePath, method, duration, chapters = []) {
  if (method === 'chapters' && chapters.length > 0) {
    return chapters;
  }
  
  if (method === 'silence') {
    try {
      const silences = await detectSilenceGaps(filePath);
      if (silences.length > 0) {
        const splits = [];
        let lastTime = 0;
        
        silences.forEach((silence, i) => {
          splits.push({
            id: i,
            title: `Part ${String(i + 1).padStart(2, '0')}`,
            start: lastTime,
            end: silence.midpoint
          });
          lastTime = silence.midpoint;
        });
        
        // Add final segment extending to total duration
        splits.push({
          id: silences.length,
          title: `Part ${String(silences.length + 1).padStart(2, '0')}`,
          start: lastTime,
          end: duration
        });
        
        return splits;
      }
    } catch (e) {
      console.error('Silence detection failed, falling back to time splits:', e);
    }
  }
  
  // Time-based splits (fixed 15 minutes = 900 seconds)
  const interval = 900; // 15 mins
  const splits = [];
  let index = 0;
  
  for (let start = 0; start < duration; start += interval) {
    const end = Math.min(start + interval, duration);
    splits.push({
      id: index,
      title: `Part ${String(index + 1).padStart(2, '0')}`,
      start: start,
      end: end
    });
    index++;
  }
  
  return splits;
}
