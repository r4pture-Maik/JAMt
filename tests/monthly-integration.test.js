/**
 * Monthly buckets wired into the background write paths: history import,
 * duration ticks, reset and the export/import bridge.
 *
 * The all-time dictionaries are covered by the existing suites; these tests
 * assert the monthly side and that it never disturbs the all-time totals.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import '../shared/month-keys.js';
import {
  currentMonthId,
  resolveTrackMonth,
  importHistoryTracks,
  resetStats,
  createExportBundle,
  validateAndMigrateImport,
  EXPORT_SCHEMA_VERSION,
  invalidateStatsCache,
  getStats
} from '../background/storage.js';
import { recordListeningDuration } from '../background/duration.js';

const CURRENT = globalThis.YTMCMonths.monthIdFromDate(new Date());

/** In-memory stand-in for `browser.storage.local`. */
function fakeBrowser(initial = {}) {
  const store = structuredClone(initial);
  const calls = { set: [] };
  return {
    store,
    calls,
    storage: {
      local: {
        async get(keys) {
          const out = {};
          for (const k of keys) if (k in store) out[k] = structuredClone(store[k]);
          return out;
        },
        async set(obj) { calls.set.push(obj); Object.assign(store, structuredClone(obj)); },
        async remove(keys) { for (const k of [].concat(keys)) delete store[k]; },
        async clear() { for (const k of Object.keys(store)) delete store[k]; }
      }
    }
  };
}

const track = (title, artist, album, durationSeconds, listenedMonth) =>
  ({ title, artist, album, durationSeconds, listenedMonth });

beforeEach(() => invalidateStatsCache());

describe('Monthly integration - month helpers', () => {
  test('currentMonthId follows the clock and accepts an explicit date', () => {
    assert.equal(currentMonthId(), CURRENT);
    assert.equal(currentMonthId(new Date(2024, 1, 29)), '2024-02');
  });

  test('resolveTrackMonth trusts only valid, non-future months', () => {
    assert.equal(resolveTrackMonth('2025-09', '2026-10'), '2025-09');
    assert.equal(resolveTrackMonth('2026-10', '2026-10'), '2026-10');
    assert.equal(resolveTrackMonth('2026-11', '2026-10'), '2026-10');
    for (const bad of [undefined, '', 'Today', '2025-13', 202509, { id: '2025-09' }]) {
      assert.equal(resolveTrackMonth(bad, '2026-10'), '2026-10', String(bad));
    }
  });
});

describe('Monthly integration - importHistoryTracks', () => {
  test('splits imported plays across the months the content script resolved', async () => {
    const br = fakeBrowser();
    await importHistoryTracks({
      tracks: [
        track('Song A', 'Artist X', 'Album 1', 200, CURRENT),
        track('Song A', 'Artist X', 'Album 1', 200, '2025-09'),
        track('Song B', 'Artist X & Artist Y', '', 100, '2025-09'),
        track('Song C', 'Artist Z', 'Album 2', 50, '2025-08')
      ]
    }, br);

    assert.deepEqual(br.store.monthIndex, ['2025-08', '2025-09', CURRENT].sort());

    const sep = br.store['month:2025-09'];
    assert.equal(sep.id, '2025-09');
    assert.equal(sep.totalPlays, 2);
    assert.equal(sep.totalListeningSeconds, 300);
    assert.deepEqual(sep.songs['song a:::artist x'], { playCount: 1, durationSeconds: 200 });
    assert.deepEqual(sep.songs['song b:::artist x & artist y'], { playCount: 1, durationSeconds: 100 });
    assert.deepEqual(sep.artists['artist x'], { playCount: 2, durationSeconds: 300 });
    assert.deepEqual(sep.artists['artist y'], { playCount: 1, durationSeconds: 100 });
    assert.deepEqual(Object.keys(sep.albums), ['album 1:::artist x']);

    assert.equal(br.store[`month:${CURRENT}`].totalPlays, 1);
    assert.equal(br.store['month:2025-08'].albums['album 2:::artist z'].playCount, 1);
  });

  test('monthly totals add up to the all-time totals', async () => {
    const br = fakeBrowser();
    await importHistoryTracks({
      tracks: [
        track('S1', 'A', 'L', 120, '2025-01'),
        track('S2', 'A', 'L', 180, '2025-02'),
        track('S3', 'B', '', 60, CURRENT)
      ]
    }, br);
    const monthly = br.store.monthIndex.map(id => br.store[`month:${id}`]);
    assert.equal(monthly.reduce((s, m) => s + m.totalPlays, 0), br.store.totalPlays);
    assert.equal(monthly.reduce((s, m) => s + m.totalListeningSeconds, 0), br.store.totalListeningSeconds);
  });

  test('missing, invalid or future months fall back to the current month', async () => {
    const br = fakeBrowser();
    await importHistoryTracks({
      tracks: [
        track('S1', 'A', '', 10, undefined),
        track('S2', 'A', '', 10, 'Last week'),
        track('S3', 'A', '', 10, '2999-01')
      ]
    }, br);
    assert.deepEqual(br.store.monthIndex, [CURRENT]);
    assert.equal(br.store[`month:${CURRENT}`].totalPlays, 3);
  });

  test('merges into existing months and keeps older months untouched', async () => {
    const br = fakeBrowser();
    await importHistoryTracks({ tracks: [track('S1', 'A', '', 10, '2025-01'), track('S1', 'A', '', 10, '2025-02')] }, br);
    const jan = structuredClone(br.store['month:2025-01']);
    await importHistoryTracks({ tracks: [track('S1', 'A', '', 15, '2025-02')] }, br);
    assert.deepEqual(br.store['month:2025-01'], jan);
    assert.deepEqual(br.store['month:2025-02'].songs['s1:::a'], { playCount: 2, durationSeconds: 25 });
    assert.deepEqual(br.store.monthIndex, ['2025-01', '2025-02']);
  });

  test('all-time data and month data land in one atomic set', async () => {
    const br = fakeBrowser();
    await importHistoryTracks({ tracks: [track('S1', 'A', '', 10, '2025-01')] }, br);
    assert.equal(br.calls.set.length, 1);
    const [written] = br.calls.set;
    assert.ok('songs' in written && 'monthIndex' in written && 'month:2025-01' in written);
  });

  test('skipped tracks never create a month', async () => {
    const br = fakeBrowser();
    await importHistoryTracks({ tracks: [{ title: '', listenedMonth: '2025-03' }, track('S', 'A', '', 1, '2025-04')] }, br);
    assert.deepEqual(br.store.monthIndex, ['2025-04']);
    assert.equal('month:2025-03' in br.store, false);
  });

  test('getStats output is unaffected by the monthly keys', async () => {
    const tracks = [track('S1', 'A', 'L', 120, '2025-01'), track('S2', 'B', '', 60, CURRENT)];
    const withMonths = fakeBrowser();
    await importHistoryTracks({ tracks }, withMonths);
    const plain = fakeBrowser();
    await importHistoryTracks({ tracks: tracks.map(({ listenedMonth, ...t }) => t) }, plain);
    invalidateStatsCache();
    const a = await getStats(withMonths);
    invalidateStatsCache();
    const b = await getStats(plain);
    assert.deepEqual(a, b);
  });
});

describe('Monthly integration - recordListeningDuration', () => {
  const seeded = () => fakeBrowser({
    totalListeningSeconds: 0,
    songs: { 'song:::artist': { title: 'Song', artist: 'Artist', album: 'Album', playCount: 1, durationSeconds: 0 } },
    artists: { artist: { artist: 'Artist', playCount: 1, durationSeconds: 0 } },
    albums: { 'album:::artist': { album: 'Album', artist: 'Artist', playCount: 1, durationSeconds: 0 } }
  });

  test('ticks for a known song accrue in the current month only as seconds', async () => {
    const br = seeded();
    await recordListeningDuration({ songTitle: 'Song', songArtist: 'Artist', songAlbum: 'Album', deltaSeconds: 5 }, br);
    await recordListeningDuration({ songTitle: 'Song', songArtist: 'Artist', songAlbum: 'Album', deltaSeconds: 5 }, br);
    const m = br.store[`month:${CURRENT}`];
    assert.deepEqual(br.store.monthIndex, [CURRENT]);
    assert.equal(m.totalPlays, 0);
    assert.equal(m.totalListeningSeconds, 10);
    assert.deepEqual(m.songs['song:::artist'], { playCount: 0, durationSeconds: 10 });
    assert.deepEqual(m.artists.artist, { playCount: 0, durationSeconds: 10 });
    assert.deepEqual(m.albums['album:::artist'], { playCount: 0, durationSeconds: 10 });
    assert.equal(br.store.totalListeningSeconds, 10);
  });

  test('ticks for an unregistered song are parked, not written to a month', async () => {
    const br = seeded();
    await recordListeningDuration({ songTitle: 'Other', songArtist: 'Nobody', deltaSeconds: 5 }, br);
    assert.equal(br.store[`month:${CURRENT}`], undefined);
    assert.equal(br.store.pendingDurations['other:::nobody'], 5);
  });

  test('singles add no album entry to the month', async () => {
    const br = seeded();
    await recordListeningDuration({ songTitle: 'Song', songArtist: 'Artist', songAlbum: '', deltaSeconds: 5 }, br);
    assert.deepEqual(br.store[`month:${CURRENT}`].albums, {});
  });
});

describe('Monthly integration - reset and backup bridge', () => {
  test('resetStats drops every month', async () => {
    const br = fakeBrowser({ monthIndex: ['2025-01'], 'month:2025-01': { id: '2025-01' } });
    await resetStats(br);
    assert.equal('month:2025-01' in br.store, false);
    assert.ok(!br.store.monthIndex || br.store.monthIndex.length === 0);
  });

  test('export carries sanitized months and import restores them', () => {
    const months = {
      '2025-09': { id: '2025-09', totalPlays: 2, totalListeningSeconds: 300, songs: { 's:::a': { playCount: 2, durationSeconds: 300 } }, artists: {}, albums: {} },
      'junk': { totalPlays: 9 }
    };
    const bundle = createExportBundle({ totalPlays: 2, songs: {}, artists: {}, albums: {}, months });
    assert.equal(bundle.schemaVersion, EXPORT_SCHEMA_VERSION);
    assert.deepEqual(Object.keys(bundle.months), ['2025-09']);

    const imported = validateAndMigrateImport(JSON.parse(JSON.stringify(bundle)));
    assert.equal(imported.valid, true);
    assert.deepEqual(imported.bundle.months, { '2025-09': months['2025-09'] });
  });

  test('exports are written in schema version 3', () => {
    assert.equal(EXPORT_SCHEMA_VERSION, 3);
    assert.equal(createExportBundle({}).schemaVersion, 3);
  });

  test('the current bundle format imports and is validated', () => {
    const current = validateAndMigrateImport({ schemaVersion: EXPORT_SCHEMA_VERSION, metrics: { totalPlays: 1 }, songs: {}, artists: {}, months: {} });
    assert.equal(current.valid, true);
    assert.equal(current.bundle.schemaVersion, EXPORT_SCHEMA_VERSION);
    assert.equal(current.bundle.totalPlays, 1);
    const bad = validateAndMigrateImport({ schemaVersion: EXPORT_SCHEMA_VERSION, songs: null, artists: {} });
    assert.equal(bad.errorCode, 'malformedBackup');
    assert.match(bad.error, /Malformed backup/);
  });

  test('versions outside the supported range are not read as export bundles', () => {
    for (const schemaVersion of [1, EXPORT_SCHEMA_VERSION + 1, '2', 2.5]) {
      const res = validateAndMigrateImport({ schemaVersion, metrics: { totalPlays: 50 }, songs: {}, artists: {} });
      // Falls through to the legacy reader, which ignores `metrics`.
      assert.notEqual(res.bundle && res.bundle.totalPlays, 50, String(schemaVersion));
    }
  });

  test('extensionVersion comes from the browser.* manifest when chrome.* is absent', () => {
    const saved = globalThis.browser;
    globalThis.browser = { runtime: { getManifest: () => ({ version: '4.5.6' }) } };
    try {
      assert.equal(createExportBundle({}, '0.0.0').extensionVersion, '4.5.6');
    } finally {
      if (saved === undefined) delete globalThis.browser; else globalThis.browser = saved;
    }
  });

  test('backups without months import with an empty month set', () => {
    const older = validateAndMigrateImport({ schemaVersion: 2, songs: {}, artists: {} });
    assert.deepEqual(older.bundle.months, {});
    const legacy = validateAndMigrateImport({ songs: { 'a:::b': { title: 'a', artist: 'b', playCount: 1 } } });
    assert.deepEqual(legacy.bundle.months, {});
  });

  test('export without months yields an empty dictionary', () => {
    assert.deepEqual(createExportBundle({}).months, {});
  });
});
