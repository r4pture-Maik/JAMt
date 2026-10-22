/**
 * content/content.js getHistoryItemMonth — reads a history row's section header
 * and hands it to shared/month-keys.js.
 *
 * content.js is one large DOM-bound IIFE, so the function (and its cache) is
 * lifted out of the real source and evaluated against a minimal fake DOM. The
 * test therefore fails if the shipped function changes shape or behaviour.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../shared/month-keys.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'content', 'content.js'), 'utf8');
const CURRENT = globalThis.YTMCMonths.monthIdFromDate(new Date());

/** Extracts the cache declaration and the function body from content.js. */
function loadGetHistoryItemMonth(documentStub, monthsApi = globalThis.YTMCMonths) {
  const cacheDecl = SOURCE.match(/const historyShelfMonthCache = new WeakMap\(\);/);
  const start = SOURCE.indexOf('function getHistoryItemMonth(');
  assert.ok(cacheDecl && start > 0, 'getHistoryItemMonth not found in content.js');
  // Walk braces to the end of the function.
  let depth = 0;
  let end = SOURCE.indexOf('{', start);
  for (; end < SOURCE.length; end++) {
    if (SOURCE[end] === '{') depth++;
    else if (SOURCE[end] === '}' && --depth === 0) break;
  }
  const fnSource = SOURCE.slice(start, end + 1);
  const factory = new Function('globalThis', 'document',
    `${cacheDecl[0]}\n${fnSource}\nreturn getHistoryItemMonth;`);
  return factory({ YTMCMonths: monthsApi }, documentStub);
}

/**
 * Tiny element model: tag name, text, children, parent. Supports the handful
 * of selectors the function uses.
 */
function el(tag, { text = '', id = '', cls = '' } = {}, children = []) {
  const node = { tag, id, cls, ownText: text, children, parentNode: null };
  children.forEach(c => { c.parentNode = node; });
  Object.defineProperty(node, 'textContent', {
    get() { return node.ownText + node.children.map(c => c.textContent).join(''); }
  });
  node.closest = (selector) => {
    const tags = selector.split(',').map(s => s.trim());
    for (let cur = node; cur; cur = cur.parentNode) if (tags.includes(cur.tag)) return cur;
    return null;
  };
  node.querySelectorAll = () => {
    // Document order walk; matches `h2`, `h2 yt-formatted-string`, `.title`.
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        const inH2 = c.tag === 'yt-formatted-string' && c.parentNode.tag === 'h2';
        if (c.tag === 'h2' || inH2 || c.cls.split(' ').includes('title')) out.push(c);
        walk(c);
      }
    };
    walk(node);
    return out;
  };
  return node;
}

function historyShelf(headerText, rowCount = 2) {
  const rows = Array.from({ length: rowCount }, (_, i) =>
    el('ytmusic-responsive-list-item-renderer', {}, [el('div', { cls: 'title', text: `Song ${i}` })]));
  const header = headerText === null ? [] : [el('h2', {}, [el('yt-formatted-string', { text: headerText })])];
  const shelf = el('ytmusic-shelf-renderer', {}, [...header, el('div', { id: 'contents' }, rows)]);
  return { shelf, rows };
}

const doc = (lang = 'en') => ({ documentElement: { lang } });

describe('content getHistoryItemMonth', () => {
  test('rows under a "MONTH YEAR" shelf get that month', () => {
    const get = loadGetHistoryItemMonth(doc());
    const { rows } = historyShelf('September 2025');
    assert.equal(get(rows[0]), '2025-09');
    assert.equal(get(rows[1]), '2025-09');
  });

  test('rows under relative shelves get the current month', () => {
    const get = loadGetHistoryItemMonth(doc());
    for (const h of ['Today', 'Yesterday', 'This week', 'Last week']) {
      assert.equal(get(historyShelf(h).rows[0]), CURRENT, h);
    }
  });

  test('uses the page language for localized headers', () => {
    const get = loadGetHistoryItemMonth(doc('nl'));
    assert.equal(get(historyShelf('mei 2025').rows[0]), '2025-05');
  });

  test('never mistakes a row title for the section header', () => {
    const get = loadGetHistoryItemMonth(doc());
    // No header: the only `.title` matches live inside rows ("Song 0"), and a
    // row titled like a month must not be read as one.
    const { rows } = historyShelf(null);
    rows[0].children[0].ownText = 'March 2024';
    assert.equal(get(rows[0]), CURRENT);
  });

  test('a row outside any shelf falls back to the current month', () => {
    const get = loadGetHistoryItemMonth(doc());
    assert.equal(get(el('ytmusic-responsive-list-item-renderer')), CURRENT);
    assert.equal(get(null), CURRENT);
  });

  test('resolves each shelf once', () => {
    let calls = 0;
    const api = {
      resolveHistorySectionMonth: (...a) => { calls++; return globalThis.YTMCMonths.resolveHistorySectionMonth(...a); }
    };
    const get = loadGetHistoryItemMonth(doc(), api);
    const { rows } = historyShelf('August 2025', 5);
    rows.forEach(r => assert.equal(get(r), '2025-08'));
    assert.equal(calls, 1);
  });

  test('returns empty when the month helper did not load', () => {
    const get = loadGetHistoryItemMonth(doc(), null);
    assert.equal(get(historyShelf('August 2025').rows[0]), '');
  });
});
