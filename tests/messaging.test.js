/**
 * shared/messaging.js — the helper that decides between Chrome's callback-only
 * `chrome.*` and Firefox's promise-only `browser.*`.
 *
 * The whole point of the module is that it is loaded fresh per engine shape, so
 * these tests re-evaluate it with a stubbed global for each case.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'shared', 'messaging.js'), 'utf8');

/**
 * Evaluates the module against a stubbed global and returns its exports.
 *
 * @param {object} globalObj The stubbed `globalThis`.
 * @returns {{sendRuntimeMessage: Function, sendTabMessage: Function,
 *            sendRuntimeMessageIgnoringReply: Function, extBrowser: object}}
 */
function loadMessaging(globalObj) {
  // The module is an IIFE over `globalThis`; a Function constructor gives it the
  // exact scope shape it has in the browser without a real eval of the file.
  const factory = new Function('globalThis', `${SOURCE}\nreturn globalThis.YTMCMessaging;`);
  return factory(globalObj);
}

/** Wraps a namespace in the property name the module looks it up under. */
function asGlobal(name, namespace) {
  return { [name]: namespace };
}

/**
 * Builds a Chrome-style stub: callback-only, `lastError` set on failure.
 *
 * A responder returning `{ hang: true }` models a peer that never calls back.
 */
function chromeStub(responder) {
  const sent = [];
  const namespace = {
    runtime: {
      id: 'chrome-id',
      lastError: null,
      sendMessage(message, callback) {
        sent.push(message);
        const outcome = responder(message);
        if (!callback) return undefined;
        if (outcome && outcome.hang) return undefined;
        if (outcome && outcome.error) {
          this.lastError = { message: outcome.error };
          callback(undefined);
        } else {
          this.lastError = null;
          callback(outcome);
        }
      }
    },
    tabs: {
      sendMessage(tabId, message, callback) {
        sent.push({ tabId, message });
        if (!callback) return undefined;
        const outcome = responder(message);
        if (outcome && outcome.hang) return undefined;
        callback(outcome);
      }
    }
  };
  const globalObj = asGlobal('chrome', namespace);
  globalObj.sent = sent;
  return globalObj;
}

/**
 * Builds a Firefox-style stub: promise-only, schema-checked options argument.
 *
 * A responder returning `{ hang: true }` models a peer that never settles.
 */
function firefoxStub(responder) {
  const sent = [];
  const namespace = {
    runtime: {
      id: 'firefox-id',
      sendMessage(message, options) {
        // Firefox declares the second parameter as an options *object*. A
        // function fails the schema check and the call throws, which is
        // exactly the bug this module exists to prevent.
        if (typeof options === 'function') {
          throw new TypeError('Incorrect argument types for the runtime.sendMessage.');
        }
        sent.push(message);
        const outcome = responder(message);
        if (outcome && outcome.hang) return new Promise(() => {});
        if (outcome && outcome.error) return Promise.reject(new Error(outcome.error));
        return Promise.resolve(outcome);
      }
    },
    tabs: {
      sendMessage(tabId, message, options) {
        if (typeof options === 'function') {
          throw new TypeError('Incorrect argument types for the tabs.sendMessage.');
        }
        sent.push({ tabId, message });
        const outcome = responder(message);
        if (outcome && outcome.hang) return new Promise(() => {});
        if (outcome && outcome.error) return Promise.reject(new Error(outcome.error));
        return Promise.resolve(outcome);
      }
    }
  };
  const globalObj = asGlobal('browser', namespace);
  globalObj.sent = sent;
  return globalObj;
}

test('resolves the reply on a promise-only engine (Firefox)', async () => {
  const stub = firefoxStub(() => ({ status: 'ok', data: 42 }));
  const messaging = loadMessaging(stub);

  assert.equal(messaging.extBrowser, stub.browser);
  assert.deepEqual(await messaging.sendRuntimeMessage({ type: 'GET_STATS' }), { status: 'ok', data: 42 });
  assert.deepEqual(await messaging.sendTabMessage(7, { type: 'PING' }), { status: 'ok', data: 42 });
  assert.deepEqual(stub.sent, [{ type: 'GET_STATS' }, { tabId: 7, message: { type: 'PING' } }]);
});

test('never passes a callback to a promise-only engine', async () => {
  // The stub throws on a callback argument, so this test fails loudly if the
  // helper ever regresses to the Chrome calling convention.
  const stub = firefoxStub(() => ({ status: 'ok' }));
  await loadMessaging(stub).sendRuntimeMessage({ type: 'TRACK_PLAYED' });
});

test('resolves the reply on a callback-only engine (Chrome)', async () => {
  const stub = chromeStub(() => ({ status: 'ok', data: 'chrome' }));
  const messaging = loadMessaging(stub);

  assert.equal(messaging.extBrowser, stub.chrome);
  assert.deepEqual(await messaging.sendRuntimeMessage({ type: 'GET_STATS' }), { status: 'ok', data: 'chrome' });
  assert.deepEqual(await messaging.sendTabMessage(3, { type: 'PING' }), { status: 'ok', data: 'chrome' });
  assert.deepEqual(stub.sent, [{ type: 'GET_STATS' }, { tabId: 3, message: { type: 'PING' } }]);
});

test('surfaces runtime.lastError as a rejection on the callback-only engine', async () => {
  const stub = chromeStub(() => ({ error: 'Could not establish connection.' }));
  const messaging = loadMessaging(stub);

  await assert.rejects(
    () => messaging.sendRuntimeMessage({ type: 'TRACK_PLAYED' }),
    /Could not establish connection/
  );
});

test('propagates a schema TypeError from a promise-only engine', async () => {
  const stub = firefoxStub(() => ({ error: 'no receiver' }));
  const messaging = loadMessaging(stub);

  await assert.rejects(() => messaging.sendRuntimeMessage({ type: 'GET_STATS' }), /no receiver/);
});

test('rejects instead of hanging when the peer never answers', async () => {
  const promiseStub = firefoxStub(() => ({ hang: true }));
  await assert.rejects(
    () => loadMessaging(promiseStub).sendTabMessage(1, { type: 'PING' }, 20),
    /timed out after 20ms/
  );

  const callbackStub = chromeStub(() => ({ hang: true }));
  await assert.rejects(
    () => loadMessaging(callbackStub).sendTabMessage(1, { type: 'PING' }, 20),
    /timed out after 20ms/
  );
});

test('ignoring-reply variant swallows both failure modes', async () => {
  const promiseStub = firefoxStub(() => ({ error: 'nope' }));
  await loadMessaging(promiseStub).sendRuntimeMessageIgnoringReply({ type: 'DEBUG_LOG' });

  const callbackStub = chromeStub(() => ({ error: 'nope' }));
  await loadMessaging(callbackStub).sendRuntimeMessageIgnoringReply({ type: 'DEBUG_LOG' });
});

test('prefers browser when both namespaces exist (Chrome 148+ and Firefox)', async () => {
  const stub = {
    ...firefoxStub(() => ({ status: 'ok', from: 'browser' })),
    ...chromeStub(() => ({ status: 'ok', from: 'chrome' }))
  };

  const messaging = loadMessaging(stub);
  assert.equal(messaging.extBrowser, stub.browser);
  assert.deepEqual(await messaging.sendRuntimeMessage({ type: 'GET_STATS' }), { status: 'ok', from: 'browser' });
});
