/**
 * JAMt - Details & Config Script
 * Handles real-time statistics display, tab navigation,
 * and a 3-step confirmation flow for erasing all extension data.
 */

// I-1: shared/i18n.js is a side-effect import and MUST stay above the messaging
// import, which is what keeps the literal `YTMCMessaging` on this file.
import '../shared/i18n.js';
import { createMatchIndex, matchTrackPlayCountWithIndex } from '../background/scoring.js';
import {
  ENRICHMENT_PROGRESS_KIND,
  isStaleScanProgress,
  SCAN_PROGRESS_STEPS,
  SCAN_PROGRESS_REASONS,
  SCAN_PROGRESS_ERROR_CODES
} from '../background/enrichment.js';
import { makeAlbumKey } from '../background/storage.js';
import { thumbnailCache } from '../background/thumbnails.js';
import '../shared/messaging.js';

const extBrowser = typeof browser !== 'undefined' ? browser : chrome;

const { sendRuntimeMessage, sendTabMessage } = globalThis.YTMCMessaging;

/**
 * Localization runtime.
 *
 * The side-effect import above has already run by the time this module body is
 * evaluated, so the global is guaranteed to exist here. The helpers are pulled
 * out once because they are closures over the *mutable* resolved locale inside
 * shared/i18n.js - destructuring them keeps every call site reading naturally
 * without ever caching a stale locale.
 */
const YTMCI18n = globalThis.YTMCI18n;
const { t, plural, formatNumber, formatBytes, formatDuration, displayArtist } = YTMCI18n;

const YOUTUBE_MUSIC_HISTORY_URL = 'https://music.youtube.com/history';

const ABOUT_CONTACT_EMAIL = 'm4ikh@proton.me';
const ABOUT_REPO_FALLBACK_URL = 'https://github.com/r4pture-Maik/ytmusic-counter';

// DOM Elements Cache
const elements = {
  // Navigation
  tabBtnDetails: document.getElementById('tabBtnDetails'),
  tabBtnConfig: document.getElementById('tabBtnConfig'),
  detailsPanel: document.getElementById('detailsPanel'),
  configPanel: document.getElementById('configPanel'),
  tabBtnAbout: document.getElementById('tabBtnAbout'),
  aboutPanel: document.getElementById('aboutPanel'),

  // About Panel
  aboutVersion: document.getElementById('aboutVersion'),
  aboutChangelogVersion: document.getElementById('aboutChangelogVersion'),
  aboutEmailLink: document.getElementById('aboutEmailLink'),
  aboutEmailValue: document.getElementById('aboutEmailValue'),
  aboutIssuesLink: document.getElementById('aboutIssuesLink'),
  aboutRepoLink: document.getElementById('aboutRepoLink'),

  // Stats in Details Panel
  totalSongsListened: document.getElementById('totalSongsListened'),
  uniqueSongsStat: document.getElementById('uniqueSongsStat'),
  totalTimeStat: document.getElementById('totalTimeStat'),
  uniqueArtistsStat: document.getElementById('uniqueArtistsStat'),
  trackedAlbumsStat: document.getElementById('trackedAlbumsStat'),
  singlesStat: document.getElementById('singlesStat'),
  completedAlbumsStat: document.getElementById('completedAlbumsStat'),
  refreshAlbumsBreakdownBtn: document.getElementById('refreshAlbumsBreakdownBtn'),
  albumsBreakdownList: document.getElementById('albumsBreakdownList'),
  toggleAllAlbumsBtn: document.getElementById('toggleAllAlbumsBtn'),
  toggleAllAlbumsText: document.getElementById('toggleAllAlbumsText'),
  albumsSectionSubtext: document.getElementById('albumsSectionSubtext'),

  // Cover Art & Media Cache Elements
  thumbnailCacheStatsBadge: document.getElementById('thumbnailCacheStatsBadge'),
  thumbnailCacheCount: document.getElementById('thumbnailCacheCount'),
  thumbnailCacheSize: document.getElementById('thumbnailCacheSize'),
  refreshThumbnailCacheStatsBtn: document.getElementById('refreshThumbnailCacheStatsBtn'),
  clearThumbnailCacheBtn: document.getElementById('clearThumbnailCacheBtn'),
  thumbnailCacheOpMessage: document.getElementById('thumbnailCacheOpMessage'),

  // Data Backup & Portability
  exportLibraryJsonBtn: document.getElementById('exportLibraryJsonBtn'),
  importLibraryJsonInput: document.getElementById('importLibraryJsonInput'),
  importExportStatusMessage: document.getElementById('importExportStatusMessage'),

  // In-app language override (AD-4 / AD-9). The <select> markup lives in
  // details.html; only the option list and the change handler are built here.
  languageSelect: document.getElementById('languageSelect'),

  // 3-Step Wipe Container & Views
  wipeStep0: document.getElementById('wipeStep0'),
  wipeStep1: document.getElementById('wipeStep1'),
  wipeStep2: document.getElementById('wipeStep2'),
  wipeStep3: document.getElementById('wipeStep3'),

  // Wipe Buttons
  initiateDeleteBtn: document.getElementById('initiateDeleteBtn'),
  cancelStep1Btn: document.getElementById('cancelStep1Btn'),
  confirmStep1Btn: document.getElementById('confirmStep1Btn'),
  cancelStep2Btn: document.getElementById('cancelStep2Btn'),
  confirmStep2Btn: document.getElementById('confirmStep2Btn'),
  cancelStep3Btn: document.getElementById('cancelStep3Btn'),
  confirmStep3Btn: document.getElementById('confirmStep3Btn'),

  // Success Feedback
  deleteSuccessAlert: document.getElementById('deleteSuccessAlert'),

  // History Scanner Launcher & Live Feedback
  launchHistoryScannerBtn: document.getElementById('launchHistoryScannerBtn'),
  scannerLivePanel: document.getElementById('scannerLivePanel'),
  scannerConfigSpinner: document.getElementById('scannerConfigSpinner'),
  scannerLiveBadge: document.getElementById('scannerLiveBadge'),
  scannerLiveCounts: document.getElementById('scannerLiveCounts'),
  scannerImportingTrack: document.getElementById('scannerImportingTrack'),
  historySyncPill: document.getElementById('historySyncPill'),
  historySyncDot: document.getElementById('historySyncDot'),
  historySyncText: document.getElementById('historySyncText'),

  // Diagnostics & Debug Elements
  toggleDebugOptions: document.getElementById('toggleDebugOptions'),
  debugSection: document.getElementById('debugSection'),
  debugPingBtn: document.getElementById('debugPingBtn'),
  debugCheckStorageBtn: document.getElementById('debugCheckStorageBtn'),
  debugResetSyncBtn: document.getElementById('debugResetSyncBtn'),
  debugClearLogsBtn: document.getElementById('debugClearLogsBtn'),
  debugTabStatus: document.getElementById('debugTabStatus'),
  debugStorageStatus: document.getElementById('debugStorageStatus'),
  debugSyncBoundaryStatus: document.getElementById('debugSyncBoundaryStatus'),
  debugScanStatus: document.getElementById('debugScanStatus'),
  enrichmentStatusTag: document.getElementById('enrichmentStatusTag'),
  enrichmentMinTracksInput: document.getElementById('enrichmentMinTracksInput'),
  fetchMissingTracklistsBtn: document.getElementById('fetchMissingTracklistsBtn'),
  debugConsole: document.getElementById('debugConsole')
};

// State for Album Display (Top 3 vs All)
let showingAllAlbums = false;
let currentTopAlbums = [];
let currentAllAlbums = [];

/* ==========================================================================
   Tab Navigation
   ========================================================================== */
function setupTabs() {
  const tabs = [
    { btn: elements.tabBtnDetails, panel: elements.detailsPanel },
    { btn: elements.tabBtnConfig, panel: elements.configPanel },
    { btn: elements.tabBtnAbout, panel: elements.aboutPanel }
  ];

  tabs.forEach(({ btn, panel }) => {
    if (!btn || !panel) return;
    btn.addEventListener('click', () => {
      tabs.forEach((tab) => {
        tab.btn.classList.remove('active');
        tab.btn.setAttribute('aria-selected', 'false');
        tab.panel.classList.remove('active');
      });

      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      panel.classList.add('active');
    });
  });
}

/* ==========================================================================
   In-App Language Override (AD-4 / AD-9)
   ========================================================================== */

/**
 * Wires the language picker's change handler and reflects the stored override.
 *
 * details.html ships one <option> per supported locale (endonyms, never run
 * through the catalog) plus the follow-the-browser option, so nothing is built
 * here. Idempotent: the change listener is attached once.
 *
 * @returns {void}
 */
function setupLanguageSelect() {
  const select = elements.languageSelect;
  if (!select) return;

  syncLanguageSelect();

  if (select.dataset.languageListenerBound === 'true') return;
  select.dataset.languageListenerBound = 'true';
  select.addEventListener('change', () => {
    // A1's setLocale() REJECTS on unsupported input rather than coercing it, so
    // this catch is load-bearing: an unhandled rejection here would surface as
    // an uncaught promise rejection with the picker left showing a language the
    // page is not actually rendering in.
    YTMCI18n.setLocale(select.value).then(() => {
      // Nothing to do: shared/i18n.js has already notified subscribers and
      // re-run localizeDocument(). The re-render handler below does the rest.
    }).catch((err) => {
      console.warn('[Details] Could not apply the language override:', err);
      // Put the control back in sync with the locale actually in force.
      syncLanguageSelect();
    });
  });
}

/** Reflects the stored override in the picker; no override means "follow browser". */
function syncLanguageSelect() {
  const select = elements.languageSelect;
  if (!select) return;
  const override = YTMCI18n.getOverride();
  const supported = YTMCI18n.SUPPORTED_LOCALES.indexOf(override) !== -1;
  select.value = supported ? override : '';
}

/* ==========================================================================
   About Panel
   ========================================================================== */
function setupAboutPanel() {
  // The manifest is the single source of truth for the version, so the About
  // page can never drift out of sync with what actually shipped.
  const manifest = extBrowser.runtime?.getManifest?.();
  const version = manifest?.version;
  if (version) {
    if (elements.aboutVersion) elements.aboutVersion.textContent = version;
    if (elements.aboutChangelogVersion) elements.aboutChangelogVersion.textContent = version;
  }

  const repoUrl = manifest?.homepage_url || ABOUT_REPO_FALLBACK_URL;
  // Strip a trailing slash and any trailing "#readme" so the issues URL is clean.
  const repoBase = repoUrl.replace(/\/+$/, '').replace(/#.*$/, '');

  if (elements.aboutRepoLink) elements.aboutRepoLink.href = repoBase;
  if (elements.aboutIssuesLink) elements.aboutIssuesLink.href = `${repoBase}/issues`;

  if (elements.aboutEmailLink) {
    elements.aboutEmailLink.href = `mailto:${ABOUT_CONTACT_EMAIL}`;
    elements.aboutEmailLink.removeAttribute('target');
  }
  if (elements.aboutEmailValue) elements.aboutEmailValue.textContent = ABOUT_CONTACT_EMAIL;
}

/* ==========================================================================
   Statistics Retrieval & Rendering
   ========================================================================== */
let loadStatsTimeout = null;
function loadStatsDebounced(delay = 200) {
  if (loadStatsTimeout) clearTimeout(loadStatsTimeout);
  loadStatsTimeout = setTimeout(() => {
    loadStatsTimeout = null;
    loadStats();
  }, delay);
}

async function loadStats() {
  try {
    const response = await sendRuntimeMessage({ type: 'GET_STATS' });
    if (response && response.status === 'ok') {
      renderStats(response.data);
    } else {
      fetchStatsDirectlyFromStorage();
    }
  } catch (err) {
    console.error('[Details] Error requesting stats:', err);
    fetchStatsDirectlyFromStorage();
  }
}

// Fallback to direct storage access if background messaging fails
async function fetchStatsDirectlyFromStorage() {
  try {
    const data = await extBrowser.storage.local.get(['totalPlays', 'songs', 'artists', 'albums', 'currentTrack']);
    const songs = data.songs || {};
    const artists = data.artists || {};
    const rawAlbums = data.albums || {};

    const cleanedAlbums = {};
    for (const [key, val] of Object.entries(rawAlbums)) {
      if (val && val.album && val.album.toLowerCase() !== 'single' && val.album.toLowerCase() !== 'ep' && !key.startsWith('single:::')) {
        cleanedAlbums[key] = val;
      }
    }
    const singlesCount = Object.values(songs).filter(s => s.isSingle || !s.album).length;
    const completedAlbumsCount = Object.values(cleanedAlbums).reduce(
      (sum, a) => sum + (a.completePlays || 0),
      0
    );

    const sortedAlbums = Object.values(cleanedAlbums)
      .sort((a, b) => ((b.completePlays || 0) * 100 + (b.playCount || 0)) - ((a.completePlays || 0) * 100 + (a.playCount || 0)));

    const compiledStats = {
      totalPlays: data.totalPlays || 0,
      uniqueSongsCount: Object.keys(songs).length,
      uniqueArtistsCount: Object.keys(artists).length,
      uniqueAlbumsCount: Object.keys(cleanedAlbums).length,
      singlesCount,
      completedAlbumsCount,
      topAlbums: sortedAlbums.slice(0, 3),
      allAlbums: sortedAlbums,
      currentTrack: data.currentTrack || null
    };
    renderStats(compiledStats);
  } catch (storageErr) {
    console.error('[Details] Storage fallback error:', storageErr);
  }
}

/** Last stats payload rendered, so a locale switch can re-format it without a reload. */
let lastRenderedStats = null;

function renderStats(stats) {
  if (!stats) return;
  lastRenderedStats = stats;

  // Numbers, durations and byte sizes are formatted in the UI (not the
  // background) so they follow the active locale, including the override.

  // Primary Row: Total Songs Listened
  if (elements.totalSongsListened) {
    const formattedCount = formatNumber(stats.totalPlays || 0);
    const prev = elements.totalSongsListened.textContent;
    if (prev !== formattedCount) {
      elements.totalSongsListened.textContent = formattedCount;
      elements.totalSongsListened.classList.add('bump');
      setTimeout(() => elements.totalSongsListened.classList.remove('bump'), 250);
    }
  }

  // Supporting metrics
  if (elements.uniqueSongsStat) {
    elements.uniqueSongsStat.textContent = formatNumber(stats.uniqueSongsCount || 0);
  }
  if (elements.totalTimeStat) {
    // The background ships raw `totalListeningSeconds`; missing seconds (e.g.
    // the storage-fallback path) render as "0 min".
    elements.totalTimeStat.textContent = formatDuration(stats.totalListeningSeconds || 0);
  }
  if (elements.uniqueArtistsStat) {
    elements.uniqueArtistsStat.textContent = formatNumber(stats.uniqueArtistsCount || 0);
  }
  if (elements.trackedAlbumsStat) {
    elements.trackedAlbumsStat.textContent = formatNumber(stats.uniqueAlbumsCount || 0);
  }
  if (elements.singlesStat) {
    elements.singlesStat.textContent = formatNumber(stats.singlesCount || 0);
  }
  if (elements.completedAlbumsStat) {
    elements.completedAlbumsStat.textContent = formatNumber(stats.completedAlbumsCount || 0);
  }

  // Render Albums Breakdown List
  currentTopAlbums = (stats.topAlbums || []).slice(0, 3);
  currentAllAlbums = (stats.allAlbums || stats.topAlbums || []);
  renderAlbumsBreakdown();
}

function computeAlbumStatusText(album, uniqueTracks, completePlays) {
  const effectivePlays = completePlays || 0;
  if (effectivePlays > 0) {
    let nextProgress = 0;
    if (album.allTracks && album.totalTracks) {
      const matchIndex = createMatchIndex(album.tracksListened);
      for (const trackTitle of album.allTracks) {
        if (matchTrackPlayCountWithIndex(trackTitle, matchIndex) > effectivePlays) nextProgress++;
      }
    }
    if (nextProgress > 0 && album.totalTracks) {
      // One message, not two joined by a separator: "Next:" and the bullet are
      // both part of the sentence, and word order is not the same in every
      // locale.
      return t('msg_album_status_completed_next', [effectivePlays, nextProgress, album.totalTracks]);
    }
    return t('msg_album_status_completed', [effectivePlays]);
  }
  if (album.totalTracks) {
    const percent = Math.round((uniqueTracks / album.totalTracks) * 100);
    return t('msg_album_status_progress', [uniqueTracks, album.totalTracks, percent]);
  }
  return plural('msg_album_status_played_songs', uniqueTracks);
}

/**
 * Artist text for an album card: the part before any "•" separator, with the
 * stored 'Unknown Artist' sentinel shown in the user's language. A missing
 * artist stays empty so no subtitle is rendered.
 */
function cleanAlbumArtist(artist) {
  const name = (artist || '').split('•')[0].trim();
  return name ? displayArtist(name) : '';
}

function updateCardInPlace(card, album) {
  // Only ever called for a card already showing this exact albumKey, so the
  // existing card can be reused and just refreshed in place.
  card._albumData = album;
  const uniqueTracks = album.uniqueTracksCount || (album.tracksListened ? Object.keys(album.tracksListened).length : 1);
  const completePlays = album.completePlays || 0;
  const isCompleted = Boolean(completePlays > 0);
  const statusText = computeAlbumStatusText(album, uniqueTracks, completePlays);

  const cleanArtistName = cleanAlbumArtist(album.artist);
  const hasDistinctArtist = cleanArtistName && cleanArtistName.toLowerCase() !== (album.album || '').toLowerCase();
  // No escaping needed: this is written through textContent below, where the
  // browser escapes by construction. Escaping here would show "&amp;" literally.
  const artistSubtitle = hasDistinctArtist ? `${cleanArtistName} • ` : '';

  // Update status pill
  const pill = card.querySelector('.album-status-pill');
  if (pill) {
    pill.textContent = statusText;
    if (isCompleted) {
      pill.classList.add('completed');
    } else {
      pill.classList.remove('completed');
    }
  }

  // Update artist and plays count
  const artistEl = card.querySelector('.album-artist');
  if (artistEl) {
    artistEl.textContent = `${artistSubtitle}${plural('msg_album_total_plays', Number(album.playCount) || 0)}`;
  }

  // Update the toggle label too. The expansion state is local DOM state that
  // loadStats() never touches, so without this a locale switch would leave
  // every already-expanded card reading "View Tracks" in the old language.
  const toggleBtn = card.querySelector('.btn-toggle-album-tracks');
  if (toggleBtn) {
    const expandedSection = card.querySelector('.album-card-expanded');
    const isExpanded = Boolean(expandedSection && expandedSection.classList.contains('active'));
    toggleBtn.textContent = isExpanded ? t('msg_album_hide_tracks') : t('msg_album_view_tracks');
  }

  // Update completion star & badge
  const container = card.querySelector('.album-artwork-container');
  if (container) {
    let star = container.querySelector('.album-cover-star');
    if (isCompleted && !star) {
      star = document.createElement('span');
      star.className = 'album-cover-star';
      star.textContent = '★';
      container.appendChild(star);
    } else if (!isCompleted && star) {
      star.remove();
    }
    // Set every time, not just on creation: `title` is translatable and a
    // re-render in a new locale must not keep the old one.
    if (isCompleted && star) {
      star.title = t('msg_album_completed_title');
    }

    const badge = container.querySelector('.album-icon-badge');
    if (badge) {
      if (isCompleted) {
        badge.classList.add('completed');
        badge.textContent = '★';
      } else {
        badge.classList.remove('completed');
        badge.textContent = '💿';
      }
    }

    // Repaint from whatever is already known (memory cache, or the album's
    // stored coverUrl). Cheap enough to run on every in-place update, and it
    // means a rebuilt card never sits empty.
    paintKnownCover(album, card.dataset.albumKey, container);
  }

  // If expanded section is active, update tracks in real time
  const expandedSection = card.querySelector('.album-card-expanded');
  if (expandedSection && expandedSection.classList.contains('active')) {
    const tracksContainer = card.querySelector('.tracks-list-grid');
    if (tracksContainer) {
      renderTrackChips(tracksContainer, card._albumData || album);
    }
  }
}

function renderTrackChips(tracksContainer, currentAlbum) {
  if (!tracksContainer || !currentAlbum) return;
  const listenedObj = currentAlbum.tracksListened || {};
  const hasAllTracks = Array.isArray(currentAlbum.allTracks) && currentAlbum.allTracks.length > 0;

  // One index for the whole album rather than a full re-scan of tracksListened
  // (and a re-normalization of every key) per rendered chip.
  const matchIndex = createMatchIndex(listenedObj);

  tracksContainer.replaceChildren();

  const header = tracksContainer.parentElement ? tracksContainer.parentElement.querySelector('.album-tracks-header') : null;
  if (header) {
    if (hasAllTracks) {
      header.textContent = t('msg_album_tracks_header', [currentAlbum.allTracks.length]);
    } else {
      const count = Object.keys(listenedObj).length || 1;
      header.textContent = t('msg_album_played_songs_header', [count]);
    }
  }

  // Track titles come from YouTube Music, so the chips are built from nodes:
  // addons-linter reports every innerHTML write as UNSAFE_VAR_ASSIGNMENT, and
  // textContent removes any chance of a title injecting markup.
  const addChip = (title, count, played) => {
    const chip = document.createElement('span');
    chip.className = played ? 'track-chip listened' : 'track-chip unplayed';

    const label = document.createElement('span');
    label.textContent = title;

    const countEl = document.createElement('span');
    countEl.className = 'track-chip-count';
    countEl.textContent = `${count}x`;

    chip.appendChild(label);
    chip.appendChild(document.createTextNode(' '));
    chip.appendChild(countEl);
    tracksContainer.appendChild(chip);
  };

  if (hasAllTracks) {
    currentAlbum.allTracks.forEach(title => {
      const count = matchTrackPlayCountWithIndex(title, matchIndex);
      addChip(title, count, count > 0);
    });
  } else {
    const entries = Object.entries(listenedObj);
    if (entries.length > 0) {
      entries.forEach(([title, count]) => addChip(title, count, true));
    } else {
      addChip(currentAlbum.album, currentAlbum.playCount || 1, true);
    }
  }
}

function wireAlbumCardEvents(card, album, cardId) {
  const toggleBtn = card.querySelector('.btn-toggle-album-tracks');
  const expandedSection = card.querySelector(`#${cardId}`);
  const tracksContainer = card.querySelector(`#${cardId}-tracks`);
  if (!toggleBtn || !expandedSection || !tracksContainer) return;

  // Chips are rendered on first expand, not up front. With "Show All" on a large
  // library this used to build ~2250 DOM nodes (plus one regex-heavy match per
  // track) for cards the user may never open.
  toggleBtn.addEventListener('click', async () => {
    const currentAlbum = card._albumData || album;
    const isActive = expandedSection.classList.toggle('active');
    toggleBtn.textContent = isActive ? t('msg_album_hide_tracks') : t('msg_album_view_tracks');

    if (isActive) {
      renderTrackChips(tracksContainer, currentAlbum);

      // If full album tracklist has not been retrieved and albumBrowseId exists, fetch it quietly in the background
      const hasAllTracks = Array.isArray(currentAlbum.allTracks) && currentAlbum.allTracks.length > 0;
      if (!hasAllTracks && currentAlbum.albumBrowseId) {
        sendRuntimeMessage({
          type: 'GET_ALBUM_DETAILS',
          payload: { album: currentAlbum.album, artist: currentAlbum.artist }
        }).then((res) => {
          if (res && res.status === 'ok' && res.data) {
            const fullAlbum = res.data;
            card._albumData = fullAlbum;
            renderTrackChips(tracksContainer, fullAlbum);

            const pill = card.querySelector('.album-status-pill');
            if (pill && fullAlbum.totalTracks) {
              const uniqueTracks = fullAlbum.uniqueTracksCount || Object.keys(fullAlbum.tracksListened || {}).length;
              const pct = Math.round((uniqueTracks / fullAlbum.totalTracks) * 100);
              const isCompleted = Boolean((fullAlbum.completePlays || 0) > 0);
              if (isCompleted) {
                pill.classList.add('completed');
                pill.textContent = t('msg_album_status_completed', [fullAlbum.completePlays]);
                const badge = card.querySelector('.album-icon-badge');
                if (badge) {
                  badge.classList.add('completed');
                  badge.textContent = '★';
                }
              } else {
                pill.classList.remove('completed');
                pill.textContent = t('msg_album_status_progress', [uniqueTracks, fullAlbum.totalTracks, pct]);
              }
            }
            loadStatsDebounced(100);
          }
        }).catch((err) => {
          console.warn('[Details] Could not load full tracklist:', err);
        });
      }
    }
  });
}

function buildAlbumCard(album, idx) {
  const card = document.createElement('div');
  card.className = 'album-breakdown-card';
  const albumKey = makeAlbumKey(album.album, album.artist);
  card.dataset.albumKey = albumKey;
  card._albumData = album;

  const uniqueTracks = album.uniqueTracksCount || (album.tracksListened ? Object.keys(album.tracksListened).length : 1);
  const completePlays = album.completePlays || 0;
  const isCompleted = Boolean(completePlays > 0);
  const statusText = computeAlbumStatusText(album, uniqueTracks, completePlays);

  const cleanArtistName = cleanAlbumArtist(album.artist);
  const hasDistinctArtist = cleanArtistName && cleanArtistName.toLowerCase() !== (album.album || '').toLowerCase();
  const artistSubtitle = hasDistinctArtist ? `${cleanArtistName} • ` : '';

  const cardId = `album-card-${idx}`;

  const badgeGlyph = isCompleted ? '★' : '💿';

  // Built as nodes instead of an innerHTML template: album and artist names come
  // from YouTube Music, and addons-linter reports every innerHTML write as
  // UNSAFE_VAR_ASSIGNMENT. textContent also makes it impossible for a title to
  // terminate the `title` attribute early.
  const artwork = document.createElement('div');
  artwork.className = 'album-artwork-container';

  const badge = document.createElement('div');
  badge.className = isCompleted ? 'album-icon-badge completed' : 'album-icon-badge';
  badge.textContent = badgeGlyph;
  artwork.appendChild(badge);

  if (isCompleted) {
    const star = document.createElement('span');
    star.className = 'album-cover-star';
    star.title = t('msg_album_completed_title');
    star.textContent = '★';
    artwork.appendChild(star);
  }

  const metaText = document.createElement('div');
  metaText.className = 'album-meta-text';

  const nameEl = document.createElement('div');
  nameEl.className = 'album-name';
  nameEl.textContent = album.album || '';
  nameEl.title = album.album || '';
  metaText.appendChild(nameEl);

  const artistEl = document.createElement('div');
  artistEl.className = 'album-artist';
  artistEl.title = cleanArtistName || album.album || '';
  artistEl.textContent = `${artistSubtitle}${plural('msg_album_total_plays', Number(album.playCount) || 0)}`;
  metaText.appendChild(artistEl);

  const cardLeft = document.createElement('div');
  cardLeft.className = 'album-card-left';
  cardLeft.appendChild(artwork);
  cardLeft.appendChild(metaText);

  const statusPill = document.createElement('span');
  statusPill.className = isCompleted ? 'album-status-pill completed' : 'album-status-pill';
  statusPill.textContent = statusText;

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'btn-toggle-album-tracks';
  toggleBtn.textContent = t('msg_album_view_tracks');

  const cardRight = document.createElement('div');
  cardRight.className = 'album-card-right';
  cardRight.appendChild(statusPill);
  cardRight.appendChild(toggleBtn);

  const cardTop = document.createElement('div');
  cardTop.className = 'album-card-top';
  cardTop.appendChild(cardLeft);
  cardTop.appendChild(cardRight);

  const expanded = document.createElement('div');
  expanded.className = 'album-card-expanded';
  expanded.id = cardId;

  const tracksHeader = document.createElement('div');
  tracksHeader.className = 'album-tracks-header';
  // The four properties this element used to carry inline now live in
  // details.css. Inline styles are legal here (the MV3 default CSP restricts
  // script-src and object-src, not style-src), so this is tidying, not a fix.
  tracksHeader.textContent =
    album.allTracks && album.allTracks.length > 0
      ? t('msg_album_tracks_header', [album.allTracks.length])
      : t('msg_album_played_songs_header', [uniqueTracks]);

  const tracksGrid = document.createElement('div');
  tracksGrid.className = 'tracks-list-grid';
  tracksGrid.id = `${cardId}-tracks`;

  expanded.appendChild(tracksHeader);
  expanded.appendChild(tracksGrid);

  card.appendChild(cardTop);
  card.appendChild(expanded);

  wireAlbumCardEvents(card, album, cardId);

  // Covers are always resolved through fetchAlbumCover, which prefers the
  // IndexedDB object URL and only falls back to the remote https:// URL.
  //
  // Painted synchronously first when the URL is already known. The observer below
  // only fires on the next frame, and only for cards in view, so without this a
  // list rebuild showed every cover as a blank placeholder first.
  paintKnownCover(album, albumKey, artwork);

  observeAlbumCard(card);

  return card;
}

function renderAlbumsBreakdown() {
  if (!elements.albumsBreakdownList) return;
  const albums = showingAllAlbums ? currentAllAlbums : currentTopAlbums;
  const totalCount = currentAllAlbums.length;

  if (elements.toggleAllAlbumsBtn && elements.toggleAllAlbumsText) {
    if (totalCount > 3) {
      elements.toggleAllAlbumsBtn.style.display = 'inline-flex';
      // `msg_details_albums_show_top3_only` / `msg_details_albums_show_all_count`
      // are the authority keys for #toggleAllAlbumsText: the same span is
      // re-rendered from JS on every stats refresh, so the HTML default and
      // these two must agree on one key each, not three.
      elements.toggleAllAlbumsText.textContent = showingAllAlbums
        ? t('msg_details_albums_show_top3_only')
        : t('msg_details_albums_show_all_count', [formatNumber(totalCount)]);
    } else {
      elements.toggleAllAlbumsBtn.style.display = 'none';
    }
  }

  if (elements.albumsSectionSubtext) {
    if (totalCount > 3) {
      elements.albumsSectionSubtext.textContent = showingAllAlbums
        ? t('msg_details_albums_subtext_showing_all', [formatNumber(totalCount)])
        : t('msg_details_albums_subtext_showing_top3', [formatNumber(totalCount)]);
    } else {
      elements.albumsSectionSubtext.textContent = t('msg_details_albums_subtext_default');
    }
  }

  if (!albums || albums.length === 0) {
    elements.albumsBreakdownList.textContent = '';
    const emptyCard = document.createElement('div');
    emptyCard.className = 'empty-state-card';
    emptyCard.textContent = t('msg_details_albums_empty_state');
    elements.albumsBreakdownList.appendChild(emptyCard);
    return;
  }

  // Non-destructive DOM Reconciliation:
  // If the same albums in the same order are already rendered, update in-place without destroying DOM!
  const existingCards = Array.from(elements.albumsBreakdownList.querySelectorAll('.album-breakdown-card'));
  const targetKeys = albums.map(a => makeAlbumKey(a.album, a.artist));
  const isMatch = existingCards.length === targetKeys.length && existingCards.every((c, i) => c.dataset.albumKey === targetKeys[i]);

  if (isMatch) {
    albums.forEach((album, idx) => {
      updateCardInPlace(existingCards[idx], album);
    });
    return;
  }

  // Full re-render when album list or order changes
  // Detached cards stay registered with the IntersectionObserver until they
  // intersect, which never happens once they are off-screen and out of the DOM.
  // On a Top 3 / Show All toggle that leaks every card from the previous list.
  if (albumCoverObserver) {
    existingCards.forEach((card) => albumCoverObserver.unobserve(card));
  }

  elements.albumsBreakdownList.textContent = '';
  albums.forEach((album, idx) => {
    const card = buildAlbumCard(album, idx);
    elements.albumsBreakdownList.appendChild(card);
  });
}

let albumCoverObserver = null;

function getAlbumCoverObserver() {
  if (!albumCoverObserver && 'IntersectionObserver' in window) {
    albumCoverObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const card = entry.target;
          observer.unobserve(card);
          const album = card._albumData;
          if (album) {
            fetchAlbumCover(album, card);
          }
        }
      });
    }, {
      rootMargin: '200px 0px',
      threshold: 0.01
    });
  }
  return albumCoverObserver;
}

function observeAlbumCard(card) {
  const observer = getAlbumCoverObserver();
  if (observer) {
    observer.observe(card);
  } else {
    fetchAlbumCover(card._albumData, card);
  }
}

function applyCoverToCard(container, url, albumName) {
  if (!container || !url) return;
  container.classList.remove('loading');

  const badge = container.querySelector('.album-icon-badge');
  let img = container.querySelector('.album-cover-img');

  if (!img) {
    img = document.createElement('img');
    img.className = 'album-cover-img';
    img.onerror = function () {
      this.style.display = 'none';
      if (badge) badge.style.display = 'flex';
    };
    img.onload = function () {
      if (badge) badge.style.display = 'none';
      img.style.display = 'block';
    };
    if (badge) {
      container.insertBefore(img, badge);
    } else {
      container.appendChild(img);
    }
  }

  // AD-8: 'Album' is the persisted sentinel this used to hardcode, and it is
  // also a real album name a track can carry - so it is mapped to a message at
  // render time only and never rewritten on the way into storage. Assigned
  // through the `alt` property (I-8: no innerHTML, and the album name is remote
  // data that can never terminate the attribute early).
  img.alt = albumName || t('msg_album_cover_alt');

  img.src = url;
  img.style.display = 'block';
  if (badge) badge.style.display = 'none';
}

/**
 * Keys whose cover has already been resolved from the network this session.
 *
 * This guards *network* work only. It used to short-circuit the whole function,
 * so any card rebuilt after a Top 3 / Show All toggle or a stats refresh came
 * back with no image at all: the key was still marked, the fetch bailed out, and
 * nothing ever painted the container again.
 */
const requestedCoverKeys = new Set();

/** Keys already warmed into the IndexedDB cache from a known remote URL. */
const warmedCoverKeys = new Set();

/**
 * Populates the 128px IndexedDB cache for an album whose remote cover URL is
 * already known, without blocking the paint.
 *
 * Guarded per key because cacheRemoteThumbnail mints a fresh object URL on every
 * call and overwrites the memory entry: unguarded, a list rebuild would re-download
 * every cover and leak the object URLs it replaced.
 *
 * @param {string} key
 * @param {string} remoteUrl
 */
function warmThumbnailCache(key, remoteUrl) {
  if (warmedCoverKeys.has(key)) return;
  warmedCoverKeys.add(key);
  thumbnailCache.cacheRemoteThumbnail(key, remoteUrl)
    .then((objectUrl) => {
      if (objectUrl) refreshThumbnailCacheStats();
    })
    .catch(() => {});
}

/**
 * Paints a cover that is already known, without any I/O.
 *
 * @param {object} album
 * @param {string} key
 * @param {Element|null} container
 * @returns {boolean} Whether the container now shows a cover.
 */
function paintKnownCover(album, key, container) {
  if (!container || !album || !album.album) return false;

  // Already painted on this container (e.g. by a concurrent duplicate call).
  // An <img> that errored is hidden by its own onerror handler, so it counts as
  // unpainted and is retried once the negative cache allows it.
  const paintedImg = container.querySelector('.album-cover-img');
  if (paintedImg && paintedImg.style.display !== 'none') return true;

  // In-memory object URL: free and synchronous. This is the common case for a
  // card rebuilt from a list that was already painted once (Top 3 / Show All).
  const memUrl = thumbnailCache.getMemoryObjectUrl(key);
  if (memUrl) {
    applyCoverToCard(container, memUrl, album.album);
    return true;
  }

  // The album record already carries a resolved remote URL (the background
  // writes it back to storage). Paint it right away so a rebuilt card is never
  // blank, and warm the 128px IndexedDB copy in the background so the next
  // rebuild can use the cache instead of the full-size original.
  if (album.coverUrl && album.coverUrl.startsWith('http')) {
    applyCoverToCard(container, album.coverUrl, album.album);
    warmThumbnailCache(key, album.coverUrl);
    return true;
  }

  return false;
}

/**
 * Full cover resolution: cached copy first, network only if nothing is known.
 *
 * @param {object} album
 * @param {Element} cardEl The card whose artwork container should be painted.
 * @returns {Promise<void>}
 */
async function fetchAlbumCover(album, cardEl) {
  if (!album || !album.album || !cardEl) return;
  const key = makeAlbumKey(album.album, album.artist);

  const container = cardEl.querySelector('.album-artwork-container');
  if (!container) return;

  if (paintKnownCover(album, key, container)) return;

  // Step 2: persistent IndexedDB copy, so covers survive a page reload.
  try {
    const cachedUrl = await thumbnailCache.getThumbnailObjectUrl(key);
    if (cachedUrl) {
      applyCoverToCard(container, cachedUrl, album.album);
      return;
    }
  } catch (_) {}

  // Nothing left locally and the network already answered for this key: stop.
  if (requestedCoverKeys.has(key) || thumbnailCache.isThumbnailFailed(key)) {
    container.classList.remove('loading');
    return;
  }
  requestedCoverKeys.add(key);
  container.classList.add('loading');

  // No remote coverUrl to fall back on here: paintKnownCover already handled
  // that case above, so reaching this point means nothing is known locally.
  // Request the cover from the background script.
  let resolvedUrl = null;
  try {
    const resp = await sendRuntimeMessage({
      type: 'FETCH_ALBUM_COVER',
      payload: {
        album: album.album,
        artist: album.artist,
        browseId: album.albumBrowseId
      }
    });
    resolvedUrl = resp && resp.status === 'ok' && resp.data && resp.data.coverUrl ? resp.data.coverUrl : null;
  } catch (_) {}

  if (!resolvedUrl) {
    // Negative caching so a permanently unavailable cover is not re-requested on
    // every rebuild. The 7-day TTL in thumbnailCache expires it, so a transient
    // failure is not permanent for the session.
    container.classList.remove('loading');
    thumbnailCache.markThumbnailFailed(key).catch(() => {});
    return;
  }

  album.coverUrl = resolvedUrl;
  applyCoverToCard(container, resolvedUrl, album.album);

  // Downscaling happens after the paint, so the cover appears immediately at
  // full resolution and the next rebuild uses the 128px cache. Doing it first
  // meant waiting on a network round trip to show anything at all.
  warmThumbnailCache(key, resolvedUrl);
}

function handleAlbumsStorageChange(oldAlbums, newAlbums) {
  if (!newAlbums || typeof newAlbums !== 'object') {
    loadStatsDebounced(200);
    return;
  }

  const oldKeys = Object.keys(oldAlbums || {});
  const newKeys = Object.keys(newAlbums || {});

  // Structural change (albums added/deleted) -> reload
  if (oldKeys.length !== newKeys.length) {
    loadStatsDebounced(200);
    return;
  }

  // Play count change -> reload
  let hasPlayCountChange = false;
  for (const k of newKeys) {
    const prev = oldAlbums && oldAlbums[k];
    const curr = newAlbums[k];
    if (!prev || prev.playCount !== curr.playCount || prev.completePlays !== curr.completePlays) {
      hasPlayCountChange = true;
      break;
    }
  }

  if (hasPlayCountChange) {
    loadStatsDebounced(200);
    return;
  }

  // Only a coverUrl changed: nothing about the ordering or the counts, so repaint
  // that one card instead of rebuilding the whole list. fetchAlbumCover resolves
  // the stored URL immediately and only reaches the network if it has none.
  if (elements.albumsBreakdownList) {
    for (const k of newKeys) {
      const prev = oldAlbums && oldAlbums[k];
      const curr = newAlbums[k];
      if (curr.coverUrl && (!prev || prev.coverUrl !== curr.coverUrl)) {
        const card = elements.albumsBreakdownList.querySelector(`[data-album-key="${k}"]`);
        if (card) {
          card._albumData = curr;
          fetchAlbumCover(curr, card);
        }
      }
    }
  }
}

/* ==========================================================================
   3-Step Confirmation Delete Flow
   ========================================================================== */
function setWipeStep(stepIndex) {
  const steps = [elements.wipeStep0, elements.wipeStep1, elements.wipeStep2, elements.wipeStep3];
  steps.forEach((step, idx) => {
    if (!step) return;
    if (idx === stepIndex) {
      step.classList.add('active');
    } else {
      step.classList.remove('active');
    }
  });
}

function setupWipeDataWorkflow() {
  // Step 0 -> Step 1
  if (elements.initiateDeleteBtn) {
    elements.initiateDeleteBtn.addEventListener('click', () => {
      hideSuccessAlert();
      setWipeStep(1);
    });
  }

  // Step 1: Cancel -> Step 0
  if (elements.cancelStep1Btn) {
    elements.cancelStep1Btn.addEventListener('click', () => {
      setWipeStep(0);
    });
  }

  // Step 1 -> Step 2 (First Confirmation)
  if (elements.confirmStep1Btn) {
    elements.confirmStep1Btn.addEventListener('click', () => {
      setWipeStep(2);
    });
  }

  // Step 2: Cancel -> Step 0
  if (elements.cancelStep2Btn) {
    elements.cancelStep2Btn.addEventListener('click', () => {
      setWipeStep(0);
    });
  }

  // Step 2 -> Step 3 (Second Confirmation)
  if (elements.confirmStep2Btn) {
    elements.confirmStep2Btn.addEventListener('click', () => {
      setWipeStep(3);
    });
  }

  // Step 3: Cancel -> Step 0
  if (elements.cancelStep3Btn) {
    elements.cancelStep3Btn.addEventListener('click', () => {
      setWipeStep(0);
    });
  }

  // Step 3 -> Execute Deletion (Third & Final Confirmation)
  if (elements.confirmStep3Btn) {
    elements.confirmStep3Btn.addEventListener('click', async () => {
      await executeDataWipe();
    });
  }
}

async function executeDataWipe() {
  const emptyState = {
    totalPlays: 0,
    totalListeningSeconds: 0,
    songs: {},
    artists: {},
    albums: {},
    currentTrack: null,
    historySyncState: null,
    scanProgress: null
  };

  try {
    // 1. Send reset message to background service
    await sendRuntimeMessage({ type: 'RESET_STATS' });

    // Direct storage reset as foolproof fallback
    await extBrowser.storage.local.clear();
    await extBrowser.storage.local.set(emptyState);

    // 2. Clear local media cache
    try {
      await thumbnailCache.clearThumbnailCache();
    } catch (_) {}
    refreshThumbnailCacheStats();

    // 3. Return UI to step 0
    setWipeStep(0);

    // 4. Update sync status UI
    lastHistorySyncState = null;
    renderHistorySyncStatus(null);
    clearScanProgressCache();
    renderScanProgress(null);
    showSuccessAlert();

    // 5. Reload stats immediately
    loadStats();
  } catch (err) {
    console.error('[Details] Error during data wipe:', err);
    // Direct fallback
    await extBrowser.storage.local.clear();
    await extBrowser.storage.local.set(emptyState);
    try {
      await thumbnailCache.clearThumbnailCache();
    } catch (_) {}
    refreshThumbnailCacheStats();
    setWipeStep(0);
    lastHistorySyncState = null;
    renderHistorySyncStatus(null);
    clearScanProgressCache();
    renderScanProgress(null);
    showSuccessAlert();
    loadStats();
  }
}

function showSuccessAlert() {
  if (!elements.deleteSuccessAlert) return;
  elements.deleteSuccessAlert.style.display = 'flex';
  setTimeout(() => {
    hideSuccessAlert();
  }, 5000);
}

function hideSuccessAlert() {
  if (!elements.deleteSuccessAlert) return;
  elements.deleteSuccessAlert.style.display = 'none';
}

/* ==========================================================================
   Scan Progress Vocabulary (AD-10)

   `scanProgress` carries machine codes, never sentences: the background cannot
   honour the in-app language override, and a sentence written there would be
   persisted into storage and re-rendered to whoever opens the page next.

   `sanitizeStatusText()` used to regex the English string "reached 200-song
   limit" back out of `scanProgress.statusText` so the panel would not show it.
   That whole problem is gone at the source: the limit is now the machine code
   `reason: 'fullHistory'`, mapped here to `msg_scan_reason_full_history`.

   The safety property the regex was buying - never render an untrusted,
   persisted English sentence produced by another context - is now structural
   rather than defensive. The line below can only ever be assembled from static
   catalog lookups keyed by values in SCAN_PROGRESS_STEPS / _REASONS /
   _ERROR_CODES, plus numbers. There is no code path that reaches a free-text
   field, so there is nothing left to strip.
   ========================================================================== */

/** `scanProgress.step` -> message key, for a history scan. */
const SCAN_STEP_KEYS = {
  scanning: 'msg_scan_step_scanning',
  boundary: 'msg_scan_step_boundary',
  importing: 'msg_scan_step_importing',
  saving: 'msg_scan_step_saving',
  done: 'msg_scan_step_done',
  failed: 'msg_scan_step_failed'
};

/**
 * `scanProgress.step` -> message key, for the album-metadata enrichment pump.
 *
 * Enrichment emits the same two `step` codes as a scan ('scanning', 'done') but
 * a scan and a metadata backfill are different activities, so it gets its own
 * wording rather than inheriting "Scanning your history".
 */
const ENRICHMENT_STEP_KEYS = {
  scanning: 'msg_enrich_step_scanning',
  done: 'msg_enrich_step_done'
};

/**
 * A step that exists only in this file.
 *
 * The optimistic payload written by setupHistoryScannerLauncher() (before the
 * content script has reported anything) is never persisted - it lives in the
 * module-level `lastScanProgress` and is overwritten by the first real storage
 * read - so extending the vocabulary here cannot widen SCAN_PROGRESS_STEPS for
 * the producers that are contractually limited to it.
 */
const LOCAL_CONNECTING_STEP = 'connecting';

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

/** True for a code the background is actually declared to emit. */
function isKnownScanCode(codes, value) {
  return typeof value === 'string' && Array.isArray(codes) && codes.indexOf(value) !== -1;
}

/**
 * Reads the play counter, tolerating the record shape.
 *
 * `plays` is the structured field; `count` is the legacy alias kept only so a
 * `scanProgress` written by an older build still renders a number instead of
 * "NaN". `??` rather than `||` so a deliberate `plays: 0` (enrichment sets it to
 * null and never 0) is not silently replaced.
 *
 * @param {object} progress
 * @returns {number}
 */
function scanPlayCount(progress) {
  const raw = progress && progress.plays !== undefined && progress.plays !== null
    ? progress.plays
    : progress && progress.count;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Unique-song counter, same null-safe collapse as {@link scanPlayCount}. */
function scanUniqueCount(progress) {
  const raw = progress && progress.uniqueSongs !== undefined && progress.uniqueSongs !== null
    ? progress.uniqueSongs
    : progress && progress.unique;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Composes the scanner's status sentence from the structured fields.
 *
 * Precedence is deliberate: an error outranks a reason, a reason outranks the
 * step. A scan that failed also has a `step`, and a scan that stopped at the
 * 200-song boundary has both a terminal step and a reason - and in each case the
 * more specific code is the one that explains what the user is looking at.
 *
 * @param {object} progress A `scanProgress` payload.
 * @returns {string} '' when the payload carries no code we can render.
 */
function composeScanStatus(progress) {
  if (!progress) return '';

  if (isKnownScanCode(SCAN_PROGRESS_ERROR_CODES, progress.errorCode)) {
    return t(SCAN_ERROR_KEYS[progress.errorCode]);
  }
  if (isKnownScanCode(SCAN_PROGRESS_REASONS, progress.reason)) {
    return t(SCAN_REASON_KEYS[progress.reason]);
  }

  const steps = progress.kind === ENRICHMENT_PROGRESS_KIND ? ENRICHMENT_STEP_KEYS : SCAN_STEP_KEYS;
  let stepKey = '';
  if (isKnownScanCode(SCAN_PROGRESS_STEPS, progress.step)) {
    stepKey = steps[progress.step] || SCAN_STEP_KEYS[progress.step];
  } else if (progress.step === LOCAL_CONNECTING_STEP) {
    stepKey = 'msg_settings_scanner_connecting';
  }
  if (!stepKey) return '';

  const processed = Number(progress.processed);
  const total = Number(progress.total);
  const hasFraction = Number.isFinite(processed) && Number.isFinite(total) && total > 0;

  return hasFraction
    ? t('msg_scan_step_progress', [t(stepKey), formatNumber(processed), formatNumber(total)])
    : t(stepKey);
}

/* ==========================================================================
   Real-Time Storage Synchronization & Live Scanner Feedback
   ========================================================================== */
function renderScanProgress(scanProgress) {
  if (!elements.scannerLivePanel) return;

  if (!scanProgress) {
    elements.scannerLivePanel.style.display = 'none';
    return;
  }

  const composedStatus = composeScanStatus(scanProgress);

  // Album-metadata enrichment shares this panel but is not a sync. It must never
  // be presented as one, or "Fetching metadata..." reads as a scan that is still
  // running (and re-enables the panel with a nonsense play count).
  if (scanProgress.kind === ENRICHMENT_PROGRESS_KIND) {
    const done = Boolean(scanProgress.enrichmentDone);
    elements.scannerLivePanel.style.display = 'flex';
    if (elements.launchHistoryScannerBtn) {
      elements.launchHistoryScannerBtn.disabled = false;
      elements.launchHistoryScannerBtn.textContent = t('msg_scanner_start_sync');
    }
    if (elements.scannerConfigSpinner) elements.scannerConfigSpinner.classList.toggle('done', done);
    if (elements.scannerLiveBadge) {
      elements.scannerLiveBadge.textContent = done ? t('msg_scanner_metadata_ready') : t('msg_scanner_metadata_fetching');
      elements.scannerLiveBadge.classList.toggle('badge-done', done);
    }
    if (elements.scannerLiveCounts) {
      const processed = scanProgress.enrichmentProcessed || 0;
      const total = scanProgress.enrichmentTotal || 0;
      elements.scannerLiveCounts.textContent = total > 0
        ? t('msg_scanner_enrich_progress', [formatNumber(processed), formatNumber(total)])
        : t('msg_scanner_enrich_resolving');
    }
    if (elements.scannerImportingTrack) {
      elements.scannerImportingTrack.textContent = composedStatus;
    }
    return;
  }

  // A scan with no recent heartbeat belongs to a tab that is gone. Treating it as
  // live is what pinned this panel on "Syncing in progress" and left the Start
  // button permanently disabled, since the content script that would have
  // cleared the flag died with its tab.
  const interrupted = isStaleScanProgress(scanProgress);
  // Same shape as before (status, then the "reopen the history page" advice),
  // but both halves are catalog strings now, so neither can be an English
  // fragment left over from another context.
  const panelStatus = interrupted
    ? (composedStatus
      ? t('msg_scanner_interrupted_hint', [composedStatus])
      : t('msg_scanner_interrupted'))
    : composedStatus;

  if (scanProgress.isScanning && !interrupted) {
    elements.scannerLivePanel.style.display = 'flex';
    if (elements.launchHistoryScannerBtn) {
      elements.launchHistoryScannerBtn.disabled = true;
      elements.launchHistoryScannerBtn.textContent = t('msg_scanner_in_progress');
    }
    if (elements.scannerConfigSpinner) elements.scannerConfigSpinner.classList.remove('done');
    if (elements.scannerLiveBadge) {
      elements.scannerLiveBadge.textContent = t('msg_settings_scanner_badge_syncing');
      elements.scannerLiveBadge.classList.remove('badge-done');
    }
    if (elements.scannerLiveCounts) {
      // Both arguments arrive as finished, already-pluralized phrases so the
      // noun agrees with the number in every locale: a single message with a
      // literal noun cannot do that for pt_BR zero / fr one-covers-zero.
      elements.scannerLiveCounts.textContent = t('msg_scanner_live_counts', [
        plural('msg_count_play', scanPlayCount(scanProgress)),
        plural('msg_count_song', scanUniqueCount(scanProgress))
      ]);
    }
    if (elements.scannerImportingTrack) {
      const latest = scanProgress.latestTrack;
      if (latest && latest.title) {
        // Remote metadata, assigned as text: I-8 forbids building this from
        // markup, and textContent makes an injected title inert by construction.
        // The stored 'Unknown Artist' sentinel is mapped at render time only.
        const artist = displayArtist(latest.artist);
        elements.scannerImportingTrack.textContent = latest.album
          ? t('msg_scanner_now_playing_album', [latest.title, artist, latest.album])
          : t('msg_scanner_now_playing', [latest.title, artist]);
      } else {
        elements.scannerImportingTrack.textContent = panelStatus || t('msg_scanner_finding_songs');
      }
    }
  } else if (panelStatus) {
    elements.scannerLivePanel.style.display = 'flex';
    if (elements.launchHistoryScannerBtn) {
      elements.launchHistoryScannerBtn.disabled = false;
      elements.launchHistoryScannerBtn.textContent = t('msg_scanner_start_sync');
    }
    if (elements.scannerConfigSpinner) {
      // An interrupted scan has no verdict to show, so the spinner keeps turning.
      elements.scannerConfigSpinner.classList.toggle('done', !interrupted);
    }
    if (elements.scannerLiveBadge) {
      const plays = scanPlayCount(scanProgress);
      // `reason: 'upToDate'` is the code that actually means "nothing new"; the
      // count is kept as a fallback for a terminal record that predates it.
      const upToDate = scanProgress.reason === 'upToDate' || (plays === 0 && !scanProgress.errorCode);
      elements.scannerLiveBadge.textContent = interrupted
        ? t('msg_settings_scanner_badge_interrupted')
        : (scanProgress.errorCode ? t('msg_settings_scanner_badge_failed') : (upToDate ? t('msg_settings_scanner_badge_up_to_date') : t('msg_settings_scanner_badge_complete')));
      elements.scannerLiveBadge.classList.toggle('badge-done', !interrupted);
    }
    if (elements.scannerLiveCounts) {
      elements.scannerLiveCounts.textContent = plural('msg_scanner_plays_synced', scanPlayCount(scanProgress));
    }
    if (elements.scannerImportingTrack) {
      elements.scannerImportingTrack.textContent = panelStatus;
    }
  } else {
    elements.scannerLivePanel.style.display = 'none';
  }
}

/**
 * Last `scanProgress` payload seen, replayed on a timer so staleness is
 * re-evaluated without waiting for a storage event.
 */
let lastScanProgress = null;

/** How often the scan panel is re-rendered from the cached payload. */
const SCAN_PANEL_TICK_MS = 15000;

/**
 * Drops the cached payload so the panel watcher stops replaying it. Used when the
 * data behind the panel is wiped, otherwise the watcher would re-render the
 * deleted scan state on its next tick.
 */
function clearScanProgressCache() {
  lastScanProgress = null;
}

function startScanPanelWatch() {
  setInterval(() => {
    // A dead scan produces no further writes, so there is no storage event to
    // react to. Re-rendering the cached payload is what lets isStaleScanProgress
    // notice the heartbeat stopped and unblock the Start button.
    if (lastScanProgress) {
      renderScanProgress(lastScanProgress);
    }
  }, SCAN_PANEL_TICK_MS);
}

async function checkScanProgress() {
  try {
    const data = await extBrowser.storage.local.get(['scanProgress']);
    // Render even a null value: an import sets scanProgress to null to drop the
    // previous run's state, and skipping that here left the panel showing the
    // pre-import "Syncing" text.
    if (data && 'scanProgress' in data) {
      lastScanProgress = data.scanProgress;
      renderScanProgress(lastScanProgress);
    }
  } catch (err) {
    console.error('[Details] Error checking scanProgress:', err);
  }
}

/**
 * Relative-time formatter, memoized per locale.
 *
 * `Intl.RelativeTimeFormat` rather than a `"$1 minutes ago"` message because
 * word order differs ("vor 5 Minuten", "há 5 minutos", "5 minuti fa").
 * `numeric: 'always'` keeps "1 day ago" from turning into "yesterday".
 */
const relativeTimeFormatters = new Map();

function getRelativeTimeFormatter() {
  const locale = YTMCI18n.intlLocale();
  let formatter = relativeTimeFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
    relativeTimeFormatters.set(locale, formatter);
  }
  return formatter;
}

/**
 * Describes when a timestamp passed, in the active locale.
 *
 * @param {number} timestamp Epoch milliseconds.
 * @returns {string}
 */
function formatRelativeTime(timestamp) {
  if (!timestamp) return t('msg_relative_recently');
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 60) return t('msg_relative_just_now');
  const formatter = getRelativeTimeFormatter();
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return formatter.format(-diffMin, 'minute');
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return formatter.format(-diffHours, 'hour');
  return formatter.format(-Math.floor(diffHours / 24), 'day');
}

function renderHistorySyncStatus(syncState) {
  if (!elements.historySyncText) return;

  const hasWatermark = syncState && Array.isArray(syncState.watermark) && syncState.watermark.length > 0;
  const hasLegacy = syncState && syncState.lastDateHeader;

  if (!syncState || (!hasWatermark && !hasLegacy && !syncState.lastSyncTimestamp)) {
    elements.historySyncText.textContent = t('msg_sync_status_ready');
    if (elements.historySyncDot) elements.historySyncDot.classList.remove('active');
    if (elements.debugSyncBoundaryStatus) elements.debugSyncBoundaryStatus.textContent = t('msg_debug_boundary_none');
    return;
  }

  const latestTitle = syncState.lastTrackTitle || (hasWatermark ? syncState.watermark[0].title : syncState.lastDateHeader);
  const timeStr = syncState.lastSyncTimestamp ? formatRelativeTime(syncState.lastSyncTimestamp) : t('msg_relative_recently');

  elements.historySyncText.textContent = t('msg_sync_status_synced', [timeStr, latestTitle]);
  if (elements.historySyncDot) elements.historySyncDot.classList.add('active');
  if (elements.debugSyncBoundaryStatus) {
    // Diagnostic readout, so the remote track title is still interpolated - but
    // through textContent, and with the count pluralized rather than "1 tracks".
    elements.debugSyncBoundaryStatus.textContent = hasWatermark
      ? t('msg_debug_watermark', [plural('msg_tracks', syncState.watermark.length), latestTitle])
      : t('msg_debug_boundary_date', [syncState.lastDateHeader, plural('msg_count_play', syncState.syncedCountOnDate || 0)]);
  }
}

async function checkHistorySyncStatus() {
  try {
    const data = await extBrowser.storage.local.get(['historySyncState']);
    lastHistorySyncState = data && data.historySyncState ? data.historySyncState : null;
    renderHistorySyncStatus(lastHistorySyncState);
  } catch (err) {
    console.error('[Details] Error checking historySyncState:', err);
  }
}

if (extBrowser.storage && extBrowser.storage.onChanged) {
  extBrowser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    if (changes.scanProgress) {
      lastScanProgress = changes.scanProgress.newValue;
      renderScanProgress(lastScanProgress);
    }
    if (changes.historySyncState) {
      lastHistorySyncState = changes.historySyncState.newValue || null;
      renderHistorySyncStatus(lastHistorySyncState);
      refreshDebugStatusBar();
    }

    // Only reload statistics if core listening stats changed
    const counterKeys = ['songs', 'artists', 'totalPlays'];
    const hasCounterChange = counterKeys.some(k => k in changes);

    if (hasCounterChange) {
      loadStatsDebounced(250);
    } else if (changes.albums) {
      handleAlbumsStorageChange(changes.albums.oldValue, changes.albums.newValue);
    }
  });
}

/* ==========================================================================
   Thumbnail Database & Cache Settings
   ========================================================================== */
let refreshThumbnailCacheStatsSeq = 0;
async function refreshThumbnailCacheStats() {
  if (!elements.thumbnailCacheCount || !elements.thumbnailCacheSize) return;

  const seq = ++refreshThumbnailCacheStatsSeq;
  try {
    const stats = await thumbnailCache.getThumbnailStats();
    if (seq === refreshThumbnailCacheStatsSeq) {
      const count = Number(stats.count) || 0;
      elements.thumbnailCacheCount.textContent = plural('msg_cache_covers', count);
      elements.thumbnailCacheSize.textContent = `(${formatBytes(Number(stats.bytes) || 0)})`;
    }
  } catch (err) {
    if (seq === refreshThumbnailCacheStatsSeq) {
      elements.thumbnailCacheCount.textContent = t('msg_generic_error');
      elements.thumbnailCacheSize.textContent = '';
    }
  }
}

function showCacheOpMessage(msg) {
  if (!elements.thumbnailCacheOpMessage) return;
  elements.thumbnailCacheOpMessage.textContent = msg;
  elements.thumbnailCacheOpMessage.style.display = 'inline';
  setTimeout(() => {
    if (elements.thumbnailCacheOpMessage) {
      elements.thumbnailCacheOpMessage.style.display = 'none';
    }
  }, 3500);
}

function setupThumbnailCacheSettings() {
  if (elements.refreshThumbnailCacheStatsBtn) {
    elements.refreshThumbnailCacheStatsBtn.addEventListener('click', async () => {
      await refreshThumbnailCacheStats();
      showCacheOpMessage(t('msg_cache_size_refreshed'));
    });
  }

  if (elements.clearThumbnailCacheBtn) {
    elements.clearThumbnailCacheBtn.addEventListener('click', async () => {
      elements.clearThumbnailCacheBtn.disabled = true;
      try {
        await thumbnailCache.clearThumbnailCache();
        requestedCoverKeys.clear();
        warmedCoverKeys.clear();
        await refreshThumbnailCacheStats();
        showCacheOpMessage(t('msg_cache_cleared'));
        renderAlbumsBreakdown();
      } catch (err) {
        showCacheOpMessage(t('msg_cache_clear_error', [err && err.message ? err.message : '']));
      } finally {
        elements.clearThumbnailCacheBtn.disabled = false;
      }
    });
  }
}

// Memory cleanup on page unload
window.addEventListener('beforeunload', () => {
  thumbnailCache.revokeAllObjectUrls();
});

function showImportExportMessage(msg, isError = false) {
  if (!elements.importExportStatusMessage) return;
  elements.importExportStatusMessage.textContent = msg;
  elements.importExportStatusMessage.style.color = isError ? 'var(--accent-red)' : 'var(--accent-green, #10b981)';
  elements.importExportStatusMessage.style.display = 'inline';
  setTimeout(() => {
    if (elements.importExportStatusMessage) {
      elements.importExportStatusMessage.style.display = 'none';
    }
  }, 4500);
}

/**
 * Maps a rejected IMPORT_DATA_V2 response to a message the reader can act on.
 *
 * A3 validates the bundle and, on failure, returns a machine `errorCode`
 * alongside the unchanged English `error` string. The code is what gets
 * translated: three known reasons produce three fixed sentences, and anything
 * else (an older build that sends no code, or a failure raised before
 * validation) falls back to the English string rather than showing nothing.
 *
 * @param {object|null} res The background's `{ status: 'error', ... }` reply.
 * @returns {string}
 */
function describeImportFailure(res) {
  const known = {
    importInvalidJson: 'msg_import_error_not_json',
    malformedSchemaV2: 'msg_import_error_bad_schema',
    unrecognizedBackupFormat: 'msg_import_error_unrecognized_format'
  };
  const key = res && res.errorCode ? known[res.errorCode] : null;
  if (key) return t(key);
  return t('msg_import_error', [res && res.error ? res.error : '']);
}

function setupDataBackupWorkflow() {
  if (elements.exportLibraryJsonBtn) {
    elements.exportLibraryJsonBtn.addEventListener('click', async () => {
      try {
        elements.exportLibraryJsonBtn.disabled = true;
        const response = await sendRuntimeMessage({ type: 'EXPORT_DATA_V2' });
        elements.exportLibraryJsonBtn.disabled = false;
        if (!response || response.status !== 'ok') {
          showImportExportMessage(t('msg_export_failed', [response && response.error ? response.error : '']), true);
          return;
        }
        // Blob + object URL instead of a data: URL. A data: URL caps out at a
        // couple of MB (and encodeURIComponent nearly doubles the size), so a
        // real library export simply failed to download.
        const json = JSON.stringify(response.data, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const objectUrl = URL.createObjectURL(blob);
        const dateStr = new Date().toISOString().split('T')[0];
        const downloadAnchor = document.createElement('a');
        downloadAnchor.href = objectUrl;
        downloadAnchor.download = `jamt-export-${dateStr}.json`;
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        downloadAnchor.remove();
        // Revoked on the next tick: revoking synchronously can cancel the
        // download in some builds.
        setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
        showImportExportMessage(t('msg_export_success'));
      } catch (err) {
        elements.exportLibraryJsonBtn.disabled = false;
        showImportExportMessage(t('msg_export_error', [err && err.message ? err.message : '']), true);
      }
    });
  }

  if (elements.importLibraryJsonInput) {
    elements.importLibraryJsonInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const parsed = JSON.parse(event.target.result);
          const res = await sendRuntimeMessage({ type: 'IMPORT_DATA_V2', payload: parsed });
          if (!res || res.status !== 'ok') {
            showImportExportMessage(describeImportFailure(res), true);
            return;
          }
          const { songsCount, artistsCount, albumsCount } = res.data;
          showImportExportMessage(t('msg_import_success', [
            plural('msg_count_song', songsCount),
            plural('msg_artists', artistsCount),
            plural('msg_albums', albumsCount)
          ]));

          // The library was replaced wholesale, so every cover resolved for the previous
          // one is meaningless. Dropping the marks lets the rebuilt cards resolve
          // against the imported albums. The thumbnail cache itself is keyed by
          // albumKey and survives the import, so warmedCoverKeys is left alone.
          requestedCoverKeys.clear();

          // The import replaces historySyncState and clears scanProgress, so both
          // panels have to be re-read from storage. They are separate keys from
          // the statistics, so the storage listener does not cover them.
          await Promise.all([loadStats(), checkScanProgress(), checkHistorySyncStatus()]);
        } catch (parseErr) {
          showImportExportMessage(t('msg_import_invalid_json', [parseErr && parseErr.message ? parseErr.message : '']), true);
        } finally {
          elements.importLibraryJsonInput.value = '';
        }
      };
      reader.readAsText(file);
    });
  }
}

/** Last historySyncState payload seen, so a locale switch can re-render it. */
let lastHistorySyncState = null;

/** Unsubscribe handle for the locale listener; released on pagehide. */
let unsubscribeLocaleChanged = null;

/**
 * Re-renders everything whose text is assembled in JS after a locale switch.
 *
 * `localizeDocument()` alone is not enough: album cards, the scanner panel, the
 * relative-time stamp and the toasts are all built here, not from `data-i18n`
 * attributes. The static chrome is left to `localizeDocument()` so there is one
 * implementation of it, not two.
 *
 * @returns {void}
 */
function renderLocalizedUi() {
  // Re-apply data-i18n attributes first: the settings/about tab labels are
  // static, and they must not lag a frame behind the JS-rendered panels.
  YTMCI18n.localizeDocument();
  setupLanguageSelect();
  // Stat cards hold a `data-i18n` placeholder ("0 min"), so the line above just
  // reset them; re-render the cached payload (it also rebuilds the album list).
  if (lastRenderedStats) renderStats(lastRenderedStats);
  else renderAlbumsBreakdown();
  if (lastScanProgress) renderScanProgress(lastScanProgress);
  renderHistorySyncStatus(lastHistorySyncState);
  refreshThumbnailCacheStats();
  refreshDebugStatusBar();
}

// Initialization on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupAboutPanel();
  setupWipeDataWorkflow();
  setupHistoryScannerLauncher();
  setupThumbnailCacheSettings();
  setupDataBackupWorkflow();
  setupDebugSection();
  if (elements.refreshAlbumsBreakdownBtn) {
    elements.refreshAlbumsBreakdownBtn.addEventListener('click', loadStats);
  }
  if (elements.toggleAllAlbumsBtn) {
    elements.toggleAllAlbumsBtn.addEventListener('click', () => {
      showingAllAlbums = !showingAllAlbums;
      renderAlbumsBreakdown();
    });
  }

  // The catalog has to be resolved before anything that renders text from JS,
  // otherwise override users would see a mix of English and their language.
  // Every data load therefore waits for init(). details.html ships English
  // inline, so a failed init still leaves a usable page.
  YTMCI18n.init()
    .then(() => {
      YTMCI18n.localizeDocument();
      setupLanguageSelect();
      if (typeof unsubscribeLocaleChanged !== 'function') {
        unsubscribeLocaleChanged = YTMCI18n.onLocaleChanged(renderLocalizedUi);
      }
    })
    .catch((err) => {
      // init() is contracted never to reject, but a swallowed failure here would
      // silently strand the page on English; continuing beats an unhandled rejection.
      console.warn('[Details] Localization init failed; continuing with English.', err);
      YTMCI18n.localizeDocument();
      setupLanguageSelect();
    })
    .then(() => {
      loadStats();
      checkScanProgress();
      checkHistorySyncStatus();
      refreshThumbnailCacheStats();
      refreshDebugStatusBar();
      // Drives the stale-scan timeout: without a re-render on a timer, a scan whose
      // tab died produces no storage event and the panel stays stuck.
      startScanPanelWatch();
    });

  // Release the subscription when the page goes away. Chrome has no
  // unload-for-extension-pages event on every platform, so this is a
  // best-effort cleanup rather than a guarantee - the set is per-document.
  window.addEventListener('pagehide', () => {
    if (typeof unsubscribeLocaleChanged === 'function') {
      unsubscribeLocaleChanged();
      unsubscribeLocaleChanged = null;
    }
  }, { once: true });
});

/* ==========================================================================
   DEBUGGING & DIAGNOSTICS MODULE (Hidden Behind Debug Options Toggle)
   ========================================================================== */
/** Longest debug console content kept in the DOM. */
const DEBUG_CONSOLE_MAX_CHARS = 4000;

let debugRenderScheduled = false;

function debugLog(tag, message, data) {
  const now = new Date().toTimeString().split(' ')[0];
  let text = `[${now}] [${tag}] ${message}`;
  if (data !== undefined) {
    text += '\n' + (typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data));
  }
  console.log(`[YTMC Debug] [${tag}]`, message, data !== undefined ? data : '');

  if (!elements.debugConsole) return;

  // Reassigning textContent re-parses the whole <pre>; during an enrichment sweep
  // that happens hundreds of times. Coalesce to one paint per frame.
  if (debugRenderScheduled) return;
  debugRenderScheduled = true;

  const render = () => {
    debugRenderScheduled = false;
    if (!elements.debugConsole) return;
    const existing = elements.debugConsole.textContent || '';
    elements.debugConsole.textContent = (text + '\n' + existing).slice(0, DEBUG_CONSOLE_MAX_CHARS);
  };

  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(render);
  } else {
    setTimeout(render, 0);
  }
}

function setupDebugSection() {
  // Wire up Debug Options Toggle Switch
  if (elements.toggleDebugOptions && elements.debugSection) {
    const isDebugActive = localStorage.getItem('ytmc_show_debug') === 'true';
    elements.toggleDebugOptions.checked = isDebugActive;
    elements.debugSection.style.display = isDebugActive ? 'block' : 'none';

    elements.toggleDebugOptions.addEventListener('change', (e) => {
      const isChecked = e.target.checked;
      localStorage.setItem('ytmc_show_debug', isChecked ? 'true' : 'false');
      elements.debugSection.style.display = isChecked ? 'block' : 'none';
      if (isChecked) {
        refreshDebugStatusBar();
      }
    });
  }

  // Ping button
  if (elements.debugPingBtn) {
    elements.debugPingBtn.addEventListener('click', async () => {
      debugLog('PING', 'Querying for open YouTube Music tabs...');
      try {
        const tabs = await extBrowser.tabs.query({ url: '*://music.youtube.com/*' });
        debugLog('PING', `tabs.query found ${tabs.length} tabs.`, tabs.map(t => ({ id: t.id, url: t.url, active: t.active })));
        if (tabs.length === 0) {
          debugLog('PING', 'WARNING: No tab matching *://music.youtube.com/* is currently open.');
          if (elements.debugTabStatus) elements.debugTabStatus.textContent = t('msg_debug_tab_none');
          return;
        }

        const targetTab = tabs[0];
        debugLog('PING', `Sending PING_CONTENT_SCRIPT to tab ${targetTab.id}...`);
        try {
          const response = await sendTabMessage(targetTab.id, { type: 'PING_CONTENT_SCRIPT' });
          debugLog('PING_SUCCESS', 'Received response from content script:', response);
          if (elements.debugTabStatus) {
            elements.debugTabStatus.textContent = plural('msg_debug_tab_connected', (response && response.itemsCount) || 0);
          }
        } catch (pingErr) {
          debugLog('PING_ERROR', 'Could not reach content script (content script might not be injected or page still loading):', pingErr.message || pingErr);
          if (elements.debugTabStatus) elements.debugTabStatus.textContent = t('msg_debug_tab_unreachable');
        }
      } catch (err) {
        debugLog('PING_EXCEPTION', 'Error during ping:', err.message || err);
      }
    });
  }

  // Check storage button
  if (elements.debugCheckStorageBtn) {
    elements.debugCheckStorageBtn.addEventListener('click', async () => {
      try {
        const allData = await extBrowser.storage.local.get(null);
        debugLog('STORAGE_DUMP', 'Current storage.local contents:', allData);
        refreshDebugStatusBar(allData);
      } catch (err) {
        debugLog('STORAGE_ERROR', 'Failed to inspect storage:', err.message || err);
      }
    });
  }

  // Reset sync boundary button
  if (elements.debugResetSyncBtn) {
    elements.debugResetSyncBtn.addEventListener('click', async () => {
      try {
        await extBrowser.storage.local.remove(['historySyncState']);
        debugLog('SYNC_RESET', 'historySyncState cleared. Next scan will run in full baseline mode.');
        lastHistorySyncState = null;
        renderHistorySyncStatus(null);
        refreshDebugStatusBar();
      } catch (err) {
        debugLog('SYNC_RESET_ERROR', 'Failed to clear sync boundary:', err.message || err);
      }
    });
  }

  // Clear logs button
  if (elements.debugClearLogsBtn) {
    elements.debugClearLogsBtn.addEventListener('click', () => {
      if (elements.debugConsole) elements.debugConsole.textContent = t('msg_debug_console_cleared');
    });
  }

  // Album tracklist enrichment: threshold config + manual backfill tool
  setupEnrichmentControls();

  // Listen for remote logs
  extBrowser.runtime.onMessage.addListener((message) => {
    if (!message) return;

    // Batched form: the background flushes its debug buffer on an interval rather
    // than sending one runtime message per line.
    if (message.type === 'DEBUG_LOG_BATCH' && Array.isArray(message.lines)) {
      message.lines.forEach(line => {
        if (line) debugLog(line.tag || 'REMOTE', line.message, line.data);
      });
      return;
    }

    if (message.type === 'DEBUG_LOG') {
      debugLog(message.tag || 'REMOTE', message.message, message.data);
    }
  });
}

/**
 * Wires the "Fetch Missing Tracklists" button and the batch-threshold input.
 *
 * Manual runs deliberately bypass the threshold: every album still missing an
 * official tracklist gets resolved, paced by the background throttled queue.
 */
function setupEnrichmentControls() {
  if (elements.enrichmentMinTracksInput) {
    elements.enrichmentMinTracksInput.addEventListener('change', async () => {
      const value = Number(elements.enrichmentMinTracksInput.value);
      if (!Number.isFinite(value) || value < 1) {
        debugLog('ENRICH', 'Ignoring invalid threshold value; reloading the saved one.');
        await loadEnrichmentConfig();
        return;
      }
      try {
        const response = await sendRuntimeMessage({ type: 'SET_ENRICHMENT_CONFIG', payload: { minUniqueTracks: value } });
        if (response && response.status === 'ok') {
          elements.enrichmentMinTracksInput.value = response.data.minUniqueTracks;
          debugLog('ENRICH', `Batch-fetch threshold set to ${response.data.minUniqueTracks} unique track(s).`);
        } else {
          debugLog('ENRICH_ERROR', 'Failed to save threshold:', response && response.error);
        }
      } catch (err) {
        debugLog('ENRICH_ERROR', 'Failed to save threshold:', err.message || err);
      }
    });
  }

  if (elements.fetchMissingTracklistsBtn) {
    elements.fetchMissingTracklistsBtn.addEventListener('click', async () => {
      const btn = elements.fetchMissingTracklistsBtn;
      btn.disabled = true;
      const originalLabel = btn.textContent;
      btn.textContent = t('msg_debug_queueing');
      debugLog('ENRICH', 'Manual tracklist backfill requested. Open a music.youtube.com tab for best results.');

      // The background answers immediately and runs the sweep as a resumable job.
      // Waiting for a final result used to hang forever once the service worker was
      // terminated mid-batch, leaving the button disabled with no feedback. Live
      // progress now arrives through scanProgress instead.
      const restoreButton = () => {
        btn.disabled = false;
        btn.textContent = originalLabel;
      };

      try {
        const response = await sendRuntimeMessage({ type: 'FETCH_MISSING_TRACKLISTS', payload: { force: true } });
        if (response && response.status === 'ok') {
          const r = response.data;
          if (r && r.queued) {
            debugLog('ENRICH', `Backfill queued: ${r.total} tracklists to resolve. Live progress in the scanner panel.`);
            if (elements.enrichmentStatusTag) {
              elements.enrichmentStatusTag.textContent = plural('msg_debug_tracklists_queued', r.total);
            }
            restoreButton();
          } else {
            debugLog('ENRICH', 'Backfill: nothing to fetch, every tracked album already has a tracklist.');
            if (elements.enrichmentStatusTag) elements.enrichmentStatusTag.textContent = t('msg_debug_tracklists_all_resolved');
            restoreButton();
            loadStats();
          }
        } else {
          debugLog('ENRICH_ERROR', 'Backfill failed:', (response && response.error) || 'unknown error');
          restoreButton();
        }
      } catch (err) {
        debugLog('ENRICH_ERROR', 'Backfill failed:', err.message || err);
        restoreButton();
      }
    });
  }

  loadEnrichmentConfig();
}

/**
 * Reads the current enrichment config from the background and reflects it in the UI.
 */
async function loadEnrichmentConfig() {
  try {
    const response = await sendRuntimeMessage({ type: 'GET_ENRICHMENT_CONFIG' });
    if (response && response.status === 'ok' && elements.enrichmentMinTracksInput) {
      elements.enrichmentMinTracksInput.value = response.data.minUniqueTracks;
    }
  } catch (err) {
    debugLog('ENRICH_ERROR', 'Could not read enrichment config:', err.message || err);
  }
}

async function refreshDebugStatusBar(data) {
  try {
    const storageData = data || await extBrowser.storage.local.get(null);
    if (elements.debugStorageStatus) {
      const plays = storageData.totalPlays || 0;
      const songs = Object.keys(storageData.songs || {}).length;
      const artists = Object.keys(storageData.artists || {}).length;
      const albums = Object.keys(storageData.albums || {}).length;
      // Each noun is pluralized on its own and then dropped into one message:
      // a single "N plays, N songs, ..." template cannot agree with the number
      // in every locale's category set at once.
      elements.debugStorageStatus.textContent = t('msg_debug_storage', [
        plural('msg_count_play', plays),
        plural('msg_count_song', songs),
        plural('msg_artists', artists),
        plural('msg_albums', albums)
      ]);
    }
    if (elements.debugScanStatus) {
      const scan = storageData.scanProgress;
      // scanPlayCount() collapses `plays` onto the legacy `count` alias.
      elements.debugScanStatus.textContent = scan && scan.isScanning
        ? t('msg_settings_debug_tag_scanner_active', [plural('msg_count_play', scanPlayCount(scan))])
        : t('msg_settings_debug_tag_scanner_idle');
    }
  } catch (_) {}
}

function setupHistoryScannerLauncher() {
  if (!elements.launchHistoryScannerBtn) return;

  elements.launchHistoryScannerBtn.addEventListener('click', async () => {
    debugLog('LAUNCHER', 'Launch Scanner button clicked.');
    
    // Optimistic local feedback only; the authoritative state arrives from the
    // content script once the history page starts reporting. Cached like any
    // other payload so the panel watcher keeps it (and eventually ages it out)
    // instead of snapping back to the previous run's state.
    lastScanProgress = {
      kind: 'scan',
      isScanning: true,
      updatedAt: Date.now(),
      count: 0,
      unique: 0,
      plays: 0,
      uniqueSongs: 0,
      latestTrack: null,
      // Structured, like the record the content script publishes (AD-10): there
      // is no `statusText` to fill in. `LOCAL_CONNECTING_STEP` is a
      // page-local code for the gap between "clicked" and "the history tab
      // answered" - this object is never written to storage, so it cannot add
      // a seventh value to the persisted step vocabulary.
      step: LOCAL_CONNECTING_STEP,
      processed: 0,
      total: null,
      reason: null,
      errorCode: null
    };
    renderScanProgress(lastScanProgress);

    await extBrowser.storage.local.set({ pendingAutostart: { time: Date.now(), forceRescan: false } });
    const historyUrl = YOUTUBE_MUSIC_HISTORY_URL;

    try {
      debugLog('LAUNCHER', 'Querying tabs for *://music.youtube.com/* ...');
      const tabs = await extBrowser.tabs.query({ url: '*://music.youtube.com/*' });
      debugLog('LAUNCHER', `Found ${tabs.length} tabs matching YouTube Music.`, tabs.map(t => ({ id: t.id, url: t.url })));

      if (tabs.length > 0) {
        const targetTab = tabs[0];
        debugLog('LAUNCHER', `Directing existing tab ${targetTab.id} to ${historyUrl}...`);
        await extBrowser.tabs.update(targetTab.id, { url: historyUrl, active: true });
        if (targetTab.windowId) {
          await extBrowser.windows.update(targetTab.windowId, { focused: true });
        }
        
        // Try messaging content script directly in case it is already on the page and didn't reload
        setTimeout(async () => {
          try {
            await sendTabMessage(targetTab.id, { type: 'START_HISTORY_SCAN', forceRescan: false });
            await extBrowser.storage.local.remove('pendingAutostart'); // Handled immediately
          } catch (_) {
            // The tab navigated away and the content script is gone; it will pick
            // the stored pendingAutostart up on the history page instead.
          }
        }, 500);
      } else {
        debugLog('LAUNCHER', `No existing tab found. Creating new tab with ${historyUrl}...`);
        const newTab = await extBrowser.tabs.create({ url: historyUrl });
        debugLog('LAUNCHER', `Created new tab with ID ${newTab.id}.`);
      }
    } catch (err) {
      debugLog('LAUNCHER_ERROR', 'Error querying/creating tabs:', err.message || err);
      window.open(historyUrl, '_blank');
    }
  });
}
