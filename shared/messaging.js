/**
 * JAMt - Cross-Browser Messaging Helpers
 *
 * Loaded as a classic script in the content script, the popup and (via a side
 * effect ESM import) the background script, for the same reason as
 * shared/browse-parse.js: one implementation, four consumers.
 *
 * Why it exists:
 *   The extension APIs come in two incompatible flavours and neither engine
 *   accepts the other's calling convention.
 *
 *   - Chromium (before the `browser` namespace landed in Chrome 148) exposes
 *     `chrome.*` only, and those methods are callback-only: passing no callback
 *     returns `undefined` and the reply is lost.
 *   - Firefox exposes `browser.*`, which is promise-only. `sendMessage` and
 *     `tabs.sendMessage` declare their last parameter as an `options` *object*,
 *     so a function there fails the schema check and the call throws
 *     `TypeError: Incorrect argument types for the runtime.sendMessage.`
 *     before the message is ever dispatched.
 *
 *   A call site written for Chrome is therefore silently dead on Firefox: play
 *   counts, the history sync, and every background round-trip stop working
 *   while the rest of the page keeps running. That is what this module
 *   normalizes, so no call site has to think about it.
 */
(function (root) {
  'use strict';

  /** `browser.*` when the engine provides it (Firefox, Chrome >= 148), else `chrome.*`. */
  const extBrowser =
    typeof root.browser !== 'undefined' && root.browser && root.browser.runtime
      ? root.browser
      : root.chrome;

  /** True when the selected namespace answers with a Promise instead of a callback. */
  const NATIVE_PROMISES = extBrowser === root.browser;

  /** Matches the old background `sendMessageToTab` guard against a dead content script. */
  const DEFAULT_TIMEOUT_MS = 15000;

  /**
   * @param {any} err
   * @returns {Error}
   */
  function toError(err) {
    if (err instanceof Error) return err;
    const message = err && typeof err === 'object' && err.message ? err.message : String(err);
    return new Error(message || 'Extension messaging failed');
  }

  /**
   * Invokes `invoke` in whichever style `extBrowser` supports and always returns
   * a Promise that settles exactly once.
   *
   * @param {() => any} invokePromise
   *   Promise flavour: returns the API's Promise.
   * @param {(callback: (response: any) => void) => any} invokeCallback
   *   Callback flavour: receives the reply callback and returns nothing usable.
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  function invoke(invokePromise, invokeCallback, timeoutMs) {
    const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Extension messaging timed out after ${limit}ms`));
      }, limit);

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };

      if (NATIVE_PROMISES) {
        let maybePromise;
        try {
          maybePromise = invokePromise();
        } catch (err) {
          finish(reject, toError(err));
          return;
        }
        if (!maybePromise || typeof maybePromise.then !== 'function') {
          finish(reject, new Error('runtime.sendMessage did not return a Promise'));
          return;
        }
        maybePromise.then(
          (response) => finish(resolve, response),
          (err) => finish(reject, toError(err))
        );
        return;
      }

      try {
        invokeCallback((response) => {
          // `runtime.lastError` is only meaningful while the callback runs, so it
          // has to be read here rather than in the promise chain.
          const lastError = extBrowser.runtime && extBrowser.runtime.lastError;
          if (lastError) {
            finish(reject, new Error(lastError.message || 'Extension messaging failed'));
            return;
          }
          finish(resolve, response);
        });
      } catch (err) {
        finish(reject, toError(err));
      }
    });
  }

  /**
   * Sends a message to the extension's own background context and resolves with
   * the reply. Rejects when there is no receiver.
   *
   * @param {any} message
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  function sendRuntimeMessage(message, timeoutMs) {
    return invoke(
      () => extBrowser.runtime.sendMessage(message),
      (cb) => extBrowser.runtime.sendMessage(message, cb),
      timeoutMs
    );
  }

  /**
   * Sends a message to a tab's content script and resolves with the reply.
   * Rejects when the content script is not injected or the tab is gone.
   *
   * @param {number} tabId
   * @param {any} message
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  function sendTabMessage(tabId, message, timeoutMs) {
    return invoke(
      () => extBrowser.tabs.sendMessage(tabId, message),
      (cb) => extBrowser.tabs.sendMessage(tabId, message, cb),
      timeoutMs
    );
  }

  /**
   * Fire-and-forget variant: the reply is irrelevant and a missing receiver is
   * not worth reporting (diagnostics, best-effort bookkeeping).
   *
   * @param {any} message
   */
  function sendRuntimeMessageIgnoringReply(message) {
    sendRuntimeMessage(message).catch(() => {});
  }

  root.YTMCMessaging = {
    extBrowser,
    sendRuntimeMessage,
    sendTabMessage,
    sendRuntimeMessageIgnoringReply
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
