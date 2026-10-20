import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanText,
  splitArtists,
  primaryArtist,
  cleanTrackTitle,
  makeSongKey,
  makeAlbumKey,
  toCount,
  incrementCount,
  sanitizeStorageData,
  validateAndMigrateImport
} from '../background/storage.js';

describe('Text keys - cleanText', () => {
  test('collapses whitespace, strips invisible characters and normalizes to NFC', () => {
    assert.equal(cleanText('  Foo  Bar​ \t baz﻿ '), 'Foo Bar baz');
    assert.equal(cleanText('Désolé'), 'Désolé');
  });

  test('coerces untrusted non-string values instead of throwing', () => {
    assert.equal(cleanText(42), '42');
    assert.equal(cleanText(null), '');
    assert.equal(cleanText({ toString: () => 'x' }), '');
    assert.equal(cleanText(NaN), '');
  });
});

describe('Text keys - splitArtists', () => {
  test('keeps protected names that contain separators whole', () => {
    assert.deepEqual(splitArtists('Tyler, The Creator'), ['Tyler, The Creator']);
    assert.deepEqual(splitArtists('AC/DC'), ['AC/DC']);
    assert.deepEqual(splitArtists('Earth, Wind & Fire, Someone'), ['Earth, Wind & Fire', 'Someone']);
  });

  test('splits on separators and feat tags and drops duplicates', () => {
    assert.deepEqual(splitArtists('Hitomitoi, ryusenkei/hitomitoi'), ['Hitomitoi', 'ryusenkei']);
    assert.deepEqual(splitArtists('A feat. B & C ft. D featuring E'), ['A', 'B', 'C', 'D', 'E']);
  });

  test('drops names that collide with Object.prototype members', () => {
    assert.deepEqual(splitArtists('__proto__, Constructor, Real'), ['Real']);
  });

  test('primaryArtist is the first credited artist', () => {
    assert.equal(primaryArtist('Coldplay, Jon Hopkins'), 'Coldplay');
    assert.equal(primaryArtist(''), '');
  });
});

describe('Text keys - cleanTrackTitle and keys', () => {
  test('strips trailing video tags and a leading artist prefix', () => {
    assert.equal(cleanTrackTitle('Archive - We Are The Same (Official Music Video)', 'Archive'), 'We Are The Same');
    assert.equal(cleanTrackTitle('Song [Lyric Video] (Audio)', 'X'), 'Song');
    // Another artist's name is part of the title, not a prefix.
    assert.equal(cleanTrackTitle('Linkin Park - Announcement', 'Milashkasiya'), 'Linkin Park - Announcement');
    // Never strips down to nothing.
    assert.equal(cleanTrackTitle('(Official Video)', 'X'), '(Official Video)');
  });

  test('song keys fold quotes, case and invisible characters', () => {
    assert.equal(makeSongKey('It’s  Time​', 'Imagine Dragons'), makeSongKey("it's time", 'imagine dragons'));
  });

  test('album keys use the primary artist', () => {
    assert.equal(makeAlbumKey('Moon Music', 'Coldplay, Jon Hopkins'), 'moon music:::coldplay');
  });
});

describe('Text keys - counters', () => {
  test('toCount coerces to a non-negative integer', () => {
    assert.equal(toCount('5'), 5);
    assert.equal(toCount(-3), 0);
    assert.equal(toCount('abc'), 0);
    assert.equal(toCount(2.6), 3);
  });

  test('incrementCount ignores inherited members', () => {
    const dict = {};
    incrementCount(dict, 'constructor');
    incrementCount(dict, 'toString');
    incrementCount(dict, 'toString', 2);
    assert.equal(dict.toString, 3);
    assert.equal(Object.prototype.hasOwnProperty.call(dict, 'constructor'), false);
  });
});

describe('Text keys - sanitizeStorageData with hostile imports', () => {
  test('survives non-string fields and string counters', () => {
    const result = sanitizeStorageData({
      songs: {
        a: { title: 123, artist: ['x'], album: {}, playCount: '4', durationSeconds: '10' },
        b: { title: { evil: true } }
      },
      albums: { c: { album: 7, artist: 'Band', playCount: '2', tracksListened: { One: '3', Two: 'x' } } },
      artists: {}
    });
    const song = result.songs['123:::unknown artist'];
    assert.equal(song.playCount, 4);
    assert.equal(song.durationSeconds, 10);
    assert.equal(Object.keys(result.songs).length, 1);
    const album = result.albums['7:::band'];
    assert.deepEqual(album.tracksListened, { One: 3 });
    assert.equal(album.playCount, 2);
  });

  test('an artist named __proto__ does not pollute Object.prototype', () => {
    validateAndMigrateImport({
      schemaVersion: 2,
      songs: { 'x:::__proto__': { title: 'X', artist: '__proto__', playCount: 1 } },
      artists: {}
    });
    assert.equal(({}).playCount, undefined);
  });

  test('merges songs and albums that only differed by noise', () => {
    const result = sanitizeStorageData({
      songs: {
        'one:::band': { title: 'One', artist: 'Band', album: 'Rec', playCount: 1, durationSeconds: 10 },
        'one (official video):::band': { title: 'One (Official Video)', artist: 'Band', album: '', playCount: 2, durationSeconds: 20 }
      },
      albums: {
        'rec:::band': { album: 'Rec', artist: 'Band', playCount: 1, tracksListened: { One: 1 } },
        'rec:::band, guest': { album: 'Rec', artist: 'Band, Guest', playCount: 1, tracksListened: { Two: 1 } }
      },
      artists: {}
    });
    assert.equal(result.modified, true);
    assert.equal(result.songs['one:::band'].playCount, 3);
    assert.equal(result.songs['one:::band'].durationSeconds, 30);
    assert.deepEqual(result.albums['rec:::band'].tracksListened, { One: 1, Two: 1 });
    assert.equal(result.albums['rec:::band'].uniqueTracksCount, 2);
  });
});
