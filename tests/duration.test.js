import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { recordListeningDuration } from '../background/duration.js';

describe('Duration Module - recordListeningDuration', () => {
  test('accumulates duration into mock storage', async () => {
    const memoryStorage = {
      totalListeningSeconds: 10,
      songs: {
        'test song:::test artist': {
          title: 'Test Song',
          artist: 'Test Artist',
          album: 'Test Album',
          playCount: 1,
          durationSeconds: 10
        }
      },
      artists: {
        'test artist': {
          artist: 'Test Artist',
          playCount: 1,
          durationSeconds: 10
        }
      },
      albums: {
        'test album:::test artist': {
          album: 'Test Album',
          artist: 'Test Artist',
          playCount: 1,
          durationSeconds: 10
        }
      }
    };

    const mockBrowser = {
      storage: {
        local: {
          get: async () => structuredClone(memoryStorage),
          set: async (updates) => {
            Object.assign(memoryStorage, updates);
          }
        }
      }
    };

    let cacheInvalidated = false;
    const result = await recordListeningDuration(
      {
        songTitle: 'Test Song',
        songArtist: 'Test Artist',
        songAlbum: 'Test Album',
        isSingle: false,
        deltaSeconds: 5
      },
      mockBrowser,
      () => { cacheInvalidated = true; }
    );

    assert.equal(result.totalListeningSeconds, 15);
    assert.equal(result.songDuration, 15);
    assert.equal(memoryStorage.totalListeningSeconds, 15);
    assert.equal(memoryStorage.songs['test song:::test artist'].durationSeconds, 15);
    assert.equal(memoryStorage.artists['test artist'].durationSeconds, 15);
    assert.equal(memoryStorage.albums['test album:::test artist'].durationSeconds, 15);
    assert.ok(cacheInvalidated);
  });

  test('parks duration instead of inventing a play for an unknown song', async () => {
    // A tick can arrive before the play is registered (worker asleep, or the 5s
    // play threshold not reached yet). Creating a `playCount: 1` record here used
    // to inflate unique/top counts without ever incrementing totalPlays.
    const memoryStorage = {
      totalListeningSeconds: 0,
      songs: {},
      artists: {},
      albums: {}
    };

    const mockBrowser = {
      storage: {
        local: {
          get: async () => structuredClone(memoryStorage),
          set: async (updates) => { Object.assign(memoryStorage, updates); }
        }
      }
    };

    const result = await recordListeningDuration(
      { songTitle: 'Ghost', songArtist: 'Nobody', songAlbum: '', deltaSeconds: 7 },
      mockBrowser
    );

    assert.equal(result.totalListeningSeconds, 7);
    assert.equal(result.songDuration, 0);
    assert.equal(Object.keys(memoryStorage.songs).length, 0, 'no phantom song entry');
    assert.equal(Object.keys(memoryStorage.artists).length, 0, 'no phantom artist entry');
    assert.equal(memoryStorage.pendingDurations['ghost:::nobody'], 7);
  });

  test('accumulates parked duration across several ticks', async () => {
    const memoryStorage = { totalListeningSeconds: 0, songs: {}, artists: {}, albums: {} };
    const mockBrowser = {
      storage: {
        local: {
          get: async () => structuredClone(memoryStorage),
          set: async (updates) => { Object.assign(memoryStorage, updates); }
        }
      }
    };

    await recordListeningDuration({ songTitle: 'Ghost', songArtist: 'N', deltaSeconds: 5 }, mockBrowser);
    await recordListeningDuration({ songTitle: 'Ghost', songArtist: 'N', deltaSeconds: 6 }, mockBrowser);

    assert.equal(memoryStorage.pendingDurations['ghost:::n'], 11);
  });

  test('serializes concurrent ticks instead of losing increments', async () => {
    // Without the storage lock, two overlapping read-modify-write cycles both read
    // the same snapshot and the second set discards the first increment.
    const memoryStorage = { totalListeningSeconds: 0, songs: {}, artists: {}, albums: {} };
    const mockBrowser = {
      storage: {
        local: {
          get: async () => {
            await new Promise((r) => setTimeout(r, 1));
            return structuredClone(memoryStorage);
          },
          set: async (updates) => {
            await new Promise((r) => setTimeout(r, 1));
            Object.assign(memoryStorage, updates);
          }
        }
      }
    };

    await Promise.all(
      [1, 2, 3, 4, 5].map((n) => recordListeningDuration({ songTitle: 'S', songArtist: 'A', deltaSeconds: n }, mockBrowser))
    );

    assert.equal(memoryStorage.totalListeningSeconds, 15);
  });
});

describe('Duration Module - guards and fallbacks', () => {
  /** Browser stub over a mutable store; `sets` records every write. */
  function stubBrowser(store) {
    const sets = [];
    return {
      sets,
      storage: {
        local: {
          get: async () => structuredClone(store),
          set: async (updates) => { sets.push(updates); Object.assign(store, updates); }
        }
      }
    };
  }

  const ZERO = { totalListeningSeconds: 0, songDuration: 0 };

  test('ignores a missing payload or a payload without a title', async () => {
    const browser = stubBrowser({});
    assert.deepEqual(await recordListeningDuration(null, browser), ZERO);
    assert.deepEqual(await recordListeningDuration({ deltaSeconds: 5 }, browser), ZERO);
    assert.deepEqual(await recordListeningDuration({ songTitle: '', deltaSeconds: 5 }, browser), ZERO);
    assert.equal(browser.sets.length, 0);
  });

  test('ignores a zero, negative or missing delta', async () => {
    const browser = stubBrowser({});
    for (const deltaSeconds of [0, -3, 0.4, undefined, NaN]) {
      assert.deepEqual(await recordListeningDuration({ songTitle: 'S', deltaSeconds }, browser), ZERO);
    }
    assert.equal(browser.sets.length, 0);
  });

  test('reports the delta without writing when no storage area is available', async () => {
    const expected = { totalListeningSeconds: 4, songDuration: 4 };
    assert.deepEqual(await recordListeningDuration({ songTitle: 'S', deltaSeconds: 4 }, null), expected);
    assert.deepEqual(await recordListeningDuration({ songTitle: 'S', deltaSeconds: 4 }, {}), expected);
    assert.deepEqual(await recordListeningDuration({ songTitle: 'S', deltaSeconds: 4 }, { storage: {} }), expected);
  });

  test('works against an entirely empty store and parks the delta', async () => {
    const store = {};
    const browser = stubBrowser(store);
    const result = await recordListeningDuration({ songTitle: ' New ', deltaSeconds: 3 }, browser);
    assert.deepEqual(result, { totalListeningSeconds: 3, songDuration: 0 });
    assert.deepEqual(store.songs, {});
    assert.deepEqual(store.artists, {});
    assert.deepEqual(store.albums, {});
    assert.equal(store.pendingDurations['new:::'], 3);
  });

  test('does not write a pending map when nothing is parked', async () => {
    const store = { songs: { 's:::a': { title: 'S', artist: 'A', durationSeconds: 1 } } };
    const browser = stubBrowser(store);
    await recordListeningDuration({ songTitle: 'S', songArtist: 'A', deltaSeconds: 2 }, browser);
    assert.equal('pendingDurations' in browser.sets[0], false);
  });

  test('credits a known song that has no artist or album', async () => {
    const store = { songs: { 's:::': { title: 'S', durationSeconds: 1 } } };
    const result = await recordListeningDuration({ songTitle: 'S', deltaSeconds: 2.4 }, stubBrowser(store));
    assert.equal(result.songDuration, 3);
    assert.equal(store.songs['s:::'].durationSeconds, 3);
  });

  test('starts from zero when stored records have no duration yet', async () => {
    const store = {
      songs: { 's:::a, b': { title: 'S' } },
      artists: { a: { artist: 'A' }, b: { artist: 'B' } },
      albums: { 'rec:::a': { album: 'Rec' } }
    };
    await recordListeningDuration(
      { songTitle: 'S', songArtist: 'A, B', songAlbum: 'Rec', deltaSeconds: 5 },
      stubBrowser(store)
    );
    assert.equal(store.songs['s:::a, b'].durationSeconds, 5);
    assert.equal(store.artists.a.durationSeconds, 5);
    assert.equal(store.artists.b.durationSeconds, 5);
    assert.equal(store.albums['rec:::a'].durationSeconds, 5);
  });

  test('only credits artists and albums that already exist', async () => {
    const store = {
      songs: { 's:::a & b': { title: 'S', durationSeconds: 0 } },
      artists: { a: { artist: 'A', durationSeconds: 1 } },
      albums: {}
    };
    await recordListeningDuration(
      { songTitle: 'S', songArtist: 'A & B', songAlbum: 'Unknown Album', deltaSeconds: 2 },
      stubBrowser(store)
    );
    assert.equal(store.artists.a.durationSeconds, 3);
    assert.equal('b' in store.artists, false);
    assert.deepEqual(store.albums, {});
  });

  test('never credits an album for singles, EPs or an explicit isSingle flag', async () => {
    for (const extra of [{ songAlbum: 'Single' }, { songAlbum: 'Single - EP' }, { songAlbum: 'EP' }, { songAlbum: 'Rec', isSingle: true }]) {
      const store = {
        songs: { 's:::a': { title: 'S', durationSeconds: 0 } },
        artists: {},
        albums: { [`${extra.songAlbum.toLowerCase()}:::a`]: { album: extra.songAlbum, durationSeconds: 10 } }
      };
      await recordListeningDuration({ songTitle: 'S', songArtist: 'A', deltaSeconds: 2, ...extra }, stubBrowser(store));
      assert.equal(Object.values(store.albums)[0].durationSeconds, 10, JSON.stringify(extra));
    }
  });

  test('calls the cache invalidation callback, but only when it is a function', async () => {
    let calls = 0;
    const browser = stubBrowser({});
    await recordListeningDuration({ songTitle: 'S', deltaSeconds: 1 }, browser, () => { calls++; });
    await recordListeningDuration({ songTitle: 'S', deltaSeconds: 1 }, browser, 'not a function');
    assert.equal(calls, 1);
  });
});
