/**
 * YTMusic Counter - Shared YouTube Music browse-response parsers
 *
 * This module is loaded in two different worlds, so it is written as a plain
 * script that publishes its API on a global namespace instead of using ESM
 * `export` statements (which are a syntax error in a classic content script):
 *
 *   1. As a classic content script (see manifest.json `content_scripts.js`),
 *      injected into `https://music.youtube.com` *before* content.js, so that
 *      the background can delegate the browse request to the page origin and
 *      sidestep the HTTP 403 that Firefox returns for `moz-extension://`
 *      origins on cross-origin POSTs.
 *   2. As a side-effect ESM import from background/background.js, which reads
 *      the very same functions back off `globalThis`.
 *
 * Keeping a single implementation guarantees the delegated (content script)
 * and fallback (service worker) code paths cannot drift apart.
 */
(function (root) {
  'use strict';

  /**
   * Last-resort InnerTube client. Deliberately stale: it only exists for the case
   * where no live page context could be obtained (service worker fallback, or a
   * MAIN-world bridge that did not answer), and YouTube rejects newer browse ID
   * namespaces such as `MPREb_` with this version. Single source of truth: the
   * service worker used to carry its own hardcoded copy.
   */
  const FALLBACK_INNERTUBE_CLIENT = {
    clientName: 'WEB_REMIX',
    clientVersion: '1.20240101.01.00'
  };

  /**
   * Recursively extracts track titles from YouTube Music browse results.
   *
   * @param {any} node
   * @param {string[]} [titles] Accumulator, for recursion.
   * @returns {string[]}
   */
  function extractTrackTitlesFromBrowse(node, titles) {
    const acc = Array.isArray(titles) ? titles : [];
    if (!node || typeof node !== 'object') return acc;

    if (node.musicResponsiveListItemRenderer) {
      const renderer = node.musicResponsiveListItemRenderer;
      const flexCols = renderer.flexColumns || [];
      const colRenderer = flexCols[0] && flexCols[0].musicResponsiveListItemFlexColumnRenderer;
      const titleCol =
        (colRenderer && colRenderer.title && colRenderer.title.runs && colRenderer.title.runs[0] && colRenderer.title.runs[0].text) ||
        (colRenderer && colRenderer.text && colRenderer.text.runs && colRenderer.text.runs[0] && colRenderer.text.runs[0].text);
      if (titleCol && acc.indexOf(titleCol.trim()) === -1) {
        acc.push(titleCol.trim());
      }
      return acc;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        extractTrackTitlesFromBrowse(item, acc);
      }
    } else {
      for (const key of Object.keys(node)) {
        if (key !== 'trackingParams' && key !== 'clickTrackingParams') {
          extractTrackTitlesFromBrowse(node[key], acc);
        }
      }
    }
    return acc;
  }

  /**
   * Finds the highest-resolution artwork URL anywhere in a browse response.
   *
   * @param {any} obj
   * @returns {string|null}
   */
  function findBestThumbnail(obj) {
    if (!obj) return null;
    let bestUrl = null;
    let maxDim = 0;

    function traverse(node, depth) {
      const d = depth || 0;
      if (!node || d > 15) return;
      if (typeof node !== 'object') return;

      if (
        typeof node.url === 'string' &&
        (node.url.includes('googleusercontent.com') || node.url.includes('ggpht.com') || node.url.includes('ytimg.com'))
      ) {
        const dim = (node.width || 1) * (node.height || 1);
        if (dim >= maxDim) {
          maxDim = dim;
          bestUrl = node.url;
        }
      }

      if (Array.isArray(node.thumbnails)) {
        for (const t of node.thumbnails) {
          if (t && typeof t.url === 'string') {
            const dim = (t.width || 1) * (t.height || 1);
            if (dim >= maxDim) {
              maxDim = dim;
              bestUrl = t.url;
            }
          }
        }
      }

      if (Array.isArray(node)) {
        for (const item of node) traverse(item, d + 1);
      } else {
        for (const key of Object.keys(node)) {
          if (key === 'thumbnails') continue;
          traverse(node[key], d + 1);
        }
      }
    }

    traverse(obj, 0);

    if (bestUrl) {
      if (bestUrl.startsWith('//')) bestUrl = 'https:' + bestUrl;
      return bestUrl;
    }
    return null;
  }

  /**
   * Builds the request body for the YouTube Music `browse` endpoint.
   * Shared so the content script and the service worker fallback stay in sync.
   *
   * @param {string} cleanBrowseId Already normalized (see normalizeBrowseId).
   * @param {object} [context] InnerTube context override. The content script passes
   *   the page's live context, which is the only way to resolve newer browse ID
   *   namespaces such as `MPREb_`: YouTube rejects them (HTTP 400) when they are
   *   requested with an outdated `clientVersion`. The service worker has no page
   *   access and falls back to the hardcoded WEB_REMIX context.
   * @returns {object}
   */
  /**
   * Returns a copy of the stale WEB_REMIX fallback client, so callers outside this
   * file (the service worker's search requests) stop hardcoding their own.
   *
   * @returns {{clientName: string, clientVersion: string}}
   */
  function getFallbackInnerTubeClient() {
    return { clientName: FALLBACK_INNERTUBE_CLIENT.clientName, clientVersion: FALLBACK_INNERTUBE_CLIENT.clientVersion };
  }

  function buildBrowseRequestBody(cleanBrowseId, context) {
    return {
      context:
        context && typeof context === 'object'
          ? context
          : { client: Object.assign({}, FALLBACK_INNERTUBE_CLIENT) },
      browseId: cleanBrowseId
    };
  }

  /**
   * Reads the page's live InnerTube context from `ytcfg`.
   *
   * Synchronous path, only usable from a world that can see the page expando:
   *   - Firefox content scripts: yes (Xray vision exposes page expandos).
   *   - Chrome content scripts: NO. The isolated world has its own global object,
   *     so `window.ytcfg` is `undefined` and this returns null.
   *   - Service worker: never (no page at all).
   *
   * On Chrome use `requestPageInnerTubeContext()` instead, which goes through the
   * MAIN-world bridge in shared/page-context.js.
   *
   * The context is deep-cloned to strip Xray wrappers and non-cloneable values
   * before it is structured-cloned across the message boundary.
   *
   * @param {object} [scope] Object carrying the page `ytcfg` (defaults to `window`).
   * @returns {object|null} A ready-to-use InnerTube context, or null when unavailable.
   */
  function getPageInnerTubeContext(scope) {
    try {
      const host = scope || (typeof window !== 'undefined' ? window : null);
      if (!host) return null;

      const cfg = host.ytcfg;
      if (!cfg || typeof cfg.get !== 'function') return null;

      const clientVersion = cfg.get('INNERTUBE_CLIENT_VERSION');
      if (!clientVersion) return null;

      const raw = cfg.get('INNERTUBE_CONTEXT');
      const base = raw && typeof raw === 'object' ? JSON.parse(JSON.stringify(raw)) : {};

      base.client = Object.assign({}, base.client, {
        clientName: cfg.get('INNERTUBE_CLIENT_NAME') || (base.client && base.client.clientName) || 'WEB_REMIX',
        clientVersion,
        hl: cfg.get('HL') || (base.client && base.client.hl) || 'en',
        gl: cfg.get('GL') || (base.client && base.client.gl) || 'US'
      });

      return base;
    } catch (_) {
      return null;
    }
  }

  const PAGE_CONTEXT_REQUEST_SOURCE = 'ytmc:request-innerTube-context';
  const PAGE_CONTEXT_RESPONSE_SOURCE = 'ytmc:innerTube-context';
  const PAGE_CONTEXT_TIMEOUT_MS = 500;
  const PAGE_CONTEXT_TTL_MS = 60000;

  let pageContextCache = null;
  let pageContextCachedAt = 0;
  let pageContextInFlight = null;

  /**
   * Asks the MAIN-world bridge (shared/page-context.js) for the live InnerTube
   * context, and caches the answer briefly.
   *
   * This is the only path that works in Chrome, where the content script's
   * isolated world cannot read `ytcfg` directly. On Firefox the synchronous
   * `getPageInnerTubeContext()` already succeeds and this is never called.
   *
   * Resolves to null (never rejects) when no bridge is present, so callers can
   * always fall back to the stale WEB_REMIX context.
   *
   * @param {object} [options]
   * @param {number} [options.timeoutMs]
   * @param {number} [options.ttlMs]
   * @returns {Promise<object|null>}
   */
  function requestPageInnerTubeContext(options) {
    const opts = options || {};
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : PAGE_CONTEXT_TIMEOUT_MS;
    const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : PAGE_CONTEXT_TTL_MS;

    if (typeof window === 'undefined' || !window.addEventListener) {
      return Promise.resolve(null);
    }
    if (pageContextCache && Date.now() - pageContextCachedAt < ttlMs) {
      return Promise.resolve(pageContextCache);
    }
    if (pageContextInFlight) return pageContextInFlight;

    let settled = false;
    const request = new Promise((resolve) => {

      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        pageContextInFlight = null;
        if (value) {
          pageContextCache = value;
          pageContextCachedAt = Date.now();
        }
        resolve(value || null);
      };

      function onMessage(event) {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== PAGE_CONTEXT_RESPONSE_SOURCE) return;
        finish(data.context || null);
      }

      const timer = setTimeout(() => finish(null), timeoutMs);
      window.addEventListener('message', onMessage);

      try {
        window.postMessage({ source: PAGE_CONTEXT_REQUEST_SOURCE }, window.location.origin);
      } catch (_) {
        finish(null);
      }
    });

    // finish() can already have run (postMessage threw synchronously); do not
    // re-publish a settled promise as the in-flight one.
    if (!settled) pageContextInFlight = request;
    return request;
  }

  /**
   * Resolves the live page context, preferring the synchronous `ytcfg` read and
   * falling back to the MAIN-world bridge. Safe to call from a content script.
   *
   * @param {object} [scope]
   * @returns {Promise<object|null>}
   */
  async function resolvePageInnerTubeContext(scope) {
    const direct = getPageInnerTubeContext(scope);
    if (direct) return direct;
    return requestPageInnerTubeContext();
  }

  root.YTMCShared = Object.assign(root.YTMCShared || {}, {
    extractTrackTitlesFromBrowse,
    findBestThumbnail,
    buildBrowseRequestBody,
    getPageInnerTubeContext,
    requestPageInnerTubeContext,
    resolvePageInnerTubeContext,
    getFallbackInnerTubeClient
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
