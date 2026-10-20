/**
 * JAMt - Content Script
 * Tracks song plays, updates per-song counter badge in the player bar,
 * and reports playback to the background worker.
 */

(function () {
  const extBrowser = typeof browser !== 'undefined' ? browser : chrome;

  const YOUTUBE_MUSIC_HISTORY_URL = 'https://music.youtube.com/history';

  // `scanProgress.kind` values, mirroring background/enrichment.js. Duplicated
  // rather than imported because this file is a classic content script: it has no
  // module scope, and the manifest injects shared/ helpers on globalThis instead.
  // The enrichment pump also writes `scanProgress`, so the two producers have to
  // be distinguishable or its text leaks into the scanner's own note line.
  const SCAN_PROGRESS_KIND = 'scan';
  const ENRICHMENT_PROGRESS_KIND = 'enrichment';

  // Injected by the manifest before this file. Destructured without a fallback
  // on purpose: a missing helper is a broken bundle, and failing here beats
  // throwing "cannot read property of undefined" from every send below.
  const {
    sendRuntimeMessage,
    sendRuntimeMessageIgnoringReply: sendMessageIgnoringReply
  } = globalThis.YTMCMessaging;

  /* ==========================================================================
     Localization

     A content script cannot read `_locales/` (no `web_accessible_resources`), so
     `YTMCI18n.init()` never fetches a catalog here and leaves the host page's
     `<html lang>` alone. Without an override, or with one that matches the browser
     locale, native `getMessage()` answers and the background is never contacted.
     Only when `needsCatalog()` is true does this file ask the background once
     (GET_LOCALIZED_MESSAGES) for the raw templates of CONTENT_MESSAGE_KEYS and
     install them with `setCatalog()`, again on every locale change. Rendering
     never waits for that round-trip: the badge and overlay re-render on arrival.
     ========================================================================== */

  /** Injected by the manifest before this file, same as YTMCMessaging above. */
  const i18n = globalThis.YTMCI18n;

  /**
   * Every key this file can render, requested in one batch when an override needs
   * a catalog. Plural bases appear as their `_one` / `_other` forms; the scan
   * vocabulary shares the `msg_scan_*` family with details.js.
   */
  const CONTENT_MESSAGE_KEYS = Object.freeze([
    'msg_content_badge_play_one',
    'msg_content_badge_play_other',
    'msg_content_badge_title_one',
    'msg_content_badge_title_other',
    'msg_content_count_play_one',
    'msg_content_count_play_other',
    'msg_content_count_new_play_one',
    'msg_content_count_new_play_other',
    'msg_content_count_song_one',
    'msg_content_count_song_other',
    'msg_content_scanner_title',
    'msg_content_scanner_metric_label',
    'msg_content_scanner_minimize',
    'msg_content_scanner_restore',
    'msg_content_scanner_toggle_minimize',
    'msg_content_scanner_ready',
    'msg_content_scanner_force_rescan',
    'msg_scanner_start_sync',
    'msg_scanner_in_progress',
    'msg_content_scan_checking_since',
    'msg_content_scan_scanning_history',
    'msg_content_scan_boundary_progress',
    'msg_content_scan_saving',
    'msg_content_scan_success',
    'msg_content_scan_synced',
    'msg_content_scan_synced_reason',
    'msg_content_scan_up_to_date',
    'msg_content_scan_empty_history',
    'msg_content_scan_failed',
    'msg_scan_step_scanning',
    'msg_scan_step_boundary',
    'msg_scan_step_importing',
    'msg_scan_step_saving',
    'msg_scan_step_done',
    'msg_scan_step_failed',
    'msg_scan_step_progress',
    'msg_scan_reason_up_to_date',
    'msg_scan_reason_complete',
    'msg_scan_reason_full_history',
    'msg_scan_reason_end_of_history',
    'msg_scan_reason_navigated_away',
    'msg_scan_error_untrusted_source',
    'msg_scan_error_scan_failed'
  ]);

  /**
   * Fetches the override catalog from the background when native `getMessage()`
   * cannot answer. Resolves to whether a catalog was installed; never rejects.
   * Bounded to 3s: nothing blocks on it and a hung service worker should not leave
   * a pending re-render behind for the lifetime of the tab.
   *
   * @returns {Promise<boolean>}
   */
  function loadOverrideCatalog() {
    if (!i18n.needsCatalog()) return Promise.resolve(false);
    return sendRuntimeMessage({
      type: 'GET_LOCALIZED_MESSAGES',
      payload: { keys: CONTENT_MESSAGE_KEYS.slice() }
    }, 3000).then((response) => {
      if (!response || response.status !== 'ok' || !response.data || typeof response.data !== 'object') return false;
      i18n.setCatalog(i18n.getLocale(), response.data);
      return true;
    }).catch(() => false);
  }

  /**
   * Boots localization. Never rejects and never delays the first render.
   *
   * @returns {void}
   */
  function initLocalization() {
    const initialLocale = i18n.getLocale();

    Promise.resolve(i18n.init()).then(loadOverrideCatalog).then((loaded) => {
      if (loaded || i18n.getLocale() !== initialLocale) renderLocalizedChrome();
    }, () => {});

    i18n.onLocaleChanged(() => {
      loadOverrideCatalog().then(() => renderLocalizedChrome(), () => {});
    });
  }

  /**
   * Writes `value` into `node`, leaving the node alone when the catalog could not
   * resolve it (AD-3: English stays inline, so an unresolvable key must never
   * blank a label).
   *
   * @param {Element|null} node
   * @param {string} value
   */
  function setText(node, value) {
    if (!node || !value) return;
    node.textContent = value;
  }

  /**
   * Localized text with an English last resort.
   *
   * The fallback only ever fires when the catalog lacks the key - a broken bundle. Keeping English here means the
   * player bar and the overlay stay readable rather than blank.
   *
   * @param {string} key
   * @param {string} fallback
   * @param {string[]|Object<string, any>} [substitutions]
   * @returns {string}
   */
  function localize(key, fallback, substitutions) {
    return i18n.t(key, substitutions) || fallback;
  }

  /**
   * Re-renders everything this file owns after the locale changes.
   *
   * The overlay's live status note is deliberately NOT rewritten: it is a
   * transient render of whatever `scanProgress` last said, and clobbering it with
   * the idle sentence would be a lie if a scan is running. The next scan event
   * recomposes it in the new locale.
   *
   * @returns {void}
   */
  function renderLocalizedChrome() {
    // Only refresh an existing badge: rendering here would pin a "0 plays"
    // badge onto a player bar that has never registered a play.
    if (document.getElementById('ytmusic-counter-badge')) {
      updateSongBadge(currentSongPlays, false);
    }
    applyScannerOverlayStrings();
  }

  console.log('[JAMt] Content script initialized.');

  let lastTrackKey = null;
  let currentSongPlays = 0;
  let trackPlaybackTimer = null;
  const MIN_PLAY_TIME_MS = 5000; // Minimum active listening duration

  /**
   * Extracts metadata of the currently playing song from the DOM
   */
  function getCurrentTrackInfo() {
    const titleElem = document.querySelector('ytmusic-player-bar .title');
    const bylineElem = document.querySelector('ytmusic-player-bar .byline');

    if (!titleElem) {
      if (navigator.mediaSession && navigator.mediaSession.metadata) {
        const meta = navigator.mediaSession.metadata;
        let coverUrl = '';
        if (meta.artwork && meta.artwork.length > 0) {
          coverUrl = meta.artwork[meta.artwork.length - 1].src || '';
        }
        return {
          title: meta.title || '',
          artist: meta.artist || '',
          album: meta.album || '',
          coverUrl
        };
      }
      return null;
    }

    const title = titleElem.textContent ? titleElem.textContent.trim() : '';
    let artist = '';
    let album = '';
    let albumBrowseId = '';
    let isSingle = false;

    if (bylineElem) {
      const bylineText = bylineElem.textContent || '';
      if (/\bsingle\b/i.test(bylineText)) {
        isSingle = true;
      }

      const links = Array.from(bylineElem.querySelectorAll('a'));
      if (links.length > 0) artist = links[0].textContent.trim();
      if (links.length > 1) {
        const linkText = links[1].textContent.trim();
        if (/^single(\s*-\s*ep)?$/i.test(linkText) || /^ep$/i.test(linkText)) {
          isSingle = true;
        } else {
          album = linkText;
          const href = links[1].getAttribute('href') || '';
          const match = href.match(/(MPREb[a-zA-Z0-9_-]+|OLAK5uy[a-zA-Z0-9_-]+)/);
          if (match) albumBrowseId = match[1];
        }
      }

      // Fallback parse by bullets
      if (!artist && bylineText) {
        const parts = bylineText.split('•').map(p => p.trim()).filter(Boolean);
        const textParts = parts.filter(p => 
          !/^\d+:\d+(:\d+)?$/.test(p) && 
          !/^\d{4}$/.test(p) &&
          !/^single(\s*-\s*ep)?$/i.test(p)
        );
        if (textParts[0]) artist = textParts[0];
        if (!album && !isSingle && textParts[1]) album = textParts[1];
      }

      // Sanitize bullets in artist and album
      if (artist && artist.includes('•')) {
        const parts = artist.split('•').map(p => p.trim()).filter(Boolean);
        artist = parts[0] || '';
        if (!album && parts[1] && !/^\d+:\d+$/.test(parts[1])) album = parts[1];
      }

      if (album && (/^single(\s*-\s*ep)?$/i.test(album) || /^ep$/i.test(album) || /^\d+:\d+(:\d+)?$/.test(album))) {
        isSingle = true;
        album = '';
      }

      if (artist && album && artist.toLowerCase() === album.toLowerCase()) {
        album = '';
        isSingle = true;
      }
    }

    let videoId = '';
    const videoLink = document.querySelector('ytmusic-player-bar .image-link, ytmusic-player-bar a.yt-simple-endpoint[href*="watch?v="]');
    if (videoLink) {
      const href = videoLink.getAttribute('href') || '';
      const match = href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
      if (match) videoId = match[1];
    }
    if (!videoId && window.location.search.includes('v=')) {
      const match = window.location.search.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
      if (match) videoId = match[1];
    }

    let coverUrl = '';
    if (navigator.mediaSession && navigator.mediaSession.metadata && navigator.mediaSession.metadata.artwork) {
      const arts = navigator.mediaSession.metadata.artwork;
      if (arts.length > 0 && arts[arts.length - 1]?.src) {
        coverUrl = arts[arts.length - 1].src;
      }
    }
    if (!coverUrl) {
      const img = document.querySelector('ytmusic-player-bar img#img, ytmusic-player-bar .thumbnail img, ytmusic-player-bar .image');
      if (img && img.src && !img.src.startsWith('data:')) {
        coverUrl = img.src;
      }
    }

    return { title, artist, album, albumBrowseId, isSingle, videoId, coverUrl };
  }

  /**
   * Checks if audio is currently actively playing
   */
  function isPlaying() {
    const playPauseBtn = document.querySelector('#play-pause-button');
    if (playPauseBtn) {
      const ariaLabel = playPauseBtn.getAttribute('aria-label') || '';
      const title = playPauseBtn.getAttribute('title') || '';
      if (/pause/i.test(ariaLabel) || /pause/i.test(title)) {
        return true;
      }
    }
    const video = document.querySelector('video');
    if (video && !video.paused && !video.ended) {
      return true;
    }
    return false;
  }

  /* ==========================================================================
     Continuous Listening Duration Tracker Module
     ========================================================================== */
  let activeMediaElement = null;
  let lastMediaTime = null;
  let bufferedDurationSeconds = 0;
  const DURATION_FLUSH_THRESHOLD_SEC = 5;

  function flushDurationBuffer() {
    if (bufferedDurationSeconds < 1) return;
    const track = getCurrentTrackInfo();
    if (!track || !track.title) return;

    const delta = Math.round(bufferedDurationSeconds);
    bufferedDurationSeconds = 0;

    sendMessageIgnoringReply({
      type: 'TIME_LISTENED_TICK',
      payload: {
        songTitle: track.title,
        songArtist: track.artist,
        songAlbum: track.album,
        isSingle: track.isSingle,
        deltaSeconds: delta
      }
    });
  }

  function handleMediaTimeUpdate(event) {
    const video = event.target;
    if (!video) return;

    // Validate that media is genuinely playing audio
    if (video.paused || video.ended || video.playbackRate <= 0 || video.muted || video.volume === 0) {
      lastMediaTime = video.currentTime;
      return;
    }

    const currentTime = video.currentTime;
    if (typeof lastMediaTime === 'number') {
      const delta = currentTime - lastMediaTime;
      // Filter rapid scrubbing or seeking (ignore negative deltas or jumps > 2s)
      if (delta > 0 && delta <= 2.0) {
        bufferedDurationSeconds += delta;
        if (bufferedDurationSeconds >= DURATION_FLUSH_THRESHOLD_SEC) {
          flushDurationBuffer();
        }
      }
    }
    lastMediaTime = currentTime;
  }

  function handleMediaRateChange() {
    lastMediaTime = activeMediaElement ? activeMediaElement.currentTime : null;
  }

  function handleMediaSeeking() {
    lastMediaTime = null; // reset anchor so scrub jump is not counted
  }

  function setupMediaElementListeners() {
    const video = document.querySelector('video');
    if (!video || video === activeMediaElement) return;

    if (activeMediaElement) {
      activeMediaElement.removeEventListener('timeupdate', handleMediaTimeUpdate);
      activeMediaElement.removeEventListener('ratechange', handleMediaRateChange);
      activeMediaElement.removeEventListener('seeking', handleMediaSeeking);
      activeMediaElement.removeEventListener('seeked', handleMediaSeeking);
      activeMediaElement.removeEventListener('pause', handleMediaRateChange);
    }

    activeMediaElement = video;
    lastMediaTime = video.currentTime;

    video.addEventListener('timeupdate', handleMediaTimeUpdate);
    video.addEventListener('ratechange', handleMediaRateChange);
    video.addEventListener('seeking', handleMediaSeeking);
    video.addEventListener('seeked', handleMediaSeeking);
    video.addEventListener('pause', handleMediaRateChange);
  }

  // pagehide + visibilitychange are the reliable flush points for a single-page
  // app. `beforeunload` frequently does not fire on in-app navigation, which used
  // to drop up to one flush threshold (5s) of listening time per track change.
  window.addEventListener('pagehide', () => {
    flushDurationBuffer();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushDurationBuffer();
  });

  /**
   * Main observer callback whenever player bar updates
   */
  function checkTrackChange() {
    setupMediaElementListeners();
    const track = getCurrentTrackInfo();
    if (!track || !track.title) return;

    const currentKey = `${track.title}:::${track.artist}`;

    if (currentKey !== lastTrackKey) {
      flushDurationBuffer();
      lastMediaTime = activeMediaElement ? activeMediaElement.currentTime : null;
      lastTrackKey = currentKey;

      if (trackPlaybackTimer) {
        clearTimeout(trackPlaybackTimer);
        trackPlaybackTimer = null;
      }

      // Step 1: Immediately fetch existing play count for THIS song and update badge
      sendRuntimeMessage({ type: 'GET_SONG_COUNT', payload: track }).then((res) => {
        if (res && res.status === 'ok') {
          currentSongPlays = res.data.songPlays || 0;
          updateSongBadge(currentSongPlays, false);
        }
      }).catch(() => {
        // Background asleep or unreachable: the badge stays as it is, and the
        // 5-second timer below still records the play.
      });

      // Step 2: Set threshold timer (5 seconds of active playback)
      trackPlaybackTimer = setTimeout(() => {
        if (lastTrackKey === currentKey && isPlaying()) {
          countSongPlay(track);
        }
      }, MIN_PLAY_TIME_MS);
    }
  }

  /**
   * Sends play notification to background script and updates UI
   */
  function countSongPlay(track) {
    sendRuntimeMessage({ type: 'TRACK_PLAYED', payload: track }).then((response) => {
      if (response && response.status === 'ok') {
        currentSongPlays = response.data.songPlays;
        console.log(`[JAMt] "${track.title}" play registered! Total plays for this song: ${currentSongPlays}`);
        updateSongBadge(currentSongPlays, true);
      }
    }).catch((err) => {
      console.warn('[JAMt] Messaging error:', err);
    });
  }

  /**
   * Updates the on-player badge with the play count for the current song
   */
  function updateSongBadge(count, animate) {
    let badge = document.getElementById('ytmusic-counter-badge');
    if (!badge) {
      const rightControls = document.querySelector('ytmusic-player-bar .right-controls-buttons');
      if (!rightControls) return;

      badge = document.createElement('div');
      badge.id = 'ytmusic-counter-badge';
      rightControls.prepend(badge);
    }

    // The label is a bare noun rather than a counted phrase: the number is its
    // own DOM node below. English fallbacks only fire if the catalog cannot
    // resolve at all, so a broken bundle degrades to the old behaviour instead of
    // rendering an empty badge.
    const label = i18n.plural('msg_content_badge_play', count) || (count === 1 ? 'play' : 'plays');
    badge.title = i18n.plural('msg_content_badge_title', count)
      || `You have listened to this song ${i18n.formatNumber(count)} ${count === 1 ? 'time' : 'times'}`;

    // Built from DOM nodes instead of innerHTML: no interpolated value reaches the
    // HTML parser, and the markup is not re-parsed on every count update.
    badge.textContent = '';

    const icon = document.createElement('span');
    icon.className = 'ytmc-icon';
    icon.textContent = '🎵';

    const countEl = document.createElement('span');
    countEl.className = animate ? 'ytmc-count pulse' : 'ytmc-count';
    countEl.textContent = i18n.formatNumber(count);

    const labelEl = document.createElement('span');
    labelEl.className = 'ytmc-label';
    labelEl.textContent = label;

    badge.appendChild(icon);
    badge.appendChild(document.createTextNode(' '));
    badge.appendChild(countEl);
    badge.appendChild(document.createTextNode(' '));
    badge.appendChild(labelEl);
  }

  /* ==========================================================================
     YouTube Music History Scanner Module (Date-Sectional Offset)
     ========================================================================== */
  let isScanning = false;
  let scanInterval = null;
  let scannedTracks = [];
  let idleScrollCount = 0;
  let activeSyncState = null;
  let topSectionDate = null;
  let topSectionCount = 0;

  const MAX_HISTORY_SCAN_ITEMS = 200;

  function isHistoryPage() {
    const path = window.location.pathname || '';
    return path === '/history' || path.startsWith('/history');
  }

  function parseTrackFromItem(item) {
    if (!item) return null;

    // 1. Extract Title
    const titleElem = item.querySelector(
      '.title-column yt-formatted-string, .title a, .title yt-formatted-string, yt-formatted-string.title, [is-empty="false"].title'
    ) || item.querySelector('.title');
    const title = titleElem ? titleElem.textContent.trim() : '';
    if (!title) return null;

    let artist = '';
    let album = '';
    let albumBrowseId = '';
    let isSingle = false;

    // Check if the item text directly mentions Single
    const itemText = item.textContent || '';
    if (/\bsingle\b/i.test(itemText)) {
      isSingle = true;
    }

    // 2. Extract Artist & Album via links inside secondary columns
    const secLinks = Array.from(item.querySelectorAll('.secondary-flex-columns a, yt-formatted-string.subtitle a, .subtitle a, .byline a'));
    
    const artistLinks = [];
    const albumLinks = [];

    secLinks.forEach(a => {
      const href = a.getAttribute('href') || '';
      const text = a.textContent.trim();
      if (!text) return;

      if (href.includes('browse/MPREb') || href.includes('browse/OLAK5uy') || 
          href.includes('playlist?list=OLAK5uy') || href.includes('playlist?list=MPREb')) {
        albumLinks.push(a);
      } else if (href.includes('channel/') || href.includes('browse/UC') || href.includes('browse/FEmusic_library')) {
        artistLinks.push(a);
      }
    });

    if (artistLinks.length > 0) {
      artist = artistLinks.map(a => a.textContent.trim()).filter(Boolean).join(', ');
    }

    if (albumLinks.length > 0) {
      const linkText = albumLinks[0].textContent.trim();
      if (/^single(\s*-\s*ep)?$/i.test(linkText) || /^ep$/i.test(linkText)) {
        isSingle = true;
      } else {
        album = linkText;
        const href = albumLinks[0].getAttribute('href') || '';
        const match = href.match(/(MPREb[a-zA-Z0-9_-]+|OLAK5uy[a-zA-Z0-9_-]+)/);
        if (match) albumBrowseId = match[1];
      }
    }

    // In YouTube Music bylines, link 0 is Artist, link 1 is Album
    if (!artist && secLinks.length > 0 && !albumLinks.includes(secLinks[0])) {
      artist = secLinks[0].textContent.trim();
    }
    if (!album && !isSingle && secLinks.length > 1 && !artistLinks.includes(secLinks[1])) {
      const cand = secLinks[1].textContent.trim();
      if (!/^single(\s*-\s*ep)?$/i.test(cand) && !/^ep$/i.test(cand) && !/^\d+:\d+$/.test(cand) && !/^\d{4}$/.test(cand)) {
        album = cand;
      }
    }

    // 3. Fallback: Parse secondary formatted text (split by bullet points)
    if (!artist || !album) {
      const subtitleElem = item.querySelector('.secondary-flex-columns yt-formatted-string, yt-formatted-string.subtitle, .subtitle, .byline');
      const subtitleText = subtitleElem ? subtitleElem.textContent.trim() : '';

      if (subtitleText) {
        const parts = subtitleText.split('•').map(p => p.trim()).filter(Boolean);
        const textParts = parts.filter(p => 
          !/^\d+:\d+(:\d+)?$/.test(p) && 
          !/^\d{4}$/.test(p) &&
          !/^\d+(\.\d+)?[KM]?\s*(plays?|views?)/i.test(p) &&
          !/^single(\s*-\s*ep)?$/i.test(p) &&
          !/^ep$/i.test(p)
        );

        if (!artist && textParts.length > 0) {
          artist = textParts[0];
        }
        if (!album && !isSingle && textParts.length > 1) {
          album = textParts[1];
        }
      }
    }

    // 4. Sanitize extracted values
    if (artist && artist.includes('•')) {
      const sub = artist.split('•').map(p => p.trim()).filter(Boolean);
      artist = sub[0] || '';
      if (!album && sub[1] && !/^\d+:\d+$/.test(sub[1])) {
        album = sub[1];
      }
    }

    if (album) {
      if (album.includes('•')) {
        album = album.split('•')[0].trim();
      }
      if (/^\d+:\d+(:\d+)?$/.test(album) || 
          /^\d{4}$/.test(album) || 
          /^\d+(\.\d+)?[KM]?\s*(plays?|views?)/i.test(album) ||
          /^single(\s*-\s*ep)?$/i.test(album) ||
          /^ep$/i.test(album)) {
        if (/^single/i.test(album)) isSingle = true;
        album = '';
      }
    }

    // Avoid artist and album being identical
    if (artist && album && artist.toLowerCase() === album.toLowerCase()) {
      album = '';
      isSingle = true;
    }

    let videoId = '';
    const videoLink = item.querySelector('a[href*="watch?v="]');
    if (videoLink) {
      const href = videoLink.getAttribute('href') || '';
      const match = href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
      if (match) videoId = match[1];
    }

    let coverUrl = '';
    const itemImg = item.querySelector('img#img, yt-img-shadow img, img');
    if (itemImg && itemImg.src && !itemImg.src.startsWith('data:')) {
      coverUrl = itemImg.src;
    }

    // 5. Extract duration from fixed columns, subtitle, or formatted strings
    let durationStr = '';
    const fixedCols = item.querySelectorAll('.fixed-columns yt-formatted-string, .fixed-columns span, [has-fixed-columns] .fixed-columns');
    for (const col of fixedCols) {
      const text = (col.textContent || '').trim();
      if (/^\d+:\d{2}(?::\d{2})?$/.test(text)) {
        durationStr = text;
        break;
      }
    }

    if (!durationStr) {
      const subtitleElem = item.querySelector('.secondary-flex-columns yt-formatted-string, yt-formatted-string.subtitle, .subtitle, .byline');
      const subtitleText = subtitleElem ? subtitleElem.textContent.trim() : '';
      if (subtitleText) {
        const parts = subtitleText.split('•').map(p => p.trim()).filter(Boolean);
        const durPart = parts.find(p => /^\d+:\d{2}(?::\d{2})?$/.test(p));
        if (durPart) durationStr = durPart;
      }
    }

    if (!durationStr) {
      const strings = item.querySelectorAll('yt-formatted-string, span');
      for (const el of strings) {
        const text = (el.textContent || '').trim();
        if (/^\d+:\d{2}(?::\d{2})?$/.test(text)) {
          durationStr = text;
          break;
        }
      }
    }

    let durationSeconds = 0;
    if (durationStr) {
      const match = durationStr.trim().match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
      if (match) {
        if (match[3] !== undefined) {
          const hours = parseInt(match[1], 10) || 0;
          const minutes = parseInt(match[2], 10) || 0;
          const seconds = parseInt(match[3], 10) || 0;
          durationSeconds = hours * 3600 + minutes * 60 + seconds;
        } else {
          const minutes = parseInt(match[1], 10) || 0;
          const seconds = parseInt(match[2], 10) || 0;
          durationSeconds = minutes * 60 + seconds;
        }
      }
    }

    return {
      title,
      // AD-8: this sentinel is persisted into storage.local and travels inside
      // export bundles, so it stays English on write. It is mapped to a message
      // key at render time only (details.js), never here.
      artist: artist || 'Unknown Artist',
      album: album || '',
      albumBrowseId: albumBrowseId || '',
      isSingle: Boolean(isSingle),
      videoId,
      coverUrl,
      duration: durationStr,
      durationSeconds
    };
  }

  /**
   * Normalizes strings for robust track comparison
   */
  function normalizeTrackStr(str) {
    return (str || '')
      .toLowerCase()
      .trim()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ');
  }

  /**
   * Compares two tracks for equality
   */
  function areTracksEqual(a, b) {
    if (!a || !b) return false;
    if (a.videoId && b.videoId && a.videoId === b.videoId) {
      return true;
    }
    const aTitle = normalizeTrackStr(a.title);
    const bTitle = normalizeTrackStr(b.title);
    if (!aTitle || !bTitle || aTitle !== bTitle) {
      return false;
    }
    const aArtist = normalizeTrackStr(a.artist);
    const bArtist = normalizeTrackStr(b.artist);
    if (aArtist && bArtist && aArtist !== 'unknown artist' && bArtist !== 'unknown artist') {
      return aArtist === bArtist || aArtist.includes(bArtist) || bArtist.includes(aArtist);
    }
    return true;
  }

  /**
   * Finds the index in parsedItems where the watermark sequence begins
   */
  function findWatermarkBoundary(parsedItems, watermark) {
    if (!Array.isArray(watermark) || watermark.length === 0) return -1;
    if (!Array.isArray(parsedItems) || parsedItems.length === 0) return -1;

    for (let i = 0; i < parsedItems.length; i++) {
      if (areTracksEqual(parsedItems[i].track, watermark[0])) {
        let matches = 1;
        const maxCheck = Math.min(watermark.length, 5);
        let sequenceValid = true;

        for (let w = 1; w < maxCheck; w++) {
          if (i + w < parsedItems.length) {
            if (areTracksEqual(parsedItems[i + w].track, watermark[w])) {
              matches++;
            } else {
              sequenceValid = false;
              break;
            }
          } else {
            break;
          }
        }

        const requiredMatches = Math.min(2, watermark.length);
        if (sequenceValid && matches >= requiredMatches) {
          return i;
        }
      }
    }

    return -1;
  }

  /**
   * Glyphs on the scanner overlay's buttons. Kept out of the catalog: they are
   * UI affordances, not language, and a translator should not be asked where ▶
   * belongs in a sentence.
   */
  const START_GLYPH = '▶';
  const MINIMIZE_GLYPHS = { open: '✕', minimized: '◻' };

  /**
   * Sets the scanner start button's label, keeping the leading glyph.
   *
   * @param {string} label Already-localized text; empty leaves the button alone.
   * @returns {void}
   */
  function setStartButtonLabel(label) {
    const span = document.querySelector('#ytmc-start-scan-btn span');
    if (!span || !label) return;
    span.textContent = `${START_GLYPH} ${label}`;
  }

  /**
   * Writes the overlay's status note. `value` has already been composed from
   * catalog lookups or numbers - never a remote string, and never markup.
   *
   * @param {string} value
   * @returns {void}
   */
  function setScanNote(value) {
    setText(document.getElementById('ytmc-scan-note'), value);
  }

  /**
   * Writes the "New Songs Synced" counter. Always a number.
   *
   * @param {number} value
   * @returns {void}
   */
  function setScanCount(value) {
    const countEl = document.getElementById('ytmc-scan-count');
    if (!countEl) return;
    countEl.textContent = i18n.formatNumber(Number(value) || 0);
  }

  /**
   * Keeps the minimize glyph, the close button's tooltip and the title group's
   * tooltip in step with the overlay's current state.
   *
   * Replaces three copies of the same branch that used to live in the click
   * handlers, and is also what makes the tooltips follow a locale change.
   *
   * @returns {void}
   */
  function updateMinimizeAffordances() {
    const overlay = document.getElementById('ytmc-history-scanner-overlay');
    if (!overlay) return;
    const isMinimized = overlay.classList.contains('ytmc-minimized');

    const closeBtn = overlay.querySelector('#ytmc-close-btn');
    if (closeBtn) {
      closeBtn.textContent = isMinimized ? MINIMIZE_GLYPHS.minimized : MINIMIZE_GLYPHS.open;
      closeBtn.title = localize(
        isMinimized ? 'msg_content_scanner_restore' : 'msg_content_scanner_minimize',
        isMinimized ? 'Restore window' : 'Minimize window'
      );
    }

    const titleGroup = overlay.querySelector('.ytmc-scanner-title-group');
    if (titleGroup) {
      titleGroup.title = localize('msg_content_scanner_toggle_minimize', 'Click to toggle minimize');
    }
  }

  /**
   * Applies every static string in the scanner overlay.
   *
   * Only chrome: the live status note, the play counter and the spinner are
   * scan state, not static labels, so they are left to the scan code and to
   * `composeScanStatusNote()`.
   *
   * @returns {void}
   */
  function applyScannerOverlayStrings() {
    const overlay = document.getElementById('ytmc-history-scanner-overlay');
    if (!overlay) return;

    setText(
      overlay.querySelector('.ytmc-scanner-title'),
      localize('msg_content_scanner_title', 'Listening History Sync')
    );
    setText(
      overlay.querySelector('.ytmc-metric-label'),
      localize('msg_content_scanner_metric_label', 'New Songs Synced')
    );
    setText(
      overlay.querySelector('label[for="ytmc-force-rescan-cb"]'),
      localize('msg_content_scanner_force_rescan', 'Re-scan full history from the beginning')
    );
    setStartButtonLabel(localize('msg_scanner_start_sync', 'Start Sync'));
    if (!isScanning) {
      setScanNote(localize('msg_content_scanner_ready', 'Ready to sync your listening history.'));
    }

    updateMinimizeAffordances();
  }

  /* --------------------------------------------------------------------------
     Scan progress vocabulary (AD-10)

     `scanProgress` carries machine codes, never sentences: it is persisted to
     storage.local, and a sentence written here would be re-rendered to whoever
     opens the Details page next, in whatever language that page resolves to.
     details.js maps the same codes to the same keys for the scanner panel.

     The key names below are B4's `msg_scan_*` family, shared verbatim with
     details.js: both renderers of a `scanProgress` payload must reach for the
     identical string, because the payload is a set of codes and the wording is
     decided once, at merge time. This script's own fragment (B5) therefore
     deliberately does not re-declare them.

     These objects are the SCAN_PROGRESS_STEPS / _REASONS / _ERROR_CODES
     vocabularies from background/enrichment.js AND their message mapping at
     once. This file is a classic content script with no module scope, so it
     cannot import those frozen arrays the way details.js does - but it does not
     need to: an unlisted code has no entry here, `keyForScanCode()` returns
     undefined, and nothing is rendered. The gate is the map's own key set, so
     the vocabulary is not duplicated as a second list that could drift from the
     map. Adding a code here without adding it to enrichment.js would still be a
     contract break; nothing in this file can paper over one.
     -------------------------------------------------------------------------- */

  /** `scanProgress.step` -> message key. */
  const SCAN_STEP_KEYS = {
    scanning: 'msg_scan_step_scanning',
    boundary: 'msg_scan_step_boundary',
    importing: 'msg_scan_step_importing',
    saving: 'msg_scan_step_saving',
    done: 'msg_scan_step_done',
    failed: 'msg_scan_step_failed'
  };

  /** `scanProgress.reason` -> message key. */
  const SCAN_REASON_KEYS = {
    upToDate: 'msg_scan_reason_up_to_date',
    complete: 'msg_scan_reason_complete',
    fullHistory: 'msg_scan_reason_full_history',
    endOfHistory: 'msg_scan_reason_end_of_history',
    navigatedAway: 'msg_scan_reason_navigated_away'
  };

  /** `scanProgress.errorCode` -> message key. */
  const SCAN_ERROR_KEYS = {
    untrustedSource: 'msg_scan_error_untrusted_source',
    scanFailed: 'msg_scan_error_scan_failed'
  };

  /**
   * Looks a machine code up in one of the maps above.
   *
   * `hasOwnProperty` because these are plain object literals: without it
   * `progress.step === 'constructor'` would resolve to Object's constructor and
   * be passed to `t()` as a key.
   *
   * @param {Record<string, string>} map
   * @param {any} code
   * @returns {string} '' for anything the map does not declare.
   */
  function keyForScanCode(map, code) {
    if (typeof code !== 'string' || !code) return '';
    return Object.prototype.hasOwnProperty.call(map, code) ? map[code] : '';
  }

  /**
   * Composes the overlay note from a `scanProgress` payload.
   *
   * Precedence matches details.js's `composeScanStatus()`: an error outranks a
   * reason, a reason outranks a step. Every branch is a static catalog lookup
   * keyed by a machine code, plus numbers, so there is no path by which a
   * persisted free-text string could reach the note - the problem
   * `sanitizeStatusText()` used to strip is gone at the source.
   *
   * @param {object} progress A `scanProgress` payload.
   * @returns {string} '' when the payload carries no code we can render.
   */
  function composeScanStatusNote(progress) {
    if (!progress || typeof progress !== 'object') return '';

    const errorKey = keyForScanCode(SCAN_ERROR_KEYS, progress.errorCode);
    if (errorKey) return i18n.t(errorKey);

    const reasonKey = keyForScanCode(SCAN_REASON_KEYS, progress.reason);
    if (reasonKey) return i18n.t(reasonKey);

    const stepKey = keyForScanCode(SCAN_STEP_KEYS, progress.step);
    if (!stepKey) return '';

    const processed = Number(progress.processed);
    const total = Number(progress.total);
    const hasFraction = Number.isFinite(processed) && Number.isFinite(total) && total > 0;

    return hasFraction
      ? i18n.t('msg_scan_step_progress', [i18n.t(stepKey), i18n.formatNumber(processed), i18n.formatNumber(total)])
      : i18n.t(stepKey);
  }

  function injectHistoryScannerOverlay() {
    if (document.getElementById('ytmc-history-scanner-overlay')) {
      // Already on screen. Deliberately NOT re-applying strings here: the note
      // and the start button belong to the running scan, and resetting them here
      // would report an idle scanner mid-sync. A locale change reaches the live
      // overlay through `renderLocalizedChrome()`.
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'ytmc-history-scanner-overlay';
    // I-8 audit (and the plan's condition for keeping this write): this template
    // interpolates NOTHING. Not one `${}` appears in the literal below - every
    // visible string in it is static markup, and every localized string is
    // applied afterwards through `textContent` / `.title` by
    // `applyScannerOverlayStrings()`. So no catalog value and no YouTube Music
    // value ever reaches the HTML parser from this call, which is strictly
    // stronger than the "only static t() results are interpolated" rule the plan
    // permits. The English text stays inline (AD-3) so the overlay is readable
    // before localization resolves, and `setText()` refuses to write an empty
    // value, so a missing key leaves the English in place rather than blanking it.
    overlay.innerHTML = `
      <div class="ytmc-scanner-header">
        <div class="ytmc-scanner-title-group">
          <div class="ytmc-scanner-logo">
            <svg viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
              <polygon points="10,8 16,12 10,16" fill="currentColor"/>
            </svg>
          </div>
          <span class="ytmc-scanner-title">Listening History Sync</span>
        </div>
        <div class="ytmc-scanner-controls">
          <button type="button" class="ytmc-btn-mini" id="ytmc-close-btn" title="Minimize window">✕</button>
        </div>
      </div>
      <div class="ytmc-scanner-body">
        <div class="ytmc-scanner-metrics">
          <div class="ytmc-metric-card">
            <span class="ytmc-metric-label">New Songs Synced</span>
            <span class="ytmc-metric-val" id="ytmc-scan-count">0</span>
          </div>
        </div>
        <div class="ytmc-scanner-status-box">
          <div class="ytmc-status-spinner" id="ytmc-scan-spinner"></div>
          <span id="ytmc-scan-note">Ready to sync your listening history.</span>
        </div>
        <div style="font-size: 11px; color: #888; display: flex; align-items: center; gap: 6px;">
          <input type="checkbox" id="ytmc-force-rescan-cb">
          <label for="ytmc-force-rescan-cb" style="cursor: pointer;">Re-scan full history from the beginning</label>
        </div>
        <div class="ytmc-scanner-actions">
          <button type="button" class="ytmc-btn-scan-start" id="ytmc-start-scan-btn">
            <span>&#9654; Start Sync</span>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const startBtn = overlay.querySelector('#ytmc-start-scan-btn');
    const closeBtn = overlay.querySelector('#ytmc-close-btn');

    startBtn.addEventListener('click', () => {
      const force = Boolean(overlay.querySelector('#ytmc-force-rescan-cb')?.checked);
      startHistoryScan(force);
    });

    closeBtn.addEventListener('click', () => {
      overlay.classList.toggle('ytmc-minimized');
      updateMinimizeAffordances();
    });

    const titleGroup = overlay.querySelector('.ytmc-scanner-title-group');
    if (titleGroup) {
      titleGroup.style.cursor = 'pointer';
      titleGroup.addEventListener('click', () => {
        if (overlay.classList.contains('ytmc-minimized')) {
          overlay.classList.remove('ytmc-minimized');
          updateMinimizeAffordances();
        }
      });
    }

    // Localized strings go in after the markup is in the DOM, never through the
    // template literal above.
    applyScannerOverlayStrings();

    // Two autostart paths: a query param when the launcher navigated here
    // directly, and a storage flag when YouTube's SPA swallowed the param.
    const search = window.location.search || '';

    if (search.includes('autostart=1')) {
      const force = search.includes('forceRescan=1');
      setTimeout(() => startHistoryScan(force), 1200);
    } else {
      extBrowser.storage.local.get(['pendingAutostart']).then((data) => {
        const pending = data && data.pendingAutostart;
        if (!pending) return;
        if (Date.now() - pending.time < 15000) {
          extBrowser.storage.local.remove('pendingAutostart');
          setTimeout(() => startHistoryScan(pending.forceRescan), 1200);
        }
      }).catch(() => {
        // No stored autostart request, or storage unavailable: nothing to resume.
      });
    }
  }

  async function startHistoryScan(forceRescan = false) {
    if (isScanning) return;
    isScanning = true;
    idleScrollCount = 0;
    scannedTracks = [];

    sendMessageIgnoringReply({ type: 'DEBUG_LOG', tag: 'SCANNER', message: 'startHistoryScan initiated.' });

    // Clear any previous processed markers on DOM elements
    document.querySelectorAll('[data-ytmc-processed]').forEach(el => {
      delete el.dataset.ytmcProcessed;
    });

    let isForce = forceRescan || window.location.search.includes('forceRescan=1');

    if (!isForce) {
      try {
        const syncData = await extBrowser.storage.local.get(['historySyncState', 'totalPlays', 'songs']);
        const songCount = syncData.songs ? Object.keys(syncData.songs).length : 0;
        const isStorageEmpty = (!syncData.totalPlays || syncData.totalPlays === 0) && songCount === 0;

        if (isStorageEmpty) {
          activeSyncState = null;
          isForce = true;
          sendMessageIgnoringReply({ type: 'DEBUG_LOG', tag: 'SCANNER', message: 'Storage empty, forcing full rescan.' });
        } else {
          activeSyncState = (syncData && syncData.historySyncState) || null;
        }
      } catch (err) {
        activeSyncState = null;
        sendMessageIgnoringReply({ type: 'DEBUG_LOG', tag: 'SCANNER_ERR', message: 'Error checking storage: ' + err.message });
      }
    } else {
      activeSyncState = null;
    }

    const watermark = (!isForce && activeSyncState && Array.isArray(activeSyncState.watermark))
      ? activeSyncState.watermark
      : [];

    sendMessageIgnoringReply({ type: 'DEBUG_LOG', tag: 'SCANNER', message: `Starting scan loop. Force: ${isForce}, Watermark size: ${watermark.length}` });

    const startBtn = document.getElementById('ytmc-start-scan-btn');
    const spinner = document.getElementById('ytmc-scan-spinner');

    if (startBtn) {
      startBtn.disabled = true;
      setStartButtonLabel(localize('msg_scanner_in_progress', 'Sync in Progress...'));
    }
    if (spinner) spinner.style.display = 'block';
    setScanCount(0);
    // `watermark[0].title` is a YouTube Music string, so it is composed into a
    // catalog template and written with `textContent` - it never reaches an
    // innerHTML sink (I-8).
    setScanNote(watermark.length > 0
      ? localize('msg_content_scan_checking_since', 'Checking for new plays since "..."', [watermark[0].title])
      : localize('msg_content_scan_scanning_history', 'Scanning your listening history...'));

    // `updatedAt` is what lets the Details page tell a running scan from one that
    // died with its tab: this content script is the only writer that can clear
    // `isScanning`, so without a heartbeat a scan interrupted mid-flight pinned
    // the Settings page on "Syncing in progress" permanently.
    //
    // AD-10: codes and numbers only. The two sentences this used to publish
    // ("Checking for new plays..." / "Finding plays in history...") map to
    // `scanning` and `importing` respectively - with a watermark we are walking
    // the list for new plays, without one we are harvesting a baseline to
    // import. `count`/`unique` stay as the legacy aliases details.js still
    // reads; `plays`/`uniqueSongs` are their structured equivalents.
    extBrowser.storage.local.set({
      scanProgress: {
        kind: SCAN_PROGRESS_KIND,
        isScanning: true,
        updatedAt: Date.now(),
        count: 0,
        unique: 0,
        latestTrack: null,
        step: watermark.length > 0 ? 'scanning' : 'importing',
        processed: null,
        total: null,
        plays: 0,
        uniqueSongs: 0,
        reason: null,
        errorCode: null
      }
    });

    // Guards against overlapping ticks: the body of this callback awaits storage
    // reads, so without this a slow await lets the next interval fire a second
    // full parse (and a second watermark boundary search) concurrently.
    let scanTickInFlight = false;

    scanInterval = setInterval(async () => {
      if (scanTickInFlight) return;
      scanTickInFlight = true;
      try {
      // YouTube renders the history list lazily, so an empty first tick after
      // navigation is normal.
      const itemElements = Array.from(document.querySelectorAll('ytmusic-responsive-list-item-renderer'));
      if (itemElements.length === 0) {
        return;
      }

      const parsedItems = [];
      for (const el of itemElements) {
        const track = parseTrackFromItem(el);
        if (track && track.title) {
          parsedItems.push({ element: el, track });
        }
      }

      if (parsedItems.length === 0) {
        return;
      }

      const hasWatermark = watermark.length > 0;

      // Mode A: Watermark Sequence Matching (Incremental Sync)
      if (hasWatermark) {
        const boundaryIndex = findWatermarkBoundary(parsedItems, watermark);

        if (boundaryIndex >= 0) {
          const newTracks = parsedItems.slice(0, boundaryIndex).map(p => p.track);
          // 'Already up to date' -> reason 'upToDate'; 'Sync complete' -> 'complete'.
          stopAndSaveHistory(true, boundaryIndex === 0 ? 'upToDate' : 'complete', newTracks, parsedItems);
          return;
        }

        // Boundary not found yet in currently loaded DOM items -> scroll to load more
        setScanNote(i18n.t('msg_content_scan_boundary_progress', [
          i18n.plural('msg_content_count_song', parsedItems.length)
        ]));
        const loadedUnique = new Set(parsedItems.map(p => `${p.track.title.toLowerCase()}:::${(p.track.artist || '').toLowerCase()}`)).size;
        extBrowser.storage.local.set({
          scanProgress: {
            kind: SCAN_PROGRESS_KIND,
            isScanning: true,
            updatedAt: Date.now(),
            // `count`/`unique` were the plays-since-sync tally; during the
            // boundary search nothing has been harvested yet, so both go to
            // null/0 and `processed` carries the loaded-item count instead. The
            // old record put the loaded-item count in `count`, which the Details
            // page read as "plays found" - a number that was never plays.
            count: 0,
            unique: loadedUnique,
            latestTrack: parsedItems[0].track,
            step: 'boundary',
            processed: parsedItems.length,
            total: null,
            plays: 0,
            uniqueSongs: null,
            reason: null,
            errorCode: null
          }
        });
      } else if (!isForce) {
        // Fallback for existing users without an initialized watermark
        try {
          const localData = await extBrowser.storage.local.get(['currentTrack', 'songs', 'totalPlays']);
          let fallbackBoundary = -1;

          if (localData.currentTrack && localData.currentTrack.title) {
            for (let idx = 0; idx < Math.min(parsedItems.length, 15); idx++) {
              if (areTracksEqual(parsedItems[idx].track, localData.currentTrack)) {
                fallbackBoundary = idx;
                console.log(`[YTMC Sync] Fallback: Matched currentTrack at index ${idx}`);
                break;
              }
            }
          }

          if (fallbackBoundary === -1 && localData.songs && Object.keys(localData.songs).length > 0) {
            const songsDict = localData.songs;
            for (let idx = 0; idx < Math.min(parsedItems.length, 15); idx++) {
              const item = parsedItems[idx].track;
              const key = `${(item.title || '').trim().toLowerCase()}:::${(item.artist || '').trim().toLowerCase()}`;
              if (songsDict[key] && songsDict[key].playCount > 0) {
                if (idx + 1 < parsedItems.length) {
                  const nextItem = parsedItems[idx + 1].track;
                  const nextKey = `${(nextItem.title || '').trim().toLowerCase()}:::${(nextItem.artist || '').trim().toLowerCase()}`;
                  if (songsDict[nextKey] && songsDict[nextKey].playCount > 0) {
                    fallbackBoundary = idx;
                    console.log(`[YTMC Sync] Fallback: Matched existing songs cluster starting at index ${idx}`);
                    break;
                  }
                } else {
                  fallbackBoundary = idx;
                  break;
                }
              }
            }
          }

          if (fallbackBoundary >= 0) {
            const newTracks = parsedItems.slice(0, fallbackBoundary).map(p => p.track);
            stopAndSaveHistory(true, fallbackBoundary === 0 ? 'upToDate' : 'complete', newTracks, parsedItems);
            return;
          }

        } catch (e) {
        }
      }

      // Mode B: Full Baseline Scan (First-time setup or Force Rescan)
      if (!hasWatermark) {
        for (const p of parsedItems) {
          if (p.element.dataset.ytmcProcessed) continue;
          p.element.dataset.ytmcProcessed = 'true';
          scannedTracks.push(p.track);
        }

        const uniqueCount = new Set(scannedTracks.map(track => `${track.title.toLowerCase()}:::${(track.artist || '').toLowerCase()}`)).size;
        setScanCount(scannedTracks.length);

        // "Importing history baseline (N plays)..." -> step 'importing' with the
        // harvested play count. `total` is the 200-item ceiling the scan stops at,
        // which is what makes this the one step with a real progress fraction.
        extBrowser.storage.local.set({
          scanProgress: {
            kind: SCAN_PROGRESS_KIND,
            isScanning: true,
            updatedAt: Date.now(),
            count: scannedTracks.length,
            unique: uniqueCount,
            latestTrack: scannedTracks[scannedTracks.length - 1],
            step: 'importing',
            processed: scannedTracks.length,
            total: MAX_HISTORY_SCAN_ITEMS,
            plays: scannedTracks.length,
            uniqueSongs: uniqueCount,
            reason: null,
            errorCode: null
          }
        });

        if (scannedTracks.length >= MAX_HISTORY_SCAN_ITEMS) {
          stopAndSaveHistory(true, 'fullHistory', scannedTracks, parsedItems);
          return;
        }
      }

      // Smooth scroll down to load next items
      const beforeCount = itemElements.length;
      window.scrollBy({ top: 1200, behavior: 'smooth' });
      if (document.scrollingElement) document.scrollingElement.scrollTop += 1200;
      document.querySelectorAll('ytmusic-app, #browse-page, ytmusic-browse-response, #contents, #main-panel').forEach(el => {
        if (el.scrollHeight > el.clientHeight) el.scrollTop += 1200;
      });
      if (itemElements.length > 0) {
        try {
          itemElements[itemElements.length - 1].scrollIntoView({ behavior: 'smooth', block: 'end' });
        } catch (_) {}
      }

      const currentItemElements = document.querySelectorAll('ytmusic-responsive-list-item-renderer');
      if (currentItemElements.length === beforeCount) {
        // The scroll did not make YouTube append more rows, so the end of the
        // list is (probably) reached.
        idleScrollCount++;
        if (idleScrollCount >= 4) {
          // Four scrolls with no new rows means the end of the history list.
          // Both branches walked it to the end, so both report 'endOfHistory';
          // they differed only in which array they were about to import.
          if (hasWatermark) {
            const allTracks = parsedItems.map(p => p.track);
            stopAndSaveHistory(true, 'endOfHistory', allTracks, parsedItems);
          } else {
            stopAndSaveHistory(true, 'endOfHistory', scannedTracks, parsedItems);
          }
          return;
        }
      } else {
        idleScrollCount = 0;
      }
      } finally {
        scanTickInFlight = false;
      }
    }, 650);
  }

  /**
   * Ends a scan, imports whatever it harvested, and publishes the terminal
   * progress record.
   *
   * @param {boolean} autoCompleted Unused by the body; kept for call-site intent.
   * @param {string} [reason] A `SCAN_PROGRESS_REASONS` code, NOT an English
   *   sentence (AD-10). The old signature took "Already up to date" / "Sync
   *   complete" / "Completed" / "Full history scanned" / "End of history
   *   reached" / "Navigated away from history" and this function then string-
   *   matched them with a /200/i regex to decide whether to mention the reason at
   *   all. Codes remove that whole branch.
   * @param {Array|null} newTracks
   * @param {Array|null} allParsed
   * @returns {void}
   */
  function stopAndSaveHistory(autoCompleted, reason = '', newTracks = null, allParsed = null) {
    if (!isScanning) {
      return;
    }
    isScanning = false;
    clearInterval(scanInterval);
    scanInterval = null;

    const startBtn = document.getElementById('ytmc-start-scan-btn');
    const spinner = document.getElementById('ytmc-scan-spinner');
    const note = document.getElementById('ytmc-scan-note');

    const tracksToImport = Array.isArray(newTracks) ? newTracks : scannedTracks;

    // Only a declared reason code is persisted; anything else degrades to
    // 'complete' rather than storing a string nobody can render.
    const terminalReason = keyForScanCode(SCAN_REASON_KEYS, reason) ? reason : 'complete';

    // Construct fresh watermark from top of the page
    let newWatermark = [];
    if (Array.isArray(allParsed) && allParsed.length > 0) {
      newWatermark = allParsed.slice(0, 50).map(p => ({
        title: p.track.title,
        // AD-8: 'Unknown Artist' is a persisted sentinel, not a translatable
        // label. It stays English here so a bundle written by this install reads
        // correctly in any install that imports it; the UI layer maps it to a
        // message key when it renders.
        artist: p.track.artist || 'Unknown Artist',
        album: p.track.album || '',
        videoId: p.track.videoId || ''
      }));
    } else if (tracksToImport.length > 0) {
      newWatermark = tracksToImport.slice(0, 50).map(track => ({
        title: track.title,
        artist: track.artist || 'Unknown Artist',
        album: track.album || '',
        videoId: track.videoId || ''
      }));
    } else if (activeSyncState && Array.isArray(activeSyncState.watermark)) {
      newWatermark = activeSyncState.watermark;
    }

    const topTrack = newWatermark.length > 0 ? newWatermark[0] : null;

    const newSyncState = {
      watermark: newWatermark,
      lastTrackTitle: topTrack ? topTrack.title : '',
      lastTrackArtist: topTrack ? topTrack.artist : '',
      lastSyncTimestamp: Date.now(),
      lastSyncedCount: tracksToImport.length,
      // Backward compatibility fields for legacy UI. AD-8: 'Synced' is a
      // persisted sentinel read back by the Details page and carried in export
      // bundles, so it is written in English and mapped to a message key at
      // render time there - never localized here.
      lastDateHeader: topTrack ? topTrack.title : 'Synced',
      syncedCountOnDate: tracksToImport.length
    };

    if (tracksToImport.length === 0) {
      setScanCount(0);

      // Two different situations that both mean "nothing was harvested", told
      // apart by whether a previous sync exists to be caught up with.
      setScanNote(activeSyncState
        ? localize('msg_content_scan_up_to_date', 'All caught up! No new plays found.')
        : localize('msg_content_scan_empty_history', 'No tracks found in history.'));

      const finishData = {
        scanProgress: {
          kind: SCAN_PROGRESS_KIND,
          isScanning: false,
          updatedAt: Date.now(),
          count: 0,
          unique: 0,
          latestTrack: null,
          step: 'done',
          processed: null,
          total: null,
          plays: 0,
          uniqueSongs: 0,
          // Nothing was harvested. With a watermark to compare against that is
          // literally "up to date"; without one it is an empty baseline, which
          // the reason vocabulary spells 'complete'.
          reason: activeSyncState ? 'upToDate' : terminalReason,
          errorCode: null
        }
      };

      if (activeSyncState) {
        finishData.historySyncState = newSyncState;
      }

      extBrowser.storage.local.set(finishData);

      if (startBtn) {
        startBtn.disabled = false;
        setStartButtonLabel(localize('msg_scanner_start_sync', 'Start Sync'));
      }
      if (spinner) spinner.style.display = 'none';
      return;
    }

    const uniqueSet = new Set(tracksToImport.map(track => `${track.title.toLowerCase()}:::${(track.artist || '').toLowerCase()}`));
    setScanCount(tracksToImport.length);

    setScanNote(i18n.t('msg_content_scan_saving', [i18n.plural('msg_content_count_play', tracksToImport.length)]));

    extBrowser.storage.local.set({
      scanProgress: {
        kind: SCAN_PROGRESS_KIND,
        isScanning: true,
        updatedAt: Date.now(),
        count: tracksToImport.length,
        unique: uniqueSet.size,
        latestTrack: tracksToImport[0],
        step: 'saving',
        processed: null,
        total: null,
        plays: tracksToImport.length,
        uniqueSongs: uniqueSet.size,
        reason: null,
        errorCode: null
      }
    });

    sendRuntimeMessage({
      type: 'IMPORT_HISTORY_TRACKS',
      payload: {
        tracks: tracksToImport,
        newSyncState
      }
    }).then((response) => {
      const res = response && response.data;
      const importedCount = (res && typeof res.importedCount === 'number') ? res.importedCount : tracksToImport.length;
      const uniqueCount = (res && typeof res.uniqueSongs === 'number') ? res.uniqueSongs : uniqueSet.size;
      const displayLabel = i18n.plural('msg_content_count_new_play', importedCount);

      setScanCount(importedCount);

      // Built from DOM nodes, never innerHTML: "Success!" is bolded, and both
      // halves come from the catalog while the play count comes from a
      // plural()-resolved catalog phrase.
      if (note) {
        note.textContent = '';
        const boldNode = document.createElement('b');
        boldNode.textContent = localize('msg_content_scan_success', 'Success!');
        note.appendChild(boldNode);
        // 'complete' needs no trailing clause - "Sync finished. Synced 12 new
        // plays." reads as two statements about the same event. Every other
        // reason says something the play count cannot: the history limit, the end
        // of the list, leaving the page mid-sync.
        const sentence = terminalReason === 'complete'
          ? localize('msg_content_scan_synced', 'Synced $1.', [displayLabel])
          : localize(
            'msg_content_scan_synced_reason',
            'Synced $1. $2',
            [displayLabel, i18n.t(SCAN_REASON_KEYS[terminalReason])]
          );
        note.appendChild(document.createTextNode(` ${sentence}`));
      }

      extBrowser.storage.local.set({
        scanProgress: {
          kind: SCAN_PROGRESS_KIND,
          isScanning: false,
          updatedAt: Date.now(),
          count: importedCount,
          unique: uniqueCount,
          latestTrack: null,
          step: 'done',
          processed: null,
          total: null,
          plays: importedCount,
          uniqueSongs: uniqueCount,
          reason: terminalReason,
          errorCode: null
        },
        historySyncState: newSyncState
      });

      const startBtn = document.getElementById('ytmc-start-scan-btn');
      const spinner = document.getElementById('ytmc-scan-spinner');
      if (startBtn) {
        startBtn.disabled = false;
        setStartButtonLabel(localize('msg_scanner_start_sync', 'Start Sync'));
      }
      if (spinner) spinner.style.display = 'none';
    }).catch((err) => {
      const failureText = (err && err.message) ? err.message : String(err);
      sendMessageIgnoringReply({
        type: 'DEBUG_LOG',
        tag: 'SCANNER_ERR',
        message: 'History import failed: ' + failureText
      });
      // The underlying message reaches the note (and the debug log) as plain
      // text. The PERSISTED record gets a code instead: a service worker error
      // string is not a fixed English sentence, and storing it would put an
      // untranslatable value into storage.local (AD-10).
      setScanNote(i18n.t('msg_content_scan_failed', [failureText]));
      setScanCount(0);
      if (startBtn) startBtn.disabled = false;
      if (spinner) spinner.style.display = 'none';

      // New: the import failing used to leave `scanProgress.isScanning: true`
      // behind forever, because only the `saving` write above had set it and
      // nothing cleared it on this path - the Details page then reported
      // "Syncing in progress" for a scan that had already died. This is also
      // the only producer of errorCode 'scanFailed' in the codebase.
      extBrowser.storage.local.set({
        scanProgress: {
          kind: SCAN_PROGRESS_KIND,
          isScanning: false,
          updatedAt: Date.now(),
          count: 0,
          unique: 0,
          latestTrack: null,
          step: 'failed',
          processed: null,
          total: null,
          plays: null,
          uniqueSongs: null,
          reason: null,
          errorCode: 'scanFailed'
        }
      });
    });
  }

  let harvestTimeout = null;
  let harvestDone = false;

  async function harvestHistoryCovers() {
    if (!isHistoryPage()) return;
    if (harvestDone) return;
    try {
      const items = Array.from(document.querySelectorAll('ytmusic-responsive-list-item-renderer'));
      if (items.length === 0) return;

      const data = await extBrowser.storage.local.get(['albums']);
      const albums = data.albums || {};
      const missingKeys = new Set(
        Object.keys(albums).filter(k => !albums[k].coverUrl)
      );
      // Nothing left to find: stop re-parsing up to 200 DOM items (and re-reading
      // the whole albums dictionary) every 1.5s for the rest of the visit.
      if (missingKeys.size === 0) {
        harvestDone = true;
        return;
      }

      const coversToBackfill = [];
      const seen = new Set();

      for (const item of items) {
        const parsed = parseTrackFromItem(item);
        if (!parsed || !parsed.album || !parsed.coverUrl) continue;
        const key = globalThis.YTMCShared.makeAlbumKey(parsed.album, parsed.artist);
        if (missingKeys.has(key) && !seen.has(key)) {
          seen.add(key);
          coversToBackfill.push({
            album: parsed.album,
            artist: parsed.artist,
            coverUrl: parsed.coverUrl,
            albumBrowseId: parsed.albumBrowseId || ''
          });
        }
      }

      if (coversToBackfill.length > 0) {
        sendRuntimeMessage({
          type: 'BACKFILL_ALBUM_COVERS',
          payload: { covers: coversToBackfill }
        }).then((res) => {
          if (res && res.status === 'ok' && res.data && res.data.updated > 0) {
            console.log(`[YTMC Content] Successfully backfilled ${res.data.updated} album covers from history page.`);
          }
        }).catch(() => {
          // Backfill is opportunistic; a failure here must not stop the harvest.
        });
      }
    } catch (_) {}
  }

  function scheduleHarvestHistoryCovers() {
    if (!isHistoryPage()) return;
    if (harvestTimeout) clearTimeout(harvestTimeout);
    harvestTimeout = setTimeout(harvestHistoryCovers, 1500);
  }

  function checkHistoryRoute() {
    if (isHistoryPage()) {
      injectHistoryScannerOverlay();
      scheduleHarvestHistoryCovers();
    } else {
      if (isScanning) {
        stopAndSaveHistory(false, 'navigatedAway');
      }
      // Leaving the history page means new albums can appear again later.
      harvestDone = false;
      const existing = document.getElementById('ytmc-history-scanner-overlay');
      if (existing) {
        existing.remove();
      }
    }
  }

  let lastCheckedHref = '';
  function handleRouteChange() {
    if (window.location.href !== lastCheckedHref) {
      lastCheckedHref = window.location.href;
      checkHistoryRoute();
    }
  }

  // Track-change work is coalesced to one run per animation frame. The player bar
  // subtree mutates constantly (progress bar ticks, artwork swaps), and every
  // mutation used to trigger a full getCurrentTrackInfo() scrape of ~10 selectors.
  let trackChangeQueued = false;
  function scheduleTrackChange() {
    if (trackChangeQueued) return;
    trackChangeQueued = true;
    const run = () => {
      trackChangeQueued = false;
      checkTrackChange();
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(run);
    } else {
      setTimeout(run, 50);
    }
  }

  // Only the player bar is observed. Falling back to document.body with
  // `subtree: true` made every mutation anywhere on the page (virtual scrolling
  // through 200 history rows, animations) re-scrape the player bar.
  const playerBarObserver = new MutationObserver(scheduleTrackChange);

  function observePlayerBar() {
    const playerBar = document.querySelector('ytmusic-player-bar');
    if (!playerBar) return false;
    playerBarObserver.observe(playerBar, { childList: true, subtree: true, characterData: true });
    return true;
  }

  // Lightweight fallback: watch the body's direct children only, so the player bar
  // can be picked up when YouTube Music mounts it late, without subscribing to the
  // whole document.
  const bodyObserver = new MutationObserver(() => {
    if (observePlayerBar()) {
      bodyObserver.disconnect();
      return;
    }
    handleRouteChange();
  });

  // Route and page change observers
  window.addEventListener('yt-navigate-start', handleRouteChange);
  window.addEventListener('yt-navigate-finish', handleRouteChange);
  window.addEventListener('yt-page-data-updated', handleRouteChange);
  window.addEventListener('popstate', handleRouteChange);
  window.addEventListener('hashchange', handleRouteChange);

  // Last-resort poll for SPA navigations that fire no event. 1500ms instead of
  // 500ms: handleRouteChange is a no-op unless the href actually changed.
  setInterval(handleRouteChange, 1500);

  // Runtime message listener
  extBrowser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;

    if (message.type === 'PING_CONTENT_SCRIPT') {
      const items = document.querySelectorAll('ytmusic-responsive-list-item-renderer');
      console.log('[YTMC Content] Received PING_CONTENT_SCRIPT. URL:', window.location.href);
      sendResponse({
        status: 'ok',
        url: window.location.href,
        isHistory: isHistoryPage(),
        itemsCount: items.length,
        isScanning: isScanning,
        scannedCount: scannedTracks.length
      });
      return true;
    }

    if (message.type === 'START_HISTORY_SCAN') {
      const forceRescan = Boolean(message.forceRescan);
      if (!isHistoryPage()) {
        extBrowser.storage.local.set({ pendingAutostart: { time: Date.now(), forceRescan } });
        window.location.href = YOUTUBE_MUSIC_HISTORY_URL;
      } else {
        injectHistoryScannerOverlay();
        startHistoryScan(forceRescan);
      }
      sendResponse({ status: 'ok' });
      return true;
    }

    // Same-origin proxy for album tracklist downloads.
    // Firefox attaches an `Origin: moz-extension://<uuid>` header to cross-origin
    // POSTs issued from the background service worker, which YouTube Music answers
    // with HTTP 403. Running the request here, inside the music.youtube.com page
    // origin, makes it a plain same-origin call that returns HTTP 200.
    if (message.type === 'FETCH_ALBUM_TRACKLIST') {
      const browseId = message.browseId;
      if (!browseId) {
        sendResponse({ status: 'error', error: 'Missing browseId' });
        return true;
      }
      fetchAlbumTracklistViaContentScript(browseId)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ status: 'error', error: (err && err.message) || String(err) }));
      return true;
    }
  });

  /**
   * Performs the `youtubei/v1/browse` POST from the page origin and parses the
   * response into `{ totalTracks, trackTitles, coverUrl }`.
   *
   * Two things make this succeed where the service worker cannot:
   *  1. The request is same-origin, so Firefox does not attach the
   *     `Origin: moz-extension://<uuid>` header that YouTube answers with 403.
   *  2. The page's live InnerTube context (current `clientVersion`, visitor data,
   *     hl/gl) is reused. Newer browse ID namespaces such as `MPREb_` are
   *     rejected with HTTP 400 when requested with a stale hardcoded version.
   *
   * @param {string} browseId Raw browse ID; normalization happens here so the
   *                          background can pass the stored value verbatim.
   * @returns {Promise<{status: string, data?: object, httpStatus?: number, rateLimited?: boolean, error?: string, usedPageContext?: boolean, bodyExcerpt?: string}>}
   */
  async function fetchAlbumTracklistViaContentScript(browseId) {
    const shared = globalThis.YTMCShared;
    if (!shared || typeof shared.extractTrackTitlesFromBrowse !== 'function') {
      return { status: 'error', error: 'Shared browse parser unavailable in content script' };
    }

    const cleanId = browseId.startsWith('VL')
      ? browseId
      : (browseId.startsWith('OLAK5uy') ? `VL${browseId}` : browseId);

    // `getPageInnerTubeContext` only resolves in Firefox: Chrome's isolated world
    // cannot see the page's `ytcfg` expando, so we go through the MAIN-world
    // bridge (shared/page-context.js) over postMessage. Both paths are wrapped so
    // a missing bridge degrades to the stale WEB_REMIX fallback instead of throwing.
    let pageContext = null;
    try {
      if (typeof shared.resolvePageInnerTubeContext === 'function') {
        pageContext = await shared.resolvePageInnerTubeContext();
      } else if (typeof shared.getPageInnerTubeContext === 'function') {
        pageContext = shared.getPageInnerTubeContext();
      }
    } catch (_) {
      pageContext = null;
    }

    let res;
    try {
      res = await fetch('https://music.youtube.com/youtubei/v1/browse?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(shared.buildBrowseRequestBody(cleanId, pageContext)),
        credentials: 'same-origin'
      });
    } catch (err) {
      return {
        status: 'error',
        error: `Network error while browsing ${cleanId}: ${(err && err.message) || err}`,
        usedPageContext: Boolean(pageContext)
      };
    }

    if (!res.ok) {
      // Read the body: YouTube puts the actual reason there ("Precondition check
      // failed", "Malformed request", ...), which the status code alone never says.
      let bodyExcerpt = '';
      try {
        bodyExcerpt = (await res.text()).slice(0, 300);
      } catch (_) {}

      const reason = extractBrowseErrorReason(bodyExcerpt);
      console.warn('[YTMC Content] Album browse failed', res.status, 'for', cleanId, bodyExcerpt);
      return {
        status: 'error',
        httpStatus: res.status,
        rateLimited: res.status === 429 || res.status === 403,
        usedPageContext: Boolean(pageContext),
        error: `HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''} from youtubei/v1/browse` +
               (reason ? ` - ${reason}` : '') +
               ` (context: ${pageContext ? 'live page ytcfg' : 'stale WEB_REMIX fallback'})`,
        bodyExcerpt
      };
    }

    let json;
    try {
      json = await res.json();
    } catch (err) {
      return { status: 'error', httpStatus: res.status, error: `Malformed JSON in browse response: ${(err && err.message) || err}` };
    }

    const trackTitles = shared.extractTrackTitlesFromBrowse(json.contents);
    const coverUrl = shared.findBestThumbnail(json);

    if (trackTitles.length === 0 && !coverUrl) {
      // A 200 with an empty shell usually means the ID resolved to a page we do
      // not understand (e.g. a library shelf rather than a real album).
      return {
        status: 'empty',
        usedPageContext: Boolean(pageContext),
        error: `HTTP 200 but no tracks or artwork for ${cleanId} (browseIdType: ${describeBrowseId(cleanId)})`
      };
    }

    return {
      status: 'ok',
      usedPageContext: Boolean(pageContext),
      data: { totalTracks: trackTitles.length || null, trackTitles, coverUrl }
    };
  }

  /**
   * Pulls the human-readable reason out of a YouTube InnerTube error body.
   * @param {string} body
   * @returns {string}
   */
  function extractBrowseErrorReason(body) {
    if (!body) return '';
    try {
      const parsed = JSON.parse(body);
      const err = parsed && parsed.error;
      if (!err) return body.slice(0, 160);
      const parts = [];
      if (err.status) parts.push(err.status);
      if (err.message) parts.push(err.message);
      if (Array.isArray(err.errors) && err.errors.length > 0) {
        for (const e of err.errors) {
          if (e && e.reason && parts.indexOf(e.reason) === -1) parts.push(e.reason);
        }
      }
      return parts.join(' | ') || err.status || err.message || body.slice(0, 160);
    } catch (_) {
      return String(body).slice(0, 160);
    }
  }

  /**
   * Classifies a browse ID so "no tracks" can be told apart from "wrong kind of ID".
   * @param {string} id
   * @returns {string}
   */
  function describeBrowseId(id) {
    if (!id) return 'empty';
    if (id.startsWith('OLAK5uy')) return 'auto-generated album playlist';
    if (id.startsWith('VLPL')) return 'user playlist';
    if (id.startsWith('MPREb_')) return 'library album page (MPREb_)';
    if (id.startsWith('VL')) return 'playlist';
    return 'unknown';
  }

  // Live sync with storage changes (e.g. after history sync or background play updates)
  if (extBrowser.storage && extBrowser.storage.onChanged) {
    extBrowser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local') {
        if (changes.songs) {
          const track = getCurrentTrackInfo();
          if (track && track.title) {
            // AD-8: the sentinel is the storage dictionary's key, so it is matched in
            // English and stays English. Nothing user-facing is produced from it
            // here.
            const key = globalThis.YTMCShared.makeSongKey(track.title, track.artist || 'Unknown Artist');
            const updatedSongs = changes.songs.newValue || {};
            if (updatedSongs[key] && typeof updatedSongs[key].playCount === 'number') {
              currentSongPlays = updatedSongs[key].playCount;
              updateSongBadge(currentSongPlays, true);
            }
          }
        }
        
        if (changes.scanProgress && changes.scanProgress.newValue) {
          // The record carries machine codes, so the note is composed here from
          // catalog lookups keyed by those codes plus numbers. This is what the
          // old `progress.statusText` assignment was doing by copying a
          // persisted English sentence straight onto the page (AD-10).
          const progress = changes.scanProgress.newValue;
          const note = document.getElementById('ytmc-scan-note');
          if (note && progress.kind !== ENRICHMENT_PROGRESS_KIND) {
            setScanNote(composeScanStatusNote(progress));
          }
        }
      }
    });
  }

  function init() {
    if (!observePlayerBar()) {
      // Player bar not mounted yet: watch the body's direct children for it.
      if (document.body) bodyObserver.observe(document.body, { childList: true });
    }
    // Started first and awaited nowhere: the badge and the overlay render from
    // whatever `YTMCI18n` can answer synchronously and re-render when an override
    // catalog arrives. Neither ever waits on a message round-trip.
    initLocalization();
    checkTrackChange();
    checkHistoryRoute();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

