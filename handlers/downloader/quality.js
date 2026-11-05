/**
 * Shared resolution/codec helpers for torrent file selection.
 *
 * These are intentionally dependency-free so both downloader implementations
 * and their tests use the same rules.
 */

const JUNK_VIDEO_RE = /(^|[\s._-])(sample|trailer|teaser|proof|preview|featurette)([\s._-]|$)/i;

export function detectQuality(name) {
  const text = String(name || '').toLowerCase();
  if (/\b(2160p|4k|uhd)\b/.test(text)) return '2160p';
  if (/\b1080[pi]\b/.test(text)) return '1080p';
  if (/\b720[pi]\b/.test(text)) return '720p';
  if (/\b(480[pi]|sd)\b/.test(text)) return '480p';
  return 'unknown';
}

export function detectCodec(name) {
  const text = String(name || '').toLowerCase();
  if (/\b(x265|h\.?265|hevc)\b/.test(text)) return 'x265';
  if (/\b(x264|h\.?264|avc)\b/.test(text)) return 'x264';
  if (/\bav1\b/.test(text)) return 'av1';
  return 'unknown';
}

export function isJunkVideoName(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  return JUNK_VIDEO_RE.test(base);
}

function qualityOf(file, torrentName) {
  const own = detectQuality(`${file.path || ''} ${file.name || ''}`);
  return own === 'unknown' ? detectQuality(torrentName) : own;
}

function codecOf(file, torrentName) {
  const own = detectCodec(`${file.path || ''} ${file.name || ''}`);
  return own === 'unknown' ? detectCodec(torrentName) : own;
}

/**
 * Keep the preferred resolution when it exists. If it does not, prefer any
 * smaller/unknown copy over 4K so an unlucky search does not download a huge
 * episode pack.
 */
export function filterByQuality(files, torrentName, preferQuality) {
  if (!preferQuality || !files.length) return files;

  const preferred = files.filter((file) => qualityOf(file, torrentName) === preferQuality);
  if (preferred.length) return preferred;

  const smaller = files.filter((file) => qualityOf(file, torrentName) !== '2160p');
  return smaller.length ? smaller : files;
}

/** Keep x264 when the chosen resolution has one; otherwise keep the pool. */
export function filterByCodec(files, torrentName, preferCodec) {
  if (!preferCodec || !files.length) return files;

  const preferred = files.filter((file) => codecOf(file, torrentName) === preferCodec);
  return preferred.length ? preferred : files;
}

/** Pick one video file, ignoring samples when a real file is available. */
export function pickPreferredVideoFile(files, torrentName, preferQuality, preferCodec) {
  if (!files.length) return null;

  const clean = files.filter((file) => !isJunkVideoName(file.name));
  let pool = filterByQuality(clean.length ? clean : files, torrentName, preferQuality);
  pool = filterByCodec(pool, torrentName, preferCodec);
  return pool.slice().sort((a, b) => b.length - a.length)[0] || null;
}
