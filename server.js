const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const youtubedl = require('youtube-dl-exec');
const { GoogleGenAI, Type } = require('@google/genai');

// Lightweight .env loader (does not overwrite existing environment variables)
(() => {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && !(key in process.env)) {
        process.env[key] = val;
      }
    }
  } catch {
    // Ignore malformed .env
  }
})();

let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
} catch {
  ffmpegPath = null;
}

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const LIBRARY_DIR = path.join(__dirname, 'library');
const LIBRARY_INDEX_PATH = path.join(LIBRARY_DIR, 'index.json');
const MODELS_CACHE_DIR = path.join(__dirname, 'models-cache');
const STEM_PYTHON_PATH = path.join(__dirname, '.venv-stems', 'bin', 'python');
const STEM_WORKER_SCRIPT = path.join(__dirname, 'stem_worker.py');
const DEFAULT_STEM_MODEL = 'model_bs_roformer_ep_317_sdr_12.9755.ckpt';
const KARAOKE_STEM_MODEL = 'mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt';
const DEMUCS_STEM_MODEL = 'htdemucs.yaml';
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
fs.mkdirSync(LIBRARY_DIR, { recursive: true });
fs.mkdirSync(MODELS_CACHE_DIR, { recursive: true });

app.use(cors({
  origin: true,
  exposedHeaders: ['X-Track-Title', 'Content-Disposition', 'X-Library-Id', 'X-From-Cache', 'X-Source-Url']
}));
app.use(express.json({ limit: '25mb' }));
app.use(express.static(PUBLIC_DIR));

const ALLOWED_YT_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be'
]);

/**
 * Validate that the provided string is a legitimate YouTube HTTP(S) URL
 * and safe to pass to yt-dlp.
 */
function validateYouTubeUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return { valid: false, error: 'URL must be a string.' };
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { valid: false, error: 'Please provide a YouTube URL.' };
  }

  if (trimmed.startsWith('-')) {
    return { valid: false, error: 'Invalid URL format.' };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Invalid URL syntax.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: 'Only http and https URLs are supported.' };
  }

  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_YT_HOSTS.has(host)) {
    return { valid: false, error: 'URL must be a valid youtube.com or youtu.be link.' };
  }

  if (host.includes('youtu.be')) {
    const id = parsed.pathname.replace(/^\/+/, '').split('/')[0];
    if (!id) {
      return { valid: false, error: 'Missing video ID in youtu.be URL.' };
    }
  } else {
    const isWatch = parsed.pathname === '/watch' && Boolean(parsed.searchParams.get('v'));
    const isShorts = /^\/shorts\/[^/]+/.test(parsed.pathname);
    const isEmbed = /^\/embed\/[^/]+/.test(parsed.pathname);
    const isLive = /^\/live\/[^/]+/.test(parsed.pathname);
    if (!isWatch && !isShorts && !isEmbed && !isLive) {
      return { valid: false, error: 'Unsupported YouTube URL path. Use a video, shorts, or youtu.be link.' };
    }
  }

  return { valid: true, url: parsed.toString() };
}

function removeFileQuietly(filePath) {
  if (!filePath) return;
  fs.promises.unlink(filePath).catch(() => {});
}

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.webm']);
const MIME_BY_EXT = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm'
};

function extractYouTubeVideoId(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    if (host.includes('youtu.be')) {
      return parsed.pathname.replace(/^\/+/, '').split('/')[0] || null;
    }
    if (parsed.searchParams.get('v')) {
      return parsed.searchParams.get('v');
    }
    const match = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function sanitizeSlug(str, fallback = 'audio') {
  return String(str || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 72) || fallback;
}

function resolveLibraryFilePath(entry) {
  const rel = entry && (entry.relPath || entry.filename);
  if (!rel || typeof rel !== 'string') return null;
  const baseDir = entry.folder === 'downloads' ? DOWNLOADS_DIR : LIBRARY_DIR;
  const cleanRel = rel.replace(/^[/\\]+/, '');
  const resolved = path.resolve(baseDir, cleanRel);
  if (!resolved.startsWith(baseDir + path.sep)) return null;
  return resolved;
}

function inferStemType(name) {
  const raw = String(name || '');
  const low = raw.toLowerCase();
  if (low.includes('__lead_vocal')) return 'lead';
  if (low.includes('__chorus')) return 'chorus';
  if (low.includes('__drums')) return 'drums';
  if (low.includes('__bass')) return 'bass';
  if (low.includes('__melody') || low.includes('__other')) return 'other';
  if (low.includes('__vocals')) return 'voice';
  if (low.includes('__instruments')) return 'music';
  if (low.includes('__mix')) return 'mix';

  const upper = raw.toUpperCase();
  if (upper.includes('[LEAD VOCAL]') || upper.includes('[LEAD]')) return 'lead';
  if (upper.includes('[CHORUS]') || upper.includes('[BACKING')) return 'chorus';
  if (upper.includes('[DRUMS]')) return 'drums';
  if (upper.includes('[BASS]')) return 'bass';
  if (upper.includes('[MELODY]') || upper.includes('[OTHER]')) return 'other';
  if (upper.includes('[AI BEAT]') || upper.includes('[STYLE BEAT]')) return 'beat';
  if (upper.includes('[VOICE ONLY]') || upper.includes('[VOCALS]') || upper.includes('[VOCAL')) return 'voice';
  if (upper.includes('[MUSIC ONLY]') || upper.includes('[INSTRUMENTS]')) return 'music';
  if (upper.includes('[MIXDOWN]') || upper.includes('[MIX]')) return 'mix';
  if (upper.includes('[CROPPED')) return 'crop';
  if (upper.includes('[TRIMMED]')) return 'trimmed';
  return 'local';
}

function readLibraryIndex() {
  try {
    if (!fs.existsSync(LIBRARY_INDEX_PATH)) return [];
    const raw = fs.readFileSync(LIBRARY_INDEX_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLibraryIndex(items) {
  try {
    fs.writeFileSync(LIBRARY_INDEX_PATH, JSON.stringify(items, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write library index:', err);
  }
}

async function listAudioFilesRel(rootDir, { recursive = true } = {}) {
  const out = [];
  const walk = async (curDir, relPrefix) => {
    let entries = [];
    try {
      entries = await fs.promises.readdir(curDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const rel = relPrefix ? path.posix.join(relPrefix, ent.name) : ent.name;
      if (ent.isDirectory()) {
        if (recursive && !ent.name.startsWith('sepjob-') && !ent.name.startsWith('stylejob-')) {
          await walk(path.join(curDir, ent.name), rel);
        }
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (!AUDIO_EXTS.has(ext)) continue;
      out.push({ rel, filename: ent.name, ext, fullPath: path.join(curDir, ent.name) });
    }
  };
  await walk(rootDir, '');
  return out;
}

async function syncAndListLibrary() {
  const existing = readLibraryIndex();
  const kept = [];
  const trackedKeys = new Set();
  let dirty = false;

  for (const entry of existing) {
    const filePath = resolveLibraryFilePath(entry);
    if (!filePath || !fs.existsSync(filePath)) {
      dirty = true;
      continue;
    }
    const folder = entry.folder === 'downloads' ? 'downloads' : 'library';
    const baseRoot = folder === 'downloads' ? DOWNLOADS_DIR : LIBRARY_DIR;
    const rel = path.relative(baseRoot, filePath).split(path.sep).join('/');
    if (!entry.relPath) entry.relPath = rel;
    trackedKeys.add(`${folder}:${rel}`);
    kept.push(entry);
  }

  for (const [folder, dirPath, recursive] of [['library', LIBRARY_DIR, true], ['downloads', DOWNLOADS_DIR, false]]) {
    const files = await listAudioFilesRel(dirPath, { recursive });
    for (const f of files) {
      const key = `${folder}:${f.rel}`;
      if (trackedKeys.has(key)) continue;

      let stat;
      try {
        stat = await fs.promises.stat(f.fullPath);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size === 0) continue;

      const rawBase = path.basename(f.filename, f.ext);
      kept.push({
        id: `lib-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 12)}`,
        title: rawBase.replace(/__/g, ' ').replace(/_/g, ' ').trim() || f.filename,
        stemType: inferStemType(rawBase),
        sourceUrl: '',
        videoId: null,
        folder,
        relPath: f.rel,
        filename: f.filename,
        ext: f.ext,
        sizeBytes: stat.size,
        durationSec: null,
        createdAt: new Date(stat.mtimeMs || Date.now()).toISOString()
      });
      trackedKeys.add(key);
      dirty = true;
    }
  }

  if (dirty) {
    writeLibraryIndex(kept);
  }

  return kept.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function streamAudioFile(req, res, filePath, { title, libraryId, fromCache, sourceUrl, downloadFilename }) {
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'application/octet-stream';

  res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');
  if (downloadFilename) {
    const disp = req?.query?.download === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${disp}; filename="${downloadFilename}"`);
  }
  if (title) res.setHeader('X-Track-Title', encodeURIComponent(title));
  if (libraryId) res.setHeader('X-Library-Id', libraryId);
  if (typeof fromCache === 'boolean') res.setHeader('X-From-Cache', String(fromCache));
  if (sourceUrl) res.setHeader('X-Source-Url', encodeURIComponent(sourceUrl));

  const range = req.headers.range;
  if (range) {
    const match = range.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? Math.min(stat.size - 1, parseInt(match[2], 10)) : stat.size - 1;
      if (start <= end && start < stat.size) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
        res.setHeader('Content-Length', end - start + 1);
        const stream = fs.createReadStream(filePath, { start, end });
        stream.on('error', (err) => !res.headersSent ? res.status(500).end() : res.destroy(err));
        stream.pipe(res);
        return;
      }
    }
  }

  res.setHeader('Content-Length', stat.size);
  const readStream = fs.createReadStream(filePath);
  readStream.on('error', (streamErr) => {
    console.error('Stream error:', streamErr);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to stream audio file.' });
    } else {
      res.destroy(streamErr);
    }
  });
  readStream.pipe(res);
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', port: PORT });
});

app.get('/api/library', async (_req, res) => {
  try {
    const items = await syncAndListLibrary();
    res.json({ items });
  } catch (err) {
    console.error('Failed to list library:', err);
    res.status(500).json({ error: 'Failed to read project audio library.' });
  }
});

app.get('/api/library/:id/audio', async (req, res) => {
  try {
    const items = await syncAndListLibrary();
    const entry = items.find((it) => it.id === req.params.id);
    if (!entry) {
      return res.status(404).json({ error: 'Library item not found.' });
    }
    const filePath = resolveLibraryFilePath(entry);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Audio file missing from disk.' });
    }
    streamAudioFile(req, res, filePath, {
      title: entry.title,
      libraryId: entry.id,
      fromCache: true,
      sourceUrl: entry.sourceUrl || '',
      downloadFilename: entry.filename
    });
  } catch (err) {
    console.error('Library stream error:', err);
    res.status(500).json({ error: 'Failed to load library audio.' });
  }
});

app.post(
  '/api/library/save',
  express.raw({ type: ['audio/wav', 'audio/x-wav', 'audio/mpeg', 'application/octet-stream'], limit: '500mb' }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Missing binary audio body.' });
      }

      const rawTitle = req.headers['x-track-title']
        ? decodeURIComponent(String(req.headers['x-track-title']))
        : 'Saved Track';
      const stemType = String(req.headers['x-stem-type'] || 'mix').toLowerCase();
      const sourceUrl = req.headers['x-source-url']
        ? decodeURIComponent(String(req.headers['x-source-url']))
        : '';
      const durationSec = Number(req.headers['x-duration-sec']) || null;
      const fmt = String(req.headers['x-format'] || 'wav').toLowerCase() === 'mp3' ? '.mp3' : '.wav';

      const existingItems = await syncAndListLibrary();
      // Avoid duplicate rapid saves with identical title + stemType + byte size
      const dup = existingItems.find(
        (it) => it.title === rawTitle && it.stemType === stemType && it.sizeBytes === req.body.length
      );
      if (dup) {
        return res.json({ item: dup, deduplicated: true });
      }

      const id = `lib-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      const shortHash = id.slice(-6);
      let relPath;
      let filename;
      if (stemType === 'mix' || stemType === 'mixdown') {
        const mixSubDir = path.join(LIBRARY_DIR, 'mixes');
        await fs.promises.mkdir(mixSubDir, { recursive: true });
        filename = `${sanitizeSlug(rawTitle, 'mix').slice(0, 48)}__mix-${shortHash}${fmt}`;
        relPath = path.posix.join('mixes', filename);
      } else {
        const suffixTag = stemType === 'voice' ? '__vocals' : (stemType === 'music' ? '__instruments' : '');
        filename = `${sanitizeSlug(rawTitle, 'stem').slice(0, 48)}${suffixTag}-${shortHash}${fmt}`;
        relPath = filename;
      }
      const outPath = path.join(LIBRARY_DIR, relPath);

      await fs.promises.writeFile(outPath, req.body);

      const entry = {
        id,
        title: rawTitle,
        stemType: stemType === 'mixdown' ? 'mix' : stemType,
        sourceUrl,
        videoId: sourceUrl ? extractYouTubeVideoId(sourceUrl) : null,
        folder: 'library',
        relPath,
        filename,
        ext: fmt,
        sizeBytes: req.body.length,
        durationSec,
        createdAt: new Date().toISOString()
      };

      const nextList = [entry, ...existingItems];
      writeLibraryIndex(nextList);

      res.json({ item: entry });
    } catch (err) {
      console.error('Library save error:', err);
      res.status(500).json({ error: 'Failed to save audio to project library.' });
    }
  }
);

app.delete('/api/library/:id', async (req, res) => {
  try {
    const items = await syncAndListLibrary();
    const idx = items.findIndex((it) => it.id === req.params.id);
    if (idx === -1) {
      return res.status(404).json({ error: 'Library item not found.' });
    }
    const [removed] = items.splice(idx, 1);
    const filePath = resolveLibraryFilePath(removed);
    if (filePath) {
      try { await fs.promises.unlink(filePath); } catch {}
      const parentDir = path.dirname(filePath);
      if (parentDir.startsWith(path.join(LIBRARY_DIR, 'stems') + path.sep)) {
        try {
          const left = await fs.promises.readdir(parentDir);
          if (left.length === 0) await fs.promises.rmdir(parentDir);
        } catch {}
      }
    }
    writeLibraryIndex(items);
    res.json({ deleted: removed.id });
  } catch (err) {
    console.error('Library delete error:', err);
    res.status(500).json({ error: 'Failed to delete library item.' });
  }
});

// ---------------- Neural Source Separation Engine (BS-RoFormer via stem_worker.py) ----------------
let stemWorkerProc = null;
let stemWorkerReadyPromise = null;
let stemPendingResolvers = new Map();
let stemQueue = Promise.resolve();

function isNeuralSeparatorAvailable() {
  return fs.existsSync(STEM_PYTHON_PATH) && fs.existsSync(STEM_WORKER_SCRIPT);
}

function resetStemWorker(reasonErr) {
  if (stemWorkerProc) {
    try {
      stemWorkerProc.kill();
    } catch {
      // Ignore
    }
    stemWorkerProc = null;
  }
  stemWorkerReadyPromise = null;
  for (const [, pending] of stemPendingResolvers) {
    pending.reject(reasonErr || new Error('Neural stem worker exited unexpectedly.'));
  }
  stemPendingResolvers.clear();
}

function ensureStemWorker() {
  if (!isNeuralSeparatorAvailable()) {
    return Promise.reject(new Error('Neural stem environment (.venv-stems) is not installed.'));
  }
  if (stemWorkerReadyPromise) return stemWorkerReadyPromise;

  stemWorkerReadyPromise = new Promise((resolve, reject) => {
    const extraPath = ffmpegPath ? path.dirname(ffmpegPath) : '';
    const env = {
      ...process.env,
      PATH: extraPath ? `${extraPath}:${process.env.PATH || ''}` : (process.env.PATH || '')
    };

    const proc = spawn(
      STEM_PYTHON_PATH,
      [STEM_WORKER_SCRIPT, '--serve', '--model-dir', MODELS_CACHE_DIR, '--model', DEFAULT_STEM_MODEL],
      { cwd: __dirname, env, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    stemWorkerProc = proc;
    let stdoutBuf = '';
    let settledReady = false;

    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      let nlIdx;
      while ((nlIdx = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nlIdx).trim();
        stdoutBuf = stdoutBuf.slice(nlIdx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.ready && !settledReady) {
          settledReady = true;
          resolve(proc);
          continue;
        }
        if (msg.id && stemPendingResolvers.has(msg.id)) {
          const pending = stemPendingResolvers.get(msg.id);
          stemPendingResolvers.delete(msg.id);
          if (msg.ok) pending.resolve(msg);
          else pending.reject(new Error(msg.error || 'Neural separation failed.'));
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const txt = chunk.toString().trim();
      if (txt) console.log('[stem_worker]', txt.split('\n').slice(-1)[0]);
    });

    proc.on('error', (err) => {
      if (!settledReady) {
        settledReady = true;
        reject(err);
      }
      resetStemWorker(err);
    });

    proc.on('exit', (code) => {
      const err = new Error(`Stem worker exited with code ${code}`);
      if (!settledReady) {
        settledReady = true;
        reject(err);
      }
      resetStemWorker(err);
    });
  });

  return stemWorkerReadyPromise;
}

function runNeuralSeparationJob(payload) {
  const jobTask = stemQueue.then(async () => {
    const proc = await ensureStemWorker();
    const id = `sep-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const msg = {
      id,
      action: payload.action || 'separate',
      input: payload.inputPath,
      outDir: payload.outDir,
      model: payload.model || DEFAULT_STEM_MODEL,
      splitInstruments: payload.splitInstruments !== false,
      drumsPath: payload.drumsPath || null,
      bassPath: payload.bassPath || null,
      otherPath: payload.otherPath || null
    };
    return new Promise((resolve, reject) => {
      stemPendingResolvers.set(id, { resolve, reject });
      proc.stdin.write(`${JSON.stringify(msg)}\n`);
    });
  });
  stemQueue = jobTask.catch(() => {});
  return jobTask;
}

app.get('/api/stem-engine-status', (_req, res) => {
  const neuralAvailable = isNeuralSeparatorAvailable();
  const modelCached = fs.existsSync(path.join(MODELS_CACHE_DIR, DEFAULT_STEM_MODEL));
  const karaokeCached = fs.existsSync(path.join(MODELS_CACHE_DIR, KARAOKE_STEM_MODEL));
  const demucsCached = fs.existsSync(path.join(MODELS_CACHE_DIR, DEMUCS_STEM_MODEL));
  res.json({
    neuralAvailable,
    multiStemAvailable: neuralAvailable && karaokeCached,
    demucsAvailable: neuralAvailable && demucsCached,
    model: 'BS-RoFormer (SDR 12.97)',
    modelId: DEFAULT_STEM_MODEL,
    karaokeModelId: KARAOKE_STEM_MODEL,
    demucsModelId: DEMUCS_STEM_MODEL,
    modelCached,
    karaokeCached,
    demucsCached
  });
});

/**
 * Persist separated neural stems into a dedicated, clearly labeled folder:
 * ./library/stems/<track-slug>-<hash>/<track>__vocals.wav + <track>__instruments.wav (+ sub-stems).
 */
async function persistSplitStems({
  result,
  cleanBase,
  sliceSuffix = '',
  sourceUrl = '',
  videoId = null,
  durationSec = null,
  stemMode = '2stem',
  splitInstruments = true
}) {
  const songSlug = sanitizeSlug(cleanBase, 'Track').slice(0, 44);
  const sliceSlug = sliceSuffix
    ? `_${sanitizeSlug(sliceSuffix, '').replace(/_+/g, '').slice(0, 16)}`
    : '';
  const jobHash = crypto.randomBytes(3).toString('hex');
  const folderName = `${songSlug}${sliceSlug}-${jobHash}`;
  const stemDirRel = path.posix.join('stems', folderName);
  const stemDirAbs = path.join(LIBRARY_DIR, stemDirRel);
  await fs.promises.mkdir(stemDirAbs, { recursive: true });

  const saveOne = async (srcPath, fileSuffix, stemType, tagLabel, extra = {}) => {
    if (!srcPath || !fs.existsSync(srcPath)) return null;
    const stemId = `lib-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const filename = `${songSlug}${fileSuffix}.wav`;
    const relPath = path.posix.join(stemDirRel, filename);
    const destPath = path.join(LIBRARY_DIR, relPath);
    await fs.promises.copyFile(srcPath, destPath);
    const stat = await fs.promises.stat(destPath);
    return {
      id: stemId,
      title: `${cleanBase} [${tagLabel}]${sliceSuffix}`,
      stemType,
      sourceUrl,
      videoId,
      folder: 'library',
      relPath,
      stemFolder: `library/${stemDirRel}`,
      filename,
      ext: '.wav',
      sizeBytes: stat.size,
      durationSec,
      createdAt: new Date().toISOString(),
      ...extra
    };
  };

  const withAudioUrl = (entry) => entry
    ? { ...entry, audioUrl: `/api/library/${encodeURIComponent(entry.id)}/audio` }
    : null;

  if (stemMode === 'multistem') {
    const voiceEntry = await saveOne(result.vocalsPath, '__vocals', 'voice', 'VOCALS', {
      rms: result.rmsStats?.vocals ?? null
    });
    const leadEntry = await saveOne(result.leadVocalPath, '__lead_vocal', 'lead', 'LEAD VOCAL', {
      rms: result.rmsStats?.leadVocal ?? null
    });
    const chorusEntry = await saveOne(result.chorusPath, '__chorus', 'chorus', 'CHORUS', {
      rms: result.rmsStats?.chorus ?? null
    });
    const musicEntry = await saveOne(result.instrumentalPath, '__instruments', 'music', 'INSTRUMENTS', {
      rms: result.rmsStats?.instruments ?? null,
      styleProfile: result.styleProfile || null
    });
    const drumsEntry = splitInstruments
      ? await saveOne(result.drumsPath, '__drums', 'drums', 'DRUMS', { rms: result.rmsStats?.drums ?? null })
      : null;
    const bassEntry = splitInstruments
      ? await saveOne(result.bassPath, '__bass', 'bass', 'BASS', { rms: result.rmsStats?.bass ?? null })
      : null;
    const otherEntry = splitInstruments
      ? await saveOne(result.otherPath, '__melody', 'other', 'MELODY', { rms: result.rmsStats?.other ?? null })
      : null;

    const entries = [leadEntry, chorusEntry, musicEntry, voiceEntry, drumsEntry, bassEntry, otherEntry].filter(Boolean);
    return {
      stemFolder: `library/${stemDirRel}`,
      entries,
      stemsMap: {
        lead: withAudioUrl(leadEntry),
        chorus: withAudioUrl(chorusEntry),
        music: withAudioUrl(musicEntry),
        voice: withAudioUrl(voiceEntry),
        drums: withAudioUrl(drumsEntry),
        bass: withAudioUrl(bassEntry),
        other: withAudioUrl(otherEntry)
      }
    };
  }

  const voiceEntry = await saveOne(result.vocalsPath, '__vocals', 'voice', 'VOCALS', {
    rms: result.rmsStats?.vocals ?? null
  });
  const musicEntry = await saveOne(result.instrumentalPath, '__instruments', 'music', 'INSTRUMENTS', {
    rms: result.rmsStats?.instruments ?? null,
    styleProfile: result.styleProfile || null
  });

  const entries = [voiceEntry, musicEntry].filter(Boolean);
  return {
    stemFolder: `library/${stemDirRel}`,
    entries,
    stemsMap: {
      voice: withAudioUrl(voiceEntry),
      music: withAudioUrl(musicEntry)
    }
  };
}

app.post(
  '/api/separate-stems',
  express.raw({ type: ['audio/wav', 'audio/x-wav', 'application/octet-stream'], limit: '500mb' }),
  async (req, res) => {
    if (!isNeuralSeparatorAvailable()) {
      return res.status(503).json({
        error: 'Neural stem separator not installed on server.',
        neuralAvailable: false
      });
    }

    const isBinaryWav = Buffer.isBuffer(req.body) && req.body.length > 0;
    const jsonBody = !isBinaryWav && req.body && typeof req.body === 'object' ? req.body : null;
    const reqLibraryId = jsonBody?.libraryId ? String(jsonBody.libraryId) : null;

    if (!isBinaryWav && !reqLibraryId) {
      return res.status(400).json({ error: 'Provide either binary WAV audio or libraryId JSON payload.' });
    }

    let rawTitle = req.headers['x-track-title']
      ? decodeURIComponent(String(req.headers['x-track-title']))
      : String(jsonBody?.title || 'Track');
    let sourceUrl = req.headers['x-source-url']
      ? decodeURIComponent(String(req.headers['x-source-url']))
      : String(jsonBody?.sourceUrl || '');
    let durationSec = Number(req.headers['x-duration-sec'] || jsonBody?.durationSec) || null;
    const stemModeRaw = String(req.headers['x-stem-mode'] || jsonBody?.stemMode || '2stem').toLowerCase();
    const stemMode = stemModeRaw === 'multistem' ? 'multistem' : '2stem';
    const splitInstruments = jsonBody
      ? jsonBody.splitInstruments !== false
      : String(req.headers['x-split-instruments'] || 'true') !== 'false';

    const jobId = `sepjob-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const jobDir = path.join(DOWNLOADS_DIR, jobId);
    const inputWav = path.join(jobDir, 'input.wav');
    const sepOutDir = path.join(jobDir, 'out');

    try {
      await fs.promises.mkdir(sepOutDir, { recursive: true });
      let sliceSuffix = '';

      if (isBinaryWav) {
        await fs.promises.writeFile(inputWav, req.body);
      } else {
        const libItems = await syncAndListLibrary();
        const libEntry = libItems.find((it) => it.id === reqLibraryId);
        if (!libEntry) {
          return res.status(404).json({ error: 'Library item not found.' });
        }
        const srcPath = resolveLibraryFilePath(libEntry);
        if (!srcPath || !fs.existsSync(srcPath)) {
          return res.status(404).json({ error: 'Library audio file missing on disk.' });
        }
        if (!rawTitle || rawTitle === 'Track') rawTitle = libEntry.title || 'Track';
        if (!sourceUrl) sourceUrl = libEntry.sourceUrl || '';
        if (!durationSec) durationSec = libEntry.durationSec || null;

        const reqStart = Number(jsonBody?.startSec);
        const reqEnd = Number(jsonBody?.endSec);
        const hasSlice = Number.isFinite(reqStart) && Number.isFinite(reqEnd) && reqEnd > reqStart + 0.1;

        if (ffmpegPath) {
          const ffArgs = ['-y'];
          if (hasSlice) {
            const clipLen = Math.max(0.25, reqEnd - reqStart);
            ffArgs.push('-ss', reqStart.toFixed(3), '-t', clipLen.toFixed(3));
            durationSec = Math.round(clipLen * 100) / 100;
            const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
            sliceSuffix = ` [${fmtT(reqStart)}-${fmtT(reqEnd)}]`;
          }
          ffArgs.push('-i', srcPath, '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', inputWav);
          await execFileAsync(ffmpegPath, ffArgs, { maxBuffer: 1024 * 1024 * 10 });
        } else if (libEntry.ext === '.wav' && !hasSlice) {
          await fs.promises.copyFile(srcPath, inputWav);
        } else {
          return res.status(500).json({ error: 'ffmpeg unavailable on server to decode/slice library audio.' });
        }
      }

      const cleanBase = rawTitle
        .replace(/\s*\[(VOICE ONLY|MUSIC ONLY|VOCAL|LEAD VOCAL|LEAD|CHORUS|INSTRUMENTS|DRUMS|BASS|MELODY|OTHER|AI BEAT|STYLE BEAT|TRIMMED|CROPPED.*?)\]/g, '')
        .trim() || 'Track';

      const result = await runNeuralSeparationJob({
        action: stemMode === 'multistem' ? 'separate_multistem' : 'separate',
        inputPath: inputWav,
        outDir: sepOutDir,
        model: DEFAULT_STEM_MODEL,
        splitInstruments
      });

      const finalDurationSec = result.durationSec || durationSec || null;
      const persisted = await persistSplitStems({
        result,
        cleanBase,
        sliceSuffix,
        sourceUrl,
        videoId: sourceUrl ? extractYouTubeVideoId(sourceUrl) : null,
        durationSec: finalDurationSec,
        stemMode,
        splitInstruments
      });

      const existingItems = await syncAndListLibrary();
      writeLibraryIndex([...persisted.entries, ...existingItems]);

      return res.json({
        model: stemMode === 'multistem'
          ? (result.model || 'BS-RoFormer + Karaoke RoFormer + HTDemucs')
          : 'BS-RoFormer (SDR 12.97)',
        mode: stemMode,
        stemFolder: persisted.stemFolder,
        loadSec: result.loadSec,
        separateSec: result.separateSec,
        rmsStats: result.rmsStats || null,
        styleProfile: result.styleProfile || null,
        stems: persisted.stemsMap
      });
    } catch (err) {
      console.error('Neural stem separation failed:', err);
      return res.status(500).json({
        error: 'Neural stem separation failed.',
        details: err?.message || String(err)
      });
    } finally {
      fs.promises.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    }
  }
);

app.post('/api/analyze-style', async (req, res) => {
  if (!isNeuralSeparatorAvailable()) {
    return res.status(503).json({ error: 'Neural stem analyzer not installed on server.' });
  }
  const { libraryId, separateFirst = true, startSec = 0, clipDurationSec = 32 } = req.body || {};
  if (!libraryId) {
    return res.status(400).json({ error: 'libraryId is required.' });
  }

  const jobId = `stylejob-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const jobDir = path.join(DOWNLOADS_DIR, jobId);
  const clipWav = path.join(jobDir, 'clip.wav');
  const outDir = path.join(jobDir, 'out');

  try {
    const items = await syncAndListLibrary();
    const entry = items.find((it) => it.id === libraryId);
    if (!entry) {
      return res.status(404).json({ error: 'Library item not found.' });
    }
    const srcPath = resolveLibraryFilePath(entry);
    if (!srcPath || !fs.existsSync(srcPath)) {
      return res.status(404).json({ error: 'Library file missing on disk.' });
    }

    await fs.promises.mkdir(outDir, { recursive: true });
    if (ffmpegPath) {
      const safeStart = Math.max(0, Number(startSec) || 0);
      const safeDur = Math.max(8, Math.min(60, Number(clipDurationSec) || 32));
      await execFileAsync(ffmpegPath, [
        '-y', '-ss', String(safeStart), '-t', String(safeDur),
        '-i', srcPath, '-ar', '44100', '-ac', '2', clipWav
      ]);
    } else if (entry.ext === '.wav') {
      await fs.promises.copyFile(srcPath, clipWav);
    } else {
      return res.status(500).json({ error: 'ffmpeg unavailable to decode non-WAV audio for analysis.' });
    }

    let result;
    if (separateFirst && (entry.stemType === 'youtube' || entry.stemType === 'local' || entry.stemType === 'crop')) {
      result = await runNeuralSeparationJob({
        action: 'separate_multistem',
        inputPath: clipWav,
        outDir,
        splitInstruments: true
      });

      const cleanBase = String(entry.title || 'Reference')
        .replace(/\s*\[(VOICE ONLY|VOCALS|MUSIC ONLY|VOCAL|LEAD VOCAL|LEAD|CHORUS|INSTRUMENTS|DRUMS|BASS|MELODY|OTHER|AI BEAT|TRIMMED|CROPPED.*?)\]/g, '')
        .trim() || 'Reference';
      const persisted = await persistSplitStems({
        result,
        cleanBase,
        sliceSuffix: ` [${Math.round(Number(startSec) || 0)}s]`,
        sourceUrl: entry.sourceUrl || '',
        videoId: entry.videoId || null,
        durationSec: result.durationSec || Math.min(Number(entry.durationSec) || 32, Number(clipDurationSec) || 32),
        stemMode: 'multistem',
        splitInstruments: true
      });

      const latest = await syncAndListLibrary();
      // Also attach styleProfile onto the parent entry for reuse
      const updated = latest.map((it) => (it.id === entry.id ? { ...it, styleProfile: result.styleProfile } : it));
      writeLibraryIndex([...persisted.entries, ...updated]);

      return res.json({
        ok: true,
        stemFolder: persisted.stemFolder,
        styleProfile: result.styleProfile,
        rmsStats: result.rmsStats || null,
        stems: persisted.stemsMap
      });
    }

    result = await runNeuralSeparationJob({
      action: 'analyze_style',
      inputPath: clipWav,
      outDir
    });
    const latest = await syncAndListLibrary();
    writeLibraryIndex(
      latest.map((it) => (it.id === entry.id ? { ...it, styleProfile: result.styleProfile } : it))
    );
    return res.json({ ok: true, styleProfile: result.styleProfile });
  } catch (err) {
    console.error('Style analysis failed:', err);
    return res.status(500).json({ error: 'Style analysis failed.', details: err?.message || String(err) });
  } finally {
    fs.promises.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.post('/api/extract', async (req, res) => {
  const { url, force } = req.body || {};
  const validation = validateYouTubeUrl(url);

  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  const videoId = extractYouTubeVideoId(validation.url);

  try {
    // Serve immediately from persistent local project library if already extracted
    if (!force && videoId) {
      const libraryItems = await syncAndListLibrary();
      const cached = libraryItems.find(
        (it) => it.videoId === videoId && (it.stemType === 'youtube' || it.stemType === 'local')
      );
      if (cached) {
        const cachedPath = resolveLibraryFilePath(cached);
        if (cachedPath && fs.existsSync(cachedPath)) {
          return streamAudioFile(req, res, cachedPath, {
            title: cached.title,
            libraryId: cached.id,
            fromCache: true,
            sourceUrl: cached.sourceUrl || validation.url,
            downloadFilename: cached.filename
          });
        }
      }
    }

    const jobId = `track-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const outputTemplate = path.join(DOWNLOADS_DIR, `${jobId}.%(ext)s`);
    const expectedMp3Path = path.join(DOWNLOADS_DIR, `${jobId}.mp3`);

    let trackTitle = 'YouTube Track';
    let durationSec = null;
    try {
      const info = await youtubedl(validation.url, {
        dumpSingleJson: true,
        noPlaylist: true,
        noWarnings: true,
        skipDownload: true
      });
      if (info && typeof info.title === 'string' && info.title.trim()) {
        trackTitle = info.title.trim();
      }
      if (info && Number.isFinite(Number(info.duration))) {
        durationSec = Number(info.duration);
      }
    } catch {
      // Metadata lookup is best-effort; continue to extraction.
    }

    const dlOptions = {
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: 0,
      noPlaylist: true,
      noWarnings: true,
      noProgress: true,
      output: outputTemplate
    };

    if (ffmpegPath) {
      dlOptions.ffmpegLocation = ffmpegPath;
    }

    try {
      await youtubedl(validation.url, dlOptions);

      if (!fs.existsSync(expectedMp3Path)) {
        throw new Error('MP3 conversion finished without producing an output file.');
      }

      const stat = await fs.promises.stat(expectedMp3Path);
      if (!stat.size) {
        throw new Error('Extracted MP3 file is empty.');
      }

      const id = `lib-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      const safeFilename = sanitizeSlug(trackTitle, jobId);
      const persistentFilename = `${safeFilename}-${id.slice(-6)}.mp3`;
      const persistentPath = path.join(LIBRARY_DIR, persistentFilename);

      try {
        await fs.promises.rename(expectedMp3Path, persistentPath);
      } catch {
        await fs.promises.copyFile(expectedMp3Path, persistentPath);
        removeFileQuietly(expectedMp3Path);
      }

      const entry = {
        id,
        title: trackTitle,
        stemType: 'youtube',
        sourceUrl: validation.url,
        videoId,
        folder: 'library',
        filename: persistentFilename,
        ext: '.mp3',
        sizeBytes: stat.size,
        durationSec,
        createdAt: new Date().toISOString()
      };

      const existingItems = await syncAndListLibrary();
      writeLibraryIndex([entry, ...existingItems]);

      streamAudioFile(req, res, persistentPath, {
        title: trackTitle,
        libraryId: entry.id,
        fromCache: false,
        sourceUrl: validation.url,
        downloadFilename: persistentFilename
      });
    } catch (innerErr) {
      removeFileQuietly(expectedMp3Path);
      fs.promises.readdir(DOWNLOADS_DIR)
        .then((files) => {
          files
            .filter((f) => f.startsWith(`${jobId}.`))
            .forEach((f) => removeFileQuietly(path.join(DOWNLOADS_DIR, f)));
        })
        .catch(() => {});
      throw innerErr;
    }
  } catch (err) {
    const rawMsg = (err && (err.stderr || err.message)) ? String(err.stderr || err.message) : 'Unknown extraction error';
    console.error('YouTube extraction failed:', rawMsg);

    const status = /unavailable|private|copyright|not available|sign in/i.test(rawMsg) ? 422 : 500;
    return res.status(status).json({
      error: 'Failed to extract audio from YouTube URL.',
      details: rawMsg.split('\n').slice(0, 3).join(' ').trim()
    });
  }
});

const REMIX_PLAN_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    remixSummary: { type: Type.STRING },
    masterVolume: { type: Type.NUMBER },
    tracks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          trackIndex: { type: Type.INTEGER },
          include: { type: Type.BOOLEAN },
          sliceStartSec: { type: Type.NUMBER },
          sliceEndSec: { type: Type.NUMBER },
          extractVoice: { type: Type.BOOLEAN },
          trimSilence: { type: Type.BOOLEAN },
          loop: { type: Type.BOOLEAN },
          volume: { type: Type.NUMBER },
          pitchSemitones: { type: Type.INTEGER },
          fineCents: { type: Type.INTEGER },
          autoTuneMode: { type: Type.INTEGER },
          tunerKey: { type: Type.INTEGER },
          vocalToneDb: { type: Type.NUMBER },
          doublerEnabled: { type: Type.BOOLEAN },
          lofiEnabled: { type: Type.BOOLEAN },
          reverbMix: { type: Type.NUMBER },
          startDelaySec: { type: Type.NUMBER },
          reason: { type: Type.STRING }
        },
        required: [
          'trackIndex',
          'include',
          'sliceStartSec',
          'sliceEndSec',
          'extractVoice',
          'trimSilence',
          'loop',
          'volume',
          'pitchSemitones',
          'fineCents',
          'autoTuneMode',
          'tunerKey',
          'vocalToneDb',
          'doublerEnabled',
          'lofiEnabled',
          'reverbMix',
          'startDelaySec',
          'reason'
        ]
      }
    },
    generateBackground: {
      type: Type.OBJECT,
      properties: {
        shouldGenerate: { type: Type.BOOLEAN },
        targetTrackIndex: { type: Type.INTEGER },
        preset: { type: Type.STRING },
        keyIndex: { type: Type.INTEGER },
        scale: { type: Type.STRING },
        bpm: { type: Type.INTEGER },
        bars: { type: Type.INTEGER }
      },
      required: ['shouldGenerate', 'targetTrackIndex', 'preset', 'keyIndex', 'scale', 'bpm', 'bars']
    }
  },
  required: ['remixSummary', 'masterVolume', 'tracks', 'generateBackground']
};

function clampNum(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sanitizeRemixPlan(rawPlan, inputTracks) {
  const validPresets = new Set([
    'rhodes', 'drums', 'bass', 'pad', 'vinyl',
    'nadhaswaram', 'mridangam', 'carnatic_lofi',
    'deep_house', 'soul_house', 'bass_drums', 'orchestral'
  ]);
  const validScales = new Set([
    'minor', 'major', 'mohanam', 'kalyani', 'mayamalavagowla', 'charukesi'
  ]);
  const trackMap = new Map();
  if (Array.isArray(rawPlan?.tracks)) {
    for (const item of rawPlan.tracks) {
      if (item && Number.isInteger(item.trackIndex) && item.trackIndex >= 0 && item.trackIndex < 4) {
        trackMap.set(item.trackIndex, item);
      }
    }
  }

  const normalizedTracks = [];
  for (let i = 0; i < 4; i += 1) {
    const srcTrack = inputTracks.find((t) => t.trackIndex === i) || { loaded: false, durationSec: 0 };
    const item = trackMap.get(i) || {};
    const dur = Math.max(0, Number(srcTrack.durationSec) || 0);

    let startSec = clampNum(item.sliceStartSec, 0, Math.max(0, dur - 0.1), 0);
    let endSec = clampNum(item.sliceEndSec, 0, dur, dur);
    if (dur > 0 && endSec <= startSec + 0.05) {
      startSec = 0;
      endSec = dur;
    }

    normalizedTracks.push({
      trackIndex: i,
      include: Boolean(srcTrack.loaded && item.include !== false),
      sliceStartSec: Number(startSec.toFixed(2)),
      sliceEndSec: Number(endSec.toFixed(2)),
      extractVoice: Boolean(item.extractVoice),
      trimSilence: Boolean(item.trimSilence),
      loop: item.loop !== undefined ? Boolean(item.loop) : true,
      volume: Number(clampNum(item.volume, 0, 1, 0.85).toFixed(2)),
      pitchSemitones: Math.round(clampNum(item.pitchSemitones, -12, 12, 0)),
      fineCents: Math.round(clampNum(item.fineCents, -50, 50, 0)),
      autoTuneMode: Math.round(clampNum(item.autoTuneMode, 0, 4, 0)),
      tunerKey: Math.round(clampNum(item.tunerKey, 0, 11, 0)),
      vocalToneDb: Number(clampNum(item.vocalToneDb, -6, 9, 0).toFixed(1)),
      doublerEnabled: Boolean(item.doublerEnabled),
      lofiEnabled: Boolean(item.lofiEnabled),
      reverbMix: Number(clampNum(item.reverbMix, 0, 1, 0.25).toFixed(2)),
      startDelaySec: Number(clampNum(item.startDelaySec, 0, 16, 0).toFixed(2)),
      reason: typeof item.reason === 'string' && item.reason.trim()
        ? item.reason.trim().slice(0, 180)
        : (srcTrack.loaded ? 'Included in remix.' : 'Empty slot.')
    });
  }

  const gb = rawPlan?.generateBackground || {};
  const preset = validPresets.has(gb.preset) ? gb.preset : 'rhodes';
  const scale = validScales.has(gb.scale) ? gb.scale : 'minor';

  return {
    remixSummary: typeof rawPlan?.remixSummary === 'string' && rawPlan.remixSummary.trim()
      ? rawPlan.remixSummary.trim()
      : 'Remix plan generated by Gemini.',
    masterVolume: Number(clampNum(rawPlan?.masterVolume, 0.1, 1, 0.85).toFixed(2)),
    tracks: normalizedTracks,
    generateBackground: {
      shouldGenerate: Boolean(gb.shouldGenerate),
      targetTrackIndex: Math.round(clampNum(gb.targetTrackIndex, 0, 3, 1)),
      preset,
      keyIndex: Math.round(clampNum(gb.keyIndex, 0, 11, 9)),
      scale,
      bpm: Math.round(clampNum(gb.bpm, 55, 138, 78)),
      bars: [2, 4, 8].includes(Number(gb.bars)) ? Number(gb.bars) : 4
    }
  };
}

app.get('/api/gemini-status', (_req, res) => {
  res.json({
    configured: Boolean(process.env.GEMINI_API_KEY),
    model: 'gemini-3.5-flash'
  });
});

app.post('/api/remix-plan', async (req, res) => {
  const { globalPrompt = '', tracks = [], apiKey: clientApiKey = '' } = req.body || {};
  const resolvedApiKey = (process.env.GEMINI_API_KEY || String(clientApiKey || '')).trim();

  if (!resolvedApiKey) {
    return res.status(400).json({
      error: 'Gemini API key is required. Set GEMINI_API_KEY in your environment/.env or paste it in the Gemini Remix Director bar.'
    });
  }

  if (!Array.isArray(tracks) || tracks.length === 0) {
    return res.status(400).json({ error: 'Track metadata array is required.' });
  }

  const hasPrompt = Boolean(String(globalPrompt).trim()) || tracks.some((t) => Boolean(String(t?.prompt || '').trim()));
  if (!hasPrompt) {
    return res.status(400).json({
      error: 'Please enter a global remix prompt or at least one per-track prompt describing what to take from the tracks.'
    });
  }

  try {
    const ai = new GoogleGenAI({ apiKey: resolvedApiKey });

    const trackSummaries = tracks.map((t) => ({
      trackIndex: t.trackIndex,
      label: `Track 0${Number(t.trackIndex) + 1}`,
      loaded: Boolean(t.loaded),
      title: t.title || '(empty)',
      durationSec: Number(t.durationSec || 0).toFixed(2),
      userPromptForThisTrack: String(t.prompt || '').trim() || '(no specific per-track instruction)',
      energyProfilePerSec: Array.isArray(t.energyProfile) ? t.energyProfile : [],
      currentSettings: t.currentState || {}
    }));

    const systemInstruction = [
      'You are an expert Lo-Fi music producer and audio engineer controlling a 4-track Web Audio DAW called TAPE-4.',
      'Your job is to read the user\'s global remix prompt and per-track prompts (and listen to any attached track audio clips) and decide EXACTLY what segment and processing to take from each of the 4 tracks to build a cohesive remix.',
      'Available track DSP capabilities:',
      '- sliceStartSec / sliceEndSec: extract a specific time range from a track\'s original audio (in seconds). If the user asks for a chorus, verse, hook, intro, or specific timestamp, pick accurate start/end seconds based on the audio you hear and energyProfilePerSec.',
      '- extractVoice: isolate center-panned lead vocals and attenuate backing instruments.',
      '- trimSilence: remove dead air at start/end and collapse long pauses.',
      '- Voice Tuner: pitchSemitones (-12..12), fineCents (-50..50), autoTuneMode (0=Off, 1=Chromatic, 2=Major, 3=Minor, 4=Pentatonic), tunerKey (0=C..11=B), vocalToneDb (-6..9), doublerEnabled (stereo vocal width).',
      '- Lo-Fi FX: lofiEnabled (2000Hz warm low-pass filter), reverbMix (0..1 ConvolverNode wet/dry mix), volume (0..1), loop (boolean), startDelaySec (0..16s arrangement entry offset).',
      '- generateBackground: if the user asks to generate/fill an empty track with a background loop, set shouldGenerate=true with an empty targetTrackIndex (0..3), preset in [rhodes, drums, bass, pad, vinyl, nadhaswaram, mridangam, carnatic_lofi, deep_house, soul_house, bass_drums, orchestral], and scale in [minor, major, mohanam, kalyani, mayamalavagowla, charukesi]. Otherwise set shouldGenerate=false.',
      'Keep tracks balanced in mix volume (e.g. vocals ~0.85-0.95, backing chords/drums ~0.55-0.75) and provide a concise, helpful `reason` per track.'
    ].join('\n');

    const parts = [
      {
        text: JSON.stringify({
          globalRemixPrompt: String(globalPrompt || '').trim() || 'Create a cohesive Lo-Fi remix honoring each per-track instruction.',
          tracks: trackSummaries
        }, null, 2)
      }
    ];

    // Attach compact WAV audio clips for loaded tracks when provided
    for (const t of tracks) {
      if (t.loaded && typeof t.audioBase64 === 'string' && t.audioBase64.length > 0) {
        parts.push({
          text: `Audio clip for Track 0${Number(t.trackIndex) + 1} ("${t.title || 'Track'}"):`
        });
        parts.push({
          inlineData: {
            mimeType: 'audio/wav',
            data: t.audioBase64
          }
        });
      }
    }

    const candidateModels = ['gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'];
    let response = null;
    let usedModel = candidateModels[0];
    let lastErr = null;

    for (const modelName of candidateModels) {
      try {
        response = await ai.models.generateContent({
          model: modelName,
          contents: [{ role: 'user', parts }],
          config: {
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: REMIX_PLAN_SCHEMA,
            temperature: 0.4,
            abortSignal: AbortSignal.timeout(20000)
          }
        });
        usedModel = modelName;
        break;
      } catch (modelErr) {
        lastErr = modelErr;
        const msg = String(modelErr?.message || '');
        const code = modelErr?.status;
        if (
          modelErr?.name === 'TimeoutError' ||
          modelErr?.name === 'AbortError' ||
          code === 404 ||
          code === 429 ||
          code === 503 ||
          /not_found|no longer available|unavailable|high demand|quota|timeout|abort/i.test(msg)
        ) {
          continue;
        }
        throw modelErr;
      }
    }

    if (!response) {
      throw lastErr || new Error('All Gemini models failed.');
    }

    const rawText = response.text;
    const parsedPlan = JSON.parse(rawText);
    const plan = sanitizeRemixPlan(parsedPlan, tracks);

    return res.json({ plan, model: usedModel });
  } catch (err) {
    console.error('Gemini remix plan error:', err);
    const msg = err?.message || 'Gemini API request failed.';
    const status = /api key|unauthorized|permission|403|401/i.test(msg) ? 401 : 500;
    return res.status(status).json({
      error: 'Failed to generate remix plan with Gemini.',
      details: msg
    });
  }
});

const MIX_VARIATIONS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    variations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          vibe: { type: Type.STRING },
          summary: { type: Type.STRING },
          leadStemId: { type: Type.STRING },
          chorusStemId: { type: Type.STRING },
          instrumentsStemId: { type: Type.STRING },
          beatMode: { type: Type.STRING },
          beatPreset: { type: Type.STRING },
          bpm: { type: Type.INTEGER },
          keyIndex: { type: Type.INTEGER },
          scale: { type: Type.STRING },
          leadPitchSemitones: { type: Type.INTEGER },
          leadVolume: { type: Type.NUMBER },
          leadLofi: { type: Type.BOOLEAN },
          leadReverb: { type: Type.NUMBER },
          chorusVolume: { type: Type.NUMBER },
          chorusReverb: { type: Type.NUMBER },
          instrumentsVolume: { type: Type.NUMBER },
          instrumentsLofi: { type: Type.BOOLEAN },
          beatVolume: { type: Type.NUMBER },
          beatLofi: { type: Type.BOOLEAN },
          beatReverb: { type: Type.NUMBER }
        },
        required: [
          'name', 'vibe', 'summary', 'beatMode', 'beatPreset',
          'bpm', 'keyIndex', 'scale', 'leadPitchSemitones',
          'leadVolume', 'leadLofi', 'leadReverb', 'chorusVolume',
          'chorusReverb', 'instrumentsVolume', 'instrumentsLofi',
          'beatVolume', 'beatLofi', 'beatReverb'
        ]
      }
    }
  },
  required: ['variations']
};

app.post('/api/mix-variations', async (req, res) => {
  const { apiKey, prompt = '', components = [], styleProfile = null } = req.body || {};
  const resolvedApiKey = String(apiKey || '').trim() || process.env.GEMINI_API_KEY || '';
  if (!resolvedApiKey) {
    return res.status(400).json({ error: 'Gemini API key required for AI variation generation.' });
  }
  if (!Array.isArray(components) || components.length === 0) {
    return res.status(400).json({ error: 'No component stems supplied.' });
  }

  const validBeatModes = new Set([
    'lofi_clone', 'carnatic_lofi_flip', 'pure_drums_bass', 'deep_chill_house', 'halftime_ambient'
  ]);
  const validPresets = new Set([
    'rhodes', 'drums', 'bass', 'pad', 'vinyl',
    'nadhaswaram', 'mridangam', 'carnatic_lofi',
    'deep_house', 'soul_house', 'bass_drums', 'orchestral'
  ]);
  const validScales = new Set(['minor', 'major', 'mohanam', 'kalyani', 'mayamalavagowla', 'charukesi']);
  const compIds = new Set(components.map((c) => c.id));

  try {
    const ai = new GoogleGenAI({ apiKey: resolvedApiKey });
    const systemInstruction = [
      'You are an expert Carnatic-Lo-Fi & Electronic fusion producer inside TAPE-4 DAW.',
      'Given extracted track components (Lead Vocals, Chorus/Backing, Instruments, Drums/Bass) and an analyzed reference Style Profile (BPM, Key, Scale, Groove), generate 4 DISTINCT, creative remix recipes combining components across tracks.',
      'For each recipe choose:',
      '- leadStemId / chorusStemId / instrumentsStemId from the provided component IDs (or empty string if omitted in that recipe).',
      '- beatMode in [lofi_clone, carnatic_lofi_flip, pure_drums_bass, deep_chill_house, halftime_ambient] (uses reference groove & style synthesis).',
      '- beatPreset in [rhodes, drums, bass, pad, vinyl, nadhaswaram, mridangam, carnatic_lofi, deep_house, soul_house, bass_drums, orchestral].',
      '- bpm (55..138), keyIndex (0..11), scale in [minor, major, mohanam, kalyani, mayamalavagowla, charukesi].',
      'Provide varied genres/textures across the 4 options: e.g. (1) Authentic Reference Lo-Fi Flip, (2) Wide Vocal + Chorus + Sub Pocket, (3) Carnatic Tanpura/Mridangam Lo-Fi Fusion, (4) Deep Chill / Soul House Flip.'
    ].join('\n');

    const candidateModels = ['gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'];
    let response = null;
    let usedModel = candidateModels[0];
    let lastErr = null;

    for (const modelName of candidateModels) {
      try {
        response = await ai.models.generateContent({
          model: modelName,
          contents: [{
            role: 'user',
            parts: [{
              text: JSON.stringify({
                userGoal: String(prompt || '').trim() || 'Mix extracted lead vocals and chorus with style-matched Lo-Fi beats derived from the Lo-Fi reference track.',
                referenceStyleProfile: styleProfile,
                availableComponents: components
              }, null, 2)
            }]
          }],
          config: {
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: MIX_VARIATIONS_SCHEMA,
            thinkingConfig: { thinkingBudget: 512 },
            temperature: 0.65,
            abortSignal: AbortSignal.timeout(25000)
          }
        });
        usedModel = modelName;
        break;
      } catch (modelErr) {
        lastErr = modelErr;
        const msg = String(modelErr?.message || '');
        if (
          modelErr?.name === 'TimeoutError' || modelErr?.name === 'AbortError' ||
          /abort|timeout|not_found|unavailable|high demand|quota/i.test(msg) ||
          [404, 429, 503].includes(modelErr?.status)
        ) {
          continue;
        }
        throw modelErr;
      }
    }

    if (!response) {
      throw lastErr || new Error('Gemini variations request failed.');
    }

    const parsed = JSON.parse(response.text);
    const variations = (Array.isArray(parsed?.variations) ? parsed.variations : []).slice(0, 6).map((v) => ({
      name: String(v.name || 'Custom Mix'),
      vibe: String(v.vibe || 'FUSION'),
      summary: String(v.summary || ''),
      leadStemId: compIds.has(v.leadStemId) ? v.leadStemId : '',
      chorusStemId: compIds.has(v.chorusStemId) ? v.chorusStemId : '',
      instrumentsStemId: compIds.has(v.instrumentsStemId) ? v.instrumentsStemId : '',
      beatMode: validBeatModes.has(v.beatMode) ? v.beatMode : 'lofi_clone',
      beatPreset: validPresets.has(v.beatPreset) ? v.beatPreset : 'carnatic_lofi',
      bpm: Math.round(clampNum(v.bpm, 55, 138, styleProfile?.bpm || 84)),
      keyIndex: Math.round(clampNum(v.keyIndex, 0, 11, styleProfile?.keyIndex ?? 5)),
      scale: validScales.has(v.scale) ? v.scale : (styleProfile?.scale || 'minor'),
      leadPitchSemitones: Math.round(clampNum(v.leadPitchSemitones, -12, 12, 0)),
      leadVolume: clampNum(v.leadVolume, 0, 1, 0.92),
      leadLofi: Boolean(v.leadLofi),
      leadReverb: clampNum(v.leadReverb, 0, 1, 0.28),
      chorusVolume: clampNum(v.chorusVolume, 0, 1, 0.62),
      chorusReverb: clampNum(v.chorusReverb, 0, 1, 0.48),
      instrumentsVolume: clampNum(v.instrumentsVolume, 0, 1, 0.55),
      instrumentsLofi: Boolean(v.instrumentsLofi),
      beatVolume: clampNum(v.beatVolume, 0, 1, 0.78),
      beatLofi: Boolean(v.beatLofi),
      beatReverb: clampNum(v.beatReverb, 0, 1, 0.22)
    }));

    return res.json({ variations, model: usedModel });
  } catch (err) {
    console.error('Gemini mix variations error:', err);
    return res.status(500).json({ error: 'Failed to generate AI mix variations.', details: err?.message || String(err) });
  }
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

const server = app.listen(PORT, () => {
  console.log(`Lo-Fi DAW server listening at http://localhost:${PORT}`);
});
server.requestTimeout = 0;
server.headersTimeout = 0;
server.setTimeout(0);
