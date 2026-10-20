/**
 * JAMt - Shared text sanitization & dictionary key builders
 *
 * Loaded in two worlds, like shared/browse-parse.js:
 *
 *   1. As a classic content script (manifest.json `content_scripts.js`), before
 *      content.js, which builds the same song/album keys to read storage back.
 *   2. As a side-effect ESM import from background/storage.js, which re-exports
 *      these functions off `globalThis`.
 *
 * A single implementation guarantees that a key built by the content script
 * always matches the key the background used when it wrote the record.
 */
(function (root) {
  'use strict';

  // Invisible code points: C0/C1 controls, soft hyphen, zero-width chars, bidi
  // marks/overrides and word joiners. They render as nothing but make two
  // visually identical strings produce two different dictionary keys.
  const INVISIBLE_RE = /[\u0000-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁤﻿]/g;

  // Typographic quote variants, folded only inside keys (display text keeps them).
  const SINGLE_QUOTES_RE = /[‘’‚‛′`´]/g;
  const DOUBLE_QUOTES_RE = /[“”„‟″]/g;

  // Trailing upload tags that turn one song into a second dictionary entry when
  // it is played from a music video instead of the album track.
  const VIDEO_TAG_RE = /\s*[(\[]\s*(?:official\s+)?(?:(?:music|lyrics?|hd)\s+)?(?:video|audio|visuali[sz]er|lyrics?|mv)\s*[)\]]\s*$/i;

  // "Artist - Title" prefix used by video uploads; en/em dashes included.
  const PREFIX_DASH_RE = /^\s*[-–—]\s+/;

  const ARTIST_SEPARATOR_RE = /\s*[,&/]\s*|\s+(?:feat\.?|ft\.?|featuring)\s+/i;

  /**
   * Artist names that contain a separator character and must never be split.
   * Longest first, so "Crosby, Stills, Nash & Young" wins over its prefix.
   */
  const PROTECTED_ARTIST_NAMES = [
    'Crosby, Stills, Nash & Young',
    'Emerson, Lake & Palmer',
    'Crosby, Stills & Nash',
    'Blood, Sweat & Tears',
    'Peter, Paul and Mary',
    'Earth, Wind & Fire',
    'Daryl Hall & John Oates',
    'Sly & The Family Stone',
    'Echo & The Bunnymen',
    'Tyler, The Creator',
    'Simon & Garfunkel',
    'Kool & The Gang',
    'Mumford & Sons',
    'Hall & Oates',
    'Iron & Wine',
    'AC/DC'
  ].sort((a, b) => b.length - a.length);

  const MASK = '\u0001';
  const PROTECTED_RE = new RegExp(
    `(^|[,&/]\\s*|\\s)(${PROTECTED_ARTIST_NAMES.map(n => n.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})(?=$|\\s*[,&/]|\\s)`,
    'gi'
  );

  /**
   * Coerces any value into clean single-line display text: NFC-normalized,
   * whitespace collapsed, invisible characters removed. Non-string values from
   * an untrusted import become '' (finite numbers are stringified) instead of
   * crashing a later `.trim()`.
   *
   * @param {unknown} value
   * @returns {string}
   */
  function cleanText(value) {
    let str;
    if (typeof value === 'string') str = value;
    else if (typeof value === 'number' && Number.isFinite(value)) str = String(value);
    else return '';
    return str
      .normalize('NFC')
      .replace(/\s/g, ' ')
      .replace(INVISIBLE_RE, '')
      .replace(/ {2,}/g, ' ')
      .trim();
  }

  /**
   * Canonical form of one key segment: clean text, lowercased, quotes folded,
   * so "It’s Time" and "It's Time" share a key.
   *
   * @param {unknown} value
   * @returns {string}
   */
  function normalizeKeyPart(value) {
    return cleanText(value)
      .toLowerCase()
      .replace(SINGLE_QUOTES_RE, "'")
      .replace(DOUBLE_QUOTES_RE, '"');
  }

  /**
   * Splits a credit string into individual artists, keeping protected names
   * whole and dropping duplicates ("Hitomitoi, ryusenkei/hitomitoi" credits
   * Hitomitoi once, not twice). Names that would collide with Object.prototype
   * members are dropped, since the result is used as a plain-object key.
   *
   * @param {unknown} artist
   * @returns {string[]}
   */
  function splitArtists(artist) {
    const source = cleanText(artist);
    if (!source) return [];

    const kept = [];
    const masked = source.replace(PROTECTED_RE, (_, lead, name) => {
      kept.push(name);
      return `${lead}${MASK}${kept.length - 1}${MASK}`;
    });
    const restoreRe = new RegExp(`${MASK}(\\d+)${MASK}`, 'g');

    const seen = new Set();
    const result = [];
    for (const part of masked.split(ARTIST_SEPARATOR_RE)) {
      const name = part.replace(restoreRe, (_, i) => kept[Number(i)]).trim();
      if (!name) continue;
      const key = normalizeKeyPart(name);
      if (seen.has(key) || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      seen.add(key);
      result.push(name);
    }
    return result;
  }

  /**
   * First credited artist; the album owner when a track lists features.
   *
   * @param {unknown} artist
   * @returns {string}
   */
  function primaryArtist(artist) {
    return splitArtists(artist)[0] || cleanText(artist);
  }

  /**
   * Display title with upload noise removed: trailing "(Official Music Video)"
   * style tags and a leading "<Artist> - " prefix. Falls back to the cleaned
   * input if stripping would leave nothing.
   *
   * @param {unknown} title
   * @param {unknown} [artist]
   * @returns {string}
   */
  function cleanTrackTitle(title, artist) {
    const original = cleanText(title);
    let result = original;

    let previous;
    do {
      previous = result;
      result = result.replace(VIDEO_TAG_RE, '');
    } while (result !== previous && result);

    const lead = primaryArtist(artist);
    if (lead && result.toLowerCase().startsWith(lead.toLowerCase())) {
      const rest = result.slice(lead.length);
      if (PREFIX_DASH_RE.test(rest)) result = rest.replace(PREFIX_DASH_RE, '');
    }

    result = result.trim();
    return result || original;
  }

  function makeSongKey(title, artist) {
    return `${normalizeKeyPart(cleanTrackTitle(title, artist))}:::${normalizeKeyPart(artist)}`;
  }

  function makeArtistKey(artist) {
    return normalizeKeyPart(artist);
  }

  /**
   * Albums are keyed by their primary artist, so a featured credit on one track
   * ("Coldplay, Jon Hopkins") does not split "Moon Music" into two albums.
   */
  function makeAlbumKey(album, artist) {
    return `${normalizeKeyPart(album)}:::${normalizeKeyPart(primaryArtist(artist))}`;
  }

  root.YTMCShared = Object.assign(root.YTMCShared || {}, {
    cleanText,
    normalizeKeyPart,
    splitArtists,
    primaryArtist,
    cleanTrackTitle,
    makeSongKey,
    makeArtistKey,
    makeAlbumKey
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
