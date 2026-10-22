import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createExportBundle,
  validateAndMigrateImport,
  EXPORT_SCHEMA_VERSION
} from '../background/storage.js';
import { calculateCompletePlays } from '../background/scoring.js';

describe('Data Bridge - createExportBundle', () => {
  test('creates a compliant export bundle', () => {
    const rawStorage = {
      totalPlays: 42,
      totalListeningSeconds: 7800,
      songs: {
        'song 1:::artist a': {
          title: 'Song 1',
          artist: 'Artist A',
          album: 'Album X',
          playCount: 10,
          durationSeconds: 1800,
          isSingle: false
        }
      },
      artists: {
        'artist a': {
          artist: 'Artist A',
          playCount: 10,
          durationSeconds: 1800
        }
      },
      albums: {
        'album x:::artist a': {
          album: 'Album X',
          artist: 'Artist A',
          playCount: 10,
          durationSeconds: 1800,
          completePlays: 2,
          totalTracks: 8,
          uniqueTracksCount: 8,
          tracksListened: { 'Track 1': 2 },
          allTracks: ['Track 1', 'Track 2'],
          coverUrl: 'https://example.com/cover.jpg'
        }
      },
      historySyncState: {
        lastTrackTitle: 'Song 1',
        lastTrackArtist: 'Artist A',
        lastSyncTimestamp: 1710000000
      },
      privateAuthToken: 'secret_token_that_must_not_leak'
    };

    const bundle = createExportBundle(rawStorage, '1.1.0');

    assert.equal(bundle.schemaVersion, EXPORT_SCHEMA_VERSION);
    assert.equal(bundle.extensionVersion, '1.1.0');
    assert.ok(bundle.exportedAt);
    assert.equal(bundle.metrics.totalPlays, 42);
    assert.equal(bundle.metrics.totalListeningSeconds, 7800);
    assert.ok(bundle.songs['song 1:::artist a']);
    assert.ok(bundle.artists['artist a']);
    assert.ok(bundle.albums['album x:::artist a']);
    assert.equal(bundle.albums['album x:::artist a'].coverUrl, 'https://example.com/cover.jpg');
    assert.deepEqual(bundle.albums['album x:::artist a'].tracksListened, { 'Track 1': 2 });
    assert.deepEqual(bundle.albums['album x:::artist a'].allTracks, ['Track 1', 'Track 2']);
    // Ensure sensitive fields are stripped
    assert.equal(bundle.privateAuthToken, undefined);
  });
});

describe('Data Bridge - validateAndMigrateImport', () => {
  test('validates a bundle from an older supported format', () => {
    const olderBundle = {
      schemaVersion: 2,
      exportedAt: '2026-09-22T00:00:00.000Z',
      extensionVersion: '1.1.0',
      metrics: {
        totalPlays: 10,
        totalListeningSeconds: 1200
      },
      songs: {
        'track:::band': {
          title: 'Track',
          artist: 'Band',
          album: '',
          playCount: 10,
          durationSeconds: 1200,
          isSingle: true
        }
      },
      artists: {
        'band': {
          artist: 'Band',
          playCount: 10,
          durationSeconds: 1200
        }
      },
      albums: {}
    };

    const res = validateAndMigrateImport(olderBundle);
    assert.ok(res.valid);
    assert.equal(res.bundle.totalPlays, 10);
    assert.equal(res.bundle.totalListeningSeconds, 1200);
    assert.ok(res.bundle.songs['track:::band']);
  });

  test('migrates a legacy flat backup without schemaVersion', () => {
    const legacyV1 = {
      totalPlays: 50,
      songs: {
        'song a:::artist a': {
          title: 'Song A',
          artist: 'Artist A',
          album: 'Album A',
          playCount: 50
        }
      },
      artists: {
        'artist a': {
          artist: 'Artist A',
          playCount: 50
        }
      },
      albums: {
        'album a:::artist a': {
          album: 'Album A',
          artist: 'Artist A',
          playCount: 50,
          completePlays: 1,
          totalTracks: 5
        }
      }
    };

    const res = validateAndMigrateImport(legacyV1);
    assert.ok(res.valid);
    assert.equal(res.bundle.schemaVersion, EXPORT_SCHEMA_VERSION);
    assert.equal(res.bundle.totalPlays, 50);
    assert.equal(res.bundle.totalListeningSeconds, 0); // defaults to 0
    assert.ok(res.bundle.songs['song a:::artist a']);
    assert.equal(res.bundle.songs['song a:::artist a'].durationSeconds, 0);
  });

  test('rejects corrupt or empty input', () => {
    assert.equal(validateAndMigrateImport(null).valid, false);
    assert.equal(validateAndMigrateImport('random string').valid, false);
    assert.equal(validateAndMigrateImport({}).valid, false);
  });

  test('imports real user data with Nurture and exports with completed album status', () => {
    const userPayload = {
      schemaVersion: 2,
      metrics: { totalPlays: 200, totalListeningSeconds: 47360 },
      songs: {
        'trying to feel alive:::porter robinson': { title: 'Trying to Feel Alive', artist: 'Porter Robinson', album: 'Nurture', playCount: 1, durationSeconds: 280 }
      },
      artists: {
        'porter robinson': { artist: 'Porter Robinson', playCount: 28, durationSeconds: 7367 }
      },
      albums: {
        'nurture:::porter robinson': {
          album: 'Nurture',
          artist: 'Porter Robinson',
          playCount: 14,
          durationSeconds: 3545,
          completePlays: 0,
          totalTracks: null,
          uniqueTracksCount: 14,
          albumBrowseId: 'MPREb_0LM03WoOBl2',
          tracksListened: {
            'Trying to Feel Alive': 1, 'Unfold': 1, 'Blossom': 1, 'Something Comforting': 1,
            'dullscythe': 1, 'Mother': 1, 'do-re-mi-fa-so-la-ti-do': 1, 'Musician': 1,
            'Wind Tempos': 1, 'Get Your Wish': 1, 'Look at the Sky': 1, 'Lifelike': 1,
            'Mirror': 1, 'Sweet Time': 1
          }
        }
      }
    };

    const importRes = validateAndMigrateImport(userPayload);
    assert.ok(importRes.valid);

    const album = importRes.bundle.albums['nurture:::porter robinson'];
    const trackTitles = [
      'Lifelike', 'Look at the Sky', 'Get Your Wish', 'Wind Tempos', 'Musician',
      'do-re-mi-fa-so-la-ti-do', 'Mother', 'dullscythe', 'Sweet Time', 'Mirror',
      'Something Comforting', 'Blossom', 'Unfold', 'Trying to Feel Alive'
    ];
    album.totalTracks = trackTitles.length;
    album.allTracks = trackTitles;
    album.completePlays = calculateCompletePlays(album);

    assert.equal(album.completePlays, 1, 'Nurture should be marked with 1 complete play');

    const exported = createExportBundle(importRes.bundle, '1.1.0');
    assert.equal(exported.schemaVersion, EXPORT_SCHEMA_VERSION);
    const exportedAlb = exported.albums['nurture:::porter robinson'];
    assert.equal(exportedAlb.completePlays, 1);
    assert.equal(exportedAlb.totalTracks, 14);
    assert.equal(exportedAlb.uniqueTracksCount, 14);
    assert.equal(exportedAlb.allTracks.length, 14);
    assert.equal(Object.keys(exportedAlb.tracksListened).length, 14);
  });
});
