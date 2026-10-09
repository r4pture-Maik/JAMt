/**
 * YTMusic Counter - Album Metadata Enrichment Policy
 *
 * Pure, dependency-free logic behind the album tracklist enrichment pipeline.
 * Everything here is unit-testable in Node (see tests/enrichment.test.js) and
 * is consumed by background/background.js.
 *
 * Rationale:
 * A 200-track history scan yields ~115 distinct albums, of which ~83% have only
 * a single listened track and can never be "completed" (singles aside).
 * Downloading their official tracklists is therefore ~91 wasted requests that
 * expose the extension to HTTP 429 / CAPTCHA. A threshold on
 * `uniqueTracksCount` removes them from the batch while Levels 2 (live
 * tracking) and 3 (on-demand UI) still resolve them lazily if the user cares.
 */

/**
 * Default minimum number of unique listened tracks an album must have to be
 * enriched during a batch scan. Overridable at runtime via the
 * `enrichmentConfig.minUniqueTracks` storage key.
 */
export const DEFAULT_MIN_UNIQUE_TRACKS = 2;

/** Lower / upper bound of the inter-request delay, in milliseconds. */
export const MIN_REQUEST_DELAY_MS = 500;
export const MAX_REQUEST_DELAY_MS = 800;

/** Backoff applied when YouTube answers with a rate-limiting status. */
export const BASE_BACKOFF_MS = 2000;
export const MAX_RETRIES = 3;

/** Storage key holding the user-tunable enrichment options. */
export const ENRICHMENT_CONFIG_KEY = 'enrichmentConfig';

/**
 * Value of `scanProgress.kind` for the album-metadata enrichment pump.
 *
 * Enrichment and the history scanner share the single `scanProgress` storage key
 * so the Details page has one place to watch, but they are different activities.
 * The kind tag lets a reader tell them apart instead of guessing from `isScanning`.
 */
export const ENRICHMENT_PROGRESS_KIND = 'enrichment';

/**
 * A scan that has not written progress for this long is treated as dead.
 *
 * `scanProgress.isScanning` is only ever cleared by the content script that set
 * it, so closing the history tab mid-scan left the Details page stuck on
 * "Sync in Progress" with the Start button disabled and no way out.
 */
export const STALE_SCAN_AFTER_MS = 3 * 60 * 1000;

/**
 * Builds the `scanProgress` payload published by the enrichment pump.
 *
 * Built from scratch rather than by spreading an earlier `scanProgress`. That
 * spread was the bug: a job is usually queued while a history scan is still
 * finishing, so every pump tick republished `isScanning: true` plus that scan's
 * `latestTrack`, and the Details page reported "Sync in Progress" with the last
 * imported track long after the import finished.
 *
 * @param {object} job Persisted enrichment job.
 * @param {string} statusText
 * @param {boolean} [done] Marks the terminal write.
 * @returns {object} A `scanProgress` payload.
 */
export function buildEnrichmentProgress(job, statusText, done = false) {
  const source = job && typeof job === 'object' ? job : {};

  return {
    kind: ENRICHMENT_PROGRESS_KIND,
    isScanning: false,
    latestTrack: null,
    count: 0,
    unique: 0,
    updatedAt: Date.now(),
    enrichmentTotal: Array.isArray(source.candidates) ? source.candidates.length : 0,
    enrichmentProcessed: Number(source.index) || 0,
    enrichmentUpdated: Number(source.updated) || 0,
    enrichmentFailed: Number(source.failed) || 0,
    enrichmentDone: Boolean(done),
    statusText: statusText || ''
  };
}

/**
 * True when the enrichment pump may overwrite the current `scanProgress`.
 *
 * A live history scan owns the panel while it runs, so publishing enrichment
 * text over it would make the scanner look idle mid-scan.
 *
 * @param {object} currentScanProgress Current value of the `scanProgress` key.
 * @returns {boolean}
 */
export function shouldPublishEnrichmentProgress(currentScanProgress) {
  if (!currentScanProgress || typeof currentScanProgress !== 'object') return true;
  if (currentScanProgress.kind === ENRICHMENT_PROGRESS_KIND) return true;
  return !currentScanProgress.isScanning;
}

/**
 * True when a scan claims to be running but has not reported progress recently
 * enough to still be alive.
 *
 * @param {object} progress A `scanProgress` payload.
 * @param {number} [now] Injectable clock for tests.
 * @returns {boolean}
 */
export function isStaleScanProgress(progress, now = Date.now()) {
  if (!progress || typeof progress !== 'object') return false;
  if (progress.kind === ENRICHMENT_PROGRESS_KIND) return false;
  if (!progress.isScanning) return false;
  const updatedAt = Number(progress.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false;
  return (now - updatedAt) > STALE_SCAN_AFTER_MS;
}

/**
 * Normalizes an album browse ID into the form expected by the browse endpoint.
 * Playlist-style IDs need the `VL` prefix; `OLAK5uy...` album IDs are converted.
 *
 * @param {string} browseId
 * @returns {string} Normalized ID, or '' when the input is unusable.
 */
export function normalizeBrowseId(browseId) {
  if (typeof browseId !== 'string') return '';
  const id = browseId.trim();
  if (!id) return '';
  if (id.startsWith('VL')) return id;
  if (id.startsWith('OLAK5uy')) return `VL${id}`;
  return id;
}

/**
 * True for HTTP statuses that indicate YouTube is throttling us.
 *
 * @param {number} status
 * @returns {boolean}
 */
export function isRateLimitedStatus(status) {
  return status === 429 || status === 403;
}

/**
 * Resolves the effective enrichment options, merging stored overrides over the
 * defaults and clamping the threshold to a sane range.
 *
 * @param {object} [storedConfig] Value previously read from storage.
 * @returns {{minUniqueTracks: number, minDelayMs: number, maxDelayMs: number, maxRetries: number}}
 */
export function resolveEnrichmentConfig(storedConfig) {
  const cfg = storedConfig && typeof storedConfig === 'object' ? storedConfig : {};

  const rawThreshold = Number(cfg.minUniqueTracks);
  const minUniqueTracks = Number.isFinite(rawThreshold) && rawThreshold >= 1
    ? Math.floor(rawThreshold)
    : DEFAULT_MIN_UNIQUE_TRACKS;

  const rawMin = Number(cfg.minDelayMs);
  const rawMax = Number(cfg.maxDelayMs);
  const minDelayMs = Number.isFinite(rawMin) && rawMin >= 0 ? Math.floor(rawMin) : MIN_REQUEST_DELAY_MS;
  const maxDelayMs = Number.isFinite(rawMax) && rawMax >= minDelayMs ? Math.floor(rawMax) : Math.max(minDelayMs, MAX_REQUEST_DELAY_MS);

  const rawRetries = Number(cfg.maxRetries);
  const maxRetries = Number.isFinite(rawRetries) && rawRetries >= 0 ? Math.floor(rawRetries) : MAX_RETRIES;

  return { minUniqueTracks, minDelayMs, maxDelayMs, maxRetries };
}

/**
 * Decides whether a single album deserves a tracklist download in a batch run.
 *
 * An album qualifies when it has a usable browse ID, no tracklist yet, and has
 * been listened to at least `minUniqueTracks` distinct tracks. `force` bypasses
 * the listening threshold (used by the manual "Fetch Missing Tracklists" tool).
 *
 * @param {any} album
 * @param {object} [options]
 * @param {number} [options.minUniqueTracks]
 * @param {boolean} [options.force] Ignore the threshold, still require a browse ID.
 * @returns {boolean}
 */
export function shouldEnrichAlbum(album, options) {
  const opts = options || {};
  if (!album || typeof album !== 'object') return false;
  if (!normalizeBrowseId(album.albumBrowseId)) return false;
  if (Array.isArray(album.allTracks) && album.allTracks.length > 0) return false;

  if (opts.force) return true;

  const threshold = Number.isFinite(opts.minUniqueTracks) ? opts.minUniqueTracks : DEFAULT_MIN_UNIQUE_TRACKS;
  const uniqueTracks = Number(album.uniqueTracksCount) || 0;
  return uniqueTracks >= threshold;
}

/**
 * Filters an albums dictionary down to the entries worth enriching.
 *
 * @param {Record<string, any>} albums
 * @param {object} [options] Same shape as shouldEnrichAlbum, plus `limit`.
 * @returns {Array<[string, any]>} `[albumKey, album]` pairs.
 */
export function selectAlbumsToEnrich(albums, options) {
  const opts = options || {};
  if (!albums || typeof albums !== 'object') return [];

  const selected = [];
  for (const [albumKey, album] of Object.entries(albums)) {
    if (shouldEnrichAlbum(album, opts)) {
      selected.push([albumKey, album]);
    }
  }

  const limit = Number(opts.limit);
  if (Number.isFinite(limit) && limit > 0) {
    return selected.slice(0, Math.floor(limit));
  }
  return selected;
}

/**
 * Splits a browse JSON payload into the shape the enrichment pipeline stores.
 * Returns null when the payload yields neither tracks nor artwork.
 *
 * @param {any} json
 * @returns {{totalTracks: number|null, trackTitles: string[], coverUrl: string|null}|null}
 */
export function parseBrowsePayload(json, helpers) {
  const { extractTrackTitlesFromBrowse, findBestThumbnail } = helpers;
  if (!json) return null;

  const trackTitles = extractTrackTitlesFromBrowse(json.contents);
  const coverUrl = findBestThumbnail(json);

  if (trackTitles.length > 0 || coverUrl) {
    return { totalTracks: trackTitles.length || null, trackTitles, coverUrl };
  }
  return null;
}

/**
 * Creates a strictly serial, self-throttling task queue with exponential
 * backoff on rate-limiting responses.
 *
 * Tasks run one at a time, separated by a random delay in
 * `[minDelayMs, maxDelayMs]`. A task may signal throttling by returning
 * `{ rateLimited: true }` (or throwing a `RateLimitError`); the queue then
 * sleeps for an exponentially growing backoff before retrying, up to
 * `maxRetries` extra attempts. A 429 triggers a global cooldown, so pending
 * tasks wait it out instead of piling onto the same blocked endpoint.
 *
 * @param {object} [options]
 * @param {number} [options.minDelayMs]
 * @param {number} [options.maxDelayMs]
 * @param {number} [options.maxRetries]
 * @param {number} [options.baseBackoffMs]
 * @param {(ms: number) => Promise<void>} [options.sleep] Injectable for tests.
 * @param {() => number} [options.random] Injectable for tests.
 * @returns {{enqueue: <T>(task: (attempt: number) => Promise<T>) => Promise<T>, size: () => number, isCoolingDown: () => boolean, pending: () => number}}
 */
export function createThrottledQueue(options) {
  const opts = options || {};
  const minDelayMs = Number.isFinite(opts.minDelayMs) ? opts.minDelayMs : MIN_REQUEST_DELAY_MS;
  const maxDelayMs = Number.isFinite(opts.maxDelayMs) ? opts.maxDelayMs : Math.max(minDelayMs, MAX_REQUEST_DELAY_MS);
  const maxRetries = Number.isFinite(opts.maxRetries) ? opts.maxRetries : MAX_RETRIES;
  const baseBackoffMs = Number.isFinite(opts.baseBackoffMs) ? opts.baseBackoffMs : BASE_BACKOFF_MS;
  const sleep = typeof opts.sleep === 'function'
    ? opts.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const random = typeof opts.random === 'function' ? opts.random : Math.random;

  const queue = [];
  let draining = false;
  // -Infinity means "no request issued yet", so the very first task fires
  // immediately instead of paying the inter-request delay upfront.
  let lastRequestAt = Number.NEGATIVE_INFINITY;
  let cooldownUntil = 0;

  function nextDelay() {
    const span = Math.max(0, maxDelayMs - minDelayMs);
    return minDelayMs + Math.floor(random() * (span + 1));
  }

  /**
   * Waits until the endpoint is off cooldown and the inter-request gap elapsed.
   */
  async function waitForSlot() {
    const now = Date.now();
    const cooldownRemaining = cooldownUntil - now;
    if (cooldownRemaining > 0) {
      await sleep(cooldownRemaining);
    }
    const gap = lastRequestAt + nextDelay() - Date.now();
    if (gap > 0) {
      await sleep(gap);
    }
    lastRequestAt = Date.now();
  }

  async function runWithRetries(task) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await waitForSlot();
      try {
        const result = await task(attempt);
        if (result && result.rateLimited) {
          throw Object.assign(new Error('Rate limited by YouTube Music'), { isRateLimit: true });
        }
        return result;
      } catch (err) {
        const throttled = Boolean(err && (err.isRateLimit || err.rateLimited || err.status === 429 || err.status === 403));
        if (!throttled || attempt === maxRetries) throw err;
        const backoff = baseBackoffMs * Math.pow(2, attempt);
        cooldownUntil = Date.now() + backoff;
        lastRequestAt = Number.NEGATIVE_INFINITY;
        await sleep(backoff);
      }
    }
    // Unreachable: the loop either returns a result or rethrows on the last
    // attempt. Kept as a guard so a caller can never observe an undefined resolve.
    return undefined;
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const item = queue.shift();
        try {
          item.resolve(await runWithRetries(item.task));
        } catch (err) {
          item.reject(err);
        }
      }
    } finally {
      draining = false;
    }
  }

  return {
    enqueue(task) {
      return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        drain();
      });
    },
    size() {
      return queue.length;
    },
    isCoolingDown() {
      return Date.now() < cooldownUntil;
    },
    pending() {
      return queue.length + (draining ? 1 : 0);
    }
  };
}
