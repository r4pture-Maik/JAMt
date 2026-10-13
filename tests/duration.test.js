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
