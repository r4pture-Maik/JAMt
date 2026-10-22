/**
 * background.js message trust boundary.
 *
 * Regression cover for the bug that made the history sync silently dead: the
 * content script dispatches IMPORT_HISTORY_TRACKS from the music.youtube.com
 * page, but the type was listed as extension-page-only, so the background
 * answered "Untrusted message source." and discarded every scan.
 *
 * The module is loaded for real (not re-implemented) against stub globals, so
 * these tests fail if the sets and the sender check ever drift apart again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'background', 'background.js'), 'utf8');

const EXTENSION_ID = 'ytmc-test-id';
const EXTENSION_ROOT = 'moz-extension://test-uuid/';

/**
 * Evaluates background.js with stubbed WebExtension globals and returns the
 * captured onMessage listener.
 *
 * @param {object} [overrides] Extra globals for the sandbox.
 * @returns {(message: any, sender: any) => any}
 */
function loadBackground(overrides = {}) {
  const logs = [];
  const noopEvent = { addListener() {} };
  let listener = null;

  const api = {
    runtime: {
      id: EXTENSION_ID,
      onMessage: { addListener: (fn) => { listener = fn; } },
      sendMessage: () => Promise.resolve(),
      getURL: () => EXTENSION_ROOT,
      getManifest: () => ({ version: '1.1.0' })
    },
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve(),
        remove: () => Promise.resolve()
      },
      onChanged: noopEvent
    },
    tabs: { query: () => Promise.resolve([]), sendMessage: () => Promise.resolve(), update: () => Promise.resolve() },
    windows: { update: () => Promise.resolve() },
    ...overrides
  };

  const sandbox = {
    browser: api,
    chrome: undefined,
    console: {
      log: (...a) => logs.push(a.map(String).join(' ')),
      warn: (...a) => logs.push('WARN ' + a.map(String).join(' ')),
      error: (...a) => logs.push('ERROR ' + a.map(String).join(' '))
    },
    fetch: async () => ({ ok: false }),
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    URL,
    setTimeout_: 0
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // The shared scripts the module imports for their side effects. They are
  // classic scripts in the browser too, so they run in the same sandbox.
  for (const file of ['shared/browse-parse.js', 'shared/messaging.js', 'shared/i18n.js']) {
    vm.runInContext(readFileSync(join(ROOT, file), 'utf8'), sandbox);
  }

  // The remaining ESM imports (storage, scoring, ...) are resolved by Node, not
  // the sandbox, so they are stripped: the trust logic under test does not
  // depend on them. Their names still have to exist at module-evaluation time,
  // because the startup code below the listener calls a few of them.
  const importBlocks = [...SOURCE.matchAll(/^import\s+([\s\S]*?)\s+from\s+'[^']+';/gm)];
  const stripped = SOURCE
    .replace(/^import[\s\S]*?from\s+'[^']+';\s*$/gm, '')
    .replace(/^import\s+'[^']+';\s*$/gm, '');

  for (const block of importBlocks) {
    const clause = block[1].trim();
    if (clause.startsWith("'") || clause.startsWith('"')) {
      // Side-effect import: already loaded above.
      continue;
    }
    const [, named] = clause.match(/\{([\s\S]*)\}/) || [null, clause.replace(/,/g, '')];
    for (const rawName of (named || '').split(',')) {
      const name = rawName.trim().split(/\s+as\s+/).pop().trim();
      if (name && !(name in sandbox)) {
        sandbox[name] = () => Promise.resolve({});
      }
    }
  }

  vm.runInContext(stripped, sandbox);

  assert.equal(typeof listener, 'function', 'background.js did not register a runtime.onMessage listener');
  return listener;
}

// AD-10: the background must not send a sentence the UI has to display, because
// it cannot honour the in-app locale override. The English string is kept
// deliberately as the catalog-less fallback, so both fields are asserted: the
// code is what the UI maps, the string is what logs and older callers read.
const UNTRUSTED = {
  status: 'error',
  error: 'Untrusted message source.',
  errorCode: 'untrustedSource'
};

/**
 * Invokes the listener and reports whether it refused the message.
 *
 * The rejection branch answers inline, so a single synchronous call is enough
 * to distinguish accepted from rejected. The reply object is compared field by
 * field: it is built inside the vm realm, so its prototype is not this realm's.
 *
 * @param {Function} listener
 * @param {any} message
 * @param {object} sender
 * @returns {object} `{ rejected: boolean, reply: any }`
 */
function dispatch(listener, message, sender) {
  let reply;
  listener(message, sender, (value) => { reply = value; });
  const rejected = Boolean(reply && reply.status === 'error');
  if (rejected) {
    assert.equal(reply.error, UNTRUSTED.error, 'unexpected rejection reason');
    assert.equal(reply.errorCode, UNTRUSTED.errorCode, 'rejection must carry a machine code');
  }
  return { rejected, reply };
}

const musicPage = (url = 'https://music.youtube.com/history') => ({
  id: EXTENSION_ID,
  url,
  origin: 'https://music.youtube.com'
});
const extensionPage = () => ({ id: EXTENSION_ID, url: `${EXTENSION_ROOT}details/details.html` });

const IMPORT = { type: 'IMPORT_HISTORY_TRACKS', payload: { tracks: [] } };

test('accepts the history import from the YouTube Music page', () => {
  const listener = loadBackground();
  // The dispatch is async (it awaits storage), so only assert that it was not
  // refused inline: an inline reply is the only rejection path.
  assert.equal(dispatch(listener, IMPORT, musicPage()).rejected, false);
});

test('accepts the history import from any music.youtube.com path', () => {
  const listener = loadBackground();
  for (const url of [
    'https://music.youtube.com/',
    'https://music.youtube.com/library',
    'https://music.youtube.com/history?autostart=1'
  ]) {
    assert.equal(dispatch(listener, IMPORT, musicPage(url)).rejected, false, `import from ${url} must not be refused`);
  }
});

test('refuses the history import from a page outside the host permission', () => {
  const listener = loadBackground();
  const { rejected } = dispatch(listener, IMPORT, { id: EXTENSION_ID, url: 'https://evil.example.com/' });
  assert.equal(rejected, true);
});

test('does not treat a lookalike host as YouTube Music', () => {
  const listener = loadBackground();
  for (const url of [
    'https://music.youtube.com.evil.example/',
    'https://music.youtube.com.attacker.tld/path'
  ]) {
    const { rejected } = dispatch(listener, IMPORT, { id: EXTENSION_ID, url });
    assert.equal(rejected, true, `${url} must not pass the origin check`);
  }
});

test('refuses the history import from another extension', () => {
  const listener = loadBackground();
  const { rejected } = dispatch(listener, IMPORT, {
    id: 'some-other-extension',
    url: `${EXTENSION_ROOT}details/details.html`
  });
  assert.equal(rejected, true);
});

test('keeps destructive configuration messages extension-page only', () => {
  const listener = loadBackground();
  for (const type of ['RESET_STATS', 'IMPORT_DATA', 'SET_ENRICHMENT_CONFIG', 'CLEAR_THUMBNAIL_CACHE']) {
    // From the content script: refused, even on a trusted origin.
    assert.equal(
      dispatch(listener, { type, payload: {} }, musicPage()).rejected,
      true,
      `${type} must stay extension-page only`
    );

    // From the Details page: accepted.
    assert.equal(
      dispatch(listener, { type, payload: {} }, extensionPage()).rejected,
      false,
      `${type} must work from the Details page`
    );
  }
});

test('keeps the history scan launcher extension-page only', () => {
  const listener = loadBackground();
  // START_HISTORY_SCAN is Details -> content script, so the content script must
  // not be able to trigger it itself.
  assert.equal(dispatch(listener, { type: 'START_HISTORY_SCAN' }, musicPage()).rejected, true);
  assert.equal(dispatch(listener, { type: 'START_HISTORY_SCAN' }, extensionPage()).rejected, false);
});

test('trusts unlisted read-only message types from the content script', () => {
  const listener = loadBackground();
  for (const type of ['TRACK_PLAYED', 'GET_STATS', 'TIME_LISTENED_TICK', 'BACKFILL_ALBUM_COVERS', 'FETCH_ALBUM_COVER']) {
    assert.equal(
      dispatch(listener, { type, payload: {} }, musicPage()).rejected,
      false,
      `${type} must reach the dispatcher from the content script`
    );
  }
});

test('refuses a malformed message and one with no type', () => {
  const listener = loadBackground();
  // No usable `message.type` means the message cannot be classified, so it is
  // refused rather than let through by default.
  for (const message of [null, undefined, { noType: true }, { type: 42 }]) {
    assert.equal(
      dispatch(listener, message, musicPage()).rejected,
      true,
      `message ${JSON.stringify(message)} must be refused`
    );
  }
});

test('refuses every message when the sender is missing entirely', () => {
  const listener = loadBackground();
  assert.equal(dispatch(listener, { type: 'GET_STATS' }, undefined).rejected, true);
});
