import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTrack,
  sanitizeStorageData,
  initializeStorage,
  getStats,
  resetStats,
  invalidateStatsCache,
  withStorageLock,
  importHistoryTracks,
  validateAndMigrateImport,
  createExportBundleV2
} from '../background/storage.js';

/** In-memory stand-in for `browser.storage.local`. */
function fakeBrowser(initial = {}) {
  const store = { ...initial };
  const calls = { set: [], remove: [], clear: 0 };
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
        async remove(key) { calls.remove.push(key); delete store[key]; },
        async clear() { calls.clear++; for (const k of Object.keys(store)) delete store[k]; }
      }
    }
  };
}

beforeEach(() => invalidateStatsCache());

describe('Storage - withStorageLock', () => {
  test('runs tasks one at a time, in submission order', async () => {
    const order = [];
    const slow = withStorageLock(async () => {
      order.push('a:start');
      await new Promise((r) => setTimeout(r, 15));
      order.push('a:end');
      return 'a';
    });
    const fast = withStorageLock(async () => { order.push('b'); return 'b'; });
    assert.deepEqual(await Promise.all([slow, fast]), ['a', 'b']);
    assert.deepEqual(order, ['a:start', 'a:end', 'b']);
  });

  test('a failing task rejects its caller but does not block later tasks', async () => {
    const failing = withStorageLock(async () => { throw new Error('nope'); });
    await assert.rejects(failing, /nope/);
    assert.equal(await withStorageLock(async () => 'still works'), 'still works');
  });
});

describe('Storage - normalizeTrack edge cases', () => {
  test('returns null for a missing track', () => {
    assert.equal(normalizeTrack(null), null);
  });

  test('keeps a real album from the bullet suffix but drops year, duration and single markers', () => {
    assert.equal(normalizeTrack({ title: 'T', artist: 'A • 2020' }).album, '');
    assert.equal(normalizeTrack({ title: 'T', artist: 'A • 3:45' }).album, '');
    assert.equal(normalizeTrack({ title: 'T', artist: 'A • Single' }).album, '');
    assert.equal(normalizeTrack({ title: 'T', artist: 'A • Real Album' }).album, 'Real Album');
  });

  test('cuts a bullet-suffixed album and falls back to Unknown Artist', () => {
    const t = normalizeTrack({ title: 'T', artist: '•', album: 'Album • 2020' });
    assert.equal(t.artist, 'Unknown Artist');
    assert.equal(t.album, 'Album');
  });

  test('treats an album equal to the artist, or a year/duration, as a single', () => {
    assert.equal(normalizeTrack({ title: 'T', artist: 'Band', album: 'band' }).isSingle, true);
    assert.equal(normalizeTrack({ title: 'T', artist: 'Band', album: '1999' }).album, '');
    assert.equal(normalizeTrack({ title: 'T', artist: 'Band', album: '1:02:03' }).album, '');
  });

  test('clamps and rounds duration', () => {
    assert.equal(normalizeTrack({ title: 'T', durationSeconds: -5 }).durationSeconds, 0);
    assert.equal(normalizeTrack({ title: 'T', durationSeconds: 12.6 }).durationSeconds, 13);
  });
});

describe('Storage - sanitizeStorageData repairs', () => {
  test('splits a bullet artist and recovers its album, flagging the data as modified', () => {
    const out = sanitizeStorageData({
      songs: { x: { title: 'Song', artist: 'Band • Record', playCount: 2 } }
    });
    const song = Object.values(out.songs)[0];
    assert.equal(song.artist, 'Band');
    assert.equal(song.album, 'Record');
    assert.equal(song.isSingle, false);
    assert.equal(out.modified, true);
  });

  test('cleans single/year/duration albums and album==artist on songs', () => {
    const out = sanitizeStorageData({
      songs: {
        'a:::band': { title: 'A', artist: 'Band', album: 'Single - EP', playCount: 1 },
        'b:::band': { title: 'B', artist: 'Band', album: 'Band', playCount: 1 },
        'c:::band': { title: 'C', artist: 'Band', album: 'Rec • 2020', playCount: 1 }
      }
    });
    assert.equal(out.songs['a:::band'].isSingle, true);
    assert.equal(out.songs['b:::band'].album, '');
    assert.equal(out.songs['c:::band'].album, 'Rec');
    assert.equal(out.modified, true);
  });

  test('merges songs that collapse onto the same key', () => {
    const out = sanitizeStorageData({
      songs: {
        'song:::band': { title: 'Song', artist: 'Band', playCount: 2, durationSeconds: 100 },
        'Song :::Band': { title: ' Song ', artist: 'Band', album: 'Record', playCount: 3, durationSeconds: 50 }
      }
    });
    const songs = Object.values(out.songs);
    assert.equal(songs.length, 1);
    assert.equal(songs[0].playCount, 5);
    assert.equal(songs[0].durationSeconds, 150);
    assert.equal(songs[0].album, 'Record');
    assert.equal(out.modified, true);
  });

  test('skips entries without a title and rebuilds artists from songs', () => {
    const out = sanitizeStorageData({
      songs: {
        k1: null,
        k2: { artist: 'No Title' },
        'x:::a & b': { title: 'X', artist: 'A & B', playCount: 2, durationSeconds: 10 },
        'y:::a': { title: 'Y', artist: 'A', playCount: 1, durationSeconds: 5 },
        'z:::unknown artist': { title: 'Z', artist: '', playCount: 1 }
      },
      artists: {}
    });
    assert.deepEqual(Object.keys(out.artists).sort(), ['a', 'b']);
    assert.equal(out.artists.a.playCount, 3);
    assert.equal(out.artists.a.durationSeconds, 15);
    assert.equal(out.artists.b.playCount, 2);
  });

  test('recovers an album artist from the songs of that album', () => {
    const out = sanitizeStorageData({
      songs: { 'one:::band': { title: 'One', artist: 'Band', album: 'Record', playCount: 1 } },
      albums: {
        'record:::record': { album: 'Record', artist: 'Record', tracksListened: { One: 1 }, playCount: 1 },
        'noartist:::': { album: 'Other', artist: '', playCount: 1 }
      }
    });
    assert.ok(out.albums['record:::band']);
    assert.equal(out.albums['record:::band'].artist, 'Band');
    assert.equal(out.modified, true);
  });

  test('recovers an album artist through the album name when no track title matches', () => {
    const out = sanitizeStorageData({
      songs: { 'two:::band': { title: 'Two', artist: 'Band', album: 'Record', playCount: 1 } },
      albums: { 'record:::': { album: 'Record', artist: '', tracksListened: { Missing: 1 }, playCount: 1 } }
    });
    assert.ok(out.albums['record:::band']);
  });

  test('drops placeholder albums and albums whose artist stays equal to the name', () => {
    const out = sanitizeStorageData({
      albums: {
        s: { album: 'Single', artist: 'X', playCount: 1 },
        y: { album: '2020', artist: 'X', playCount: 1 },
        d: { album: '3:45', artist: 'X', playCount: 1 },
        same: { album: 'Same', artist: 'Same', playCount: 1 },
        broken: null
      }
    });
    assert.deepEqual(out.albums, {});
    assert.equal(out.modified, true);
  });

  test('strips a bullet suffix from an album artist', () => {
    const out = sanitizeStorageData({
      albums: { k: { album: 'Rec', artist: 'Band • 2020', playCount: 1 } }
    });
    assert.ok(out.albums['rec:::band']);
  });

  test('merges albums that collapse onto the same key', () => {
    const out = sanitizeStorageData({
      albums: {
        'rec:::band': {
          album: 'Rec', artist: 'Band', playCount: 2, durationSeconds: 10,
          tracksListened: { A: 1 }, uniqueTracksCount: 1
        },
        'Rec :::Band': {
          album: 'Rec', artist: 'Band', playCount: 3, durationSeconds: 20, totalTracks: 4,
          allTracks: ['A', 'B', 'C', 'D'], albumBrowseId: 'MPREb_x', tracksListened: { A: 2, B: 1 }
        }
      }
    });
    const album = out.albums['rec:::band'];
    assert.equal(album.playCount, 5);
    assert.equal(album.durationSeconds, 30);
    assert.equal(album.totalTracks, 4);
    assert.deepEqual(album.allTracks, ['A', 'B', 'C', 'D']);
    assert.equal(album.albumBrowseId, 'MPREb_x');
    assert.deepEqual(album.tracksListened, { A: 3, B: 1 });
    assert.equal(album.uniqueTracksCount, 2);
    assert.equal(out.modified, true);
  });

  test('already-clean data is not flagged as modified', () => {
    const data = {
      songs: { 'a:::band': { title: 'A', artist: 'Band', album: 'Rec', isSingle: false, playCount: 1 } },
      artists: { band: { artist: 'Band', playCount: 1 } },
      albums: {}
    };
    assert.equal(sanitizeStorageData(data).modified, false);
  });
});

describe('Storage - initializeStorage', () => {
  test('does nothing without a usable storage area', async () => {
    await initializeStorage(null);
    await initializeStorage({});
  });

  test('seeds defaults on an empty store and removes the legacy history key', async () => {
    const b = fakeBrowser({ history: [1, 2, 3] });
    await initializeStorage(b);
    assert.equal(b.store.totalPlays, 0);
    assert.equal(b.store.totalListeningSeconds, 0);
    assert.equal(b.store.historySyncState, null);
    assert.deepEqual(b.store.songs, {});
    assert.deepEqual(b.store.artists, {});
    assert.deepEqual(b.store.albums, {});
    assert.deepEqual(b.calls.remove, ['history']);
  });

  test('writes nothing when the stored data is already clean', async () => {
    const b = fakeBrowser({
      totalPlays: 1, totalListeningSeconds: 2, historySyncState: null,
      songs: { 'a:::band': { title: 'A', artist: 'Band', album: 'Rec', isSingle: false, playCount: 1 } },
      artists: { band: { artist: 'Band', playCount: 1 } },
      albums: {}
    });
    await initializeStorage(b);
    assert.equal(b.calls.set.length, 0);
  });

  test('heals corrupted entries in place', async () => {
    const b = fakeBrowser({
      totalPlays: 1, totalListeningSeconds: 0, historySyncState: null,
      songs: { x: { title: 'A', artist: 'Band • Rec', playCount: 1 } },
      artists: {}, albums: {}
    });
    await initializeStorage(b);
    assert.equal(b.store.songs['a:::band'].album, 'Rec');
  });

  test('swallows storage errors', async () => {
    const original = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args);
    try {
      await initializeStorage({ storage: { local: { get: async () => { throw new Error('disk'); } } } });
    } finally {
      console.error = original;
    }
    assert.equal(logged.length, 1);
  });
});

describe('Storage - getStats', () => {
  test('returns an empty payload without a storage area', async () => {
    const stats = await getStats(null);
    assert.equal(stats.totalPlays, 0);
    assert.deepEqual(stats.topSongs, []);
    assert.deepEqual(stats.allAlbums, []);
  });

  test('ranks the top three and strips allTracks from the broadcast', async () => {
    const songs = {};
    for (const [i, plays] of [5, 9, 1, 7].entries()) {
      songs[`s${i}:::band`] = { title: `S${i}`, artist: 'Band', album: i === 3 ? '' : 'Rec', isSingle: i === 3, playCount: plays };
    }
    const b = fakeBrowser({
      totalPlays: 22,
      totalListeningSeconds: 100.4,
      songs,
      albums: {
        'rec:::band': {
          album: 'Rec', artist: 'Band', playCount: 15, durationSeconds: 60,
          tracksListened: { S0: 1, S1: 1, S2: 1 }, allTracks: ['S0', 'S1', 'S2']
        }
      },
      currentTrack: { title: 'S1' }
    });
    const stats = await getStats(b);
    assert.deepEqual(stats.topSongs.map((s) => s.title), ['S1', 'S3', 'S0']);
    assert.equal(stats.totalPlays, 22);
    assert.equal(stats.totalListeningSeconds, 100);
    assert.equal(stats.uniqueSongsCount, 4);
    assert.equal(stats.singlesCount, 1);
    assert.equal(stats.uniqueAlbumsCount, 1);
    assert.equal(stats.currentTrack.title, 'S1');
    assert.ok(stats.allAlbums.every((a) => !('allTracks' in a)));
    assert.equal(stats.topArtists[0].artist, 'Band');
  });

  test('serves a cached payload until the cache is invalidated', async () => {
    const b = fakeBrowser({ totalPlays: 1 });
    const first = await getStats(b);
    b.store.totalPlays = 50;
    assert.equal((await getStats(b)).totalPlays, first.totalPlays);
    invalidateStatsCache();
    assert.equal((await getStats(b)).totalPlays, 50);
  });
});

describe('Storage - resetStats', () => {
  test('clears storage, writes the empty state and clears the thumbnail cache', async () => {
    const b = fakeBrowser({ totalPlays: 9, songs: { a: {} } });
    let cleared = 0;
    const state = await resetStats(b, { clearThumbnailCache: async () => { cleared++; } });
    assert.equal(b.calls.clear, 1);
    assert.equal(b.store.totalPlays, 0);
    assert.deepEqual(b.store.songs, {});
    assert.equal(state.currentTrack, null);
    assert.equal(cleared, 1);
  });

  test('still resets when the thumbnail cache throws or storage is missing', async () => {
    const state = await resetStats(null, { clearThumbnailCache: async () => { throw new Error('x'); } });
    assert.equal(state.totalPlays, 0);
  });
});

describe('Storage - importHistoryTracks', () => {
  test('returns an empty result for no tracks', async () => {
    assert.deepEqual(await importHistoryTracks({ tracks: [] }, fakeBrowser()), { importedCount: 0, totalPlays: 0 });
    assert.deepEqual(await importHistoryTracks(null, fakeBrowser()), { importedCount: 0, totalPlays: 0 });
  });

  test('builds songs, artists and albums from scratch', async () => {
    const b = fakeBrowser();
    const result = await importHistoryTracks({
      tracks: [
        { title: 'One', artist: 'A, B', album: 'Rec', durationSeconds: 100, albumBrowseId: 'MPREb_1', coverUrl: 'https://i.ytimg.com/c', allTracks: ['One', 'Two'] },
        { title: 'Solo', artist: 'A', durationSeconds: 50 },
        { title: '', artist: 'Skipped' },
        null
      ],
      newSyncState: { lastTrackTitle: 'One' }
    }, b);

    assert.equal(result.importedCount, 2);
    assert.equal(result.totalPlays, 2);
    assert.equal(result.totalListeningSeconds, 150);
    assert.equal(result.uniqueSongs, 2);
    assert.equal(result.uniqueArtists, 2);
    assert.equal(result.uniqueAlbums, 1);
    assert.equal(result.singlesCount, 1);
    assert.deepEqual(result.historySyncState, { lastTrackTitle: 'One' });
    assert.equal(b.store.artists.a.playCount, 2);
    assert.equal(b.store.artists.b.playCount, 1);
    const album = b.store.albums['rec:::a, b'];
    assert.equal(album.totalTracks, 2);
    assert.equal(album.albumBrowseId, 'MPREb_1');
    assert.deepEqual(b.store.historySyncState, { lastTrackTitle: 'One' });
  });

  test('accumulates onto existing records and fills in missing album data', async () => {
    const b = fakeBrowser({
      totalPlays: 1,
      totalListeningSeconds: 10,
      songs: { 'one:::band': { title: 'One', artist: 'Band', album: '', isSingle: true, playCount: 1, durationSeconds: 10 } },
      artists: { band: { artist: 'Band', playCount: 1, durationSeconds: 10 } },
      albums: {
        'rec:::band': { album: 'Rec', artist: 'Band', playCount: 1, durationSeconds: 10, tracksListened: { Other: 1 }, uniqueTracksCount: 1 }
      }
    });
    const result = await importHistoryTracks({
      tracks: [
        { title: 'One', artist: 'Band', album: 'Rec', isSingle: false, durationSeconds: 20, albumBrowseId: 'MPREb_9', coverUrl: 'https://i.ytimg.com/c', totalTracks: 8, allTracks: ['One', 'Other'] }
      ]
    }, b);

    assert.equal(result.totalPlays, 2);
    const song = b.store.songs['one:::band'];
    assert.equal(song.playCount, 2);
    assert.equal(song.durationSeconds, 30);
    assert.equal(song.album, 'Rec');
    assert.equal(song.isSingle, false);
    const album = b.store.albums['rec:::band'];
    assert.equal(album.playCount, 2);
    assert.equal(album.uniqueTracksCount, 2);
    assert.equal(album.albumBrowseId, 'MPREb_9');
    assert.equal(album.coverUrl, 'https://i.ytimg.com/c');
    assert.equal(album.totalTracks, 8);
    assert.deepEqual(album.allTracks, ['One', 'Other']);
    assert.equal('historySyncState' in b.store, false);
  });

  test('overlapping imports are serialized so no increment is lost', async () => {
    const b = fakeBrowser();
    const track = { title: 'Same', artist: 'Band', durationSeconds: 10 };
    await Promise.all([
      importHistoryTracks({ tracks: [track] }, b),
      importHistoryTracks({ tracks: [track] }, b),
      importHistoryTracks({ tracks: [track] }, b)
    ]);
    assert.equal(b.store.totalPlays, 3);
    assert.equal(b.store.songs['same:::band'].playCount, 3);
  });
});

describe('Storage - validateAndMigrateImport legacy formats', () => {
  test('migrates a legacy top-level backup and derives totalPlays from songs', () => {
    const result = validateAndMigrateImport({
      songs: { 'a:::band': { title: 'A', artist: 'Band', playCount: 4 }, 'b:::band': { title: 'B', artist: 'Band' } },
      totalListeningSeconds: 99.6
    });
    assert.equal(result.valid, true);
    assert.equal(result.bundle.schemaVersion, 2);
    assert.equal(result.bundle.totalPlays, 5);
    assert.equal(result.bundle.totalListeningSeconds, 100);
    assert.equal(result.bundle.historySyncState, null);
  });

  test('migrates a backup wrapped in a data field and keeps its sync state', () => {
    const result = validateAndMigrateImport({
      data: {
        totalPlays: 7,
        artists: { band: { artist: 'Band', playCount: 1 } },
        historySyncState: { lastTrackTitle: 'X' }
      }
    });
    assert.equal(result.valid, true);
    assert.equal(result.bundle.totalPlays, 7);
    assert.deepEqual(result.bundle.historySyncState, { lastTrackTitle: 'X' });
  });

  test('carries the sync watermark of a schema v2 bundle', () => {
    const result = validateAndMigrateImport({
      schemaVersion: 2,
      metrics: { totalPlays: 3.4, totalListeningSeconds: -5 },
      songs: {},
      artists: {},
      syncWatermark: { lastTrackTitle: 'T', lastTrackArtist: 'A', lastSyncTimestamp: 1 }
    });
    assert.equal(result.valid, true);
    assert.equal(result.bundle.totalPlays, 3);
    assert.equal(result.bundle.totalListeningSeconds, 0);
    assert.deepEqual(result.bundle.historySyncState, { lastTrackTitle: 'T', lastTrackArtist: 'A', lastSyncTimestamp: 1 });
  });

  test('rejects arrays', () => {
    assert.equal(validateAndMigrateImport([]).errorCode, 'importInvalidJson');
  });
});

describe('Storage - createExportBundleV2 fallbacks', () => {
  test('tolerates a missing payload and falls back to the supplied version', () => {
    const bundle = createExportBundleV2(null, '9.9.9');
    assert.equal(bundle.schemaVersion, 2);
    assert.equal(bundle.extensionVersion, '9.9.9');
    assert.deepEqual(bundle.songs, {});
    assert.equal(bundle.syncWatermark.lastTrackTitle, undefined);
  });

  test('uses "unknown" when no version is given and reads the live manifest when available', () => {
    assert.equal(createExportBundleV2({}).extensionVersion, 'unknown');
    globalThis.chrome = { runtime: { getManifest: () => ({ version: '3.2.1' }) } };
    try {
      assert.equal(createExportBundleV2({}, '0.0.0').extensionVersion, '3.2.1');
    } finally {
      delete globalThis.chrome;
    }
  });

  test('derives totalTracks from allTracks and keeps optional album fields', () => {
    const bundle = createExportBundleV2({
      albums: {
        'rec:::band': {
          album: 'Rec', artist: 'Band', playCount: 1, coverUrl: 'https://i.ytimg.com/c', albumBrowseId: 'MPREb_1',
          tracksListened: { A: 1 }, allTracks: ['A', 'B']
        }
      }
    });
    const album = bundle.albums['rec:::band'];
    assert.equal(album.totalTracks, 2);
    assert.equal(album.uniqueTracksCount, 1);
    assert.equal(album.coverUrl, 'https://i.ytimg.com/c');
    assert.equal(album.albumBrowseId, 'MPREb_1');
    assert.deepEqual(album.allTracks, ['A', 'B']);
  });
});
