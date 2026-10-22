/**
 * background/monthly.js — per-month listening buckets (`monthIndex` +
 * `month:YYYY-MM` keys) kept next to the all-time dictionaries.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MONTH_INDEX_KEY,
  MONTH_KEY_PREFIX,
  isMonthId,
  monthStorageKey,
  createEmptyMonthBucket,
  artistKeysFor,
  recordPlayInBucket,
  recordDurationInBucket,
  addMonthId,
  readMonthState,
  buildMonthUpdates,
  getMonthlyStats,
  collectMonthsForExport,
  listStoredMonthKeys,
  sanitizeMonthsForImport
} from '../background/monthly.js';

/** In-memory stand-in for `browser.storage.local`, recording each call. */
function fakeBrowser(initial = {}) {
  const store = structuredClone(initial);
  const calls = { get: [], set: [] };
  return {
    store,
    calls,
    storage: {
      local: {
        async get(keys) {
          calls.get.push(keys);
          const out = {};
          for (const k of keys) if (k in store) out[k] = structuredClone(store[k]);
          return out;
        },
        async set(obj) { calls.set.push(obj); Object.assign(store, structuredClone(obj)); }
      }
    }
  };
}

describe('Monthly - keys and ids', () => {
  test('storage key constants and builders', () => {
    assert.equal(MONTH_INDEX_KEY, 'monthIndex');
    assert.equal(MONTH_KEY_PREFIX, 'month:');
    assert.equal(monthStorageKey('2026-10'), 'month:2026-10');
  });

  test('isMonthId validates format and month range', () => {
    assert.equal(isMonthId('2026-10'), true);
    for (const bad of ['2026-13', '2026-00', '2026-1', '', null, 5]) assert.equal(isMonthId(bad), false);
  });

  test('createEmptyMonthBucket returns independent fresh objects', () => {
    const a = createEmptyMonthBucket('2026-10');
    const b = createEmptyMonthBucket('2026-10');
    assert.deepEqual(a, { id: '2026-10', totalPlays: 0, totalListeningSeconds: 0, songs: {}, artists: {}, albums: {} });
    a.songs.x = 1;
    assert.deepEqual(b.songs, {});
  });

  test('artistKeysFor splits collaborations like the all-time dictionary does', () => {
    assert.deepEqual(artistKeysFor('Daft Punk'), ['daft punk']);
    assert.deepEqual(artistKeysFor('A, B & C feat. D'), ['a', 'b', 'c', 'd']);
    assert.deepEqual(artistKeysFor('A / a'), ['a']);
    assert.deepEqual(artistKeysFor(''), []);
    assert.deepEqual(artistKeysFor(undefined), []);
  });
});

describe('Monthly - bucket math', () => {
  test('recordPlayInBucket bumps totals and every entry', () => {
    const b = createEmptyMonthBucket('2026-10');
    recordPlayInBucket(b, { songKey: 's:::a', artistKeys: ['a', 'b'], albumKey: 'al:::a', seconds: 200.4 });
    recordPlayInBucket(b, { songKey: 's:::a', artistKeys: ['a'], seconds: 100 });
    assert.equal(b.totalPlays, 2);
    assert.equal(b.totalListeningSeconds, 300);
    assert.deepEqual(b.songs['s:::a'], { playCount: 2, durationSeconds: 300 });
    assert.deepEqual(b.artists.a, { playCount: 2, durationSeconds: 300 });
    assert.deepEqual(b.artists.b, { playCount: 1, durationSeconds: 200 });
    assert.deepEqual(b.albums['al:::a'], { playCount: 1, durationSeconds: 200 });
  });

  test('recordPlayInBucket counts a play even with no or negative seconds', () => {
    const b = createEmptyMonthBucket('2026-10');
    recordPlayInBucket(b, { songKey: 's', seconds: -50 });
    recordPlayInBucket(b, { songKey: 's' });
    assert.equal(b.totalPlays, 2);
    assert.equal(b.totalListeningSeconds, 0);
    assert.deepEqual(b.songs.s, { playCount: 2, durationSeconds: 0 });
    assert.deepEqual(b.albums, {});
  });

  test('recordPlayInBucket repairs a bucket missing its dictionaries', () => {
    const b = { id: '2026-10', totalPlays: 0, totalListeningSeconds: 0 };
    recordPlayInBucket(b, { songKey: 's', artistKeys: ['a'], albumKey: 'al', seconds: 1 });
    assert.equal(b.songs.s.playCount, 1);
    assert.equal(b.artists.a.playCount, 1);
    assert.equal(b.albums.al.playCount, 1);
  });

  test('dangerous keys never reach the prototype', () => {
    const b = createEmptyMonthBucket('2026-10');
    recordPlayInBucket(b, { songKey: '__proto__', artistKeys: ['constructor'], albumKey: 'prototype', seconds: 5 });
    recordDurationInBucket(b, { songKey: '__proto__', seconds: 5 });
    assert.equal(Object.keys(b.songs).length, 0);
    assert.equal(Object.keys(b.artists).length, 0);
    assert.equal(Object.keys(b.albums).length, 0);
    assert.equal({}.playCount, undefined);
  });

  test('recordDurationInBucket adds seconds only, never plays', () => {
    const b = createEmptyMonthBucket('2026-10');
    recordPlayInBucket(b, { songKey: 's', artistKeys: ['a'], albumKey: 'al', seconds: 0 });
    recordDurationInBucket(b, { songKey: 's', artistKeys: ['a'], albumKey: 'al', seconds: 5 });
    recordDurationInBucket(b, { songKey: 'other', seconds: 5 });
    assert.equal(b.totalPlays, 1);
    assert.equal(b.totalListeningSeconds, 10);
    assert.deepEqual(b.songs.s, { playCount: 1, durationSeconds: 5 });
    assert.deepEqual(b.artists.a, { playCount: 1, durationSeconds: 5 });
    assert.deepEqual(b.albums.al, { playCount: 1, durationSeconds: 5 });
    assert.deepEqual(b.songs.other, { playCount: 0, durationSeconds: 5 });
  });

  test('recordDurationInBucket ignores non-positive deltas', () => {
    const b = createEmptyMonthBucket('2026-10');
    recordDurationInBucket(b, { songKey: 's', seconds: 0 });
    recordDurationInBucket(b, { songKey: 's', seconds: -3 });
    assert.deepEqual(b, createEmptyMonthBucket('2026-10'));
  });
});

describe('Monthly - index', () => {
  test('addMonthId keeps a sorted, unique, valid index without mutating input', () => {
    const index = ['2026-10', '2025-12'];
    const next = addMonthId(index, '2026-01');
    assert.deepEqual(next, ['2025-12', '2026-01', '2026-10']);
    assert.deepEqual(index, ['2026-10', '2025-12']);
    assert.deepEqual(addMonthId(next, '2026-01'), next);
    assert.deepEqual(addMonthId(['2026-11', 'bad'], '2026-01'), ['2026-01', '2026-11']);
    assert.deepEqual(addMonthId(null, '2026-01'), ['2026-01']);
    assert.deepEqual(addMonthId(['2026-01'], 'nope'), ['2026-01']);
  });
});

describe('Monthly - storage helpers', () => {
  const stored = {
    monthIndex: ['2026-09', '2026-10'],
    'month:2026-09': { id: '2026-09', totalPlays: 3, totalListeningSeconds: 30, songs: {}, artists: {}, albums: {} },
    'month:2026-10': { id: '2026-10', totalPlays: 1, totalListeningSeconds: 10, songs: {}, artists: {}, albums: {} }
  };

  test('readMonthState reads index and buckets in a single get', async () => {
    const br = fakeBrowser(stored);
    const state = await readMonthState(br, ['2026-10', '2026-11', 'garbage']);
    assert.equal(br.calls.get.length, 1);
    assert.deepEqual(state.index, ['2026-09', '2026-10']);
    assert.equal(state.buckets['2026-10'].totalPlays, 1);
    assert.deepEqual(state.buckets['2026-11'], createEmptyMonthBucket('2026-11'));
    assert.equal('garbage' in state.buckets, false);
  });

  test('readMonthState tolerates a corrupt index and bucket', async () => {
    const br = fakeBrowser({ monthIndex: 'oops', 'month:2026-10': 'broken' });
    const state = await readMonthState(br, ['2026-10']);
    assert.deepEqual(state.index, []);
    assert.deepEqual(state.buckets['2026-10'], createEmptyMonthBucket('2026-10'));
  });

  test('buildMonthUpdates registers every bucket in the index', () => {
    const b = createEmptyMonthBucket('2026-11');
    const updates = buildMonthUpdates(['2026-09'], { '2026-11': b });
    assert.deepEqual(updates, { monthIndex: ['2026-09', '2026-11'], 'month:2026-11': b });
  });

  test('getMonthlyStats returns existing months sorted, all by default', async () => {
    const br = fakeBrowser(stored);
    const all = await getMonthlyStats(br);
    assert.deepEqual(all.months.map(m => m.id), ['2026-09', '2026-10']);
    const some = await getMonthlyStats(br, ['2026-10', '2026-05', '2026-09']);
    assert.deepEqual(some.months.map(m => m.id), ['2026-09', '2026-10']);
    assert.deepEqual(await getMonthlyStats(null), { months: [] });
  });

  test('getMonthlyStats is read-only', async () => {
    const br = fakeBrowser(stored);
    await getMonthlyStats(br);
    assert.equal(br.calls.set.length, 0);
  });

  test('collectMonthsForExport and listStoredMonthKeys follow the index', async () => {
    const br = fakeBrowser({ ...stored, monthIndex: ['2026-08', '2026-09', '2026-10'] });
    const months = await collectMonthsForExport(br);
    assert.deepEqual(Object.keys(months).sort(), ['2026-09', '2026-10']);
    assert.deepEqual(await listStoredMonthKeys(br), ['month:2026-08', 'month:2026-09', 'month:2026-10']);
  });
});

describe('Monthly - sanitizeMonthsForImport', () => {
  test('keeps valid months and coerces counters to non-negative integers', () => {
    const out = sanitizeMonthsForImport({
      '2026-10': {
        id: 'spoofed',
        totalPlays: '4',
        totalListeningSeconds: -9,
        songs: { 's': { playCount: 2.6, durationSeconds: 'x', title: 'leak' } },
        artists: { 'a': { playCount: 1, durationSeconds: 10 } },
        albums: 'not a dict'
      }
    });
    assert.deepEqual(out, {
      '2026-10': {
        id: '2026-10',
        totalPlays: 4,
        totalListeningSeconds: 0,
        songs: { s: { playCount: 3, durationSeconds: 0 } },
        artists: { a: { playCount: 1, durationSeconds: 10 } },
        albums: {}
      }
    });
  });

  test('drops invalid ids, non-object buckets/entries, and dangerous keys', () => {
    const raw = JSON.parse('{"2026-13":{},"bad":{},"2026-01":null,"2026-02":{"songs":{"__proto__":{"playCount":1},"ok":{"playCount":1},"n":5}}}');
    const out = sanitizeMonthsForImport(raw);
    assert.deepEqual(Object.keys(out), ['2026-02']);
    assert.deepEqual(Object.keys(out['2026-02'].songs), ['ok']);
    assert.equal({}.playCount, undefined);
  });

  test('non-object input yields an empty dictionary', () => {
    for (const v of [null, undefined, 'x', 3, ['2026-10']]) assert.deepEqual(sanitizeMonthsForImport(v), {});
  });
});
