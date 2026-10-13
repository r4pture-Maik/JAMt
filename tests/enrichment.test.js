import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Side-effect import: registers the shared parsers on globalThis.YTMCShared,
// exactly as background/background.js does.
import '../shared/browse-parse.js';

import {
  DEFAULT_MIN_UNIQUE_TRACKS,
  MIN_REQUEST_DELAY_MS,
  MAX_REQUEST_DELAY_MS,
  normalizeBrowseId,
  isRateLimitedStatus,
  resolveEnrichmentConfig,
  shouldEnrichAlbum,
  selectAlbumsToEnrich,
  parseBrowsePayload,
  createThrottledQueue,
  ENRICHMENT_PROGRESS_KIND,
  STALE_SCAN_AFTER_MS,
  buildEnrichmentProgress,
  shouldPublishEnrichmentProgress,
  isStaleScanProgress,
  SCAN_PROGRESS_STEPS,
  SCAN_PROGRESS_REASONS,
  SCAN_PROGRESS_ERROR_CODES
} from '../background/enrichment.js';

/** The shared browse helpers, as published by shared/browse-parse.js. */
function loadSharedParsers() {
  return globalThis.YTMCShared;
}

describe('Enrichment - normalizeBrowseId', () => {
  test('leaves playlist-style IDs untouched', () => {
    assert.equal(normalizeBrowseId('VLPLQwVrqPPF'), 'VLPLQwVrqPPF');
  });

  test('prefixes bare album IDs with VL', () => {
    assert.equal(normalizeBrowseId('OLAK5uy_abc123'), 'VLOLAK5uy_abc123');
  });

  test('passes through other opaque IDs unchanged', () => {
    assert.equal(normalizeBrowseId('MPREb_1234'), 'MPREb_1234');
  });

  test('returns empty string for unusable input', () => {
    assert.equal(normalizeBrowseId(''), '');
    assert.equal(normalizeBrowseId('   '), '');
    assert.equal(normalizeBrowseId(null), '');
    assert.equal(normalizeBrowseId(undefined), '');
    assert.equal(normalizeBrowseId(42), '');
  });
});

describe('Enrichment - isRateLimitedStatus', () => {
  test('flags 429 and 403 as rate limiting', () => {
    assert.equal(isRateLimitedStatus(429), true);
    assert.equal(isRateLimitedStatus(403), true);
  });

  test('does not flag ordinary responses', () => {
    assert.equal(isRateLimitedStatus(200), false);
    assert.equal(isRateLimitedStatus(404), false);
    assert.equal(isRateLimitedStatus(500), false);
  });
});

describe('Enrichment - resolveEnrichmentConfig', () => {
  test('falls back to documented defaults', () => {
    const cfg = resolveEnrichmentConfig(null);
    assert.equal(cfg.minUniqueTracks, DEFAULT_MIN_UNIQUE_TRACKS);
    assert.equal(cfg.minUniqueTracks, 2);
    assert.equal(cfg.minDelayMs, MIN_REQUEST_DELAY_MS);
    assert.equal(cfg.maxDelayMs, MAX_REQUEST_DELAY_MS);
    assert.equal(cfg.maxRetries, 3);
  });

  test('honours a valid user override', () => {
    const cfg = resolveEnrichmentConfig({ minUniqueTracks: 5, minDelayMs: 250, maxDelayMs: 400, maxRetries: 1 });
    assert.equal(cfg.minUniqueTracks, 5);
    assert.equal(cfg.minDelayMs, 250);
    assert.equal(cfg.maxDelayMs, 400);
    assert.equal(cfg.maxRetries, 1);
  });

  test('clamps nonsense values instead of trusting them', () => {
    const cfg = resolveEnrichmentConfig({ minUniqueTracks: 0, minDelayMs: -99, maxDelayMs: 10, maxRetries: -4 });
    assert.equal(cfg.minUniqueTracks, DEFAULT_MIN_UNIQUE_TRACKS, 'threshold below 1 is rejected');
    assert.equal(cfg.minDelayMs, MIN_REQUEST_DELAY_MS, 'negative delay is rejected');
    assert.ok(cfg.maxDelayMs >= cfg.minDelayMs, 'maxDelayMs is never below minDelayMs');
    assert.equal(cfg.maxRetries, 3, 'negative retry count is rejected');
  });

  test('ignores non-numeric garbage', () => {
    const cfg = resolveEnrichmentConfig({ minUniqueTracks: 'many' });
    assert.equal(cfg.minUniqueTracks, DEFAULT_MIN_UNIQUE_TRACKS);
  });
});

describe('Enrichment - shouldEnrichAlbum (threshold barrier)', () => {
  const makeAlbum = (overrides) => ({
    album: 'Nurture',
    artist: 'Pelican',
    albumBrowseId: 'OLAK5uy_nurture',
    tracksListened: {},
    uniqueTracksCount: 0,
    totalTracks: null,
    allTracks: null,
    ...overrides
  });

  test('default barrier is 2 unique listened tracks', () => {
    assert.equal(DEFAULT_MIN_UNIQUE_TRACKS, 2);
    assert.equal(shouldEnrichAlbum(makeAlbum({ uniqueTracksCount: 1 })), false);
    assert.equal(shouldEnrichAlbum(makeAlbum({ uniqueTracksCount: 2 })), true);
    assert.equal(shouldEnrichAlbum(makeAlbum({ uniqueTracksCount: 3 })), true);
  });

  test('honours a raised threshold (>= 3 mode from the plan)', () => {
    assert.equal(shouldEnrichAlbum(makeAlbum({ uniqueTracksCount: 2 }), { minUniqueTracks: 3 }), false);
    assert.equal(shouldEnrichAlbum(makeAlbum({ uniqueTracksCount: 3 }), { minUniqueTracks: 3 }), true);
  });

  test('never enriches an album without a usable browse ID', () => {
    assert.equal(shouldEnrichAlbum(makeAlbum({ uniqueTracksCount: 9, albumBrowseId: '' })), false);
    assert.equal(shouldEnrichAlbum(makeAlbum({ uniqueTracksCount: 9, albumBrowseId: '   ' })), false);
    assert.equal(shouldEnrichAlbum(makeAlbum({ uniqueTracksCount: 9, albumBrowseId: undefined })), false);
  });

  test('never re-downloads an album that already has a tracklist', () => {
    assert.equal(shouldEnrichAlbum(makeAlbum({ uniqueTracksCount: 9, allTracks: ['A', 'B'] })), false);
  });

  test('treats an empty allTracks array as still missing', () => {
    assert.equal(shouldEnrichAlbum(makeAlbum({ uniqueTracksCount: 9, allTracks: [] })), true);
  });

  test('force bypasses the listening threshold but not the browse ID requirement', () => {
    assert.equal(shouldEnrichAlbum(makeAlbum({ uniqueTracksCount: 1 }), { force: true }), true);
    assert.equal(shouldEnrichAlbum(makeAlbum({ uniqueTracksCount: 1, albumBrowseId: '' }), { force: true }), false);
  });

  test('rejects malformed input', () => {
    assert.equal(shouldEnrichAlbum(null), false);
    assert.equal(shouldEnrichAlbum(undefined), false);
    assert.equal(shouldEnrichAlbum('not an album'), false);
  });

  test('derives the count defensively when uniqueTracksCount is missing', () => {
    const album = makeAlbum({ uniqueTracksCount: undefined });
    assert.equal(shouldEnrichAlbum(album), false);
    album.uniqueTracksCount = null;
    assert.equal(shouldEnrichAlbum(album), false);
  });
});

describe('Enrichment - selectAlbumsToEnrich', () => {
  /**
   * Reproduces the real distribution measured on a 200-track history:
   * 95 albums with a single listened track, 10 with two, 10 with three or more.
   */
  function buildRealisticLibrary() {
    const albums = {};
    for (let i = 0; i < 95; i++) {
      albums[`single ${i}:::artist`] = { album: `single ${i}`, artist: 'artist', albumBrowseId: `OLAK5uy_s${i}`, uniqueTracksCount: 1, allTracks: null };
    }
    for (let i = 0; i < 10; i++) {
      albums[`ep ${i}:::artist`] = { album: `ep ${i}`, artist: 'artist', albumBrowseId: `OLAK5uy_e${i}`, uniqueTracksCount: 2, allTracks: null };
    }
    for (let i = 0; i < 10; i++) {
      albums[`album ${i}:::artist`] = { album: `album ${i}`, artist: 'artist', albumBrowseId: `OLAK5uy_a${i}`, uniqueTracksCount: 3 + (i % 5), allTracks: null };
    }
    // 5 albums already fully enriched, must never be selected.
    for (let i = 0; i < 5; i++) {
      albums[`done ${i}:::artist`] = { album: `done ${i}`, artist: 'artist', albumBrowseId: `OLAK5uy_d${i}`, uniqueTracksCount: 8, allTracks: ['a', 'b', 'c'] };
    }
    return albums;
  }

  test('cuts 95 of 115 requests by skipping single-track albums', () => {
    const albums = buildRealisticLibrary();
    const selected = selectAlbumsToEnrich(albums);
    assert.equal(Object.keys(albums).length, 120);
    assert.equal(selected.length, 20, 'only the 2-track and 3+-track albums survive the barrier');
    assert.ok(selected.every(([, album]) => album.uniqueTracksCount >= 2));
  });

  test('a >= 3 threshold cuts 105 of 115 requests', () => {
    const selected = selectAlbumsToEnrich(buildRealisticLibrary(), { minUniqueTracks: 3 });
    assert.equal(selected.length, 10);
  });

  test('force mode selects every album still missing a tracklist', () => {
    const selected = selectAlbumsToEnrich(buildRealisticLibrary(), { force: true });
    assert.equal(selected.length, 115);
    assert.ok(selected.every(([, album]) => !album.allTracks || album.allTracks.length === 0));
  });

  test('preserves the album key so callers can persist by key', () => {
    const selected = selectAlbumsToEnrich({ 'nurture:::pelican': { albumBrowseId: 'OLAK5uy_x', uniqueTracksCount: 4 } });
    assert.deepEqual(selected.map(([key]) => key), ['nurture:::pelican']);
  });

  test('respects the limit option', () => {
    const selected = selectAlbumsToEnrich(buildRealisticLibrary(), { limit: 7 });
    assert.equal(selected.length, 7);
  });

  test('handles empty and malformed dictionaries', () => {
    assert.deepEqual(selectAlbumsToEnrich({}), []);
    assert.deepEqual(selectAlbumsToEnrich(null), []);
    assert.deepEqual(selectAlbumsToEnrich(undefined), []);
    assert.deepEqual(selectAlbumsToEnrich('nope'), []);
  });
});

describe('Enrichment - parseBrowsePayload', () => {
  const helpers = {
    extractTrackTitlesFromBrowse: (contents) => contents.titles || [],
    findBestThumbnail: (json) => json.cover || null
  };

  test('returns the tracklist and the cover', () => {
    const result = parseBrowsePayload({ contents: { titles: ['One', 'Two'] }, cover: 'https://i.ytimg.com/a.jpg' }, helpers);
    assert.deepEqual(result, { totalTracks: 2, trackTitles: ['One', 'Two'], coverUrl: 'https://i.ytimg.com/a.jpg' });
  });

  test('accepts a cover-only response with a null track count', () => {
    const result = parseBrowsePayload({ contents: { titles: [] }, cover: 'https://i.ytimg.com/a.jpg' }, helpers);
    assert.equal(result.totalTracks, null);
    assert.deepEqual(result.trackTitles, []);
  });

  test('returns null when the payload yields nothing usable', () => {
    assert.equal(parseBrowsePayload({ contents: { titles: [] }, cover: null }, helpers), null);
    assert.equal(parseBrowsePayload(null, helpers), null);
  });
});

describe('Shared browse parser - buildBrowseRequestBody', () => {
  test('falls back to the hardcoded WEB_REMIX context when none is supplied', async () => {
    const shared = await loadSharedParsers();
    const body = shared.buildBrowseRequestBody('MPREb_rVOXOuBjO1u');
    assert.equal(body.browseId, 'MPREb_rVOXOuBjO1u');
    assert.equal(body.context.client.clientName, 'WEB_REMIX');
    assert.equal(body.context.client.clientVersion, '1.20240101.01.00');
  });

  test('uses a supplied live context verbatim, so MPREb_ is not stuck behind a stale client version', async () => {
    const shared = await loadSharedParsers();
    const liveContext = { client: { clientName: 'WEB_REMIX', clientVersion: '1.20260920.01.00', visitorData: 'Cgt2aXNpdG9y' } };
    const body = shared.buildBrowseRequestBody('MPREb_rVOXOuBjO1u', liveContext);
    assert.equal(body.context.client.clientVersion, '1.20260920.01.00');
    assert.equal(body.context.client.visitorData, 'Cgt2aXNpdG9y');
    assert.equal(body.browseId, 'MPREb_rVOXOuBjO1u');
  });
});

describe('Shared browse parser - getPageInnerTubeContext', () => {
  test('builds a context from the page ytcfg, overriding the client identity', async () => {
    const shared = await loadSharedParsers();
    const cfg = new Map([
      ['INNERTUBE_CLIENT_VERSION', '1.20260920.01.00'],
      ['INNERTUBE_CLIENT_NAME', 'WEB_REMIX'],
      ['HL', 'it'],
      ['GL', 'IT'],
      ['INNERTUBE_CONTEXT', { client: { clientName: 'WEB_REMIX', visitorData: 'abc' }, request: { useSsl: true } }]
    ]);
    const context = shared.getPageInnerTubeContext({ ytcfg: { get: (k) => cfg.get(k) } });

    assert.equal(context.client.clientVersion, '1.20260920.01.00');
    assert.equal(context.client.hl, 'it');
    assert.equal(context.client.gl, 'IT');
    assert.equal(context.client.visitorData, 'abc', 'preserves fields the page provides');
    assert.equal(context.request.useSsl, true);
  });

  test('returns null when ytcfg is absent or has no client version', async () => {
    const shared = await loadSharedParsers();
    assert.equal(shared.getPageInnerTubeContext({}), null);
    assert.equal(shared.getPageInnerTubeContext({ ytcfg: {} }), null);
    assert.equal(shared.getPageInnerTubeContext({ ytcfg: { get: () => undefined } }), null);
    assert.equal(shared.getPageInnerTubeContext({ ytcfg: { get: () => { throw new Error('Xray denied'); } } }), null);
    assert.equal(shared.getPageInnerTubeContext(null), null);
  });

  test('deep-clones the page context so Xray wrappers never cross the message boundary', async () => {
    const shared = await loadSharedParsers();
    const pageContext = { client: { clientName: 'WEB_REMIX', clientVersion: '1.20260920.01.00' } };
    const cfg = new Map([
      ['INNERTUBE_CLIENT_VERSION', '1.20260920.01.00'],
      ['INNERTUBE_CONTEXT', pageContext]
    ]);
    const context = shared.getPageInnerTubeContext({ ytcfg: { get: (k) => cfg.get(k) } });

    assert.notEqual(context, pageContext, 'returns a copy, not the page object');
    assert.deepEqual(context, JSON.parse(JSON.stringify(context)), 'is structured-cloneable');
  });
});

describe('Enrichment - createThrottledQueue', () => {
  /**
   * Runs a queue body against a virtual clock so pacing is asserted exactly
   * rather than by wall-clock timing.
   */
  function withVirtualClock(run) {
    const realNow = Date.now;
    let virtualNow = 1000;
    const sleeps = [];
    Date.now = () => virtualNow;
    const sleep = async (ms) => { sleeps.push(ms); virtualNow += ms; };
    const restore = () => { Date.now = realNow; };
    return run({ sleep, sleeps, random: () => 0, now: () => virtualNow, restore });
  }

  test('runs tasks strictly one at a time, never concurrently', async () => {
    await withVirtualClock(async ({ sleep, random, restore }) => {
      try {
        const queue = createThrottledQueue({ minDelayMs: 500, maxDelayMs: 800, sleep, random });
        let inFlight = 0;
        let maxInFlight = 0;
        const order = [];

        const task = (id, ms) => async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, ms));
          order.push(id);
          inFlight--;
          return id;
        };

        // Enqueued all at once, without awaiting individually.
        const results = await Promise.all([
          queue.enqueue(task('a', 5)),
          queue.enqueue(task('b', 1)),
          queue.enqueue(task('c', 1))
        ]);

        assert.equal(maxInFlight, 1, 'never more than one request in flight');
        assert.deepEqual(order, ['a', 'b', 'c'], 'executed in submission order');
        assert.deepEqual(results, ['a', 'b', 'c']);
      } finally {
        restore();
      }
    });
  });

  test('spaces requests by a delay inside the configured window', async () => {
    await withVirtualClock(async ({ sleep, sleeps, random, restore }) => {
      try {
        const queue = createThrottledQueue({ minDelayMs: 500, maxDelayMs: 800, sleep, random: () => 0.5 });
        await queue.enqueue(async () => 'first');
        await queue.enqueue(async () => 'second');
        await queue.enqueue(async () => 'third');

        assert.equal(sleeps.length, 2, 'the first request fires immediately');
        assert.deepEqual(sleeps, [650, 650]);
        for (const ms of sleeps) {
          assert.ok(ms >= 500 && ms <= 800, `delay ${ms} stays within the 500-800ms window`);
        }
      } finally {
        restore();
      }
    });
  });

  test('retries with exponential backoff when the endpoint rate limits', async () => {
    await withVirtualClock(async ({ sleep, sleeps, restore }) => {
      try {
        const queue = createThrottledQueue({ minDelayMs: 500, maxDelayMs: 800, baseBackoffMs: 2000, maxRetries: 3, sleep, random: () => 0 });
        const attempts = [];
        const result = await queue.enqueue(async (attempt) => {
          attempts.push(attempt);
          if (attempt < 2) return { rateLimited: true };
          return 'ok';
        });

        assert.equal(result, 'ok');
        assert.deepEqual(attempts, [0, 1, 2], 'two retries were needed');
        // backoff grows 2000 -> 4000, plus the 500ms inter-request delay before each retry
        assert.ok(sleeps.includes(2000), 'first backoff is 2s');
        assert.ok(sleeps.includes(4000), 'second backoff doubles to 4s');
      } finally {
        restore();
      }
    });
  });

  test('gives up after maxRetries and rejects the caller', async () => {
    await withVirtualClock(async ({ sleep, restore }) => {
      try {
        const queue = createThrottledQueue({ minDelayMs: 10, maxDelayMs: 10, baseBackoffMs: 100, maxRetries: 2, sleep, random: () => 0 });
        let calls = 0;
        await assert.rejects(
          queue.enqueue(async () => { calls++; return { rateLimited: true }; }),
          /Rate limited/
        );
        assert.equal(calls, 3, 'initial attempt plus 2 retries');
      } finally {
        restore();
      }
    });
  });

  test('does not retry non-throttling failures', async () => {
    await withVirtualClock(async ({ sleep, restore }) => {
      try {
        const queue = createThrottledQueue({ minDelayMs: 10, maxDelayMs: 10, maxRetries: 3, sleep, random: () => 0 });
        let calls = 0;
        await assert.rejects(queue.enqueue(async () => { calls++; throw new Error('network down'); }), /network down/);
        assert.equal(calls, 1, 'a plain error is surfaced immediately');
      } finally {
        restore();
      }
    });
  });

  test('a 429 cooldown is applied to the tasks queued behind it', async () => {
    await withVirtualClock(async ({ sleep, sleeps, restore }) => {
      try {
        const queue = createThrottledQueue({ minDelayMs: 500, maxDelayMs: 800, baseBackoffMs: 3000, maxRetries: 1, sleep, random: () => 0 });
        const gated = queue.enqueue(async (attempt) => (attempt === 0 ? { rateLimited: true } : 'recovered'));
        const follower = queue.enqueue(async () => 'follower');

        assert.equal(await gated, 'recovered');
        assert.equal(await follower, 'follower');
        assert.ok(sleeps.includes(3000), 'the 429 triggered a global cooldown that the follower waited out');
      } finally {
        restore();
      }
    });
  });

  test('one rejected task does not stall the rest of the queue', async () => {
    await withVirtualClock(async ({ sleep, restore }) => {
      try {
        const queue = createThrottledQueue({ minDelayMs: 10, maxDelayMs: 10, sleep, random: () => 0 });
        const bad = queue.enqueue(async () => { throw new Error('boom'); });
        const good = queue.enqueue(async () => 'fine');

        await assert.rejects(bad, /boom/);
        assert.equal(await good, 'fine');
      } finally {
        restore();
      }
    });
  });
});

describe('Enrichment progress - buildEnrichmentProgress', () => {
  /**
   * The bug this guards: the payload was built by spreading the `scanProgress`
   * snapshot taken when the job was queued, so every write republished
   * `isScanning: true` and that scan's `latestTrack`. The Settings page read
   * "Syncing in progress" with the pre-import track forever.
   */
  function sampleJob(overrides = {}) {
    return {
      candidates: [['a:::b', {}], ['c:::d', {}]],
      index: 1,
      updated: 1,
      failed: 0,
      ...overrides
    };
  }

  test('carries only enrichment state, never a scan field', () => {
    // AD-10: the second argument is an options object of machine codes. It used
    // to be a positional `(statusText, done)` pair, and the record carried an
    // English sentence that was persisted to storage and re-rendered verbatim.
    const progress = buildEnrichmentProgress(sampleJob(), { step: 'scanning' });

    assert.equal(progress.kind, ENRICHMENT_PROGRESS_KIND);
    assert.equal(progress.isScanning, false, 'enrichment must not claim a scan is running');
    assert.equal(progress.latestTrack, null);
    assert.equal(progress.count, 0);
    assert.equal(progress.unique, 0);

    // The structured progress fields replace `statusText`.
    assert.equal(progress.step, 'scanning');
    assert.equal(progress.processed, 1);
    assert.equal(progress.total, 2);
    assert.equal(progress.reason, null);
    assert.equal(progress.errorCode, null);
    assert.equal(
      Object.prototype.hasOwnProperty.call(progress, 'statusText'),
      false,
      'scanProgress must not carry an English sentence (AD-10)'
    );

    assert.equal(progress.enrichmentTotal, 2);
    assert.equal(progress.enrichmentProcessed, 1);
    assert.equal(progress.enrichmentDone, false);
  });

  test('the terminal write is marked done', () => {
    const progress = buildEnrichmentProgress(
      sampleJob({ index: 2 }),
      { done: true, reason: 'complete' }
    );

    assert.equal(progress.enrichmentDone, true);
    assert.equal(progress.enrichmentProcessed, 2);
    assert.equal(progress.isScanning, false);

    // `done` used to be the third positional argument; passing it there now
    // leaves `enrichmentDone` false and the step stuck on 'scanning'.
    assert.equal(progress.step, 'done', 'a done write must carry the terminal step');
    assert.equal(progress.reason, 'complete');
    assert.equal(progress.errorCode, null);
  });

  test('tolerates a job with no candidates', () => {
    const progress = buildEnrichmentProgress({}, { step: 'scanning' });

    assert.equal(progress.isScanning, false);
    assert.equal(progress.enrichmentTotal, 0);
    assert.equal(progress.step, 'scanning');
    assert.equal(progress.processed, 0);
    assert.equal(progress.total, 0);
    assert.equal(Object.prototype.hasOwnProperty.call(progress, 'statusText'), false);
  });

  test('stamps a heartbeat so staleness checks have a reference point', () => {
    const before = Date.now();
    const progress = buildEnrichmentProgress(sampleJob(), { step: 'scanning' });

    assert.ok(progress.updatedAt >= before, 'carries a fresh updatedAt');
    assert.equal(isStaleScanProgress(progress, before + 1000), false);
  });

  test('carries a machine error code, never a sentence, on failure', () => {
    const progress = buildEnrichmentProgress(sampleJob(), {
      done: true,
      step: 'failed',
      reason: 'navigatedAway',
      errorCode: 'scanFailed'
    });

    assert.equal(progress.step, 'failed');
    assert.equal(progress.reason, 'navigatedAway');
    assert.equal(progress.errorCode, 'scanFailed');
    assert.ok(SCAN_PROGRESS_ERROR_CODES.includes(progress.errorCode));
    assert.ok(SCAN_PROGRESS_REASONS.includes(progress.reason));
    assert.ok(SCAN_PROGRESS_STEPS.includes(progress.step));
  });

  test('the progress vocabularies are frozen', () => {
    for (const vocabulary of [SCAN_PROGRESS_STEPS, SCAN_PROGRESS_REASONS, SCAN_PROGRESS_ERROR_CODES]) {
      assert.equal(Object.isFrozen(vocabulary), true);
      assert.throws(() => { vocabulary.push('injected'); }, TypeError);
    }
  });
});

describe('Enrichment progress - shouldPublishEnrichmentProgress', () => {
  test('holds back while a history scan is live', () => {
    assert.equal(shouldPublishEnrichmentProgress({ kind: 'scan', isScanning: true }), false);
  });

  test('publishes over a finished scan or an existing enrichment payload', () => {
    assert.equal(shouldPublishEnrichmentProgress({ kind: 'scan', isScanning: false }), true);
    assert.equal(shouldPublishEnrichmentProgress({ kind: ENRICHMENT_PROGRESS_KIND, isScanning: false }), true);
    assert.equal(shouldPublishEnrichmentProgress(null), true);
  });
});

describe('Enrichment progress - isStaleScanProgress', () => {
  const now = 10_000_000;

  test('a scan with a fresh heartbeat is live', () => {
    assert.equal(isStaleScanProgress({ kind: 'scan', isScanning: true, updatedAt: now - 1000 }, now), false);
  });

  test('a scan whose tab is gone is stale', () => {
    assert.equal(
      isStaleScanProgress({ kind: 'scan', isScanning: true, updatedAt: now - STALE_SCAN_AFTER_MS - 1 }, now),
      true
    );
  });

  test('never reports an enrichment payload or a finished scan as stale', () => {
    assert.equal(isStaleScanProgress({ kind: ENRICHMENT_PROGRESS_KIND, updatedAt: 0 }, now), false);
    assert.equal(isStaleScanProgress({ kind: 'scan', isScanning: false, updatedAt: 0 }, now), false);
    assert.equal(isStaleScanProgress(null, now), false);
  });
});
