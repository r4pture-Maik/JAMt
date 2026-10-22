/**
 * background.js end to end: live plays, backup export and backup import keep
 * the monthly buckets in step with the all-time dictionaries.
 *
 * Loaded like tests/is-trusted-message.test.js: background.js runs in a vm
 * sandbox with its ESM imports stripped. Unlike that suite, the stripped names
 * are bound to the REAL storage / monthly / duration / scoring / enrichment
 * exports, so the handlers under test do their actual reads and writes. Only
 * thumbnails.js (IndexedDB) stays stubbed. The listener is then driven exactly
 * as the content script and the Details page drive it.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import '../shared/month-keys.js';
import { EXPORT_SCHEMA_VERSION } from '../background/storage.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'background', 'background.js'), 'utf8');

const EXTENSION_ID = 'jamt-test-id';
const EXTENSION_ROOT = 'moz-extension://test-uuid/';
const PAGE_SENDER = { id: EXTENSION_ID, url: `${EXTENSION_ROOT}details/details.html` };

/** Modules whose real exports are bound into the sandbox. */
const REAL_MODULES = new Set(['./storage.js', './monthly.js', './duration.js', './scoring.js', './enrichment.js']);

const store = {};
let listener = null;

const browserStub = {
  runtime: {
    id: EXTENSION_ID,
    onMessage: { addListener: (fn) => { listener = fn; } },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    sendMessage: () => Promise.resolve(),
    getURL: (p = '') => EXTENSION_ROOT + p,
    getManifest: () => ({ version: '7.7.7' })
  },
  storage: {
    local: {
      async get(keys) {
        const list = keys == null ? Object.keys(store) : [].concat(keys);
        const out = {};
        for (const k of list) if (k in store) out[k] = structuredClone(store[k]);
        return out;
      },
      async set(obj) { Object.assign(store, structuredClone(obj)); },
      async remove(keys) { for (const k of [].concat(keys)) delete store[k]; },
      async clear() { for (const k of Object.keys(store)) delete store[k]; }
    },
    onChanged: { addListener() {} }
  },
  tabs: { query: () => Promise.resolve([]), sendMessage: () => Promise.resolve(), update: () => Promise.resolve() },
  windows: { update: () => Promise.resolve() }
};

/** Sends a message through the real listener and resolves with its reply. */
function send(type, payload, sender = PAGE_SENDER) {
  return new Promise((resolve) => {
    const sync = listener({ type, payload }, sender, resolve);
    if (sync !== true) resolve(undefined);
  });
}

let CURRENT;

/** Evaluates background.js in a sandbox wired to the real storage modules. */
async function loadBackground() {
  const sandbox = {
    browser: browserStub,
    chrome: undefined,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }),
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    URL,
    structuredClone
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of ['shared/browse-parse.js', 'shared/messaging.js', 'shared/i18n.js', 'shared/month-keys.js']) {
    vm.runInContext(readFileSync(join(ROOT, file), 'utf8'), sandbox);
  }

  for (const [, clause, from] of SOURCE.matchAll(/^import\s+(\{[\s\S]*?\})\s+from\s+'([^']+)';/gm)) {
    const real = REAL_MODULES.has(from)
      ? await import(pathToFileURL(join(ROOT, 'background', from)).href)
      : null;
    for (const rawName of clause.slice(1, -1).split(',')) {
      const [orig, alias = orig] = rawName.trim().split(/\s+as\s+/).map(s => s.trim());
      if (!orig) continue;
      sandbox[alias] = real ? real[orig] : () => Promise.resolve({});
    }
  }

  const stripped = SOURCE
    .replace(/^import[\s\S]*?from\s+'[^']+';\s*$/gm, '')
    .replace(/^import\s+'[^']+';\s*$/gm, '');
  vm.runInContext(stripped, sandbox);
}

before(async () => {
  await loadBackground();
  assert.equal(typeof listener, 'function');
  CURRENT = globalThis.YTMCMonths.monthIdFromDate(new Date());
  // Let initializeStorage settle before the tests write.
  await new Promise((r) => setTimeout(r, 20));
});

describe('background monthly tracking', () => {
  test('TRACK_PLAYED books each play into the current month', async () => {
    const play = { title: 'Live Song', artist: 'Band & Guest', album: 'Live Album', durationSeconds: 180 };
    const first = await send('TRACK_PLAYED', play);
    await send('TRACK_PLAYED', play);
    assert.equal(first.status, 'ok');

    const bucket = store[`month:${CURRENT}`];
    assert.ok(store.monthIndex.includes(CURRENT));
    assert.equal(bucket.totalPlays, 2);
    assert.equal(bucket.songs['live song:::band & guest'].playCount, 2);
    assert.equal(bucket.artists.band.playCount, 2);
    assert.equal(bucket.artists.guest.playCount, 2);
    assert.equal(bucket.albums['live album:::band & guest'].playCount, 2);
    // Live plays carry no seconds of their own: ticks add them.
    assert.equal(bucket.totalListeningSeconds, 0);
    assert.equal(store.songs['live song:::band & guest'].playCount, 2);
  });

  test('TIME_LISTENED_TICK adds seconds to the month without adding plays', async () => {
    const before = structuredClone(store[`month:${CURRENT}`]);
    const reply = await send('TIME_LISTENED_TICK', {
      songTitle: 'Live Song', songArtist: 'Band & Guest', songAlbum: 'Live Album', deltaSeconds: 5
    });
    assert.equal(reply.status, 'ok');
    const bucket = store[`month:${CURRENT}`];
    assert.equal(bucket.totalPlays, before.totalPlays);
    assert.equal(bucket.totalListeningSeconds, before.totalListeningSeconds + 5);
    assert.equal(bucket.songs['live song:::band & guest'].durationSeconds, 5);
  });

  test('parked duration is booked to the month when the play registers', async () => {
    await send('TIME_LISTENED_TICK', { songTitle: 'Late', songArtist: 'Solo', deltaSeconds: 7 });
    assert.equal(store[`month:${CURRENT}`].songs['late:::solo'], undefined);
    await send('TRACK_PLAYED', { title: 'Late', artist: 'Solo' });
    assert.deepEqual(store[`month:${CURRENT}`].songs['late:::solo'], { playCount: 1, durationSeconds: 7 });
  });

  test('GET_MONTHLY_STATS returns the stored months', async () => {
    const reply = await send('GET_MONTHLY_STATS', {});
    assert.equal(reply.status, 'ok');
    assert.deepEqual(reply.data.months.map(m => m.id), store.monthIndex);
  });

  test('IMPORT_HISTORY_TRACKS from the content script lands in the scanned months', async () => {
    const sender = { id: EXTENSION_ID, url: 'https://music.youtube.com/history' };
    const reply = await send('IMPORT_HISTORY_TRACKS', {
      tracks: [{ title: 'Old', artist: 'Past', album: '', durationSeconds: 100, listenedMonth: '2025-09' }]
    }, sender);
    assert.equal(reply.status, 'ok');
    assert.deepEqual(store['month:2025-09'].songs['old:::past'], { playCount: 1, durationSeconds: 100 });
  });

  test('export -> import round-trips months and drops months the backup lacks', async () => {
    const exported = await send('EXPORT_DATA');
    assert.equal(exported.status, 'ok');
    const bundle = exported.data;
    assert.equal(bundle.schemaVersion, EXPORT_SCHEMA_VERSION);
    // The stub manifest says 7.7.7: the bundle must carry the shipped version.
    assert.equal(bundle.extensionVersion, '7.7.7');
    assert.deepEqual(Object.keys(bundle.months).sort(), [...store.monthIndex].sort());

    // Simulate a month only present locally: the import must remove it.
    store.monthIndex = [...store.monthIndex, '2020-01'].sort();
    store['month:2020-01'] = { id: '2020-01', totalPlays: 1, totalListeningSeconds: 0, songs: {}, artists: {}, albums: {} };

    const imported = await send('IMPORT_DATA', JSON.parse(JSON.stringify(bundle)));
    assert.equal(imported.status, 'ok');
    assert.equal('month:2020-01' in store, false);
    assert.deepEqual([...store.monthIndex].sort(), Object.keys(bundle.months).sort());
    for (const [id, b] of Object.entries(bundle.months)) assert.deepEqual(store[`month:${id}`], b);
  });

  test('RESET_STATS wipes every month', async () => {
    const reply = await send('RESET_STATS');
    assert.equal(reply.status, 'ok');
    assert.equal(Object.keys(store).some(k => k.startsWith('month:')), false);
  });
});
