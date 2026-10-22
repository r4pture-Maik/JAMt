/**
 * JAMt - Storage, State & Data Bridge Module
 * Manages local storage schema, data migrations, cached metrics compilation,
 * and the export/import pipeline.
 */

import { cleanAlbumsDict, calculateCompletePlays } from './scoring.js';
// Side-effect import: publishes the key builders on globalThis.YTMCShared so the
// content script and the background share one implementation.
import '../shared/text-keys.js';

const textKeys = globalThis.YTMCShared;
if (!textKeys || typeof textKeys.makeSongKey !== 'function') {
  throw new Error('[JAMt] shared/text-keys.js failed to register globalThis.YTMCShared');
}

// Side-effect import: registers the month helpers on `globalThis.YTMCMonths`.
import '../shared/month-keys.js';

import {
  artistKeysFor,
  buildMonthUpdates,
  readMonthState,
  recordPlayInBucket,
  sanitizeMonthsForImport
} from './monthly.js';

/**
 * Storage key holding duration accrued before its play was registered.
 * Drained by handleTrackPlayed in background.js.
 */
export const PENDING_DURATIONS_KEY = 'pendingDurations';

// Consistent dictionary key generators (see shared/text-keys.js)
export const {
  cleanText,
  normalizeKeyPart,
  splitArtists,
  primaryArtist,
  cleanTrackTitle,
  makeSongKey,
  makeArtistKey,
  makeAlbumKey
} = textKeys;

/**
 * Coerces an untrusted counter into a non-negative integer. An imported
 * `"playCount": "5"` would otherwise turn `+=` into string concatenation.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function toCount(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Adds `amount` to `dict[key]` using own properties only, so a track titled
 * "constructor" or "toString" counts from 0 instead of an inherited member.
 *
 * @param {Record<string, number>} dict
 * @param {string} key
 * @param {number} [amount=1]
 */
export function incrementCount(dict, key, amount = 1) {
  if (isDangerousKey(key)) return;
  const current = Object.prototype.hasOwnProperty.call(dict, key) ? toCount(dict[key]) : 0;
  dict[key] = current + amount;
}

/**
 * Credits one play (and its duration) to every artist of a credit string.
 *
 * @param {Record<string, object>} artists
 * @param {string} artistCredit
 * @param {number} plays
 * @param {number} durationSeconds
 */
export function addArtistPlays(artists, artistCredit, plays, durationSeconds) {
  for (const rawName of splitArtists(artistCredit)) {
    const aKey = makeArtistKey(rawName);
    if (!Object.prototype.hasOwnProperty.call(artists, aKey)) {
      artists[aKey] = { artist: rawName, playCount: plays, durationSeconds };
    } else {
      artists[aKey].playCount = toCount(artists[aKey].playCount) + plays;
      artists[aKey].durationSeconds = toCount(artists[aKey].durationSeconds) + durationSeconds;
    }
  }
}

/**
 * Copies a `tracksListened` map with cleaned titles and numeric counts, merging
 * entries that only differed by whitespace or upload tags.
 *
 * @param {unknown} listened
 * @param {string} artist
 * @returns {Record<string, number>}
 */
function cleanTracksListened(listened, artist) {
  const out = {};
  if (!listened || typeof listened !== 'object') return out;
  for (const [t, c] of Object.entries(listened)) {
    const title = cleanTrackTitle(t, artist);
    const count = toCount(c);
    if (title && count > 0) incrementCount(out, title, count);
  }
  return out;
}

const NOT_AN_ALBUM_RE = /^(?:single(?:\s*-\s*ep)?|ep|\d+:\d+(?::\d+)?|\d{4})$/i;

/**
 * Cleans title/artist/album/isSingle of a song-like record. Shared by
 * normalizeTrack (live data) and sanitizeStorageData (stored / imported data),
 * which used to carry two copies of this logic.
 *
 * @param {object} raw
 * @returns {{ title: string, artist: string, album: string, isSingle: boolean }}
 */
function cleanSongFields(raw) {
  let artist = cleanText(raw.artist);
  let album = cleanText(raw.album);
  let isSingle = Boolean(raw.isSingle);

  // "Artist • Album" (or "Artist • 3:45" / "Artist • 2019" / "Artist • Single")
  if (artist.includes('•')) {
    const parts = artist.split('•').map(p => p.trim()).filter(Boolean);
    artist = parts[0] || '';
    if (!album && parts[1] && !NOT_AN_ALBUM_RE.test(parts[1]) && !/^single/i.test(parts[1])) {
      album = parts[1];
    }
  }

  if (album.includes('•')) {
    album = album.split('•').map(p => p.trim()).filter(Boolean)[0] || '';
  }

  // Discard album if single, ep, or duration/year
  if (album && NOT_AN_ALBUM_RE.test(album)) {
    isSingle = true;
    album = '';
  }

  // If album and artist are identical, it's not a real album
  if (album && artist && album.toLowerCase() === artist.toLowerCase()) {
    album = '';
    isSingle = true;
  }

  artist = artist || 'Unknown Artist';
  return {
    title: cleanTrackTitle(raw.title, artist),
    artist,
    album,
    isSingle: isSingle || !album
  };
}

/**
 * Returns the month id (`YYYY-MM`, local time) that live plays and duration ticks are booked to.
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function currentMonthId(now = new Date()) {
  return globalThis.YTMCMonths.monthIdFromDate(now);
}

/**
 * Picks the month a history track is booked to. The month comes from the content script, so it
 * is untrusted: anything that is not a valid month id, or that lies after the current month,
 * falls back to the current month.
 *
 * @param {any} rawMonth  e.g. "2025-09"
 * @param {string} current  current month id
 * @returns {string}
 */
export function resolveTrackMonth(rawMonth, current) {
  const { isValidMonthId, compareMonthIds } = globalThis.YTMCMonths;
  if (isValidMonthId(rawMonth) && compareMonthIds(rawMonth, current) <= 0) {
    return rawMonth;
  }
  return current;
}

// In-memory cache for compiled statistics
let statsCache = null;

/**
 * Rejects dictionary keys that would reach `Object.prototype` when used as a
 * plain-object property. An imported backup is untrusted input, and assigning
 * `obj['__proto__'] = value` mutates the object's prototype rather than storing
 * a record.
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isDangerousKey(key) {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

export function invalidateStatsCache() {
  statsCache = null;
}

/**
 * Serializes every read-modify-write cycle on the shared dictionaries.
 *
 * `storage.local` has no atomic read-modify-write, and the extension writes
 * `songs`/`artists`/`albums` from several independent paths (play registration,
 * duration ticks every 5s, history import, cover backfill, tracklist writes).
 * Without this lock two overlapping handlers read the same snapshot and the
 * second `set` silently discards the first one's increment.
 *
 * The chain is never rejected, so one failing task cannot poison every task
 * queued behind it. Tasks must NOT call each other while holding the lock.
 */
let storageLockChain = Promise.resolve();

export function withStorageLock(task) {
  const run = storageLockChain.then(() => task());
  storageLockChain = run.then(() => {}, () => {});
  return run;
}

/**
 * Normalizes and sanitizes track metadata extracted from DOM / MediaSession
 *
 * @param {object} rawTrack
 * @returns {object|null}
 */
export function normalizeTrack(rawTrack) {
  if (!rawTrack) return null;
  return {
    ...rawTrack,
    ...cleanSongFields(rawTrack),
    durationSeconds: toCount(rawTrack.durationSeconds)
  };
}

/**
 * Self-healing data sanitizer to fix any corrupted artist/album metadata
 *
 * @param {object} data
 * @returns {{ modified: boolean, songs: object, artists: object, albums: object }}
 */
export function sanitizeStorageData(data) {
  let modified = false;
  const rawSongs = (data && data.songs) || {};
  const rawAlbums = (data && data.albums) || {};
  const rawArtists = (data && data.artists) || {};
  const cleanSongs = {};
  const cleanAlbums = {};

  // 1. Sanitize songs
  for (const [key, song] of Object.entries(rawSongs)) {
    if (!song || typeof song !== 'object' || !cleanText(song.title)) {
      modified = true;
      continue;
    }
    if (isDangerousKey(key)) {
      // An untrusted import could otherwise assign to Object.prototype.
      modified = true;
      continue;
    }
    const fields = cleanSongFields(song);
    const durationSeconds = toCount(song.durationSeconds);
    const playCount = toCount(song.playCount) || 1;

    if (fields.title !== song.title || fields.artist !== song.artist || fields.album !== (song.album || '')
      || fields.isSingle !== Boolean(song.isSingle)
      || (song.durationSeconds !== undefined && durationSeconds !== song.durationSeconds)
      || (song.playCount !== undefined && playCount !== song.playCount)) {
      modified = true;
    }

    const cleanKey = makeSongKey(fields.title, fields.artist);
    if (cleanKey !== key) modified = true;

    if (!Object.prototype.hasOwnProperty.call(cleanSongs, cleanKey)) {
      cleanSongs[cleanKey] = { ...song, ...fields, playCount, durationSeconds };
    } else {
      const target = cleanSongs[cleanKey];
      target.playCount += playCount;
      target.durationSeconds += durationSeconds;
      if (fields.album && !target.album) {
        target.album = fields.album;
        target.isSingle = false;
      }
      modified = true;
    }
  }

  // 2. Sanitize albums
  // Index built once so the artist-recovery lookups below stay O(1) instead of
  // scanning every song for every listened track of every album.
  const songsByTitle = new Map();
  const songsByAlbum = new Map();
  for (const song of Object.values(cleanSongs)) {
    const lowerTitle = song.title.toLowerCase();
    if (!songsByTitle.has(lowerTitle)) songsByTitle.set(lowerTitle, song);

    if (song.album) {
      const lowerAlbum = song.album.toLowerCase();
      if (!songsByAlbum.has(lowerAlbum)) songsByAlbum.set(lowerAlbum, song);
    }
  }

  // 2. Sanitize albums
  for (const [key, alb] of Object.entries(rawAlbums)) {
    if (!alb || typeof alb !== 'object' || !cleanText(alb.album)) {
      modified = true;
      continue;
    }
    if (isDangerousKey(key)) {
      // Same as above: never let imported data reach Object.prototype.
      modified = true;
      continue;
    }
    const albumName = cleanText(alb.album);
    let albumArtist = cleanText(alb.artist);
    const durationSeconds = toCount(alb.durationSeconds);
    if (albumName !== alb.album) modified = true;

    if (albumArtist.includes('•')) {
      albumArtist = albumArtist.split('•')[0].trim();
      modified = true;
    }

    // If albumArtist is identical to albumName, recover true artist from cleanSongs
    if (!albumArtist || albumArtist.toLowerCase() === albumName.toLowerCase()) {
      const lowerAlbumName = albumName.toLowerCase();
      let matchedArtist = '';
      for (const tTitle of Object.keys(alb.tracksListened || {})) {
        const matchingSong = songsByTitle.get(tTitle.trim().toLowerCase());
        if (matchingSong && matchingSong.artist && matchingSong.artist.toLowerCase() !== lowerAlbumName) {
          matchedArtist = matchingSong.artist;
          break;
        }
      }
      if (!matchedArtist) {
        const songWithAlbum = songsByAlbum.get(lowerAlbumName);
        if (songWithAlbum && songWithAlbum.artist && songWithAlbum.artist.toLowerCase() !== lowerAlbumName) {
          matchedArtist = songWithAlbum.artist;
        }
      }

      if (matchedArtist) {
        albumArtist = matchedArtist;
        modified = true;
      }
    }

    const lowerAlb = albumName.toLowerCase();
    if (lowerAlb === 'single' || lowerAlb === 'single - ep' || lowerAlb === 'ep' || /^\d+:\d+$/.test(albumName) || /^\d{4}$/.test(albumName)) {
      modified = true;
      continue;
    }

    // Discard album if artist is still identical to album name
    if (albumArtist && albumArtist.toLowerCase() === albumName.toLowerCase()) {
      modified = true;
      continue;
    }

    const cleanAlbKey = makeAlbumKey(albumName, albumArtist);
    if (cleanAlbKey !== key) modified = true;

    const playCount = toCount(alb.playCount) || 1;
    if (!Object.prototype.hasOwnProperty.call(cleanAlbums, cleanAlbKey)) {
      cleanAlbums[cleanAlbKey] = {
        ...alb,
        album: albumName,
        artist: albumArtist || 'Unknown Artist',
        playCount,
        durationSeconds,
        tracksListened: cleanTracksListened(alb.tracksListened, albumArtist)
      };
      if (alb.tracksListened) {
        cleanAlbums[cleanAlbKey].uniqueTracksCount = Object.keys(cleanAlbums[cleanAlbKey].tracksListened).length;
      } else {
        delete cleanAlbums[cleanAlbKey].tracksListened;
      }
      if (!Array.isArray(alb.allTracks)) delete cleanAlbums[cleanAlbKey].allTracks;
      cleanAlbums[cleanAlbKey].completePlays = calculateCompletePlays(cleanAlbums[cleanAlbKey]);
    } else {
      const target = cleanAlbums[cleanAlbKey];
      target.playCount += playCount;
      target.durationSeconds += durationSeconds;
      if (alb.totalTracks && !target.totalTracks) target.totalTracks = alb.totalTracks;
      if (Array.isArray(alb.allTracks) && !target.allTracks) target.allTracks = alb.allTracks;
      if (alb.albumBrowseId && !target.albumBrowseId) target.albumBrowseId = alb.albumBrowseId;
      if (alb.coverUrl && !target.coverUrl) target.coverUrl = alb.coverUrl;
      if (alb.tracksListened && typeof alb.tracksListened === 'object') {
        if (!target.tracksListened) target.tracksListened = {};
        for (const [t, c] of Object.entries(cleanTracksListened(alb.tracksListened, albumArtist))) {
          incrementCount(target.tracksListened, t, c);
        }
        target.uniqueTracksCount = Object.keys(target.tracksListened).length;
      }
      target.completePlays = calculateCompletePlays(target);
      modified = true;
    }
  }

  // 3. Rebuild artists dictionary purely from cleanSongs
  const cleanArtists = {};
  for (const song of Object.values(cleanSongs)) {
    if (!song.artist || song.artist === 'Unknown Artist') continue;
    addArtistPlays(cleanArtists, song.artist, song.playCount, song.durationSeconds);
  }

  // Any difference in keys or counters means the stored dictionary was stale.
  const rawArtistKeys = Object.keys(rawArtists);
  if (rawArtistKeys.length !== Object.keys(cleanArtists).length
    || rawArtistKeys.some(k => !Object.prototype.hasOwnProperty.call(cleanArtists, k)
      || !rawArtists[k] || rawArtists[k].playCount !== cleanArtists[k].playCount)) {
    modified = true;
  }

  return {
    modified,
    songs: cleanSongs,
    artists: cleanArtists,
    albums: cleanAlbums
  };
}

/**
 * Initializes default storage schema & heals legacy entries
 *
 * @param {object} extBrowser
 */
export async function initializeStorage(extBrowser) {
  if (!extBrowser || !extBrowser.storage || !extBrowser.storage.local) return;
  try {
    const data = await extBrowser.storage.local.get([
      'totalPlays',
      'totalListeningSeconds',
      'songs',
      'artists',
      'albums',
      'historySyncState'
    ]);
    const sanitized = sanitizeStorageData(data);
    const updates = {};
    if (typeof data.totalPlays === 'undefined') updates.totalPlays = 0;
    if (typeof data.totalListeningSeconds === 'undefined') updates.totalListeningSeconds = 0;
    if (typeof data.historySyncState === 'undefined') updates.historySyncState = null;

    if (sanitized.modified || !data.songs || !data.artists || !data.albums) {
      updates.songs = sanitized.songs;
      updates.artists = sanitized.artists;
      updates.albums = sanitized.albums;
      invalidateStatsCache();
    }

    // Remove legacy 'history' if present from previous versions
    await extBrowser.storage.local.remove('history');

    if (Object.keys(updates).length > 0) {
      await extBrowser.storage.local.set(updates);
    }
  } catch (err) {
    console.error('[JAMt Background] Storage init error:', err);
  }
}

/**
 * Compiles aggregated statistics with Top 3 rankings, listening duration, and caching
 *
 * The payload carries raw numbers only (`totalListeningSeconds`, play counts, ...).
 * The background never formats user-facing text (AD-10): it cannot honour the
 * in-app locale override, and any sentence it produced would be a fixed English
 * string baked into the wire format. The UI composes display text from these
 * values via `YTMCI18n` instead.
 *
 * @param {object} extBrowser
 * @returns {Promise<object>}
 */
export async function getStats(extBrowser) {
  if (statsCache) {
    return statsCache;
  }

  if (!extBrowser || !extBrowser.storage || !extBrowser.storage.local) {
    return {
      totalPlays: 0,
      totalListeningSeconds: 0,
      currentTrack: null,
      uniqueSongsCount: 0,
      uniqueArtistsCount: 0,
      uniqueAlbumsCount: 0,
      singlesCount: 0,
      completedAlbumsCount: 0,
      topSongs: [],
      topArtists: [],
      topAlbums: [],
      allAlbums: []
    };
  }

  const data = await extBrowser.storage.local.get([
    'totalPlays',
    'totalListeningSeconds',
    'songs',
    'artists',
    'albums',
    'currentTrack'
  ]);
  const sanitized = sanitizeStorageData(data);
  const songs = sanitized.songs;
  const artists = sanitized.artists;
  // Pure read: persistence of any repair is the caller's job, under the lock.
  const albums = cleanAlbumsDict(sanitized.albums);
  const totalListeningSeconds = Math.max(0, Math.round(data.totalListeningSeconds || 0));

  // Sort top items for each category (Top 3)
  const topSongs = Object.values(songs)
    .sort((a, b) => b.playCount - a.playCount)
    .slice(0, 3);

  const topArtists = Object.values(artists)
    .sort((a, b) => b.playCount - a.playCount)
    .slice(0, 3);

  const sortedAlbums = Object.values(albums)
    .sort((a, b) => {
      const aScore = (a.completePlays || 0) * 100 + (a.playCount || 0);
      const bScore = (b.completePlays || 0) * 100 + (b.playCount || 0);
      return bScore - aScore;
    });

  const topAlbums = sortedAlbums.slice(0, 3);

  const singlesCount = Object.values(songs).filter(s => s.isSingle || !s.album).length;
  const completedAlbumsCount = Object.values(albums).reduce(
    (sum, a) => sum + (a.completePlays || 0),
    0
  );

  // `allTracks` is intentionally stripped from the broadcast payload. It is by
  // far the heaviest field (one entry per track of every album) and is only
  // needed once a card is expanded, which already re-fetches it through
  // GET_ALBUM_DETAILS. Shipping it made every GET_STATS message hundreds of KB.
  const allAlbums = sortedAlbums.map(album => {
    const { allTracks, ...lightweight } = album;
    return lightweight;
  });

  statsCache = {
    totalPlays: data.totalPlays || 0,
    totalListeningSeconds,
    currentTrack: data.currentTrack || null,
    uniqueSongsCount: Object.keys(songs).length,
    uniqueArtistsCount: Object.keys(artists).length,
    uniqueAlbumsCount: Object.keys(albums).length,
    singlesCount,
    completedAlbumsCount,
    topSongs,
    topArtists,
    topAlbums,
    allAlbums
  };

  return statsCache;
}

/**
 * Resets all statistics and storage
 *
 * @param {object} extBrowser
 * @param {object} [thumbnailCache]
 * @returns {Promise<object>}
 */
export async function resetStats(extBrowser, thumbnailCache = null) {
  const emptyState = {
    totalPlays: 0,
    totalListeningSeconds: 0,
    songs: {},
    artists: {},
    albums: {},
    currentTrack: null,
    historySyncState: null,
    scanProgress: null,
    monthIndex: []
  };
  if (extBrowser && extBrowser.storage && extBrowser.storage.local) {
    await extBrowser.storage.local.clear();
    await extBrowser.storage.local.set(emptyState);
  }
  invalidateStatsCache();

  // Clear local media cache
  if (thumbnailCache && thumbnailCache.clearThumbnailCache) {
    try {
      await thumbnailCache.clearThumbnailCache();
    } catch (_) {}
  }

  return emptyState;
}

/**
 * Schema version written into export bundles. Bump it whenever the bundle
 * changes shape; it is data inside the JSON, never part of a function or
 * message name.
 */
export const EXPORT_SCHEMA_VERSION = 3;

/**
 * Oldest bundle format the importer reads. Every bundle from here up to
 * EXPORT_SCHEMA_VERSION shares one reader: newer fields (e.g. `months`) are
 * optional, so an older bundle simply lacks them.
 */
const MIN_IMPORT_SCHEMA_VERSION = 2;

/**
 * @param {object} input
 * @returns {boolean} Whether `input` declares a supported export bundle format.
 */
function isExportBundle(input) {
  const v = input.schemaVersion;
  return Number.isInteger(v) && v >= MIN_IMPORT_SCHEMA_VERSION && v <= EXPORT_SCHEMA_VERSION;
}

/**
 * Version from the live manifest, whichever namespace the engine exposes
 * (`browser.*` on Firefox / Chrome >= 148, `chrome.*` otherwise).
 *
 * @returns {string} The manifest version, or '' outside an extension context.
 */
function readManifestVersion() {
  for (const ns of [globalThis.browser, globalThis.chrome]) {
    try {
      const version = ns && ns.runtime && ns.runtime.getManifest && ns.runtime.getManifest().version;
      if (version) return version;
    } catch (_) {}
  }
  return '';
}

/**
 * Creates a standardized export bundle (EXPORT_SCHEMA_VERSION) from current storage state.
 * Guaranteed to strip Google account tokens, internal tokens, or non-portable cookies.
 *
 * @param {object} rawStorage
 * @param {string} [extensionVersion] The manifest version, passed by the
 *   background. The live manifest wins when it is reachable; this is the
 *   fallback for contexts where no extension namespace is global.
 * @returns {object} Export bundle
 */
export function createExportBundle(rawStorage, extensionVersion) {
  const source = (rawStorage && typeof rawStorage === 'object') ? rawStorage : {};
  const sanitized = sanitizeStorageData(source);
  const totalPlays = Math.max(0, Math.round(source.totalPlays || 0));
  const totalListeningSeconds = Math.max(0, Math.round(source.totalListeningSeconds || 0));
  const historySync = source.historySyncState || {};

  const cleanSongs = {};
  for (const [key, s] of Object.entries(sanitized.songs || {})) {
    cleanSongs[key] = {
      title: s.title || '',
      artist: s.artist || '',
      album: s.album || '',
      playCount: s.playCount || 0,
      durationSeconds: s.durationSeconds || 0,
      isSingle: Boolean(s.isSingle)
    };
  }

  const cleanArtists = {};
  for (const [key, a] of Object.entries(sanitized.artists || {})) {
    cleanArtists[key] = {
      artist: a.artist || '',
      playCount: a.playCount || 0,
      durationSeconds: a.durationSeconds || 0
    };
  }

  const cleanAlbums = {};
  for (const [key, a] of Object.entries(sanitized.albums || {})) {
    cleanAlbums[key] = {
      album: a.album || '',
      artist: a.artist || '',
      playCount: a.playCount || 0,
      durationSeconds: a.durationSeconds || 0,
      completePlays: a.completePlays || 0,
      totalTracks: a.totalTracks || (Array.isArray(a.allTracks) ? a.allTracks.length : null),
      uniqueTracksCount: a.uniqueTracksCount || (a.tracksListened ? Object.keys(a.tracksListened).length : 0),
      ...(a.coverUrl ? { coverUrl: a.coverUrl } : {}),
      ...(a.albumBrowseId ? { albumBrowseId: a.albumBrowseId } : {}),
      ...(a.tracksListened ? { tracksListened: a.tracksListened } : {}),
      ...(Array.isArray(a.allTracks) ? { allTracks: a.allTracks } : {})
    };
  }

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    // Read from the live manifest so it can never drift from manifest.json.
    extensionVersion: readManifestVersion() || extensionVersion || 'unknown',
    metrics: {
      totalPlays,
      totalListeningSeconds
    },
    songs: cleanSongs,
    artists: cleanArtists,
    albums: cleanAlbums,
    months: sanitizeMonthsForImport(source.months),
    syncWatermark: {
      lastTrackTitle: historySync.lastTrackTitle || undefined,
      lastTrackArtist: historySync.lastTrackArtist || undefined,
      lastSyncTimestamp: historySync.lastSyncTimestamp || undefined
    }
  };
}

/**
 * Validates and migrates an imported JSON object: any export bundle up to EXPORT_SCHEMA_VERSION, or a legacy flat backup
 *
 * @param {any} input
 * @returns {{ valid: boolean, errorCode?: string, error?: string, bundle?: object }}
 *   `errorCode` is a stable machine-readable code the UI maps to a localized
 *   message; `error` is the English sentence kept as a fallback for callers
 *   (and log output) that have no catalog available. Codes:
 *   `importInvalidJson` | `malformedBackup` | `unrecognizedBackupFormat`.
 */
export function validateAndMigrateImport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errorCode: 'importInvalidJson', error: 'Import payload must be a valid JSON object.' };
  }

  // Export bundle: optional fields are read when present, whatever the version.
  if (isExportBundle(input)) {
    if (!input.songs || typeof input.songs !== 'object' || !input.artists || typeof input.artists !== 'object') {
      return { valid: false, errorCode: 'malformedBackup', error: 'Malformed backup: songs or artists dictionary missing.' };
    }
    const metrics = input.metrics || {};
    const totalPlays = Math.max(0, Math.round(metrics.totalPlays || 0));
    const totalListeningSeconds = Math.max(0, Math.round(metrics.totalListeningSeconds || 0));
    const sanitized = sanitizeStorageData({ songs: input.songs, albums: input.albums, artists: input.artists });

    return {
      valid: true,
      bundle: {
        schemaVersion: EXPORT_SCHEMA_VERSION,
        totalPlays,
        totalListeningSeconds,
        songs: sanitized.songs,
        artists: sanitized.artists,
        albums: cleanAlbumsDict(sanitized.albums),
        months: sanitizeMonthsForImport(input.months),
        historySyncState: input.syncWatermark ? {
          lastTrackTitle: input.syncWatermark.lastTrackTitle,
          lastTrackArtist: input.syncWatermark.lastTrackArtist,
          lastSyncTimestamp: input.syncWatermark.lastSyncTimestamp
        } : null
      }
    };
  }

  // Legacy flat backup (no schemaVersion): songs/artists/albums directly on top level or inside data
  const legacyData = input.data && typeof input.data === 'object' ? input.data : input;
  if (!legacyData.songs && !legacyData.artists && !legacyData.albums) {
    return { valid: false, errorCode: 'unrecognizedBackupFormat', error: 'Unrecognized backup format. No songs, artists, or albums found.' };
  }

  const sanitized = sanitizeStorageData(legacyData);
  let computedPlays = legacyData.totalPlays || 0;
  if (!computedPlays && sanitized.songs) {
    computedPlays = Object.values(sanitized.songs).reduce((sum, s) => sum + (s.playCount || 1), 0);
  }

  return {
    valid: true,
    bundle: {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      totalPlays: Math.max(0, Math.round(computedPlays)),
      totalListeningSeconds: Math.max(0, Math.round(legacyData.totalListeningSeconds || 0)),
      songs: sanitized.songs,
      artists: sanitized.artists,
      albums: cleanAlbumsDict(sanitized.albums),
      months: {},
      historySyncState: legacyData.historySyncState || null
    }
  };
}

/**
 * Ingests an array of history tracks extracted from YouTube Music
 * Updates total plays, duration, songs, artists, and album progress.
 *
 * @param {object} payload
 * @param {object} extBrowser
 * @returns {Promise<object>}
 */
export async function importHistoryTracks(payload, extBrowser) {
  const tracks = (payload && payload.tracks) || [];
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return { importedCount: 0, totalPlays: 0 };
  }

  // Serialized against live play registration and duration ticks: a history import
  // is a long read-modify-write over the same dictionaries, and without the lock it
  // would discard whatever a tick wrote in the meantime.
  return withStorageLock(async () => {
  const data = await extBrowser.storage.local.get(['totalPlays', 'totalListeningSeconds', 'songs', 'artists', 'albums']);
  let totalPlays = data.totalPlays || 0;
  let totalListeningSeconds = Math.max(0, Math.round(data.totalListeningSeconds || 0));
  const songs = data.songs || {};
  const artists = data.artists || {};
  const albums = cleanAlbumsDict(data.albums || {});

  // Month of each counted track, resolved up front so every bucket it touches is read in one call.
  const current = currentMonthId();
  const trackMonths = tracks.map((rawTrack) => {
    const track = normalizeTrack(rawTrack);
    return track && track.title ? resolveTrackMonth(rawTrack.listenedMonth, current) : null;
  });
  const monthIds = [...new Set(trackMonths.filter(Boolean))];
  const { index: monthIndex, buckets: monthBuckets } = await readMonthState(extBrowser, monthIds);
  const touchedMonths = new Set();

  let newPlaysCount = 0;

  for (const [trackIndex, rawTrack] of tracks.entries()) {
    const track = normalizeTrack(rawTrack);
    if (!track || !track.title) continue;

    const monthId = trackMonths[trackIndex];
    const trackDuration = Math.max(0, Math.round(track.durationSeconds || 0));
    totalPlays += 1;
    totalListeningSeconds += trackDuration;
    newPlaysCount += 1;

    const songKey = makeSongKey(track.title, track.artist);
    const isSingle = Boolean(track.isSingle || !track.album || /^single(\s*-\s*ep)?$/i.test(track.album) || /^ep$/i.test(track.album));
    const albumName = isSingle ? '' : (track.album || '');

    if (!songs[songKey]) {
      songs[songKey] = {
        title: track.title,
        artist: track.artist || 'Unknown Artist',
        album: albumName,
        isSingle: isSingle,
        playCount: 1,
        durationSeconds: trackDuration
      };
    } else {
      songs[songKey].playCount = (songs[songKey].playCount || 0) + 1;
      songs[songKey].durationSeconds = (songs[songKey].durationSeconds || 0) + trackDuration;
      if (albumName && !songs[songKey].album) {
        songs[songKey].album = albumName;
      }
      if (typeof track.isSingle !== 'undefined') {
        songs[songKey].isSingle = isSingle;
      }
    }

    if (track.artist) {
      addArtistPlays(artists, track.artist, 1, trackDuration);
    }

    if (albumName) {
      const albumKey = makeAlbumKey(albumName, track.artist);
      if (!albums[albumKey]) {
        albums[albumKey] = {
          album: albumName,
          artist: track.artist || 'Unknown Artist',
          albumBrowseId: track.albumBrowseId || '',
          coverUrl: track.coverUrl || '',
          tracksListened: {
            [track.title]: 1
          },
          uniqueTracksCount: 1,
          totalTracks: track.totalTracks || (Array.isArray(track.allTracks) ? track.allTracks.length : null),
          allTracks: Array.isArray(track.allTracks) ? track.allTracks : undefined,
          playCount: 1,
          durationSeconds: trackDuration,
          completePlays: 0
        };
      } else {
        albums[albumKey].playCount = (albums[albumKey].playCount || 0) + 1;
        albums[albumKey].durationSeconds = (albums[albumKey].durationSeconds || 0) + trackDuration;
        if (!albums[albumKey].tracksListened) albums[albumKey].tracksListened = {};
        incrementCount(albums[albumKey].tracksListened, track.title);
        albums[albumKey].uniqueTracksCount = Object.keys(albums[albumKey].tracksListened).length;
        if (track.albumBrowseId && !albums[albumKey].albumBrowseId) {
          albums[albumKey].albumBrowseId = track.albumBrowseId;
        }
        if (track.coverUrl && !albums[albumKey].coverUrl) {
          albums[albumKey].coverUrl = track.coverUrl;
        }
        if (track.totalTracks && !albums[albumKey].totalTracks) {
          albums[albumKey].totalTracks = track.totalTracks;
        }
        if (Array.isArray(track.allTracks) && !albums[albumKey].allTracks) {
          albums[albumKey].allTracks = track.allTracks;
        }
      }
    }

    recordPlayInBucket(monthBuckets[monthId], {
      songKey,
      artistKeys: artistKeysFor(track.artist),
      albumKey: albumName ? makeAlbumKey(albumName, track.artist) : '',
      seconds: trackDuration
    });
    touchedMonths.add(monthId);
  }

  for (const alb of Object.values(albums)) {
    if (!alb.totalTracks && Array.isArray(alb.allTracks) && alb.allTracks.length > 0) {
      alb.totalTracks = alb.allTracks.length;
    }
    alb.completePlays = calculateCompletePlays(alb);
  }

  const storageUpdates = {
    totalPlays,
    totalListeningSeconds,
    songs,
    artists,
    albums
  };
  if (touchedMonths.size > 0) {
    const touched = {};
    for (const id of touchedMonths) touched[id] = monthBuckets[id];
    Object.assign(storageUpdates, buildMonthUpdates(monthIndex, touched));
  }
  if (payload.newSyncState) {
    storageUpdates.historySyncState = payload.newSyncState;
  }

  await extBrowser.storage.local.set(storageUpdates);
  invalidateStatsCache();

  const singlesCount = Object.values(songs).filter(s => s.isSingle || !s.album).length;

  return {
    importedCount: newPlaysCount,
    totalPlays,
    totalListeningSeconds,
    uniqueSongs: Object.keys(songs).length,
    uniqueArtists: Object.keys(artists).length,
    uniqueAlbums: Object.keys(albums).length,
    singlesCount,
    historySyncState: payload.newSyncState || null
  };
  });
}
