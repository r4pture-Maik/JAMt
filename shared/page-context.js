/**
 * JAMt - Page-World InnerTube Context Bridge
 *
 * Runs in the MAIN world (see manifest.json `content_scripts[1].world`), which is
 * the only place where YouTube Music's `ytcfg` expando actually lives.
 *
 * Why this file exists:
 *   - Firefox exposes page expandos to content scripts through Xray vision, so
 *     `window.ytcfg` is readable straight from the isolated world.
 *   - Chrome does NOT: the isolated world has a separate global object, so
 *     `window.ytcfg` is `undefined` there and the extension silently fell back to
 *     a stale hardcoded `clientVersion`, which YouTube answers with HTTP 400 for
 *     newer browse ID namespaces (`MPREb_`).
 *
 * This script closes that gap: it reads `ytcfg` in the page world and hands the
 * context to the isolated world over `window.postMessage`, which is the one
 * channel that crosses the world boundary in both engines.
 *
 * It is deliberately dependency-free and defensive: any failure here simply means
 * the extension keeps using the stale fallback context.
 */
(function () {
  'use strict';

  if (window.__ytmcPageContextBridge) return;
  window.__ytmcPageContextBridge = true;

  var REQUEST_SOURCE = 'ytmc:request-innerTube-context';
  var RESPONSE_SOURCE = 'ytmc:innerTube-context';

  /**
   * Reads the live InnerTube context out of the page's `ytcfg`.
   *
   * Mirrors the logic in shared/browse-parse.js, which cannot run in this world
   * because the two files are loaded into different global scopes.
   *
   * @returns {object|null} A structured-cloneable InnerTube context, or null.
   */
  function readContext() {
    try {
      var cfg = window.ytcfg;
      if (!cfg || typeof cfg.get !== 'function') return null;

      var clientVersion = cfg.get('INNERTUBE_CLIENT_VERSION');
      if (!clientVersion) return null;

      var raw = cfg.get('INNERTUBE_CONTEXT');
      var base = raw && typeof raw === 'object' ? JSON.parse(JSON.stringify(raw)) : {};

      base.client = Object.assign({}, base.client, {
        clientName: cfg.get('INNERTUBE_CLIENT_NAME') || (base.client && base.client.clientName) || 'WEB_REMIX',
        clientVersion: clientVersion,
        hl: cfg.get('HL') || (base.client && base.client.hl) || 'en',
        gl: cfg.get('GL') || (base.client && base.client.gl) || 'US'
      });

      return base;
    } catch (_) {
      return null;
    }
  }

  window.addEventListener('message', function (event) {
    // Only same-window traffic, and never react to our own reply.
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.source !== REQUEST_SOURCE) return;

    var context = readContext();
    window.postMessage({ source: RESPONSE_SOURCE, context: context }, window.location.origin);
  });
})();
