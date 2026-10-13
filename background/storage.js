/**
 * JAMt - Storage, State & Data Bridge Module
 * Manages local storage schema, data migrations, cached metrics compilation,
 * and Schema v2 versioned export/import pipelines.
 */

import { cleanAlbumsDict, calculateCompletePlays } from './scoring.js';

/**
 * Storage key holding duration accrued before its play was registered.
 * Drained by handleTrackPlayed in background.js.
 */
export const PENDING_DURATIONS_KEY = 'pendingDurations';

// Consistent dictionary key generators
export function makeSongKey(title, artist) {
  return `${(title || '').trim().toLowerCase()}:::${(artist || '').trim().toLowerCase()}`;
}

export function makeArtistKey(artist) {
  return (artist || '').trim().toLowerCase();
}

export function makeAlbumKey(album, artist) {
  return `${(album || '').trim().toLowerCase()}:::${(artist || '').trim().toLowerCase()}`;
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
  let title = (rawTrack.title || '').trim();
  let artist = (rawTrack.artist || '').trim();
  let album = (rawTrack.album || '').trim();
  let isSingle = Boolean(rawTrack.isSingle);

  // If artist contains bullet "•" (e.g. "Artist • Album")
  if (artist.includes('•')) {
    const parts = artist.split('•').map(p => p.trim()).filter(Boolean);
    artist = parts[0] || 'Unknown Artist';
    if (!album && parts[1] && !/^\d+:\d+$/.test(parts[1]) && !/^\d{4}$/.test(parts[1]) && !/^single/i.test(parts[1])) {
      album = parts[1];
    }
  }

  // If album contains bullet "•"
  if (album.includes('•')) {
    const parts = album.split('•').map(p => p.trim()).filter(Boolean);
    album = parts[0] || '';
  }

  // Discard album if single, ep, or duration/year
  if (album && (/^single(\s*-\s*ep)?$/i.test(album) || /^ep$/i.test(album) || /^\d+:\d+(:\d+)?$/.test(album) || /^\d{4}$/.test(album))) {
    isSingle = true;
    album = '';
  }

  // If album and artist are identical, it's not a real album
  if (album && artist && album.toLowerCase() === artist.toLowerCase()) {
    album = '';
    isSingle = true;
  }

  const durationSeconds = Math.max(0, Math.round(rawTrack.durationSeconds || 0));

  return {
    ...rawTrack,
    title,
    artist: artist || 'Unknown Artist',
    album,
    isSingle: isSingle || !album,
    durationSeconds
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
    if (!song || !song.title) continue;
    if (isDangerousKey(key)) {
      // An untrusted import could otherwise assign to Object.prototype.
      modified = true;
      continue;
    }
    let title = song.title.trim();
    let artist = (song.artist || '').trim();
    let album = (song.album || '').trim();
    let isSingle = Boolean(song.isSingle);
    const durationSeconds = Math.max(0, Math.round(song.durationSeconds || 0));

    if (artist.includes('•')) {
      const parts = artist.split('•').map(p => p.trim()).filter(Boolean);
      artist = parts[0] || 'Unknown Artist';
      if (!album && parts[1] && !/^\d+:\d+$/.test(parts[1]) && !/^\d{4}$/.test(parts[1]) && !/^single/i.test(parts[1])) {
        album = parts[1];
      }
      modified = true;
    }

    if (album.includes('•')) {
      const parts = album.split('•').map(p => p.trim()).filter(Boolean);
      album = parts[0] || '';
      modified = true;
    }

    if (album && (/^single(\s*-\s*ep)?$/i.test(album) || /^ep$/i.test(album) || /^\d+:\d+(:\d+)?$/.test(album) || /^\d{4}$/.test(album))) {
      isSingle = true;
      album = '';
      modified = true;
    }

    if (album && artist && album.toLowerCase() === artist.toLowerCase()) {
      album = '';
      isSingle = true;
      modified = true;
    }

    const cleanKey = makeSongKey(title, artist);
    if (cleanKey !== key) modified = true;

    if (!cleanSongs[cleanKey]) {
      cleanSongs[cleanKey] = {
        ...song,
        title,
        artist: artist || 'Unknown Artist',
        album,
        isSingle: isSingle || !album,
        durationSeconds
      };
    } else {
      cleanSongs[cleanKey].playCount = (cleanSongs[cleanKey].playCount || 0) + (song.playCount || 1);
      cleanSongs[cleanKey].durationSeconds = (cleanSongs[cleanKey].durationSeconds || 0) + durationSeconds;
      if (album && !cleanSongs[cleanKey].album) cleanSongs[cleanKey].album = album;
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
    if (!alb || !alb.album) continue;
    if (isDangerousKey(key)) {
      // Same as above: never let imported data reach Object.prototype.
      modified = true;
      continue;
    }
    let albumName = alb.album.trim();
    let albumArtist = (alb.artist || '').trim();
    const durationSeconds = Math.max(0, Math.round(alb.durationSeconds || 0));

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

    if (!cleanAlbums[cleanAlbKey]) {
      cleanAlbums[cleanAlbKey] = {
        ...alb,
        album: albumName,
        artist: albumArtist || 'Unknown Artist',
        durationSeconds
      };
      cleanAlbums[cleanAlbKey].completePlays = calculateCompletePlays(cleanAlbums[cleanAlbKey]);
    } else {
      cleanAlbums[cleanAlbKey].playCount = (cleanAlbums[cleanAlbKey].playCount || 0) + (alb.playCount || 1);
      cleanAlbums[cleanAlbKey].durationSeconds = (cleanAlbums[cleanAlbKey].durationSeconds || 0) + durationSeconds;
      if (alb.totalTracks && !cleanAlbums[cleanAlbKey].totalTracks) cleanAlbums[cleanAlbKey].totalTracks = alb.totalTracks;
      if (alb.allTracks && !cleanAlbums[cleanAlbKey].allTracks) cleanAlbums[cleanAlbKey].allTracks = alb.allTracks;
      if (alb.albumBrowseId && !cleanAlbums[cleanAlbKey].albumBrowseId) cleanAlbums[cleanAlbKey].albumBrowseId = alb.albumBrowseId;
      if (alb.tracksListened) {
        if (!cleanAlbums[cleanAlbKey].tracksListened) cleanAlbums[cleanAlbKey].tracksListened = {};
        for (const [t, c] of Object.entries(alb.tracksListened)) {
          cleanAlbums[cleanAlbKey].tracksListened[t] = (cleanAlbums[cleanAlbKey].tracksListened[t] || 0) + c;
        }
        cleanAlbums[cleanAlbKey].uniqueTracksCount = Object.keys(cleanAlbums[cleanAlbKey].tracksListened).length;
      }
      cleanAlbums[cleanAlbKey].completePlays = calculateCompletePlays(cleanAlbums[cleanAlbKey]);
      modified = true;
    }
  }

  // 3. Rebuild artists dictionary purely from cleanSongs
  const cleanArtists = {};
  for (const song of Object.values(cleanSongs)) {
    if (!song.artist || song.artist === 'Unknown Artist') continue;
    const artistList = song.artist.split(/[,&/]| feat\.? | ft\.? /i).map(a => a.trim()).filter(Boolean);
    artistList.forEach(rawName => {
      const aKey = makeArtistKey(rawName);
      if (!cleanArtists[aKey]) {
        cleanArtists[aKey] = {
          artist: rawName,
          playCount: song.playCount || 1,
          durationSeconds: song.durationSeconds || 0
        };
      } else {
        cleanArtists[aKey].playCount += (song.playCount || 1);
        cleanArtists[aKey].durationSeconds = (cleanArtists[aKey].durationSeconds || 0) + (song.durationSeconds || 0);
      }
    });
  }

  const oldArtistCount = Object.keys(rawArtists).length;
  const newArtistCount = Object.keys(cleanArtists).length;
  if (oldArtistCount !== newArtistCount) modified = true;

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
    scanProgress: null
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
 * Creates a standardized ExportBundleV2 from current storage state.
 * Guaranteed to strip Google account tokens, internal tokens, or non-portable cookies.
 *
 * @param {object} rawStorage
 * @param {string} [extensionVersion='1.1.0']
 * @returns {object} ExportBundleV2
 */
export function createExportBundleV2(rawStorage, extensionVersion) {
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
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    // Read from the live manifest so it can never drift from manifest.json.
    extensionVersion: (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
      ? chrome.runtime.getManifest().version
      : (extensionVersion || 'unknown'),
    metrics: {
      totalPlays,
      totalListeningSeconds
    },
    songs: cleanSongs,
    artists: cleanArtists,
    albums: cleanAlbums,
    syncWatermark: {
      lastTrackTitle: historySync.lastTrackTitle || undefined,
      lastTrackArtist: historySync.lastTrackArtist || undefined,
      lastSyncTimestamp: historySync.lastSyncTimestamp || undefined
    }
  };
}

/**
 * Validates and migrates an imported JSON object (handles both Schema v1 legacy and Schema v2)
 *
 * @param {any} input
 * @returns {{ valid: boolean, errorCode?: string, error?: string, bundle?: object }}
 *   `errorCode` is a stable machine-readable code the UI maps to a localized
 *   message; `error` is the English sentence kept as a fallback for callers
 *   (and log output) that have no catalog available. Codes:
 *   `importInvalidJson` | `malformedSchemaV2` | `unrecognizedBackupFormat`.
 */
export function validateAndMigrateImport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errorCode: 'importInvalidJson', error: 'Import payload must be a valid JSON object.' };
  }

  // Schema v2 validation
  if (input.schemaVersion === 2) {
    if (!input.songs || typeof input.songs !== 'object' || !input.artists || typeof input.artists !== 'object') {
      return { valid: false, errorCode: 'malformedSchemaV2', error: 'Malformed Schema v2: songs or artists dictionary missing.' };
    }
    const metrics = input.metrics || {};
    const totalPlays = Math.max(0, Math.round(metrics.totalPlays || 0));
    const totalListeningSeconds = Math.max(0, Math.round(metrics.totalListeningSeconds || 0));
    const sanitized = sanitizeStorageData({ songs: input.songs, albums: input.albums, artists: input.artists });

    return {
      valid: true,
      bundle: {
        schemaVersion: 2,
        totalPlays,
        totalListeningSeconds,
        songs: sanitized.songs,
        artists: sanitized.artists,
        albums: cleanAlbumsDict(sanitized.albums),
        historySyncState: input.syncWatermark ? {
          lastTrackTitle: input.syncWatermark.lastTrackTitle,
          lastTrackArtist: input.syncWatermark.lastTrackArtist,
          lastSyncTimestamp: input.syncWatermark.lastSyncTimestamp
        } : null
      }
    };
  }

  // Schema v1 legacy migration: has songs/artists/albums directly on top level or inside data
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
      schemaVersion: 2,
      totalPlays: Math.max(0, Math.round(computedPlays)),
      totalListeningSeconds: Math.max(0, Math.round(legacyData.totalListeningSeconds || 0)),
      songs: sanitized.songs,
      artists: sanitized.artists,
      albums: cleanAlbumsDict(sanitized.albums),
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

  let newPlaysCount = 0;

  for (const rawTrack of tracks) {
    const track = normalizeTrack(rawTrack);
    if (!track || !track.title) continue;

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
      const artistList = track.artist.split(/[,&/]| feat\.? | ft\.? /i).map(a => a.trim()).filter(Boolean);
      artistList.forEach(rawName => {
        const aKey = makeArtistKey(rawName);
        if (!artists[aKey]) {
          artists[aKey] = { artist: rawName, playCount: 1, durationSeconds: trackDuration };
        } else {
          artists[aKey].playCount = (artists[aKey].playCount || 0) + 1;
          artists[aKey].durationSeconds = (artists[aKey].durationSeconds || 0) + trackDuration;
        }
      });
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
        albums[albumKey].tracksListened[track.title] = (albums[albumKey].tracksListened[track.title] || 0) + 1;
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
