'use strict';

// On-disk cache of transcoded Ogg/Opus, keyed by YouTube video id. A song is
// downloaded/transcoded once; replays stream straight from disk — no yt-dlp, no
// proxy, no bandwidth. This is the trick that keeps proxy GB usage sane.

const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const DIR = path.join(__dirname, 'cache');
const MAX_BYTES = 1.5 * 1024 * 1024 * 1024; // ~1.5 GB cap (LRU-evicted)

try { fs.mkdirSync(DIR, { recursive: true }); } catch {}

function videoId(url) {
  const m = url.match(/[?&]v=([\w-]{11})/) || url.match(/youtu\.be\/([\w-]{11})/);
  return m ? m[1] : null;
}

// Path to a cached file if present (and touch it for LRU recency), else null.
function cachedPath(id) {
  if (!id) return null;
  const p = path.join(DIR, `${id}.ogg`);
  try {
    if (fs.statSync(p).size > 0) {
      const now = new Date();
      fs.utimes(p, now, now, () => {});
      return p;
    }
  } catch {}
  return null;
}

// Tee a live Ogg/Opus stream into the cache while returning a readable for the
// player. The cache file is committed only when the source finishes cleanly, so
// interrupted/failed downloads never leave a corrupt cache entry.
function teeToCache(src, id) {
  const out = new PassThrough();
  if (!id) { src.pipe(out); return out; }

  const tmp = path.join(DIR, `.${id}.tmp`);
  let file;
  try { file = fs.createWriteStream(tmp); } catch { src.pipe(out); return out; }

  let bytes = 0;
  let finished = false;
  file.on('error', () => { try { file.destroy(); } catch {} });

  src.on('data', (chunk) => {
    bytes += chunk.length;
    if (file && !file.destroyed) file.write(chunk);
    if (!out.destroyed && !out.writableEnded) { try { out.write(chunk); } catch {} }
  });

  src.on('end', () => {
    finished = true;
    if (!out.destroyed && !out.writableEnded) out.end();
    if (!file || file.destroyed) return;
    file.end(() => {
      if (bytes > 4096) {
        fs.rename(tmp, path.join(DIR, `${id}.ogg`), (e) => {
          if (e) fs.unlink(tmp, () => {}); else enforceLimit();
        });
      } else {
        fs.unlink(tmp, () => {});
      }
    });
  });

  const abort = () => {
    if (finished) return;
    finished = true;
    if (file && !file.destroyed) { try { file.destroy(); } catch {} }
    fs.unlink(tmp, () => {});
  };
  src.on('error', abort);
  src.on('close', () => { if (!finished) abort(); });

  return out;
}

function enforceLimit() {
  try {
    const files = fs.readdirSync(DIR)
      .filter((f) => f.endsWith('.ogg'))
      .map((f) => {
        const p = path.join(DIR, f);
        const s = fs.statSync(p);
        return { p, size: s.size, mtime: s.mtimeMs };
      });
    let total = files.reduce((a, f) => a + f.size, 0);
    if (total <= MAX_BYTES) return;
    files.sort((a, b) => a.mtime - b.mtime); // oldest first
    for (const f of files) {
      if (total <= MAX_BYTES) break;
      fs.unlink(f.p, () => {});
      total -= f.size;
    }
  } catch {}
}

function status() {
  try {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.ogg'));
    const bytes = files.reduce((a, f) => {
      try { return a + fs.statSync(path.join(DIR, f)).size; } catch { return a; }
    }, 0);
    return { count: files.length, mb: Math.round(bytes / (1024 * 1024)) };
  } catch {
    return { count: 0, mb: 0 };
  }
}

module.exports = { videoId, cachedPath, teeToCache, status, DIR };
