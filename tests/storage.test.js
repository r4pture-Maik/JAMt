import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeSongKey,
  makeArtistKey,
  makeAlbumKey,
  normalizeTrack,
  sanitizeStorageData,
  createExportBundleV2,
  isDangerousKey,
  PENDING_DURATIONS_KEY,
  validateAndMigrateImport
} from '../background/storage.js';

describe('Storage Module - Key Helpers', () => {
  test('creates consistent lowercase trimmed keys', () => {
    assert.equal(makeSongKey(' Song Name ', ' Queen '), 'song name:::queen');
    assert.equal(makeArtistKey(' Queen '), 'queen');
    assert.equal(makeAlbumKey(' A Night at the Opera ', ' Queen '), 'a night at the opera:::queen');
  });
});

describe('Storage Module - normalizeTrack', () => {
  test('splits bullet-separated artist and album', () => {
    const raw = {
      title: 'Bohemian Rhapsody',
      artist: 'Queen • A Night at the Opera'
    };
    const normalized = normalizeTrack(raw);
    assert.equal(normalized.artist, 'Queen');
    assert.equal(normalized.album, 'A Night at the Opera');
    assert.equal(normalized.isSingle, false);
  });

  test('marks track as single if album is single or ep', () => {
    const raw = {
      title: 'Single Song',
      artist: 'Band',
      album: 'Single'
    };
    const normalized = normalizeTrack(raw);
    assert.equal(normalized.album, '');
    assert.equal(normalized.isSingle, true);
  });

  test('detects identical artist and album as single', () => {
    const raw = {
      title: 'Track One',
      artist: 'ArtistName',
      album: 'ArtistName'
    };
    const normalized = normalizeTrack(raw);
    assert.equal(normalized.album, '');
    assert.equal(normalized.isSingle, true);
  });

  test('preserves durationSeconds on track', () => {
    const raw = {
      title: 'Long Song',
      artist: 'Band',
      album: 'Album',
      durationSeconds: 345
    };
    const normalized = normalizeTrack(raw);
    assert.equal(normalized.durationSeconds, 345);
  });
});

describe('Storage Module - sanitizeStorageData', () => {
  test('deduplicates and rebuilds artists list splitting multiple artists', () => {
    const rawData = {
      songs: {
        'song 1:::daft punk feat. pharrell williams': {
          title: 'Song 1',
          artist: 'Daft Punk feat. Pharrell Williams',
          album: 'Random Access Memories',
          playCount: 4,
          durationSeconds: 960
        }
      },
      albums: {
        'random access memories:::daft punk': {
          album: 'Random Access Memories',
          artist: 'Daft Punk',
          playCount: 4,
          durationSeconds: 960
        }
      }
    };

    const sanitized = sanitizeStorageData(rawData);
    assert.ok(sanitized.modified);
    assert.ok(sanitized.artists['daft punk']);
    assert.ok(sanitized.artists['pharrell williams']);
    assert.equal(sanitized.artists['daft punk'].playCount, 4);
    assert.equal(sanitized.artists['pharrell williams'].playCount, 4);
    assert.equal(sanitized.artists['daft punk'].durationSeconds, 960);
  });

  test('drops prototype-polluting keys from an untrusted import', () => {
    // An imported backup is attacker-controllable input. A "__proto__" key reaching
    // `songs[key] = value` mutates the object's prototype instead of storing a
    // record, so the sanitizer must reject it.
    const rawData = {
      songs: JSON.parse('{"__proto__": {"title": "Evil", "artist": "X"}, "ok:::x": {"title": "Ok", "artist": "X", "playCount": 2}}'),
      albums: {}
    };

    const sanitized = sanitizeStorageData(rawData);
    assert.ok(sanitized.modified);
    assert.equal(Object.prototype.hasOwnProperty.call(sanitized.songs, '__proto__'), false);
    assert.ok(sanitized.songs['ok:::x']);
    assert.equal({}.title, undefined);
  });

  test('isDangerousKey rejects prototype chain keys only', () => {
    assert.equal(isDangerousKey('__proto__'), true);
    assert.equal(isDangerousKey('constructor'), true);
    assert.equal(isDangerousKey('prototype'), true);
    assert.equal(isDangerousKey('normal:::key'), false);
  });

  test('tolerates a missing or null storage payload', () => {
    assert.doesNotThrow(() => sanitizeStorageData(undefined));
    assert.doesNotThrow(() => sanitizeStorageData(null));
    assert.doesNotThrow(() => createExportBundleV2(undefined));
    assert.doesNotThrow(() => createExportBundleV2(null));
  });
});

describe('Storage Module - createExportBundleV2', () => {
  test('produces a schema v2 bundle from stored state', () => {
    const bundle = createExportBundleV2({
      totalPlays: 42,
      totalListeningSeconds: 3600,
      songs: { 'ok:::x': { title: 'Ok', artist: 'X', playCount: 2, durationSeconds: 300 } },
      artists: { x: { artist: 'X', playCount: 2, durationSeconds: 300 } },
      albums: { 'alb:::x': { album: 'Alb', artist: 'X', playCount: 2, completePlays: 1, totalTracks: 2, uniqueTracksCount: 2 } },
      historySyncState: { lastTrackTitle: 'Ok', lastTrackArtist: 'X', lastSyncTimestamp: 123 }
    });

    assert.equal(bundle.schemaVersion, 2);
    assert.equal(bundle.metrics.totalPlays, 42);
    assert.equal(bundle.metrics.totalListeningSeconds, 3600);
    assert.ok(bundle.songs['ok:::x']);
    assert.equal(bundle.syncWatermark.lastTrackTitle, 'Ok');
  });

  test('carries the album tracklist so a backup restores without re-fetching', () => {
    const bundle = createExportBundleV2({
      totalPlays: 1,
      songs: {},
      artists: {},
      albums: { 'alb:::x': { album: 'Alb', artist: 'X', allTracks: ['A', 'B'], tracksListened: { A: 1, B: 1 } } }
    });

    assert.deepEqual(bundle.albums['alb:::x'].allTracks, ['A', 'B']);
    assert.equal(bundle.albums['alb:::x'].totalTracks, 2);
  });
});

describe('Storage Module - pendingDurations key', () => {
  test('is namespaced so it cannot collide with the counters', () => {
    assert.equal(PENDING_DURATIONS_KEY, 'pendingDurations');
  });
});

describe('Storage Module - validateAndMigrateImport error codes (AD-10)', () => {
  /**
   * AD-10: the background may not send a sentence the UI has to display, because
   * it cannot honour the in-app locale override. Each failure therefore carries a
   * stable `errorCode` the UI maps to a message key, *alongside* the English
   * `error` string that stays for log output and catalog-less callers.
   */
  const CASES = [
    {
      label: 'a non-object payload',
      input: 'not json at all',
      errorCode: 'importInvalidJson',
      error: 'Import payload must be a valid JSON object.'
    },
    {
      label: 'a schema v2 bundle missing its dictionaries',
      input: { schemaVersion: 2, songs: null, artists: {} },
      errorCode: 'malformedSchemaV2',
      error: 'Malformed Schema v2: songs or artists dictionary missing.'
    },
    {
      label: 'a backup with no recognisable collections',
      input: { data: { unrelated: true } },
      errorCode: 'unrecognizedBackupFormat',
      error: 'Unrecognized backup format. No songs, artists, or albums found.'
    }
  ];

  for (const { label, input, errorCode, error } of CASES) {
    test(`reports ${errorCode} for ${label}`, () => {
      const result = validateAndMigrateImport(input);

      assert.equal(result.valid, false);
      assert.equal(result.errorCode, errorCode, 'the machine code is what the UI maps');
      // The English fallback is kept deliberately: it is still asserted, not
      // replaced, so a wording regression cannot slip through either.
      assert.equal(result.error, error);
      assert.equal(result.bundle, undefined, 'a rejected import must not carry a bundle');
    });
  }

  test('a valid schema v2 bundle carries no errorCode', () => {
    const result = validateAndMigrateImport({
      schemaVersion: 2,
      songs: { 'ok:::x': { title: 'Ok', artist: 'X', playCount: 2, durationSeconds: 300 } },
      artists: { x: { artist: 'X', playCount: 2, durationSeconds: 300 } },
      albums: {},
      metrics: { totalPlays: 2, totalListeningSeconds: 600 }
    });

    assert.equal(result.valid, true);
    assert.equal(result.error, undefined);
    assert.equal(result.errorCode, undefined);
    assert.equal(result.bundle.totalListeningSeconds, 600);
  });
});
