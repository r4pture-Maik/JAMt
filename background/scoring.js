/**
 * JAMt - Scoring & Album Completion Engine
 * Implements fuzzy matching, title normalization, and resilient album completion algorithms.
 */

/**
 * Normalizes track title for resilient fuzzy matching between
 * YouTube Music player bar and Remix/Browse API tracklists.
 * Strips smart quotes, hyphens, remaster/deluxe/live/bonus tags, and metadata noise.
 *
 * @param {string} str
 * @returns {string}
 */
export function normalizeTrackTitle(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[\u2018\u2019`´]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    // Strip leading track numbers like "01. ", "1 - ", etc.
    .replace(/^\s*\d+[\.\-\s]+/g, '')
    // Strip parenthetical and bracketed remaster / bonus / live / explicit / video tags
    .replace(/\s*[\(\[]((\d{2,4}\s*)?remaster(ed)?(\s*\d{2,4})?|deluxe(\s*edition)?|bonus(\s*track)?|live(\s*at.*?)?|explicit|version|anniversary(\s*edition)?|official(\s*(music\s*|hd\s*)?video|\s*audio)?|lyric(\s*video)?|visualizer|audio|hd(\s*video)?|4k)[\)\]]/gi, '')
    // Strip trailing "- 2011 Remaster", "- Remastered", etc.
    .replace(/\s*-\s*((\d{2,4}\s*)?remaster(ed)?(\s*\d{2,4})?|deluxe|live|explicit|bonus|mono|stereo|official(\s*video)?).*$/gi, '')
    // Strip featuring artist tags like "(feat. X)" or "[ft. X]"
    .replace(/\s*[\(\[](feat\.|ft\.|featuring).*?[\)\]]/gi, '')
    // Strip remaining punctuation except alphanumeric, spaces, and single quotes
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Matches a track title against the listened dictionary using multi-tier strategy:
 * 1. Direct exact match
 * 2. Case-insensitive match
 * 3. Normalized title match
 *
 * @param {string} trackTitle
 * @param {Record<string, number>} listened
 * @returns {number} Play count of matched track, or 0
 */
/**
 * Builds a reusable lookup index over a `tracksListened` dictionary.
 *
 * `matchTrackPlayCount` re-ran `normalizeTrackTitle` (a chain of ~8 regexes) on
 * every key for every lookup, so completing one album of 20 tracks against a
 * 20-entry dictionary cost 400 regex evaluations. `calculateCompletePlays` pays
 * that once per track of every album on each call, and it is called from
 * getStats, from the sanitizer and from every play registration.
 *
 * Build the index once per album and reuse it for all of that album's lookups.
 *
 * @param {Record<string, number>} listened
 * @returns {{byLower: Map<string, number>, byNormalized: Map<string, number>}}
 */
export function createMatchIndex(listened) {
  const byLower = new Map();
  const byNormalized = new Map();

  if (!listened || typeof listened !== 'object') return { byLower, byNormalized };

  for (const [key, count] of Object.entries(listened)) {
    if (typeof count !== 'number') continue;
    const lower = key.trim().toLowerCase();
    if (!byLower.has(lower)) byLower.set(lower, count);
    const normalized = normalizeTrackTitle(key);
    if (normalized && !byNormalized.has(normalized)) byNormalized.set(normalized, count);
  }

  return { byLower, byNormalized };
}

/**
 * Index-backed variant of `matchTrackPlayCount`. Same three-tier strategy, but
 * the expensive normalization is precomputed by `createMatchIndex`.
 *
 * @param {string} trackTitle
 * @param {{byLower: Map<string, number>, byNormalized: Map<string, number>}} index
 * @returns {number}
 */
export function matchTrackPlayCountWithIndex(trackTitle, index) {
  if (!trackTitle || !index) return 0;

  const targetLower = trackTitle.trim().toLowerCase();
  const lowerHit = index.byLower.get(targetLower);
  if (lowerHit !== undefined) return lowerHit;

  const normTarget = normalizeTrackTitle(trackTitle);
  if (!normTarget) return 0;

  const normHit = index.byNormalized.get(normTarget);
  return normHit !== undefined ? normHit : 0;
}

export function matchTrackPlayCount(trackTitle, listened) {
  if (!trackTitle || !listened) return 0;
  return matchTrackPlayCountWithIndex(trackTitle, createMatchIndex(listened));
}

/**
 * Calculates how many times an album has been completely listened to.
 * An album is completed if and only if EVERY track in its official tracklist (allTracks)
 * has been listened to at least N times: completePlays = Math.min(...playCounts).
 *
 * @param {object} album
 * @returns {number}
 */
export function calculateCompletePlays(album) {
  if (!album || !Array.isArray(album.allTracks) || album.allTracks.length === 0) {
    return 0;
  }

  // One index for the whole album instead of one full re-scan of tracksListened
  // (and one re-normalization of every key) per track.
  const index = createMatchIndex(album.tracksListened);
  let minPlays = Infinity;
  for (const title of album.allTracks) {
    const count = matchTrackPlayCountWithIndex(title, index);
    if (count < minPlays) minPlays = count;
  }

  return minPlays > 0 ? minPlays : 0;
}

/**
 * Cleans the stored albums dictionary:
 * - Drops singles and false album names
 * - Recomputes completePlays via calculateCompletePlays for self-healing
 *
 * This function is deliberately PURE. It used to write `albums` back to storage
 * as a side effect, which was unsafe from three directions: it ran on read paths
 * (including getStats), it was not serialized against concurrent writers, and the
 * `cleaned` object it persisted silently *dropped* entries. A read racing a
 * play-registration `set` could therefore delete albums outright, and every write
 * fired storage.onChanged, which bounced back into getStats.
 *
 * Persisting a repair is now the caller's responsibility, under the storage lock.
 *
 * @param {Record<string, any>} albums
 * @returns {Record<string, any>}
 */
export function cleanAlbumsDict(albums) {
  if (!albums || typeof albums !== 'object') return {};
  const cleaned = {};

  for (const [key, val] of Object.entries(albums)) {
    if (!val || !val.album) continue;
    const name = val.album.trim().toLowerCase();
    if (name === 'single' || name === 'single - ep' || name === 'ep' || key.startsWith('single:::')) {
      continue;
    }

    // Sync totalTracks if allTracks is present
    if (Array.isArray(val.allTracks) && val.allTracks.length > 0) {
      val.totalTracks = val.allTracks.length;
    }

    val.completePlays = calculateCompletePlays(val);
    cleaned[key] = val;
  }

  return cleaned;
}
