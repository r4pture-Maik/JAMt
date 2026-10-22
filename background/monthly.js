/**
 * JAMt - Monthly Listening Module
 * Month-granularity buckets stored next to the all-time dictionaries: one storage key per month
 * (`month:YYYY-MM`) plus a sorted `monthIndex`. Pure bucket math and storage helpers.
 */

import { makeArtistKey, isDangerousKey } from './storage.js';

/** storage.local key holding the sorted array of month ids that have a bucket. */
export const MONTH_INDEX_KEY = 'monthIndex';

/** Prefix of the per-month storage keys (`month:YYYY-MM`). */
export const MONTH_KEY_PREFIX = 'month:';

const MONTH_ID_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const DICT_NAMES = ['songs', 'artists', 'albums'];

function isObject(value) {
  return typeof value === 'object' && value !== null;
}

function nonNegative(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

/**
 * Returns true when `id` is a month id in the `YYYY-MM` format (month 01..12).
 *
 * @param {any} id
 * @returns {boolean}
 */
export function isMonthId(id) {
  return typeof id === 'string' && MONTH_ID_RE.test(id);
}

/**
 * Builds the storage key of a month bucket.
 *
 * @param {string} id  month id, e.g. "2026-10"
 * @returns {string} e.g. "month:2026-10"
 */
export function monthStorageKey(id) {
  return MONTH_KEY_PREFIX + id;
}

/**
 * Creates a fresh, empty month bucket.
 *
 * @param {string} id  month id, e.g. "2026-10"
 * @returns {{ id: string, totalPlays: number, totalListeningSeconds: number, songs: object, artists: object, albums: object }}
 */
export function createEmptyMonthBucket(id) {
  return {
    id,
    totalPlays: 0,
    totalListeningSeconds: 0,
    songs: {},
    artists: {},
    albums: {}
  };
}

/**
 * Splits a raw artist string into unique artist keys, using the same separators as storage.js.
 *
 * @param {string} artist  e.g. "B feat. C"
 * @returns {string[]} e.g. ["b", "c"]
 */
export function artistKeysFor(artist) {
  const keys = (artist || '')
    .split(/[,&/]| feat\.? | ft\.? /i)
    .map(a => a.trim())
    .filter(Boolean)
    .map(makeArtistKey)
    .filter(Boolean);
  return [...new Set(keys)];
}

/**
 * Adds `playDelta` plays and `seconds` to the entry `key` of `dict`, creating it when missing.
 * Dangerous keys are ignored.
 */
function addToEntry(dict, key, playDelta, seconds) {
  if (!key || isDangerousKey(key)) return;
  if (!Object.hasOwn(dict, key)) {
    dict[key] = { playCount: 0, durationSeconds: 0 };
  }
  dict[key].playCount += playDelta;
  dict[key].durationSeconds += seconds;
}

/**
 * Applies a play (or a bare duration when `playDelta` is 0) to the song, artist and album entries.
 */
function applyToBucket(bucket, { songKey, artistKeys = [], albumKey = '' }, playDelta, seconds) {
  bucket.songs = bucket.songs || {};
  bucket.artists = bucket.artists || {};
  bucket.albums = bucket.albums || {};

  addToEntry(bucket.songs, songKey, playDelta, seconds);
  for (const artistKey of artistKeys) {
    addToEntry(bucket.artists, artistKey, playDelta, seconds);
  }
  addToEntry(bucket.albums, albumKey, playDelta, seconds);
}

/**
 * Records one play in a month bucket: bumps the totals and the song, artist and album entries.
 *
 * @param {object} bucket  month bucket (mutated)
 * @param {object} play
 * @param {string} [play.songKey]
 * @param {string[]} [play.artistKeys]
 * @param {string} [play.albumKey]
 * @param {number} [play.seconds]  listening seconds attributed to this play
 * @returns {object} the same bucket
 */
export function recordPlayInBucket(bucket, { songKey, artistKeys = [], albumKey = '', seconds = 0 } = {}) {
  const secs = nonNegative(seconds);
  bucket.totalPlays = (bucket.totalPlays || 0) + 1;
  bucket.totalListeningSeconds = (bucket.totalListeningSeconds || 0) + secs;
  applyToBucket(bucket, { songKey, artistKeys, albumKey }, 1, secs);
  return bucket;
}

/**
 * Adds listening seconds to a month bucket without counting a play.
 * Totals other than the listening time are left untouched.
 *
 * @param {object} bucket  month bucket (mutated)
 * @param {object} tick
 * @param {string} [tick.songKey]
 * @param {string[]} [tick.artistKeys]
 * @param {string} [tick.albumKey]
 * @param {number} tick.seconds
 * @returns {object} the same bucket
 */
export function recordDurationInBucket(bucket, { songKey, artistKeys = [], albumKey = '', seconds } = {}) {
  const secs = nonNegative(seconds);
  if (secs <= 0) return bucket;
  bucket.totalListeningSeconds = (bucket.totalListeningSeconds || 0) + secs;
  applyToBucket(bucket, { songKey, artistKeys, albumKey }, 0, secs);
  return bucket;
}

/**
 * Returns the index with `id` added: sorted ascending, unique, invalid ids dropped.
 *
 * @param {any} index  current index (non-array is treated as empty)
 * @param {string} id  month id to add (ignored when invalid)
 * @returns {string[]} a new array
 */
export function addMonthId(index, id) {
  const source = Array.isArray(index) ? index : [];
  const ids = [...source, id].filter(isMonthId);
  return [...new Set(ids)].sort();
}

/**
 * Reads the month index as an array (empty when missing or malformed).
 */
async function readIndex(extBrowser) {
  const data = await extBrowser.storage.local.get([MONTH_INDEX_KEY]);
  const index = data ? data[MONTH_INDEX_KEY] : undefined;
  return Array.isArray(index) ? index : [];
}

/**
 * Reads the index and the requested month buckets in one storage call.
 * Missing or malformed buckets come back as fresh empty buckets.
 *
 * @param {object} extBrowser
 * @param {string[]} ids  month ids to read (invalid ids are skipped)
 * @returns {Promise<{ index: string[], buckets: object }>}
 */
export async function readMonthState(extBrowser, ids) {
  const monthIds = (Array.isArray(ids) ? ids : []).filter(isMonthId);
  const data = await extBrowser.storage.local.get([
    MONTH_INDEX_KEY,
    ...monthIds.map(monthStorageKey)
  ]);

  const index = Array.isArray(data[MONTH_INDEX_KEY]) ? data[MONTH_INDEX_KEY] : [];
  const buckets = {};
  for (const id of monthIds) {
    const stored = data[monthStorageKey(id)];
    buckets[id] = isObject(stored) ? stored : createEmptyMonthBucket(id);
  }

  return { index, buckets };
}

/**
 * Builds the storage.local update object for a set of month buckets.
 * Pure: callers merge it into their own `storage.local.set` so the write is atomic.
 *
 * @param {any} index  current month index
 * @param {object} buckets  { [id]: bucket }
 * @returns {object} keys `monthIndex` and `month:<id>` for each bucket
 */
export function buildMonthUpdates(index, buckets) {
  const ids = Object.keys(buckets || {}).filter(isMonthId);
  const updates = {
    [MONTH_INDEX_KEY]: ids.reduce((acc, id) => addMonthId(acc, id), Array.isArray(index) ? [...index] : [])
  };
  for (const id of ids) {
    updates[monthStorageKey(id)] = buckets[id];
  }
  return updates;
}

/**
 * Read-only query of month buckets, sorted ascending by id. Missing months are skipped.
 *
 * @param {object} extBrowser
 * @param {string[]} [ids]  month ids to query; when not an array, every month in the index is used
 * @returns {Promise<{ months: object[] }>}
 */
export async function getMonthlyStats(extBrowser, ids) {
  if (!extBrowser || !extBrowser.storage || !extBrowser.storage.local) {
    return { months: [] };
  }

  const wanted = Array.isArray(ids) ? ids : await readIndex(extBrowser);
  const monthIds = [...new Set(wanted.filter(isMonthId))].sort();
  if (monthIds.length === 0) {
    return { months: [] };
  }

  const data = await extBrowser.storage.local.get(monthIds.map(monthStorageKey));
  const months = monthIds
    .map(id => data[monthStorageKey(id)])
    .filter(isObject);

  return { months };
}

/**
 * Collects every month listed in the index that exists in storage.
 *
 * @param {object} extBrowser
 * @returns {Promise<object>} { [id]: bucket }
 */
export async function collectMonthsForExport(extBrowser) {
  if (!extBrowser || !extBrowser.storage || !extBrowser.storage.local) {
    return {};
  }

  const ids = [...new Set((await readIndex(extBrowser)).filter(isMonthId))].sort();
  if (ids.length === 0) {
    return {};
  }

  const data = await extBrowser.storage.local.get(ids.map(monthStorageKey));
  const months = {};
  for (const id of ids) {
    const stored = data[monthStorageKey(id)];
    if (isObject(stored)) months[id] = stored;
  }
  return months;
}

/**
 * Lists the storage keys of every month in the index (used to remove old months before an import).
 *
 * @param {object} extBrowser
 * @returns {Promise<string[]>} e.g. ["month:2026-09", "month:2026-10"]
 */
export async function listStoredMonthKeys(extBrowser) {
  if (!extBrowser || !extBrowser.storage || !extBrowser.storage.local) {
    return [];
  }
  const ids = [...new Set((await readIndex(extBrowser)).filter(isMonthId))];
  return ids.map(monthStorageKey);
}

/**
 * Sanitizes months coming from an untrusted backup file.
 * Each bucket id is taken from its dictionary key; counters are clamped to non-negative integers
 * and dangerous dictionary keys are dropped.
 *
 * @param {any} months  { [id]: rawBucket }
 * @returns {object} { [id]: cleanBucket }
 */
export function sanitizeMonthsForImport(months) {
  if (!isObject(months) || Array.isArray(months)) return {};

  const clean = {};
  for (const [id, raw] of Object.entries(months)) {
    if (!isMonthId(id) || !isObject(raw)) continue;

    const bucket = createEmptyMonthBucket(id);
    bucket.totalPlays = nonNegative(raw.totalPlays);
    bucket.totalListeningSeconds = nonNegative(raw.totalListeningSeconds);

    for (const name of DICT_NAMES) {
      if (!isObject(raw[name])) continue;
      for (const [key, entry] of Object.entries(raw[name])) {
        if (isDangerousKey(key) || !isObject(entry)) continue;
        bucket[name][key] = {
          playCount: nonNegative(entry.playCount),
          durationSeconds: nonNegative(entry.durationSeconds)
        };
      }
    }

    clean[id] = bucket;
  }
  return clean;
}
