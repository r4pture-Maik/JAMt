import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  importHistoryTracks,
  getStats,
  invalidateStatsCache
} from '../background/storage.js';

function createMockBrowser(initialData = {}) {
  const memoryStorage = structuredClone(initialData);
  return {
    storage: {
      local: {
        get: async (keys) => {
          if (!keys) return structuredClone(memoryStorage);
          const keyList = typeof keys === 'string' ? [keys] : keys;
          const result = {};
          for (const k of keyList) {
            if (k in memoryStorage) {
              result[k] = structuredClone(memoryStorage[k]);
            }
          }
          return result;
        },
        set: async (updates) => {
          Object.assign(memoryStorage, structuredClone(updates));
        },
        remove: async (keys) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) delete memoryStorage[k];
        }
      }
    },
    _getStorage: () => memoryStorage
  };
}

describe('History Ingestion Module - Core Statistics Updates', () => {
  beforeEach(() => {
    invalidateStatsCache();
  });

  test('updates albums, finished album, songs, time listened, and different songs on full album ingestion', async () => {
    const mockBrowser = createMockBrowser();

    const payload = {
      tracks: [
        {
          title: 'Speak to Me',
          artist: 'Pink Floyd',
          album: 'The Dark Side of the Moon',
          durationSeconds: 120,
          totalTracks: 3,
          allTracks: ['Speak to Me', 'Breathe', 'On the Run']
        },
        {
          title: 'Breathe',
          artist: 'Pink Floyd',
          album: 'The Dark Side of the Moon',
          durationSeconds: 160,
          totalTracks: 3,
          allTracks: ['Speak to Me', 'Breathe', 'On the Run']
        },
        {
          title: 'On the Run',
          artist: 'Pink Floyd',
          album: 'The Dark Side of the Moon',
          durationSeconds: 200,
          totalTracks: 3,
          allTracks: ['Speak to Me', 'Breathe', 'On the Run']
        }
      ]
    };

    const importResult = await importHistoryTracks(payload, mockBrowser);
    assert.equal(importResult.importedCount, 3);
    assert.equal(importResult.totalPlays, 3);
    assert.equal(importResult.totalListeningSeconds, 480);
    assert.equal(importResult.uniqueSongs, 3);
    assert.equal(importResult.uniqueAlbums, 1);

    const stats = await getStats(mockBrowser);

    // 1. Albums
    assert.equal(stats.uniqueAlbumsCount, 1, 'albums count should be 1');

    // 2. Finished albums (completedAlbumsCount)
    assert.equal(stats.completedAlbumsCount, 1, 'finished album count should be 1 when all 3 tracks are listened to');

    // 3. Songs (total plays)
    assert.equal(stats.totalPlays, 3, 'songs count should be 3 total plays');

    // 4. Time listened. AD-10: the background ships raw seconds only; the UI
    // layer formats them. Asserting the absence is stronger than the old
    // `'8 mins'` string equality - it pins the wire format, not just a value.
    assert.equal(stats.totalListeningSeconds, 480, 'time listened in seconds should be 480');
    assert.equal(
      Object.prototype.hasOwnProperty.call(stats, 'formattedTotalTime'),
      false,
      'getStats() must not ship pre-formatted text (AD-10)'
    );

    // 5. Different songs (uniqueSongsCount)
    assert.equal(stats.uniqueSongsCount, 3, 'different songs count should be 3');
  });

  test('differentiates different songs (unique) from total song plays on repeat listens', async () => {
    const mockBrowser = createMockBrowser();

    // 4 repeat listens of the exact same song
    const payload = {
      tracks: [
        {
          title: 'Bohemian Rhapsody',
          artist: 'Queen • A Night at the Opera',
          durationSeconds: 354,
          totalTracks: 12
        },
        {
          title: 'Bohemian Rhapsody',
          artist: 'Queen',
          album: 'A Night at the Opera',
          durationSeconds: 354,
          totalTracks: 12
        },
        {
          title: 'Bohemian Rhapsody',
          artist: 'Queen',
          album: 'A Night at the Opera',
          durationSeconds: 354,
          totalTracks: 12
        },
        {
          title: 'Bohemian Rhapsody',
          artist: 'Queen',
          album: 'A Night at the Opera',
          durationSeconds: 354,
          totalTracks: 12
        }
      ]
    };

    await importHistoryTracks(payload, mockBrowser);
    const stats = await getStats(mockBrowser);

    // Songs: 4 plays
    assert.equal(stats.totalPlays, 4, 'songs total plays should be 4');

    // Different songs: only 1 unique song
    assert.equal(stats.uniqueSongsCount, 1, 'different songs count should strictly remain 1');

    // Time listened: 4 * 354 = 1416 seconds. AD-10: no pre-formatted string.
    assert.equal(stats.totalListeningSeconds, 1416, 'time listened should accumulate each play');
    assert.equal(Object.prototype.hasOwnProperty.call(stats, 'formattedTotalTime'), false);

    // Album exists but is NOT finished (1 out of 12 tracks listened to)
    assert.equal(stats.uniqueAlbumsCount, 1, 'album count should be 1');
    assert.equal(stats.completedAlbumsCount, 0, 'finished album should be 0 because only 1 of 12 tracks played');
  });

  test('tracks incremental progress of finished album across separate ingestion batches', async () => {
    const mockBrowser = createMockBrowser();
    const discoveryTracks = ['One More Time', 'Aerodynamic', 'Digital Love'];

    // Batch 1: Listen to 2 out of 3 tracks
    await importHistoryTracks({
      tracks: [
        {
          title: 'One More Time',
          artist: 'Daft Punk',
          album: 'Discovery',
          durationSeconds: 320,
          totalTracks: 3,
          allTracks: discoveryTracks
        },
        {
          title: 'Aerodynamic',
          artist: 'Daft Punk',
          album: 'Discovery',
          durationSeconds: 210,
          totalTracks: 3,
          allTracks: discoveryTracks
        }
      ]
    }, mockBrowser);

    let stats = await getStats(mockBrowser);
    assert.equal(stats.uniqueAlbumsCount, 1);
    assert.equal(stats.completedAlbumsCount, 0, 'album not yet finished after 2 of 3 tracks');
    assert.equal(stats.uniqueSongsCount, 2, '2 different songs');
    assert.equal(stats.totalPlays, 2);
    assert.equal(stats.totalListeningSeconds, 530);

    // Batch 2: Listen to the remaining 3rd track
    await importHistoryTracks({
      tracks: [
        {
          title: 'Digital Love',
          artist: 'Daft Punk',
          album: 'Discovery',
          durationSeconds: 300,
          totalTracks: 3,
          allTracks: discoveryTracks
        }
      ]
    }, mockBrowser);

    stats = await getStats(mockBrowser);
    assert.equal(stats.uniqueAlbumsCount, 1);
    assert.equal(stats.completedAlbumsCount, 1, 'album is now marked finished after listening to all 3 tracks');
    assert.equal(stats.uniqueSongsCount, 3, '3 different songs');
    assert.equal(stats.totalPlays, 3);
    assert.equal(stats.totalListeningSeconds, 830);

    // Batch 3: Listen to all 3 tracks a second time -> completes album twice
    await importHistoryTracks({
      tracks: [
        { title: 'One More Time', artist: 'Daft Punk', album: 'Discovery', durationSeconds: 320, totalTracks: 3, allTracks: discoveryTracks },
        { title: 'Aerodynamic', artist: 'Daft Punk', album: 'Discovery', durationSeconds: 210, totalTracks: 3, allTracks: discoveryTracks },
        { title: 'Digital Love', artist: 'Daft Punk', album: 'Discovery', durationSeconds: 300, totalTracks: 3, allTracks: discoveryTracks }
      ]
    }, mockBrowser);

    stats = await getStats(mockBrowser);
    assert.equal(stats.completedAlbumsCount, 2, 'album is marked finished 2 times after 2 complete listens');
    assert.equal(stats.uniqueSongsCount, 3, 'different songs count remains 3');
    assert.equal(stats.totalPlays, 6);
    assert.equal(stats.totalListeningSeconds, 1660);
  });

  test('handles mixed history with multiple albums and singles accurately', async () => {
    const mockBrowser = createMockBrowser();

    const payload = {
      tracks: [
        // Album 1 (Complete: 2 of 2 tracks)
        { title: 'Track 1A', artist: 'Band A', album: 'Album A', durationSeconds: 100, totalTracks: 2, allTracks: ['Track 1A', 'Track 1B'] },
        { title: 'Track 1B', artist: 'Band A', album: 'Album A', durationSeconds: 150, totalTracks: 2, allTracks: ['Track 1A', 'Track 1B'] },

        // Album 2 (Incomplete: 1 of 4 tracks)
        { title: 'Track 2A', artist: 'Band B', album: 'Album B', durationSeconds: 200, totalTracks: 4, allTracks: ['Track 2A', 'Track 2B', 'Track 2C', 'Track 2D'] },

        // Single 1 (marked with Single)
        { title: 'Hit Single', artist: 'Pop Star', album: 'Single', durationSeconds: 180 },

        // Single 2 (no album specified)
        { title: 'Lo-Fi Beat', artist: 'Chill Guy', album: '', durationSeconds: 120 }
      ]
    };

    await importHistoryTracks(payload, mockBrowser);
    const stats = await getStats(mockBrowser);

    // Albums: Album A and Album B (singles are excluded from albums)
    assert.equal(stats.uniqueAlbumsCount, 2, 'should have exactly 2 distinct albums');

    // Finished albums: Only Album A completed (2/2)
    assert.equal(stats.completedAlbumsCount, 1, 'only Album A should count as finished album');

    // Singles
    assert.equal(stats.singlesCount, 2, 'should recognize 2 singles');

    // Different songs: 2 (from A) + 1 (from B) + 2 (singles) = 5
    assert.equal(stats.uniqueSongsCount, 5, 'different songs should be 5');

    // Songs: 5 total plays
    assert.equal(stats.totalPlays, 5, 'songs count should be 5 total plays');

    // Time listened: 100 + 150 + 200 + 180 + 120 = 750 seconds. AD-10: raw seconds only.
    assert.equal(stats.totalListeningSeconds, 750);
    assert.equal(Object.prototype.hasOwnProperty.call(stats, 'formattedTotalTime'), false);
  });

  test('preserves history sync state and handles empty or invalid payloads gracefully', async () => {
    const mockBrowser = createMockBrowser();

    // Ingest with sync state
    const result1 = await importHistoryTracks({
      tracks: [{ title: 'Track 1', artist: 'Artist 1', album: 'Album 1', durationSeconds: 100, totalTracks: 2 }],
      newSyncState: { lastTrackTitle: 'Track 1', lastSyncTimestamp: 1710000000000 }
    }, mockBrowser);

    assert.equal(result1.historySyncState.lastTrackTitle, 'Track 1');
    const storageState = mockBrowser._getStorage();
    assert.equal(storageState.historySyncState.lastTrackTitle, 'Track 1');

    // Ingest empty tracks payload
    const resultEmpty = await importHistoryTracks({ tracks: [] }, mockBrowser);
    assert.equal(resultEmpty.importedCount, 0);

    // Existing stats remain intact
    const stats = await getStats(mockBrowser);
    assert.equal(stats.totalPlays, 1);
    assert.equal(stats.uniqueSongsCount, 1);
    assert.equal(stats.uniqueAlbumsCount, 1);
    assert.equal(stats.completedAlbumsCount, 0);
    assert.equal(stats.totalListeningSeconds, 100);
  });
});

describe('History Ingestion Module - Top Rankings & Duration Formatting', () => {
  beforeEach(() => {
    invalidateStatsCache();
  });

  test('computes accurate top songs and top albums after history ingestion', async () => {
    const mockBrowser = createMockBrowser();

    const payload = {
      tracks: [
        // Song A: 3 plays
        { title: 'Song Alpha', artist: 'Artist One', album: 'Alpha Album', durationSeconds: 200, totalTracks: 1 },
        { title: 'Song Alpha', artist: 'Artist One', album: 'Alpha Album', durationSeconds: 200, totalTracks: 1 },
        { title: 'Song Alpha', artist: 'Artist One', album: 'Alpha Album', durationSeconds: 200, totalTracks: 1 },

        // Song B: 2 plays
        { title: 'Song Beta', artist: 'Artist Two', album: 'Beta Album', durationSeconds: 150, totalTracks: 2 },
        { title: 'Song Beta', artist: 'Artist Two', album: 'Beta Album', durationSeconds: 150, totalTracks: 2 },

        // Song C: 1 play
        { title: 'Song Gamma', artist: 'Artist Three', album: 'Gamma Album', durationSeconds: 180, totalTracks: 3 }
      ]
    };

    await importHistoryTracks(payload, mockBrowser);
    const stats = await getStats(mockBrowser);

    // Top Songs
    assert.equal(stats.topSongs.length, 3);
    assert.equal(stats.topSongs[0].title, 'Song Alpha');
    assert.equal(stats.topSongs[0].playCount, 3);
    assert.equal(stats.topSongs[1].title, 'Song Beta');
    assert.equal(stats.topSongs[1].playCount, 2);
    assert.equal(stats.topSongs[2].title, 'Song Gamma');
    assert.equal(stats.topSongs[2].playCount, 1);

    // Total listening time: (3*200) + (2*150) + 180 = 1080 seconds. AD-10: raw seconds only.
    assert.equal(stats.totalListeningSeconds, 1080);
    assert.equal(Object.prototype.hasOwnProperty.call(stats, 'formattedTotalTime'), false);

    // Different songs = 3
    assert.equal(stats.uniqueSongsCount, 3);

    // Albums = 3
    assert.equal(stats.uniqueAlbumsCount, 3);
  });
});
