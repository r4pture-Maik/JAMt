/**
 * YTMusic Counter - Native MV3 Background Service Worker
 * Orchestrates scoring, persistent storage, thumbnail caching,
 * continuous playback duration accumulation, and Schema v2 data bridges.
 */

// Side-effect import: registers the shared locale runtime on `globalThis.YTMCI18n`.
// Listed first so it is available to every handler below.
import '../shared/i18n.js';

import {
  calculateCompletePlays,
  cleanAlbumsDict
} from './scoring.js';

import {
  makeSongKey,
  makeArtistKey,
  makeAlbumKey,
  normalizeTrack,
  sanitizeStorageData,
  initializeStorage,
  getStats,
  resetStats,
  invalidateStatsCache,
  createExportBundleV2,
  validateAndMigrateImport,
  importHistoryTracks,
  withStorageLock,
  isDangerousKey,
  PENDING_DURATIONS_KEY
} from './storage.js';

// cacheRemoteThumbnail is deliberately absent: an object URL minted in the service
// worker cannot be displayed by an extension page, and downloading the image twice
// (worker + page) doubled the cost of every cover. The Details page downscales and
// caches it itself. See handleFetchAlbumCover.
import {
  thumbnailCache,
  clearThumbnailCache,
  getThumbnailStats
} from './thumbnails.js';

import {
  recordListeningDuration
} from './duration.js';

import {
  ENRICHMENT_CONFIG_KEY,
  selectAlbumsToEnrich,
  shouldEnrichAlbum,
  normalizeBrowseId,
  isRateLimitedStatus,
  parseBrowsePayload,
  resolveEnrichmentConfig,
  createThrottledQueue,
  buildEnrichmentProgress,
  shouldPublishEnrichmentProgress
} from './enrichment.js';

// Side-effect import: registers the shared browse parsers on `globalThis.YTMCShared`.
// The same file is injected as a classic script into the content script, so both
// worlds share one implementation of the browse-response parsing.
import '../shared/browse-parse.js';

// Side-effect import: registers the cross-browser messaging helpers on
// `globalThis.YTMCMessaging`. Same deal as above — one implementation for the
// background, the content script, the popup and the Details page.
import '../shared/messaging.js';

if (!globalThis.YTMCShared || typeof globalThis.YTMCShared.buildBrowseRequestBody !== 'function') {
  // Without this the module would throw on the very first browse request, with a
  // stack trace pointing at the destructuring rather than at the real cause.
  throw new Error('[YTMusic Counter] shared/browse-parse.js failed to register globalThis.YTMCShared');
}

if (!globalThis.YTMCI18n || typeof globalThis.YTMCI18n.getMessages !== 'function') {
  throw new Error('[YTMusic Counter] shared/i18n.js failed to register globalThis.YTMCI18n');
}

if (!globalThis.YTMCMessaging || typeof globalThis.YTMCMessaging.sendTabMessage !== 'function') {
  throw new Error('[YTMusic Counter] shared/messaging.js failed to register globalThis.YTMCMessaging');
}

const {
  extractTrackTitlesFromBrowse,
  findBestThumbnail,
  buildBrowseRequestBody,
  getFallbackInnerTubeClient
} = globalThis.YTMCShared;

const { sendRuntimeMessage, sendTabMessage, sendRuntimeMessageIgnoringReply } = globalThis.YTMCMessaging;

/** Single source of truth for the stale WEB_REMIX fallback context. */
const FALLBACK_INNERTUBE_CLIENT = getFallbackInnerTubeClient();

const extBrowser = typeof browser !== 'undefined' ? browser : chrome;

/**
 * Forwards a diagnostic line to the Details page debug console.
 * Silently no-ops when no receiver is listening (e.g. the page is closed).
 *
 * @param {string} tag
 * @param {string} message
 * @param {any} [data]
 */
/** Buffered debug lines, flushed on an interval instead of one message per line. */
let debugBuffer = [];
let debugFlushTimer = null;

const DEBUG_FLUSH_INTERVAL_MS = 400;
const DEBUG_MAX_BUFFER = 100;

function flushDebugLog() {
  debugFlushTimer = null;
  if (debugBuffer.length === 0) return;
  const lines = debugBuffer;
  debugBuffer = [];

  try {
    // One message per batch instead of one per line: an enrichment sweep used to
    // emit hundreds of runtime messages, and the Details page re-rendered its
    // entire <pre> for every one of them.
    sendRuntimeMessageIgnoringReply({ type: 'DEBUG_LOG_BATCH', lines });
  } catch (_) {}
}

function debugLog(tag, message, data) {
  try {
    const line = { tag, message };
    if (data !== undefined) line.data = data;
    debugBuffer.push(line);
    if (debugBuffer.length > DEBUG_MAX_BUFFER) debugBuffer.shift();
    if (!debugFlushTimer) debugFlushTimer = setTimeout(flushDebugLog, DEBUG_FLUSH_INTERVAL_MS);
  } catch (_) {}
}

/**
 * Message types only an extension page (popup, Details) may send.
 *
 * They overwrite the whole database (RESET_STATS, IMPORT_DATA_V2) or change
 * extension configuration, so the boundary is enforced explicitly rather than
 * left to the accident that a page cannot reach `runtime.onMessage`.
 */
const EXTENSION_PAGE_ONLY_TYPES = new Set([
  'RESET_STATS',
  'IMPORT_DATA_V2',
  'FETCH_MISSING_TRACKLISTS',
  'SET_ENRICHMENT_CONFIG',
  'CLEAR_THUMBNAIL_CACHE',
  'START_HISTORY_SCAN',
  'PING_CONTENT_SCRIPT'
]);

/**
 * Message types the content script legitimately sends from the page origin.
 *
 * IMPORT_HISTORY_TRACKS belongs here and *not* in EXTENSION_PAGE_ONLY_TYPES: it
 * is dispatched by content/content.js while the user sits on
 * music.youtube.com/history, so its `sender.url` is the page and never the
 * extension root. It used to sit in the extension-page-only set, which made the
 * background answer "Untrusted message source." to every single history import:
 * the scan ran, collected the plays, and the background silently threw them
 * away.
 */
const CONTENT_SCRIPT_TYPES = new Set(['IMPORT_HISTORY_TRACKS']);

/**
 * Origins the content script may legitimately run on. Used as the trust anchor
 * for CONTENT_SCRIPT_TYPES: the message must come from our own content script
 * (already enforced by the sender.id check) *and* from a page we hold a host
 * permission for.
 */
const CONTENT_SCRIPT_ORIGINS = ['https://music.youtube.com/'];

/** Upper bound on a single history-import payload. */
const MAX_HISTORY_IMPORT_TRACKS = 5000;

/**
 * Storage key for the resumable enrichment queue.
 *
 * Declared with the other storage keys rather than next to the pump: the import
 * handler clears it, and `handleImportDataV2` is defined above that point.
 * A `const` used before its declaration is a temporal dead zone error, not a
 * hoisted value, so the two had to stay in that order.
 */
const ENRICHMENT_QUEUE_KEY = 'enrichmentQueue';

/**
 * Validates that a message really came from this extension before acting on it.
 *
 * `runtime.onMessage` is reachable by every content script of this extension.
 * Web pages cannot call it, but the handlers behind it overwrite the entire
 * database, so the boundary is worth enforcing explicitly.
 *
 * Three tiers:
 *   1. `sender.id` must be this extension. This alone rejects every other
 *      extension and every web page.
 *   2. Unlisted types are trusted: they only read or report.
 *   3. Listed types must additionally come from an allowed surface — an
 *      extension page, or for CONTENT_SCRIPT_TYPES a music.youtube.com page.
 *
 * @param {any} message
 * @param {object} sender
 * @returns {boolean}
 */
function isTrustedMessage(message, sender) {
  if (!message || typeof message.type !== 'string') return false;
  if (!sender || sender.id !== extBrowser.runtime.id) return false;

  const isExtensionPageOnly = EXTENSION_PAGE_ONLY_TYPES.has(message.type);
  const isContentScript = CONTENT_SCRIPT_TYPES.has(message.type);
  if (!isExtensionPageOnly && !isContentScript) return true;

  const senderUrl = typeof sender.url === 'string' ? sender.url : '';
  if (senderUrl.startsWith(extBrowser.runtime.getURL(''))) return true;

  if (isContentScript) {
    return CONTENT_SCRIPT_ORIGINS.some((origin) => senderUrl.startsWith(origin));
  }

  return false;
}

/* ==========================================================================
   Localization

   The locale runtime is the shared one (shared/i18n.js), imported for its side
   effect at the top of this file. The only thing the background needs it for is
   serving catalogs to content scripts, whose fetch() is bound to the page origin
   and cannot read `_locales`.
   ========================================================================== */

/** Upper bound on keys accepted by one GET_LOCALIZED_MESSAGES request. */
const MAX_LOCALIZED_MESSAGE_KEYS = 500;

/** Upper bound on a single message key length, to reject junk payloads. */
const MAX_LOCALIZED_MESSAGE_KEY_LENGTH = 200;

/**
 * Resolves a batch of catalog keys for the content script. Serves
 * GET_LOCALIZED_MESSAGES.
 *
 * Read-only, so it is deliberately left out of EXTENSION_PAGE_ONLY_TYPES: the
 * base `sender.id` check already excludes other extensions and web pages.
 *
 * @param {object} payload
 * @returns {Promise<Record<string, string>>} `{ key: rawTemplate }` for the
 *   active override locale, or `{}` when the native `getMessage` can answer and
 *   no catalog is needed.
 */
async function handleGetLocalizedMessages(payload) {
  const requested = payload && Array.isArray(payload.keys) ? payload.keys : [];

  // Bound the work: a pathological payload must not become a memory or time
  // sink in a service worker.
  const keys = [];
  for (const key of requested) {
    if (keys.length >= MAX_LOCALIZED_MESSAGE_KEYS) break;
    if (typeof key !== 'string' || key.length === 0) continue;
    if (key.length > MAX_LOCALIZED_MESSAGE_KEY_LENGTH) continue;
    keys.push(key);
  }

  await globalThis.YTMCI18n.init();
  if (!globalThis.YTMCI18n.needsCatalog()) return {};
  return globalThis.YTMCI18n.getMessages(keys);
}

// Listen for storage changes to invalidate the stats cache
if (extBrowser.storage && extBrowser.storage.onChanged) {
  extBrowser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
      const keys = ['songs', 'artists', 'albums', 'totalPlays', 'totalListeningSeconds', 'currentTrack'];
      if (keys.some(k => k in changes)) {
        invalidateStatsCache();
      }
    }
  });
}

// Initialize default storage schema & heal corrupted entries upon service worker start
initializeStorage(extBrowser).then(() => {
  autoHealMissingTracklists();
  // A previous batch may have been interrupted by a worker restart.
  resumeEnrichmentQueue();
}).catch(() => {});

/**
 * Resolves the effective enrichment options, honouring the user override stored
 * under `enrichmentConfig`.
 *
 * @returns {Promise<{minUniqueTracks: number, minDelayMs: number, maxDelayMs: number, maxRetries: number}>}
 */
async function getEnrichmentConfig() {
  try {
    const data = await extBrowser.storage.local.get([ENRICHMENT_CONFIG_KEY]);
    return resolveEnrichmentConfig(data[ENRICHMENT_CONFIG_KEY]);
  } catch (_) {
    return resolveEnrichmentConfig(null);
  }
}

/** How often the enrichment pump mirrors progress into storage.local. */
const ENRICHMENT_PROGRESS_WRITE_EVERY = 5;

/** Cap on albums touched by the startup heal, per service worker wake-up. */
const AUTO_HEAL_BATCH_LIMIT = 20;

async function autoHealMissingTracklists() {
  try {
    const config = await getEnrichmentConfig();
    const data = await extBrowser.storage.local.get(['albums']);
    const selected = selectAlbumsToEnrich(data.albums || {}, { minUniqueTracks: config.minUniqueTracks });
    const candidates = await filterRecentlyFailedAlbums(selected);

    // Bounded per wake-up: the service worker restarts often, and an unbounded
    // sweep on every restart is what turned transient failures into 429s.
    const batch = candidates.slice(0, AUTO_HEAL_BATCH_LIMIT);
    for (const [albKey, alb] of batch) {
      ensureAlbumTracklist(albKey, alb.albumBrowseId).catch(() => {});
    }

    if (candidates.length > batch.length) {
      debugLog('BG_ENRICH', `Auto-heal: ${batch.length}/${candidates.length} albums this wake-up, remainder deferred.`);
    }
  } catch (_) {}
}

extBrowser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isTrustedMessage(message, sender)) {
    // AD-10: the UI maps `errorCode` to a localized message; `error` stays as the
    // English fallback so nothing that renders it today breaks.
    sendResponse({
      status: 'error',
      error: 'Untrusted message source.',
      errorCode: 'untrustedSource'
    });
    return;
  }

  switch (message.type) {
    case 'GET_SONG_COUNT': {
      getSongCount(message.payload)
        .then(result => sendResponse({ status: 'ok', data: result }))
        .catch(err => sendResponse({ status: 'error', error: err.message }));
      return true;
    }

    case 'TRACK_PLAYED': {
      handleTrackPlayed(message.payload)
        .then(result => sendResponse({ status: 'ok', data: result }))
        .catch(err => sendResponse({ status: 'error', error: err.message }));
      return true;
    }

    case 'TIME_LISTENED_TICK': {
      recordListeningDuration(message.payload, extBrowser, invalidateStatsCache)
        .then(result => sendResponse({ status: 'ok', data: result }))
        .catch(err => sendResponse({ status: 'error', error: err.message }));
      return true;
    }

    case 'GET_STATS': {
      getStats(extBrowser)
        .then(stats => sendResponse({ status: 'ok', data: stats }))
        .catch(err => sendResponse({ status: 'error', error: err.message }));
      return true;
    }

    case 'GET_ALBUM_DETAILS': {
      handleGetAlbumDetails(message.payload)
        .then(details => sendResponse({ status: 'ok', data: details }))
        .catch(err => sendResponse({ status: 'error', error: err.message }));
      return true;
    }

    case 'FETCH_ALBUM_COVER': {
      handleFetchAlbumCover(message.payload)
        .then(result => sendResponse({ status: 'ok', data: result }))
        .catch(err => sendResponse({ status: 'error', error: err.message }));
      return true;
    }

    case 'RESET_STATS': {
      resetStats(extBrowser, thumbnailCache)
        .then(res => sendResponse({ status: 'ok', data: res }))
        .catch(err => sendResponse({ status: 'error', error: err.message }));
      return true;
    }

    case 'IMPORT_HISTORY_TRACKS': {
      handleImportHistory(message.payload)
        .then(result => sendResponse({ status: 'ok', data: result }))
        .catch(err => sendResponse({ status: 'error', error: err.message }));
      return true;
    }

    case 'BACKFILL_ALBUM_COVERS': {
      handleBackfillAlbumCovers(message.payload)
        .then(result => sendResponse({ status: 'ok', data: result }))
        .catch(err => sendResponse({ status: 'error', error: err.message }));
      return true;
    }

    case 'GET_ENRICHMENT_CONFIG': {
      getEnrichmentConfig()
        .then(config => sendResponse({ status: 'ok', data: config }))
        .catch(err => sendResponse({ status: 'error', error: err.message }));
      return true;
    }

    case 'SET_ENRICHMENT_CONFIG': {
      handleSetEnrichmentConfig(message.payload)
        .then(config => sendResponse({ status: 'ok', data: config }))
        .catch(err => sendResponse({ status: 'error', error: err.message }));
      return true;
    }

    case 'FETCH_MISSING_TRACKLISTS': {
      handleFetchMissingTracklists(message.payload)
        .then(result => sendResponse({ status: 'ok', data: result }))
        .catch(err => sendResponse({ status: 'error', error: err.message }));
      return true;
    }

    case 'GET_LOCALIZED_MESSAGES': {
      handleGetLocalizedMessages(message.payload)
        .then(messages => sendResponse({ status: 'ok', data: messages }))
        .catch(err => sendResponse({ status: 'error', error: err.message, errorCode: 'localizedMessagesFailed' }));
      return true;
    }

    case 'GET_THUMBNAIL_STATS': {
      getThumbnailStats()
        .then(stats => sendResponse({ status: 'ok', data: stats }))
        .catch(err => sendResponse({ status: 'error', error: err.message }));
      return true;
    }

    case 'CLEAR_THUMBNAIL_CACHE': {
      clearThumbnailCache()
        .then(res => sendResponse({ status: 'ok', data: res }))
        .catch(err => sendResponse({ status: 'error', error: err.message }));
      return true;
    }

    case 'EXPORT_DATA_V2': {
      handleExportDataV2()
        .then(bundle => sendResponse({ status: 'ok', data: bundle }))
        .catch(err => sendResponse({ status: 'error', error: err.message }));
      return true;
    }

    case 'IMPORT_DATA_V2': {
      handleImportDataV2(message.payload)
        .then(res => sendResponse({ status: 'ok', data: res }))
        .catch(err => sendResponse({
          status: 'error',
          error: err.message,
          // See handleImportDataV2: the UI localizes from the code, not the sentence.
          ...(err.errorCode ? { errorCode: err.errorCode } : {})
        }));
      return true;
    }

    default:
      sendResponse({ status: 'ignored' });
      break;
  }
});

/**
 * Returns the current play count for a specific song
 */
async function getSongCount(payload) {
  if (!payload || !payload.title) return { songPlays: 0 };
  const songKey = makeSongKey(payload.title, payload.artist);
  const data = await extBrowser.storage.local.get(['songs']);
  const songs = data.songs || {};
  const songPlays = (songs[songKey] && songs[songKey].playCount) || 0;
  return { songPlays };
}

/**
 * Records a track play and updates song, artist, and total counters
 */
async function handleTrackPlayed(rawTrack) {
  const track = normalizeTrack(rawTrack);
  if (!track || !track.title) return { totalPlays: 0, songPlays: 0 };

  const songKey = makeSongKey(track.title, track.artist);

  // The read-modify-write is serialized against every other writer (duration
  // ticks, history import, cover backfill). A 5s tick landing on top of a play
  // registration used to make one of the two `set` calls discard the other.
  const outcome = await withStorageLock(async () => {
    let tracklistToFetch = null;

    const data = await extBrowser.storage.local.get([
      'totalPlays', 'totalListeningSeconds', 'songs', 'artists', 'albums', PENDING_DURATIONS_KEY
    ]);
    const totalPlays = (data.totalPlays || 0) + 1;
    const songs = data.songs || {};
    const artists = data.artists || {};
    const albums = cleanAlbumsDict(data.albums || {});
    const pendingDurations = data[PENDING_DURATIONS_KEY] || {};

    // Drain any duration that accrued before this play was ever registered. Only
    // the parked delta is applied: live ticks already added their own seconds
    // directly, so adding track.durationSeconds here would double-count.
    const durationDelta = Number(pendingDurations[songKey]) || 0;
    if (durationDelta > 0) delete pendingDurations[songKey];

    const isSingle = Boolean(track.isSingle || !track.album || /^single(\s*-\s*ep)?$/i.test(track.album) || /^ep$/i.test(track.album));
    const albumName = isSingle ? '' : (track.album || '');

    // Update Song count
    if (!songs[songKey]) {
      songs[songKey] = {
        title: track.title,
        artist: track.artist || 'Unknown Artist',
        album: albumName,
        isSingle: isSingle,
        playCount: 1,
        durationSeconds: durationDelta
      };
    } else {
      songs[songKey].playCount = (songs[songKey].playCount || 0) + 1;
      if (albumName && !songs[songKey].album) songs[songKey].album = albumName;
      if (typeof track.isSingle !== 'undefined') songs[songKey].isSingle = isSingle;
      if (durationDelta > 0) {
        songs[songKey].durationSeconds = (songs[songKey].durationSeconds || 0) + durationDelta;
      }
    }

    // Update Artist count (handles multiple artists separated by comma or feat)
    if (track.artist) {
      const artistList = track.artist.split(/[,&/]| feat\.? | ft\.? /i).map(a => a.trim()).filter(Boolean);
      artistList.forEach(rawName => {
        const aKey = makeArtistKey(rawName);
        if (!artists[aKey]) {
          artists[aKey] = { artist: rawName, playCount: 1, durationSeconds: durationDelta };
        } else {
          artists[aKey].playCount = (artists[aKey].playCount || 0) + 1;
          if (durationDelta > 0) {
            artists[aKey].durationSeconds = (artists[aKey].durationSeconds || 0) + durationDelta;
          }
        }
      });
    }

    // Update Album count - ONLY for real albums (not singles)
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
          totalTracks: null,
          playCount: 1,
          durationSeconds: durationDelta,
          completePlays: 0
        };
      } else {
        albums[albumKey].playCount = (albums[albumKey].playCount || 0) + 1;
        if (durationDelta > 0) {
          albums[albumKey].durationSeconds = (albums[albumKey].durationSeconds || 0) + durationDelta;
        }
        if (!albums[albumKey].tracksListened) albums[albumKey].tracksListened = {};
        albums[albumKey].tracksListened[track.title] = (albums[albumKey].tracksListened[track.title] || 0) + 1;
        albums[albumKey].uniqueTracksCount = Object.keys(albums[albumKey].tracksListened).length;
        if (track.albumBrowseId && !albums[albumKey].albumBrowseId) {
          albums[albumKey].albumBrowseId = track.albumBrowseId;
        }
        if (track.coverUrl && !albums[albumKey].coverUrl) {
          albums[albumKey].coverUrl = track.coverUrl;
        }
      }

      if (!albums[albumKey].totalTracks && Array.isArray(albums[albumKey].allTracks) && albums[albumKey].allTracks.length > 0) {
        albums[albumKey].totalTracks = albums[albumKey].allTracks.length;
      }
      if (albums[albumKey].totalTracks || albums[albumKey].allTracks) {
        albums[albumKey].completePlays = calculateCompletePlays(albums[albumKey]);
      }

      if (shouldEnrichAlbum(albums[albumKey], { force: true })) {
        tracklistToFetch = { albumKey, browseId: albums[albumKey].albumBrowseId };
      }
    }

    const currentTrack = {
      title: track.title,
      artist: track.artist || 'Unknown Artist',
      album: albumName,
      isSingle,
      songPlays: songs[songKey].playCount
    };

    const updates = {
      totalPlays,
      songs,
      artists,
      albums,
      currentTrack
    };
    if (Object.keys(pendingDurations).length > 0) updates[PENDING_DURATIONS_KEY] = pendingDurations;

    await extBrowser.storage.local.set(updates);

    return {
      totalPlays,
      songPlays: songs[songKey].playCount,
      currentTrack,
      // Level 2 (live tracking): the album being played right now always earns its
      // tracklist, regardless of the batch threshold. Handed back to the caller
      // instead of being fetched inline, because ensureAlbumTracklist acquires this
      // same lock to persist its result and would deadlock.
      tracklistToFetch
    };
  });

  invalidateStatsCache();

  // Fire-and-forget, outside the lock. The request still goes through the
  // throttled queue, so it cannot stampede the browse endpoint.
  if (outcome.tracklistToFetch) {
    const { albumKey, browseId } = outcome.tracklistToFetch;
    ensureAlbumTracklist(albumKey, browseId).catch(() => {});
  }

  return {
    totalPlays: outcome.totalPlays,
    songPlays: outcome.songPlays,
    currentTrack: outcome.currentTrack
  };
}

/**
 * Handles 1-click export of data bundle conforming to Schema v2
 */
async function handleExportDataV2() {
  const data = await extBrowser.storage.local.get([
    'totalPlays',
    'totalListeningSeconds',
    'songs',
    'artists',
    'albums',
    'historySyncState'
  ]);
  return createExportBundleV2(data);
}

/**
 * Handles validated import and migration of Schema v1 or v2 backups
 */
async function handleImportDataV2(payload) {
  const migration = validateAndMigrateImport(payload);
  if (!migration.valid) {
    // The machine code has to travel with the message: the Details page maps it to
    // a localized toast, and it cannot honour the in-app language override from an
    // English sentence alone (AD-10). The sentence stays as the fallback for a
    // failure that carries no code.
    const err = new Error(migration.error || 'Invalid backup data.');
    if (migration.errorCode) err.errorCode = migration.errorCode;
    throw err;
  }

  const bundle = migration.bundle;
  await withStorageLock(async () => {
    await extBrowser.storage.local.set({
      totalPlays: bundle.totalPlays,
      totalListeningSeconds: bundle.totalListeningSeconds,
      songs: bundle.songs,
      artists: bundle.artists,
      albums: bundle.albums,
      historySyncState: bundle.historySyncState,
      // The bundle replaces the whole library, so state left over from before the
      // import is meaningless. Clearing scanProgress stops the Settings page from
      // inheriting `isScanning: true` (and the pre-import latestTrack) and
      // reporting "Syncing in progress" for a sync that is not running. Any queued
      // enrichment job targets the previous library's albums and is dropped; a new
      // one is queued immediately below against the imported albums.
      scanProgress: null,
      [ENRICHMENT_QUEUE_KEY]: null
    });
  });

  invalidateStatsCache();

  // Enrichment is queued, NOT awaited. Awaiting it kept this handler alive for the
  // whole batch (hundreds of throttled requests, well past the 5-minute per-event
  // ceiling in MV3), so the worker was terminated before sendResponse and the
  // Details page hung on "Importing...". Progress is mirrored to scanProgress,
  // which the Details page already listens to.
  const queued = await enqueueAlbumEnrichment();

  return {
    success: true,
    totalPlays: bundle.totalPlays,
    totalListeningSeconds: bundle.totalListeningSeconds,
    songsCount: Object.keys(bundle.songs).length,
    artistsCount: Object.keys(bundle.artists).length,
    albumsCount: Object.keys(bundle.albums).length,
    enrichment: queued
  };
}

/**
 * Imports an array of tracks extracted from the YouTube Music History page
 */
async function handleImportHistory(payload) {
  const tracks = (payload && payload.tracks) || [];
  if (Array.isArray(tracks) && tracks.length > MAX_HISTORY_IMPORT_TRACKS) {
    throw new Error(`Import payload too large: ${tracks.length} tracks (max ${MAX_HISTORY_IMPORT_TRACKS}).`);
  }

  const result = await importHistoryTracks(payload, extBrowser);

  // Queued rather than awaited, for the same reason as handleImportDataV2: a full
  // enrichment batch outlives the MV3 per-event budget, and this handler must
  // still be able to answer the content script's IMPORT_HISTORY_TRACKS callback.
  const queued = await enqueueAlbumEnrichment();

  return { ...result, enrichment: queued };
}

/**
 * Returns detailed album data with listened tracks vs full album tracklist
 */
async function handleGetAlbumDetails(payload) {
  if (!payload || !payload.album) return null;

  const albumKey = makeAlbumKey(payload.album, payload.artist);

  const readAlbum = async () => {
    const data = await extBrowser.storage.local.get(['albums']);
    const albums = cleanAlbumsDict(data.albums || {});
    let album = albums[albumKey];
    if (!album) {
      const matchKey = Object.keys(albums).find(k => k.toLowerCase() === albumKey.toLowerCase());
      if (matchKey) album = albums[matchKey];
    }
    return { albums, album };
  };

  let { album } = await readAlbum();
  if (!album) return null;

  if (album.albumBrowseId && (!album.allTracks || album.allTracks.length === 0)) {
    try {
      // Level 3 (on-demand): a single throttled request, delegated to the page origin.
      const fetched = await tracklistQueue.enqueue(() => fetchAlbumTrackCount(album.albumBrowseId));
      if (fetched && fetched.trackTitles && fetched.trackTitles.length > 0) {
        await withStorageLock(async () => {
          const { albums, album: current } = await readAlbum();
          if (!current) return;

          current.totalTracks = fetched.totalTracks || fetched.trackTitles.length;
          current.allTracks = fetched.trackTitles;
          current.completePlays = calculateCompletePlays(current);
          if (fetched.coverUrl && !current.coverUrl) {
            current.coverUrl = fetched.coverUrl;
          }

          const actualKey = albums[albumKey]
            ? albumKey
            : Object.keys(albums).find(k => k.toLowerCase() === albumKey.toLowerCase());
          if (actualKey) {
            albums[actualKey] = current;
            await extBrowser.storage.local.set({ albums });
            album = current;
          }
        });
        invalidateStatsCache();
      }
    } catch (_) {}
  }

  return album;
}

/**
 * Serial, self-throttling queue guarding every album browse request.
 * Tasks are spaced by a random 500-800ms delay and back off exponentially
 * whenever YouTube answers with 429/403.
 */
let tracklistQueue = createThrottledQueue();

/**
 * Rebuilds the throttled queue with the delays currently configured by the user.
 * Called after the threshold/delays are changed from the Details page.
 */
async function reconfigureTracklistQueue() {
  const config = await getEnrichmentConfig();
  tracklistQueue = createThrottledQueue({
    minDelayMs: config.minDelayMs,
    maxDelayMs: config.maxDelayMs,
    maxRetries: config.maxRetries
  });
  return config;
}

/**
 * Sends a message to a tab's content script, rejecting when the content script
 * is unreachable.
 *
 * Thin alias over shared/messaging.js, kept as a named function because the
 * call sites read better with the tab id first and because the timeout used to
 * live here.
 *
 * @param {number} tabId
 * @param {object} message
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
function sendMessageToTab(tabId, message, timeoutMs) {
  return sendTabMessage(tabId, message, timeoutMs || 15000);
}

/**
 * Finds a YouTube Music tab whose content script can perform same-origin
 * browse requests. Prefers the focused/active tab, then any audible one.
 *
 * @returns {Promise<number|null>} Tab ID, or null when no usable tab is open.
 */
async function findMusicTabId() {
  try {
    const tabs = await extBrowser.tabs.query({ url: '*://music.youtube.com/*' });
    if (!tabs || tabs.length === 0) return null;

    const preferred =
      tabs.find((tab) => tab.active) ||
      tabs.find((tab) => tab.audible) ||
      tabs.find((tab) => tab.highlighted) ||
      tabs[0];

    if (!preferred) return null;

    // A discarded tab has no content script until it is restored.
    if (preferred.discarded) {
      await extBrowser.tabs.update(preferred.id, { active: true }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    return preferred.id;
  } catch (_) {
    return null;
  }
}

/**
 * Direct (service worker) browse request. Used only as a fallback when no
 * YouTube Music tab is available to proxy the call, or when the delegation
 * fails for a non-throttling reason.
 *
 * @param {string} cleanId
 * @returns {Promise<object|null>}
 */
async function fetchAlbumTrackCountDirect(cleanId) {
  const res = await fetch('https://music.youtube.com/youtubei/v1/browse?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildBrowseRequestBody(cleanId))
  });

  if (!res.ok) {
    const err = new Error(`Direct browse request failed with HTTP ${res.status}`);
    err.status = res.status;
    err.rateLimited = isRateLimitedStatus(res.status);
    throw err;
  }

  return parseBrowsePayload(await res.json(), { extractTrackTitlesFromBrowse, findBestThumbnail });
}

/**
 * Resolves an album's official tracklist and cover art.
 *
 * Delegation strategy:
 *  1. Find an open `music.youtube.com` tab and ask its content script to run the
 *     browse POST from the page origin. This is what avoids the HTTP 403 Firefox
 *     returns for `moz-extension://` origins.
 *  2. Fall back to a direct service worker fetch when no tab is open.
 *
 * Rate limiting (429/403) is surfaced to the caller as `rateLimited: true` so the
 * throttled queue can apply exponential backoff instead of hammering the endpoint.
 *
 * @param {string} browseId
 * @returns {Promise<{totalTracks: number|null, trackTitles: string[], coverUrl: string|null}|null>}
 */
async function fetchAlbumTrackCount(browseId) {
  const cleanId = normalizeBrowseId(browseId);
  if (!cleanId) return null;

  const tabId = await findMusicTabId();
  if (tabId !== null) {
    try {
      const response = await sendMessageToTab(tabId, { type: 'FETCH_ALBUM_TRACKLIST', browseId: cleanId });

      if (response && response.status === 'ok' && response.data) {
        debugLog('BG_ENRICH', `Delegated browse for ${cleanId} via tab ${tabId}: ${response.data.trackTitles.length} tracks${response.usedPageContext ? ' (live page context)' : ' (fallback context)'}.`);
        return response.data;
      }
      if (response && response.status === 'empty') {
        debugLog('BG_ENRICH', `Delegated browse for ${cleanId} returned no tracks or artwork: ${response.error || 'no reason given'}.`);
        return null;
      }
      if (response && response.rateLimited) {
        debugLog('BG_ENRICH', `Delegated browse for ${cleanId} was rate limited (HTTP ${response.httpStatus}).`);
        return { rateLimited: true };
      }

      // Never collapse this to a bare 'unknown error': the delegated content script
      // always sends a reason, and the status code is what actually matters.
      if (!response) {
        debugLog('BG_ENRICH', `Delegated browse for ${cleanId} got an empty response from tab ${tabId}. Falling back to direct fetch.`);
      } else {
        debugLog('BG_ENRICH', `Delegated browse for ${cleanId} failed [response: ${JSON.stringify(response)}]. Falling back to direct fetch.`);
      }
    } catch (err) {
      debugLog('BG_ENRICH', `Could not reach content script in tab ${tabId}: ${(err && err.message) || err}. Falling back to direct fetch.`);
    }
  } else {
    debugLog('BG_ENRICH', 'No music.youtube.com tab open; using direct fetch for ' + cleanId);
  }

  try {
    return await fetchAlbumTrackCountDirect(cleanId);
  } catch (err) {
    if (err && err.rateLimited) {
      return { rateLimited: true };
    }
    console.warn('[YTMusic Counter] Error fetching album metadata:', err);
    return null;
  }
}

let googleSearchCooldownUntil = 0;

async function resolveAlbumCover(album, artist, browseId) {
  let coverUrl = null;
  const cleanAlb = (album || '').replace(/\s*[\(\[].*?[\)\]]/g, '').trim();
  const cleanArt = (artist || '').split('•')[0].split(/[,&/]| feat/i)[0].trim();

  // Tier 1: YouTube Music Browse endpoint (authoritative artwork for the album)
  if (browseId) {
    try {
      const cleanId = normalizeBrowseId(browseId);
      const res = await fetch('https://music.youtube.com/youtubei/v1/browse?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBrowseRequestBody(cleanId))
      });
      if (res.ok) {
        const json = await res.json();
        coverUrl = findBestThumbnail(json);
      }
    } catch (_) {}
  }

  // Tier 2: YouTube Music Search endpoint, for albums with no browseId (if not in cooldown)
  const isGoogleThrottled = Date.now() < googleSearchCooldownUntil;

  if (!coverUrl && (cleanAlb || cleanArt) && !isGoogleThrottled) {
    try {
      const searchRes = await fetch('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: { client: Object.assign({}, FALLBACK_INNERTUBE_CLIENT) },
          query: `${cleanAlb} ${cleanArt}`.trim()
        })
      });

      if (searchRes.status === 429 || searchRes.status === 403) {
        googleSearchCooldownUntil = Date.now() + 10 * 60 * 1000;
        console.warn('[YTMusic Counter] Google rate-limited search. Cooldown active for 10 minutes.');
      } else if (searchRes.ok) {
        const json = await searchRes.json();
        coverUrl = findBestThumbnail(json);
      }
    } catch (err) {
      console.warn('[YTMusic Counter] Native search error:', err);
    }
  }

  if (!coverUrl && cleanAlb && Date.now() >= googleSearchCooldownUntil) {
    try {
      const searchRes = await fetch('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: { client: Object.assign({}, FALLBACK_INNERTUBE_CLIENT) },
          query: cleanAlb
        })
      });

      if (searchRes.status === 429 || searchRes.status === 403) {
        googleSearchCooldownUntil = Date.now() + 10 * 60 * 1000;
        console.warn('[YTMusic Counter] Google rate-limited search. Cooldown active for 10 minutes.');
      } else if (searchRes.ok) {
        const json = await searchRes.json();
        coverUrl = findBestThumbnail(json);
      }
    } catch (_) {}
  }

  return coverUrl;
}

const coverQueue = [];
let isProcessingQueue = false;

function enqueueCoverRequest(album, artist, browseId) {
  return new Promise((resolve) => {
    coverQueue.push({ album, artist, browseId, resolve });
    processCoverQueue();
  });
}

async function processCoverQueue() {
  if (isProcessingQueue || coverQueue.length === 0) return;
  isProcessingQueue = true;

  while (coverQueue.length > 0) {
    const item = coverQueue.shift();
    try {
      const url = await resolveAlbumCover(item.album, item.artist, item.browseId);
      item.resolve(url);
    } catch (_) {
      item.resolve(null);
    }
    if (coverQueue.length > 0) {
      await new Promise(r => setTimeout(r, 1200));
    }
  }

  isProcessingQueue = false;
}

async function handleFetchAlbumCover(payload) {
  if (!payload || !payload.album) return { coverUrl: null };
  const albumName = payload.album;
  const artistName = payload.artist || '';
  const albumKey = makeAlbumKey(albumName, artistName);

  const data = await extBrowser.storage.local.get(['albums']);
  const albums = cleanAlbumsDict(data.albums || {});

  if (albums[albumKey] && albums[albumKey].coverUrl) {
    return { coverUrl: albums[albumKey].coverUrl };
  }

  const browseId = payload.browseId || (albums[albumKey] && albums[albumKey].albumBrowseId);
  const coverUrl = await enqueueCoverRequest(albumName, artistName, browseId);

  if (coverUrl) {
    // No thumbnail caching here on purpose: the object URL minted in the service
    // worker can never be displayed by an extension page, and fetching the image
    // twice (worker + page) doubled the download for every cover. The Details page
    // downsizes and caches it itself via thumbnailCache.
    await withStorageLock(async () => {
      const freshData = await extBrowser.storage.local.get(['albums']);
      const freshAlbums = cleanAlbumsDict(freshData.albums || {});
      if (!freshAlbums[albumKey]) {
        freshAlbums[albumKey] = {
          album: albumName,
          artist: artistName,
          albumBrowseId: browseId || '',
          coverUrl: coverUrl,
          tracksListened: {},
          uniqueTracksCount: 0,
          totalTracks: null,
          playCount: 0,
          durationSeconds: 0,
          completePlays: 0
        };
      } else {
        freshAlbums[albumKey].coverUrl = coverUrl;
      }
      await extBrowser.storage.local.set({ albums: freshAlbums });
    });
    invalidateStatsCache();
  }

  return { coverUrl };
}

async function handleBackfillAlbumCovers(payload) {
  if (!payload || !Array.isArray(payload.covers) || payload.covers.length === 0) {
    return { updated: 0 };
  }

  const updated = await withStorageLock(async () => {
    const data = await extBrowser.storage.local.get(['albums']);
    const albums = cleanAlbumsDict(data.albums || {});
    let changed = 0;

    for (const item of payload.covers) {
      if (!item || isDangerousKey(makeAlbumKey(item.album, item.artist))) continue;
      if (!item.album || !item.coverUrl) continue;
      const albumKey = makeAlbumKey(item.album, item.artist);
      let target = albums[albumKey];
      if (!target) {
        const matchKey = Object.keys(albums).find(k => k.toLowerCase() === albumKey.toLowerCase());
        if (matchKey) target = albums[matchKey];
      }

      if (target && !target.coverUrl) {
        target.coverUrl = item.coverUrl;
        if (item.albumBrowseId && !target.albumBrowseId) {
          target.albumBrowseId = item.albumBrowseId;
        }
        changed++;
      }
    }

    if (changed > 0) {
      await extBrowser.storage.local.set({ albums });
    }
    return changed;
  });

  if (updated > 0) {
    invalidateStatsCache();
  }

  return { updated };
}

const pendingTracklistFetches = new Set();

/** Storage key holding per-album enrichment attempt bookkeeping. */
const ENRICHMENT_ATTEMPTS_KEY = 'enrichmentAttempts';

/** Do not retry an album that failed within this window (12h). */
const ENRICHMENT_RETRY_COOLDOWN_MS = 12 * 60 * 60 * 1000;

/**
 * Downloads an album's official tracklist (if missing) and persists it.
 *
 * The network fetch happens outside the storage lock; only the read-modify-write
 * is serialized, via the same `withStorageLock` every other writer uses. The
 * previous dedicated `albumsStorageMutex` only guarded this function, so a
 * concurrent play registration or duration tick could still clobber the write.
 *
 * @param {string} albumKey
 * @param {string} browseId
 * @returns {Promise<boolean|null>} True when a tracklist was written, false when the
 *   download failed or came back empty, and null when the call was skipped (no
 *   browse ID, or a fetch for that album is already in flight).
 */
async function ensureAlbumTracklist(albumKey, browseId) {
  if (!browseId || pendingTracklistFetches.has(albumKey)) {
    return null;
  }
  pendingTracklistFetches.add(albumKey);

  try {
    const fetched = await tracklistQueue.enqueue(() => fetchAlbumTrackCount(browseId));
    if (!fetched || !fetched.trackTitles || fetched.trackTitles.length === 0) {
      await recordEnrichmentAttempt(albumKey, false);
      return false;
    }

    return await withStorageLock(async () => {
      try {
        const data = await extBrowser.storage.local.get(['albums']);
        const albums = cleanAlbumsDict(data.albums || {});
        const targetKey = albums[albumKey]
          ? albumKey
          : Object.keys(albums).find((k) => k.toLowerCase() === albumKey.toLowerCase());

        if (!targetKey || !albums[targetKey]) {
          console.warn('[YTMusic Counter] Could not find album in database during lock:', albumKey);
          return false;
        }

        albums[targetKey].totalTracks = fetched.totalTracks || fetched.trackTitles.length;
        albums[targetKey].allTracks = fetched.trackTitles;
        albums[targetKey].completePlays = calculateCompletePlays(albums[targetKey]);

        if (fetched.coverUrl && !albums[targetKey].coverUrl) {
          albums[targetKey].coverUrl = fetched.coverUrl;
        }

        await extBrowser.storage.local.set({ albums });
        invalidateStatsCache();
        return true;
      } catch (err) {
        console.error('[YTMusic Counter] Error persisting tracklist for', albumKey, err);
        return false;
      }
    });
  } catch (err) {
    console.warn('[YTMusic Counter] Error ensuring album tracklist for', albumKey, err);
    await recordEnrichmentAttempt(albumKey, false);
    return false;
  } finally {
    pendingTracklistFetches.delete(albumKey);
  }
}

/**
 * Records an enrichment attempt so failures are not retried forever.
 *
 * `pendingTracklistFetches` only dedupes *concurrent* calls and lives in memory,
 * so a service worker restart used to re-request every unresolved album. Combined
 * with the queue's internal retry x3 and exponential backoff, that is the
 * fastest way to earn a 429 or a CAPTCHA from the browse endpoint.
 *
 * @param {string} albumKey
 * @param {boolean} succeeded
 */
async function recordEnrichmentAttempt(albumKey, succeeded) {
  if (!albumKey) return;
  try {
    const data = await extBrowser.storage.local.get([ENRICHMENT_ATTEMPTS_KEY]);
    const attempts = data[ENRICHMENT_ATTEMPTS_KEY] || {};
    if (succeeded) {
      delete attempts[albumKey];
    } else {
      attempts[albumKey] = Date.now();
    }
    await extBrowser.storage.local.set({ [ENRICHMENT_ATTEMPTS_KEY]: attempts });
  } catch (_) {
    // Bookkeeping is best-effort; never fail a fetch over it.
  }
}

/**
 * Filters out albums whose last attempt failed inside the cooldown window.
 *
 * @param {Array<[string, object]>} candidates
 * @returns {Promise<Array<[string, object]>>}
 */
async function filterRecentlyFailedAlbums(candidates) {
  if (candidates.length === 0) return candidates;
  try {
    const data = await extBrowser.storage.local.get([ENRICHMENT_ATTEMPTS_KEY]);
    const attempts = data[ENRICHMENT_ATTEMPTS_KEY] || {};
    const cutoff = Date.now() - ENRICHMENT_RETRY_COOLDOWN_MS;
    return candidates.filter(([albumKey]) => {
      const lastAttempt = Number(attempts[albumKey]) || 0;
      return lastAttempt < cutoff;
    });
  } catch (_) {
    return candidates;
  }
}

/** Albums processed per pump before yielding back to the event loop. */
const ENRICHMENT_BATCH_SIZE = 5;

/** Delay between two pump cycles. */
const ENRICHMENT_PUMP_INTERVAL_MS = 1500;

let enrichmentPumpTimer = null;

/**
 * Persists a resumable enrichment job and starts pumping it.
 *
 * The previous design awaited the whole batch inside the message handler. That is
 * incompatible with MV3: a single event may not keep the service worker alive for
 * more than ~5 minutes, and a full sweep is hundreds of throttled requests. The
 * worker was killed mid-batch, `sendResponse` never fired, and the Details page's
 * "Fetch Missing Tracklists" button stayed disabled forever.
 *
 * Now the candidate list plus a cursor live in storage, the UI is answered
 * immediately, and the pump advances in small slices. If the worker dies anyway,
 * `resumeEnrichmentQueue()` picks the job back up on the next start.
 *
 * @param {object} [options]
 * @param {boolean} [options.force] Ignore the unique-tracks threshold.
 * @returns {Promise<{queued: boolean, total: number, reason?: string}>}
 */
async function enqueueAlbumEnrichment(options) {
  const opts = options || {};
  const config = await getEnrichmentConfig();
  const data = await extBrowser.storage.local.get(['albums']);
  const selected = selectAlbumsToEnrich(data.albums || {}, {
    minUniqueTracks: config.minUniqueTracks,
    force: Boolean(opts.force)
  });
  // Skip albums that already failed inside the cooldown window, otherwise a
  // re-run (or a worker restart mid-job) re-requests every known-bad browse ID.
  const candidates = await filterRecentlyFailedAlbums(selected);

  if (candidates.length === 0) {
    return {
      queued: false,
      total: 0,
      deferred: selected.length,
      reason: selected.length > 0 ? 'all-recently-failed' : 'no-albums-to-enrich'
    };
  }

  const job = {
    candidates,
    index: 0,
    updated: 0,
    failed: 0,
    skipped: selected.length - candidates.length,
    force: Boolean(opts.force),
    startedAt: Date.now()
  };

  await extBrowser.storage.local.set({ [ENRICHMENT_QUEUE_KEY]: job });
  scheduleEnrichmentPump(0);

  debugLog('BG_ENRICH', `Enrichment queued: ${candidates.length} albums (resumable${job.skipped ? `, ${job.skipped} deferred after recent failure` : ''}).`);
  return { queued: true, total: candidates.length, deferred: job.skipped };
}

/**
 * Resumes a persisted enrichment job. Safe to call on every worker start.
 *
 * @returns {Promise<void>}
 */
async function resumeEnrichmentQueue() {
  try {
    const data = await extBrowser.storage.local.get([ENRICHMENT_QUEUE_KEY]);
    const job = data[ENRICHMENT_QUEUE_KEY];
    if (!job || !Array.isArray(job.candidates) || job.candidates.length === 0) return;
    if (job.index >= job.candidates.length) {
      await extBrowser.storage.local.remove(ENRICHMENT_QUEUE_KEY);
      return;
    }
    debugLog('BG_ENRICH', `Resuming enrichment at ${job.index}/${job.candidates.length}.`);
    scheduleEnrichmentPump(0);
  } catch (_) {}
}

/**
 * Writes enrichment progress to `scanProgress`, unless a live history scan owns
 * the panel. Without this guard the pump overwrote the scanner's `isScanning`
 * state mid-scan and the scanner looked stuck.
 *
 * @param {object} progress A payload from buildEnrichmentProgress.
 * @returns {Promise<boolean>} Whether the write happened.
 */
async function publishEnrichmentProgress(progress) {
  try {
    const data = await extBrowser.storage.local.get(['scanProgress']);
    if (!shouldPublishEnrichmentProgress(data.scanProgress)) return false;
    await extBrowser.storage.local.set({ scanProgress: progress });
    return true;
  } catch (_) {
    return false;
  }
}

function scheduleEnrichmentPump(delayMs) {
  if (enrichmentPumpTimer) clearTimeout(enrichmentPumpTimer);
  enrichmentPumpTimer = setTimeout(() => {
    enrichmentPumpTimer = null;
    pumpEnrichmentQueue().catch(() => {});
  }, delayMs || ENRICHMENT_PUMP_INTERVAL_MS);
}

/**
 * Advances the persisted enrichment job by one small batch.
 *
 * @returns {Promise<void>}
 */
async function pumpEnrichmentQueue() {
  let job;
  try {
    const data = await extBrowser.storage.local.get([ENRICHMENT_QUEUE_KEY]);
    job = data[ENRICHMENT_QUEUE_KEY];
  } catch (_) {
    return;
  }

  if (!job || !Array.isArray(job.candidates)) return;

  const end = Math.min(job.index + ENRICHMENT_BATCH_SIZE, job.candidates.length);

  for (; job.index < end; job.index++) {
    const [albumKey, album] = job.candidates[job.index];

    // Progress is throttled: writing it for every album meant hundreds of
    // storage.set calls, and each one fired storage.onChanged on the Details page.
    if (job.index % ENRICHMENT_PROGRESS_WRITE_EVERY === 0) {
      await publishEnrichmentProgress(buildEnrichmentProgress(job, { step: 'scanning' }));
    }

    const resolved = await ensureAlbumTracklist(albumKey, album.albumBrowseId);
    if (resolved === true) {
      job.updated++;
    } else if (resolved === null) {
      job.skipped++;
    } else {
      job.failed++;
      debugLog('BG_ENRICH_ERR', `Could not resolve a tracklist for ${albumKey}.`);
    }
  }

  if (job.index >= job.candidates.length) {
    await publishEnrichmentProgress(buildEnrichmentProgress(job, {
      step: 'done',
      reason: 'complete',
      done: true
    }));
    await extBrowser.storage.local.remove(ENRICHMENT_QUEUE_KEY);
    debugLog('BG_ENRICH', `Enrichment finished: ${job.updated} updated, ${job.failed} unresolved, ${job.skipped} skipped, of ${job.candidates.length}.`);
    return;
  }

  await extBrowser.storage.local.set({ [ENRICHMENT_QUEUE_KEY]: job }).catch(() => {});
  scheduleEnrichmentPump(ENRICHMENT_PUMP_INTERVAL_MS);
}

/**
 * Handles the manual "Fetch Missing Tracklists" tool from the Details page.
 * Bypasses the listening-threshold barrier so every album that still lacks a
 * tracklist gets resolved, but keeps the serial throttled pacing.
 *
 * Answers immediately with the queue depth; the sweep itself runs in the
 * background and reports through `scanProgress`.
 *
 * @param {object} [payload]
 * @param {boolean} [payload.force] Defaults to true; set false to honour the threshold.
 * @returns {Promise<{queued: boolean, total: number, reason?: string}>}
 */
async function handleFetchMissingTracklists(payload) {
  const force = !payload || payload.force !== false;
  return enqueueAlbumEnrichment({ force });
}

/**
 * Persists the user-tunable enrichment options and rebuilds the throttled queue.
 *
 * @param {object} payload
 * @returns {Promise<object>} The effective (clamped) configuration.
 */
async function handleSetEnrichmentConfig(payload) {
  const incoming = payload && typeof payload === 'object' ? payload : {};
  const existing = await getEnrichmentConfig();

  const merged = { ...existing };
  for (const key of ['minUniqueTracks', 'minDelayMs', 'maxDelayMs', 'maxRetries']) {
    if (incoming[key] !== undefined && incoming[key] !== null && incoming[key] !== '') {
      merged[key] = Number(incoming[key]);
    }
  }

  const resolved = resolveEnrichmentConfig(merged);
  await extBrowser.storage.local.set({ [ENRICHMENT_CONFIG_KEY]: resolved });
  await reconfigureTracklistQueue();

  debugLog('BG_ENRICH', `Enrichment config updated: ${JSON.stringify(resolved)}`);
  return resolved;
}
