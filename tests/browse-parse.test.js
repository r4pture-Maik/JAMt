import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Side-effect import: registers the parsers on globalThis.YTMCShared.
import '../shared/browse-parse.js';

const S = globalThis.YTMCShared;

const row = (text, key = 'title') => ({
  musicResponsiveListItemRenderer: {
    flexColumns: [{ musicResponsiveListItemFlexColumnRenderer: { [key]: { runs: [{ text }] } } }]
  }
});

describe('Browse parse - extractTrackTitlesFromBrowse', () => {
  test('collects titles from nested renderers in order', () => {
    const response = { contents: { a: [row('One'), { b: row('Two') }], c: row('Three') } };
    assert.deepEqual(S.extractTrackTitlesFromBrowse(response), ['One', 'Two', 'Three']);
  });

  test('reads the text column when there is no title column', () => {
    assert.deepEqual(S.extractTrackTitlesFromBrowse(row('Via Text', 'text')), ['Via Text']);
  });

  test('trims and de-duplicates titles', () => {
    assert.deepEqual(S.extractTrackTitlesFromBrowse([row('  Same '), row('Same')]), ['Same']);
  });

  test('skips renderers without a usable title', () => {
    const empty = { musicResponsiveListItemRenderer: { flexColumns: [] } };
    const noRuns = { musicResponsiveListItemRenderer: { flexColumns: [{ musicResponsiveListItemFlexColumnRenderer: {} }] } };
    assert.deepEqual(S.extractTrackTitlesFromBrowse([empty, noRuns, { musicResponsiveListItemRenderer: {} }]), []);
  });

  test('ignores tracking params and tolerates non-object input', () => {
    const response = { trackingParams: row('Hidden'), clickTrackingParams: row('Hidden 2'), ok: row('Shown') };
    assert.deepEqual(S.extractTrackTitlesFromBrowse(response), ['Shown']);
    assert.deepEqual(S.extractTrackTitlesFromBrowse(null), []);
    assert.deepEqual(S.extractTrackTitlesFromBrowse('text'), []);
  });

  test('appends to a caller-provided accumulator', () => {
    const acc = ['Existing'];
    const out = S.extractTrackTitlesFromBrowse(row('New'), acc);
    assert.equal(out, acc);
    assert.deepEqual(acc, ['Existing', 'New']);
  });
});

describe('Browse parse - findBestThumbnail', () => {
  test('returns null for empty input and filters bare url nodes by host', () => {
    assert.equal(S.findBestThumbnail(null), null);
    assert.equal(S.findBestThumbnail({ thumbnails: [{ url: 'https://example.com/a.jpg', width: 9, height: 9 }] }), 'https://example.com/a.jpg');
    assert.equal(S.findBestThumbnail({ x: { url: 'https://example.com/a.jpg' } }), null);
  });

  test('picks the largest thumbnail from a thumbnails array', () => {
    const obj = {
      thumbnail: {
        thumbnails: [
          { url: 'https://lh3.googleusercontent.com/small', width: 60, height: 60 },
          { url: 'https://lh3.googleusercontent.com/big', width: 544, height: 544 },
          { url: 'https://lh3.googleusercontent.com/mid', width: 226, height: 226 }
        ]
      }
    };
    assert.equal(S.findBestThumbnail(obj), 'https://lh3.googleusercontent.com/big');
  });

  test('recognises ggpht and ytimg hosts and bare url nodes', () => {
    assert.equal(S.findBestThumbnail({ x: { url: 'https://yt3.ggpht.com/a', width: 10, height: 10 } }), 'https://yt3.ggpht.com/a');
    assert.equal(S.findBestThumbnail({ x: { url: 'https://i.ytimg.com/vi/a.jpg' } }), 'https://i.ytimg.com/vi/a.jpg');
  });

  test('upgrades protocol-relative URLs to https', () => {
    const obj = { thumbnails: [{ url: '//lh3.googleusercontent.com/x', width: 1, height: 1 }] };
    assert.equal(S.findBestThumbnail(obj), 'https://lh3.googleusercontent.com/x');
  });

  test('finds thumbnails in arrays and stops at the depth limit', () => {
    const shallow = [{ deep: { thumbnails: [{ url: 'https://i.ytimg.com/a', width: 5, height: 5 }] } }];
    assert.equal(S.findBestThumbnail(shallow), 'https://i.ytimg.com/a');

    let deep = { thumbnails: [{ url: 'https://i.ytimg.com/too-deep', width: 5, height: 5 }] };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    assert.equal(S.findBestThumbnail(deep), null);
  });
});

describe('Browse parse - request body and fallback client', () => {
  test('uses the stale fallback client when no context is given', () => {
    const body = S.buildBrowseRequestBody('MPREb_abc');
    assert.equal(body.browseId, 'MPREb_abc');
    assert.deepEqual(body.context, { client: S.getFallbackInnerTubeClient() });
  });

  test('uses the live context when provided', () => {
    const ctx = { client: { clientName: 'WEB_REMIX', clientVersion: '9.9' } };
    assert.equal(S.buildBrowseRequestBody('MPREb_abc', ctx).context, ctx);
  });

  test('falls back for a non-object context', () => {
    assert.equal(S.buildBrowseRequestBody('x', 'nope').context.client.clientName, 'WEB_REMIX');
  });

  test('getFallbackInnerTubeClient returns a copy', () => {
    const a = S.getFallbackInnerTubeClient();
    a.clientVersion = 'mutated';
    assert.notEqual(S.getFallbackInnerTubeClient().clientVersion, 'mutated');
  });
});

describe('Browse parse - getPageInnerTubeContext', () => {
  const cfg = (values) => ({ ytcfg: { get: (k) => values[k] } });

  test('returns null without a usable ytcfg', () => {
    assert.equal(S.getPageInnerTubeContext({}), null);
    assert.equal(S.getPageInnerTubeContext({ ytcfg: {} }), null);
    assert.equal(S.getPageInnerTubeContext(cfg({})), null);
  });

  test('returns null when no scope and no window are available', () => {
    assert.equal(S.getPageInnerTubeContext(), null);
  });

  test('builds a context from ytcfg values, overriding the client fields', () => {
    const ctx = S.getPageInnerTubeContext(cfg({
      INNERTUBE_CLIENT_VERSION: '1.2.3',
      INNERTUBE_CLIENT_NAME: 'WEB_REMIX',
      INNERTUBE_CONTEXT: { client: { clientVersion: 'old', extra: 1 }, user: { lockedSafetyMode: false } },
      HL: 'it',
      GL: 'IT'
    }));
    assert.deepEqual(ctx.client, { clientVersion: '1.2.3', extra: 1, clientName: 'WEB_REMIX', hl: 'it', gl: 'IT' });
    assert.deepEqual(ctx.user, { lockedSafetyMode: false });
  });

  test('applies defaults when optional values are missing', () => {
    const ctx = S.getPageInnerTubeContext(cfg({ INNERTUBE_CLIENT_VERSION: '1.0' }));
    assert.deepEqual(ctx.client, { clientVersion: '1.0', clientName: 'WEB_REMIX', hl: 'en', gl: 'US' });
  });

  test('returns null instead of throwing when ytcfg misbehaves', () => {
    assert.equal(S.getPageInnerTubeContext({ ytcfg: { get() { throw new Error('boom'); } } }), null);
  });
});

describe('Browse parse - requestPageInnerTubeContext', () => {
  afterEach(() => { delete globalThis.window; });

  /** A minimal window whose bridge answers (or not) when a request is posted. */
  function installWindow(onRequest) {
    const listeners = new Set();
    const win = {
      location: { origin: 'https://music.youtube.com' },
      addEventListener: (_, fn) => listeners.add(fn),
      removeEventListener: (_, fn) => listeners.delete(fn),
      // Async like a real postMessage: the reply never lands before the caller has returned.
      postMessage: (data) => { if (onRequest) onRequest(data, (msg) => queueMicrotask(() => listeners.forEach((fn) => fn(msg)))); },
      listenerCount: () => listeners.size
    };
    globalThis.window = win;
    return win;
  }

  test('resolves null when there is no window', async () => {
    assert.equal(await S.requestPageInnerTubeContext({ ttlMs: 0 }), null);
  });

  test('resolves the context answered by the bridge, then serves it from cache', async () => {
    const context = { client: { clientVersion: '5.5' } };
    let requests = 0;
    const win = installWindow((req, reply) => {
      requests++;
      assert.equal(req.source, 'ytmc:request-innerTube-context');
      reply({ source: win, data: { source: 'ytmc:innerTube-context', context } });
    });
    assert.deepEqual(await S.requestPageInnerTubeContext({ ttlMs: 0 }), context);
    assert.equal(win.listenerCount(), 0);

    assert.deepEqual(await S.requestPageInnerTubeContext({ ttlMs: 60000 }), context);
    assert.equal(requests, 1);
  });

  test('ignores foreign and malformed messages, then times out with null', async () => {
    const win = installWindow((_, reply) => {
      reply({ source: {}, data: { source: 'ytmc:innerTube-context', context: { bad: true } } });
      reply({ source: win, data: null });
      reply({ source: win, data: { source: 'other' } });
    });
    assert.equal(await S.requestPageInnerTubeContext({ timeoutMs: 10, ttlMs: 0 }), null);
    assert.equal(win.listenerCount(), 0);
  });

  test('resolves null when the bridge answers without a context', async () => {
    const win = installWindow((_, reply) => reply({ source: win, data: { source: 'ytmc:innerTube-context' } }));
    assert.equal(await S.requestPageInnerTubeContext({ ttlMs: 0 }), null);
  });

  test('resolves null when postMessage throws', async () => {
    const win = installWindow();
    win.postMessage = () => { throw new Error('blocked'); };
    assert.equal(await S.requestPageInnerTubeContext({ ttlMs: 0 }), null);
  });

  test('concurrent callers share one in-flight request', async () => {
    let requests = 0;
    installWindow(() => { requests++; });
    const a = S.requestPageInnerTubeContext({ timeoutMs: 10, ttlMs: 0 });
    const b = S.requestPageInnerTubeContext({ timeoutMs: 10, ttlMs: 0 });
    assert.equal(a, b);
    await a;
    assert.equal(requests, 1);
  });
});

describe('Browse parse - resolvePageInnerTubeContext', () => {
  afterEach(() => { delete globalThis.window; });

  test('prefers the synchronous ytcfg read', async () => {
    const scope = { ytcfg: { get: (k) => (k === 'INNERTUBE_CLIENT_VERSION' ? '2.0' : undefined) } };
    const ctx = await S.resolvePageInnerTubeContext(scope);
    assert.equal(ctx.client.clientVersion, '2.0');
  });

  test('falls back to the bridge request, resolving null without one', async () => {
    assert.equal(await S.resolvePageInnerTubeContext({}), null);
  });
});
