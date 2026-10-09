/**
 * YTMusic Counter - Popup Script
 * Handles real-time grouped stats rendering for Songs, Artists, and Completed Albums.
 */

const extBrowser = typeof browser !== 'undefined' ? browser : chrome;

const { sendRuntimeMessage } = globalThis.YTMCMessaging;

const elements = {
  totalPlays: document.getElementById('totalPlays'),
  totalDuration: document.getElementById('totalDuration'),
  uniqueSongs: document.getElementById('uniqueSongs'),
  uniqueArtists: document.getElementById('uniqueArtists'),
  uniqueAlbums: document.getElementById('uniqueAlbums'),
  completedAlbums: document.getElementById('completedAlbums'),

  topSongsList: document.getElementById('topSongsList'),
  topArtistsList: document.getElementById('topArtistsList'),
  topAlbumsList: document.getElementById('topAlbumsList'),

  tabButtons: document.querySelectorAll('.tab-btn'),
  tabContents: document.querySelectorAll('.tab-content'),

  refreshStatsBtn: document.getElementById('refreshStatsBtn'),
  openDetailsFooterBtn: document.getElementById('openDetailsFooterBtn')
};

// Tab Switching
elements.tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    elements.tabButtons.forEach(b => b.classList.remove('active'));
    elements.tabContents.forEach(c => c.classList.remove('active'));

    btn.classList.add('active');
    const targetId = btn.getAttribute('data-tab');
    const targetContent = document.getElementById(targetId);
    if (targetContent) {
      targetContent.classList.add('active');
    }
  });
});

async function loadStats() {
  try {
    const response = await sendRuntimeMessage({ type: 'GET_STATS' });
    if (response && response.status === 'ok') {
      renderStats(response.data);
    }
  } catch (err) {
    console.error('Could not communicate with background script:', err);
  }
}

function renderStats(stats) {
  if (!stats) return;

  // Hero Stats
  if (elements.totalPlays) {
    const prev = elements.totalPlays.textContent;
    const next = String(stats.totalPlays || 0);
    if (prev !== next) {
      elements.totalPlays.textContent = next;
      elements.totalPlays.classList.add('bump');
      setTimeout(() => elements.totalPlays.classList.remove('bump'), 200);
    }
  }

  if (elements.totalDuration) {
    elements.totalDuration.textContent = '⏱️ ' + (stats.formattedTotalTime || '0 min');
  }

  if (elements.uniqueSongs) elements.uniqueSongs.textContent = stats.uniqueSongsCount || 0;
  if (elements.uniqueArtists) elements.uniqueArtists.textContent = stats.uniqueArtistsCount || 0;
  if (elements.uniqueAlbums) elements.uniqueAlbums.textContent = stats.uniqueAlbumsCount || 0;
  if (elements.completedAlbums) elements.completedAlbums.textContent = stats.completedAlbumsCount || 0;

  // Render Top Songs
  renderSongsList(stats.topSongs || []);

  // Render Top Artists
  renderArtistsList(stats.topArtists || []);

  // Render Completed Albums
  renderAlbumsList(stats.topAlbums || []);
}

function cleanArtist(artist) {
  if (!artist) return '';
  return String(artist).split('•')[0].trim();
}

/**
 * Replaces a list's content with a single "nothing here yet" row.
 */
function renderEmptyState(list, message) {
  list.textContent = '';
  const li = document.createElement('li');
  li.className = 'empty-state';
  li.textContent = message;
  list.appendChild(li);
}

/**
 * Builds one `<li class="ranked-item">` row.
 *
 * Built from DOM nodes rather than an innerHTML string: track titles and artist
 * names come from YouTube Music, and addons-linter flags every innerHTML write
 * as UNSAFE_VAR_ASSIGNMENT. Using textContent also means a title containing
 * `<` or `"` cannot break out of the tooltip attribute.
 *
 * @param {number} rank 1-based position, rendered as "#1".
 * @param {string} name Primary label.
 * @param {string} [subtitle] Optional second line.
 * @param {string} count Right-hand side label.
 * @param {Node} [countPrefix] Optional node prepended inside the count label.
 * @returns {HTMLLIElement}
 */
function createRankedItem(rank, name, subtitle, count, countPrefix) {
  const li = document.createElement('li');
  li.className = 'ranked-item';

  const left = document.createElement('div');
  left.className = 'ranked-left';

  const index = document.createElement('span');
  index.className = 'rank-index';
  index.textContent = `#${rank}`;

  const text = document.createElement('div');
  text.className = 'rank-text';

  const nameEl = document.createElement('div');
  nameEl.className = 'rank-name';
  nameEl.textContent = name;
  nameEl.title = name;
  text.appendChild(nameEl);

  if (subtitle) {
    const sub = document.createElement('span');
    sub.className = 'rank-sub';
    sub.textContent = subtitle;
    sub.title = subtitle;
    text.appendChild(sub);
  }

  left.appendChild(index);
  left.appendChild(text);

  const countEl = document.createElement('span');
  countEl.className = 'rank-count';
  if (countPrefix) {
    countEl.appendChild(countPrefix);
    // The old markup put a space between the star and the label; keep it so
    // the row does not read "★3 songs".
    countEl.appendChild(document.createTextNode(' '));
  }
  countEl.appendChild(document.createTextNode(count));

  li.appendChild(left);
  li.appendChild(countEl);
  return li;
}

/**
 * Renders up to three rows into `list`, or an empty-state row.
 *
 * @param {Element} list
 * @param {Array<object>} items
 * @param {string} emptyMessage
 * @param {(item: object, index: number) => HTMLLIElement} buildRow
 */
function renderTopThree(list, items, emptyMessage, buildRow) {
  if (!list) return;
  const top3 = (items || []).slice(0, 3);
  if (top3.length === 0) {
    renderEmptyState(list, emptyMessage);
    return;
  }
  list.textContent = '';
  top3.forEach((item, idx) => list.appendChild(buildRow(item, idx)));
}

/** "3 plays" / "1 play" */
function pluralPlays(count) {
  return `${count || 0} ${count === 1 ? 'play' : 'plays'}`;
}

function renderSongsList(items) {
  renderTopThree(elements.topSongsList, items, 'No songs tracked yet.', (song, idx) =>
    createRankedItem(
      idx + 1,
      song.title || '',
      cleanArtist(song.artist),
      pluralPlays(song.playCount)
    )
  );
}

function renderArtistsList(items) {
  renderTopThree(elements.topArtistsList, items, 'No artists tracked yet.', (artist, idx) =>
    createRankedItem(idx + 1, cleanArtist(artist.artist), '', pluralPlays(artist.playCount))
  );
}

function renderAlbumsList(items) {
  renderTopThree(elements.topAlbumsList, items, 'No albums tracked yet.', (album, idx) => {
    const uniqueTracks =
      album.uniqueTracksCount ||
      (album.tracksListened ? Object.keys(album.tracksListened).length : 1);
    const isComplete = album.completePlays > 0;

    const artistName = cleanArtist(album.artist);
    const hasDistinctArtist =
      artistName && artistName.toLowerCase() !== (album.album || '').toLowerCase();

    // The star is a node, not markup, so it keeps its own tooltip.
    let star = null;
    if (isComplete) {
      star = document.createElement('span');
      star.className = 'star-mark';
      star.textContent = '★';
      star.title = `Completed ${album.completePlays}x`;
    }

    const count = `${uniqueTracks} ${uniqueTracks === 1 ? 'song' : 'songs'} - ${pluralPlays(album.playCount)}`;
    return createRankedItem(
      idx + 1,
      album.album || '',
      hasDistinctArtist ? artistName : '',
      count,
      star
    );
  });
}

// Refresh stats button handler
if (elements.refreshStatsBtn) {
  elements.refreshStatsBtn.addEventListener('click', async () => {
    elements.refreshStatsBtn.classList.add('spinning');
    await loadStats();
    setTimeout(() => {
      elements.refreshStatsBtn.classList.remove('spinning');
    }, 450);
  });
}

// Open Details Page
function openDetailsPage() {
  const detailsUrl = extBrowser.runtime.getURL('details/details.html');
  try {
    extBrowser.tabs.create({ url: detailsUrl });
    window.close();
  } catch (err) {
    window.open(detailsUrl, '_blank');
  }
}

if (elements.openDetailsFooterBtn) {
  elements.openDetailsFooterBtn.addEventListener('click', openDetailsPage);
}

// Live sync with storage changes
if (extBrowser.storage && extBrowser.storage.onChanged) {
  extBrowser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
      const counterKeys = ['songs', 'artists', 'albums', 'totalPlays'];
      if (counterKeys.some(k => k in changes)) {
        loadStats();
      }
    }
  });
}

// Initial fetch
document.addEventListener('DOMContentLoaded', loadStats);
