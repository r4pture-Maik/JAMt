/**
 * JAMt - Duration Tracking Module
 * Accumulates continuous playback time across global metrics, songs, artists, and albums.
 */

import { makeSongKey, makeArtistKey, makeAlbumKey, splitArtists, withStorageLock, PENDING_DURATIONS_KEY } from './storage.js';

/**
 * Records a listening duration tick (delta) and updates storage.
 *
 * @param {object} payload
 * @param {string} payload.songTitle
 * @param {string} payload.songArtist
 * @param {string} [payload.songAlbum]
 * @param {boolean} [payload.isSingle]
 * @param {number} payload.deltaSeconds
 * @param {object} extBrowser
 * @param {Function} [invalidateCacheFn]
 * @returns {Promise<{ totalListeningSeconds: number, songDuration: number }>}
 */
export async function recordListeningDuration(payload, extBrowser, invalidateCacheFn = null) {
  if (!payload || !payload.songTitle) {
    return { totalListeningSeconds: 0, songDuration: 0 };
  }

  const delta = Math.max(0, Math.round(payload.deltaSeconds || 0));
  if (delta <= 0) {
    return { totalListeningSeconds: 0, songDuration: 0 };
  }

  if (!extBrowser || !extBrowser.storage || !extBrowser.storage.local) {
    return { totalListeningSeconds: delta, songDuration: delta };
  }

  const title = payload.songTitle.trim();
  const artist = (payload.songArtist || '').trim();
  const album = (payload.songAlbum || '').trim();
  const isSingle = Boolean(payload.isSingle || !album || /^single(\s*-\s*ep)?$/i.test(album) || /^ep$/i.test(album));
  const songKey = makeSongKey(title, artist);

  // The whole read-modify-write runs under the shared storage lock: a 5s tick can
  // otherwise overlap a play registration and silently discard its increment.
  const result = await withStorageLock(async () => {
    const data = await extBrowser.storage.local.get([
      'totalListeningSeconds',
      'songs',
      'artists',
      'albums',
      PENDING_DURATIONS_KEY
    ]);

    const totalListeningSeconds = (data.totalListeningSeconds || 0) + delta;
    const songs = data.songs || {};
    const artists = data.artists || {};
    const albums = data.albums || {};
    const pending = data[PENDING_DURATIONS_KEY] || {};

    // Ticks are booked to the current month. Read in the same lock as the all-time data.
    const monthId = currentMonthId();
    const { index: monthIndex, buckets: monthBuckets } = await readMonthState(extBrowser, [monthId]);
    let monthUpdates = {};

    let songDuration = 0;

    if (songs[songKey]) {
      // 1. Known song: attribute the delta directly.
      songs[songKey].durationSeconds = (songs[songKey].durationSeconds || 0) + delta;
      songDuration = songs[songKey].durationSeconds;

      // 2. Known artist(s).
      if (artist) {
        for (const rawName of splitArtists(artist)) {
          const aKey = makeArtistKey(rawName);
          if (Object.prototype.hasOwnProperty.call(artists, aKey)) {
            artists[aKey].durationSeconds = (artists[aKey].durationSeconds || 0) + delta;
          }
        }
      }

      // 3. Known album (singles excluded).
      if (album && !isSingle) {
        const albumKey = makeAlbumKey(album, artist);
        if (albums[albumKey]) {
          albums[albumKey].durationSeconds = (albums[albumKey].durationSeconds || 0) + delta;
        }
      }

      // 4. Same delta, booked to the current month (only keys that exist in the all-time dicts).
      const monthAlbumKey = makeAlbumKey(album, artist);
      recordDurationInBucket(monthBuckets[monthId], {
        songKey,
        artistKeys: artistKeysFor(artist).filter((aKey) => artists[aKey]),
        albumKey: album && !isSingle && albums[monthAlbumKey] ? monthAlbumKey : '',
        seconds: delta
      });
      monthUpdates = buildMonthUpdates(monthIndex, { [monthId]: monthBuckets[monthId] });
    } else {
      // The play was never registered (service worker asleep, or the 5s play
      // threshold not reached). Creating a `playCount: 1` record here would
      // inflate unique/tops counts without ever incrementing totalPlays, so the
      // delta is parked until handleTrackPlayed creates the real entry.
      pending[songKey] = (pending[songKey] || 0) + delta;
    }

    const updates = {
      totalListeningSeconds,
      songs,
      artists,
      albums
    };
    if (Object.keys(pending).length > 0) updates[PENDING_DURATIONS_KEY] = pending;
    Object.assign(updates, monthUpdates);

    await extBrowser.storage.local.set(updates);

    return { totalListeningSeconds, songDuration };
  });

  if (typeof invalidateCacheFn === 'function') {
    invalidateCacheFn();
  }

  return result;
}
