/**
 * shared/i18n.js — the localization runtime.
 *
 * Loaded with the same trick as tests/messaging.test.js: the module is a classic
 * IIFE that assigns to `globalThis`, so a `Function` constructor gives it the
 * exact scope shape it has in the browser while letting each test hand it a
 * fresh stub and a fresh set of module-level state.
 *
 * Three groups of assertions live here:
 *
 *   - Locale plumbing (plural categories, the AD-5 fallback chain, setLocale's
 *     validation). These are pure and need no stub at all, which is deliberate:
 *     they are the rules the whole localization rests on.
 *   - Runtime behaviour against a stubbed extension API (lookup, plural,
 *     formatting helpers, catalog hand-off, extension page vs content script).
 *   - Catalog invariants, read straight from `_locales/*`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'shared', 'i18n.js'), 'utf8');

/**
 * Evaluates the module against a stubbed global and returns its exports.
 *
 * @param {object} [globalObj] The stubbed `globalThis`; empty means "no
 *   extension API at all", which is a real case the module has to tolerate.
 * @returns {object} `globalThis.YTMCI18n`
 */
function loadI18n(globalObj = {}) {
  const factory = new Function('globalThis', `${SOURCE}\nreturn globalThis.YTMCI18n;`);
  return factory(globalObj);
}

/** loadI18n + init(): the locale is only known once the runtime has read the browser language. */
async function loadReady(globalObj) {
  const i18n = loadI18n(globalObj);
  await i18n.init();
  return i18n;
}

/**
 * A stub covering the extension APIs the module touches: `i18n.getUILanguage`,
 * `i18n.getMessage`, and a promise-based `storage.sync`.
 *
 * Its `getMessage` behaves like the real thing in the two ways that matter:
 * substitutions must be strings, and an unfilled `$n` is DROPPED (never left
 * verbatim). Together they make a plural() that forgets to pass the count, or
 * passes a number, fail loudly instead of passing by accident.
 *
 * @param {object} [options]
 * @param {string} [options.uiLanguage] Value returned by `getUILanguage()`.
 * @param {object} [options.catalog] Key -> `messages.json` entry, served by native `getMessage`.
 * @param {object} [options.stored] Initial `storage.sync` contents.
 * @param {string} [options.protocol] `location.protocol`; omit for "no location" (plain Node).
 * @param {object} [options.fetchCatalogs] Locale -> catalog, served by the stub `fetch`.
 */
function i18nStub({ uiLanguage = 'en', catalog = null, stored = {}, protocol = null, fetchCatalogs = null } = {}) {
  const sync = {
    items: { ...stored },
    writes: [],
    get(key) {
      const items = (key in this.items) ? { [key]: this.items[key] } : {};
      return Promise.resolve(items);
    },
    set(items) {
      this.writes.push(items);
      Object.assign(this.items, items);
      return Promise.resolve();
    },
    remove(key) {
      this.writes.push(key);
      delete this.items[key];
      return Promise.resolve();
    }
  };

  const globalObj = {
    chrome: {
      runtime: {
        id: 'test-id',
        getURL: (path) => `chrome-extension://test-id/${path}`
      },
      i18n: {
        getUILanguage: () => uiLanguage,
        getMessage(key, subs) {
          const entry = catalog && catalog[key];
          if (!entry) return '';
          const message = typeof entry === 'string' ? entry : entry.message;
          const list = subs === undefined ? [] : subs;
          if (!Array.isArray(list) || list.some((value) => typeof value !== 'string')) {
            throw new TypeError('getMessage substitutions must be an array of strings');
          }
          return message.replace(/\$(\d)/g, (_, digit) => list[Number(digit) - 1] ?? '');
        }
      },
      storage: { sync, onChanged: { addListener() {} } }
    },
    fetchCalls: [],
    document: { documentElement: { lang: 'host-page-lang' } }
  };

  if (protocol) globalObj.location = { protocol };
  if (fetchCatalogs) {
    globalObj.fetch = (url) => {
      globalObj.fetchCalls.push(url);
      const locale = /_locales\/([^/]+)\//.exec(url)?.[1];
      const data = fetchCatalogs[locale];
      return Promise.resolve({ ok: Boolean(data), status: data ? 200 : 404, json: () => Promise.resolve(data) });
    };
  }

  globalObj._sync = sync;
  return globalObj;
}

/** Runs `fn` with `console.warn` captured; returns the warning messages. */
function captureWarnings(fn) {
  const messages = [];
  const original = console.warn;
  console.warn = (...args) => { messages.push(args.map(String).join(' ')); };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return messages;
}

/** English forms for the duration and size helpers. */
const EN_UNITS = {
  msg_count_hour_one: { message: '$1 hr' },
  msg_count_hour_other: { message: '$1 hrs' },
  msg_count_minute_one: { message: '$1 min' },
  msg_count_minute_other: { message: '$1 mins' },
  msg_durationUnderOneMinute: { message: '< 1 min' },
  msg_cache_size_kb: { message: '$1 KB' },
  msg_cache_size_mb: { message: '$1 MB' },
  msg_artist_unknown: { message: 'Unknown' }
};

describe('i18n - locale plumbing (no extension API required)', () => {
  const i18n = loadI18n();

  test('exposes the shipped locale set with en as the default', () => {
    assert.equal(i18n.DEFAULT_LOCALE, 'en');
    assert.deepEqual(i18n.SUPPORTED_LOCALES, ['en', 'de', 'es', 'fr', 'it', 'pt_BR']);
  });

  test('does not export internals that moved or were removed', () => {
    for (const removed of ['extBrowser', 'OVERRIDE_STORAGE_KEY', 'applySubstitutions']) {
      assert.equal(removed in i18n, false, `${removed} must not be exported`);
    }
  });

  /**
   * AD-6. These are the exact cases the plural mechanism exists for: a
   * `count === 1 ?` ternary gets `fr` at 0 and `pt_BR` at 0 wrong.
   */
  describe('plural category selection (AD-6)', () => {
    test('English: one for 1, other for everything else', () => {
      assert.equal(i18n.selectPluralCategory('en', 1), 'one');
      assert.equal(i18n.selectPluralCategory('en', 0), 'other');
      assert.equal(i18n.selectPluralCategory('en', 2), 'other');
      assert.equal(i18n.selectPluralCategory('en', 5), 'other');
    });

    test('French: `one` covers BOTH 0 and 1, `other` from 2', () => {
      // `0 play` is singular in French. This is the case a hand-written rule
      // gets wrong, so it is asserted twice over.
      assert.equal(i18n.selectPluralCategory('fr', 0), 'one');
      assert.equal(i18n.selectPluralCategory('fr', 1), 'one');
      assert.equal(i18n.selectPluralCategory('fr', 2), 'other');
      assert.equal(i18n.selectPluralCategory('fr', 100), 'other');
    });

    test('pt_BR: 0 is `other` (declared deviation from CLDR), one for 1, other from 2', () => {
      // CLDR says `one` at 0, Brazilian usage is "0 reproducoes". `zero` is never returned.
      assert.equal(i18n.selectPluralCategory('pt_BR', 0), 'other');
      assert.equal(i18n.selectPluralCategory('pt_BR', 1), 'one');
      assert.equal(i18n.selectPluralCategory('pt_BR', 2), 'other');
    });

    test('de, es and it use the simple one/other pair', () => {
      for (const locale of ['de', 'es', 'it']) {
        assert.equal(i18n.selectPluralCategory(locale, 0), 'other', `${locale} at 0`);
        assert.equal(i18n.selectPluralCategory(locale, 1), 'one', `${locale} at 1`);
        assert.equal(i18n.selectPluralCategory(locale, 3), 'other', `${locale} at 3`);
      }
    });

    test('never returns `zero`, accepts either separator, and an unusable locale never throws', () => {
      for (const locale of i18n.SUPPORTED_LOCALES) {
        assert.notEqual(i18n.selectPluralCategory(locale, 0), 'zero', `${locale} at 0`);
      }
      assert.equal(i18n.selectPluralCategory('pt-BR', 0), 'other');
      assert.equal(i18n.selectPluralCategory('en', NaN), 'other', 'a non-finite count degrades to other');
      assert.equal(i18n.selectPluralCategory(null, 1), 'one', 'null falls back to the default locale');
      assert.equal(i18n.selectPluralCategory('not a locale!!', 1), 'other', 'an invalid tag degrades to other');
    });
  });

  /**
   * AD-5. The chain is ours and is asserted as a chain, not only as a result.
   */
  describe('locale fallback chain (AD-5)', () => {
    test('the chain for pt_BR walks pt_BR -> pt -> en', () => {
      assert.deepEqual(i18n.localeChain('pt_BR'), ['pt-BR', 'pt', 'en']);
      assert.deepEqual(i18n.localeChain('pt-BR'), ['pt-BR', 'pt', 'en']);
    });

    test('a region-only request resolves to the regionless locale', () => {
      assert.deepEqual(i18n.localeChain('de-AT'), ['de-AT', 'de', 'en']);
      assert.equal(i18n.resolveLocale('de-AT'), 'de');
    });

    test('resolveLocale walks the chain and lands on a shipped locale', () => {
      assert.equal(i18n.resolveLocale('pt_BR'), 'pt_BR', 'an exact match needs no fallback');
      assert.equal(i18n.resolveLocale('en-GB'), 'en');
      assert.equal(i18n.resolveLocale('it-CH'), 'it');
    });

    test('an unsupported or missing request lands on the default, never on nothing', () => {
      assert.equal(i18n.resolveLocale('de-AT'), 'de');
      assert.equal(i18n.resolveLocale('xx'), 'en');
      assert.equal(i18n.resolveLocale(''), 'en');
      assert.equal(i18n.resolveLocale(null), 'en');
      assert.equal(i18n.resolveLocale(undefined), 'en');

      // `pt_PT` must not silently become `pt_BR`: that is the wrong language,
      // not a safe one, and the catalogs for it are Brazilian.
      assert.equal(i18n.resolveLocale('pt_PT'), 'en');
      // Matching is exact for the same reason: we ship `pt_BR`, not `pt`, so a
      // bare `pt` finds no catalog rather than silently reading as Brazilian.
      assert.equal(i18n.resolveLocale('pt'), 'en');

      for (const locale of ['xx', '', null, 'de-AT', 'pt-BR', 'fr']) {
        assert.ok(
          i18n.SUPPORTED_LOCALES.includes(i18n.resolveLocale(locale)),
          `resolveLocale(${JSON.stringify(locale)}) must return a shipped locale`
        );
      }
    });

    test('normalizeLocale canonicalises case and separators', () => {
      assert.equal(i18n.normalizeLocale('pt_br'), 'pt-BR');
      assert.equal(i18n.normalizeLocale('PT-br'), 'pt-BR');
      assert.equal(i18n.normalizeLocale('  de-at  '), 'de-AT');
      assert.equal(i18n.normalizeLocale(null), '');
      assert.equal(i18n.normalizeLocale(42), '');
    });

    test('intlLocale gives the BCP-47 form every Intl constructor accepts', () => {
      assert.equal(i18n.intlLocale('pt_BR'), 'pt-BR');
      assert.equal(i18n.intlLocale('de'), 'de');
      assert.equal(i18n.intlLocale(), 'en', 'defaults to the resolved locale');
      assert.doesNotThrow(() => new Intl.PluralRules(i18n.intlLocale('pt_BR')));
      assert.throws(() => new Intl.PluralRules('pt_BR'), RangeError, 'the raw catalog code is NOT valid BCP-47');
    });
  });

  describe('t() and plural() degrade without throwing', () => {
    test('t() before init() resolves returns a string, never throws', () => {
      // No chrome stub at all: `extBrowser` is undefined here, which is the
      // context a plain page or a revoked-permission worker lands in.
      const bare = loadI18n();
      assert.doesNotThrow(() => bare.t('msg_extName'));
      assert.equal(typeof bare.t('msg_extName'), 'string');
      assert.equal(bare.t('msg_extName'), '');
      assert.equal(bare.plural('msg_count_play', 1), '');
      assert.equal(bare.getLocale(), 'en', 'the resolved locale is readable before init');
      assert.equal(bare.getOverride(), null);
      assert.equal(bare.needsCatalog(), false);
    });

    test('t() rejects a non-string key with an empty string', () => {
      const bare = loadI18n();
      assert.equal(bare.t(null), '');
      assert.equal(bare.t(undefined), '');
      assert.equal(bare.t(''), '');
      assert.equal(bare.t(42), '');
      assert.equal(bare.plural('', 1), '');
    });
  });
});

describe('i18n - message lookup', () => {
  const CATALOG = {
    msg_extName: { message: 'YTMusic Counter' },
    msg_greeting: { message: 'Hello, $1!' },
    msg_count_play_one: { message: '$1 play' },
    msg_count_play_other: { message: '$1 plays' },
    // Ships ONLY the `_other` form, to exercise the silent fallback chain.
    msg_partial_other: { message: 'fallback' }
  };

  test('resolves a key through the native path', () => {
    const i18n = loadI18n(i18nStub({ catalog: CATALOG }));
    assert.equal(i18n.t('msg_greeting', ['Ada']), 'Hello, Ada!');
  });

  test('t() coerces substitutions to strings before they reach getMessage', () => {
    // The stub throws on a non-string substitution, exactly like a strict engine.
    const i18n = loadI18n(i18nStub({ catalog: CATALOG }));
    assert.equal(i18n.t('msg_greeting', [5]), 'Hello, 5!');
    assert.equal(i18n.t('msg_greeting', [null]), 'Hello, !');
    assert.equal(i18n.t('msg_greeting', 7), 'Hello, 7!', 'a lone scalar is accepted too');
  });

  test('warns exactly once per missing key and returns an empty string', () => {
    // A fresh module instance, because the "warn once" set is module state and
    // is exactly what this test is measuring.
    const i18n = loadI18n(i18nStub({ catalog: CATALOG }));

    const warnings = captureWarnings(() => {
      assert.equal(i18n.t('msg_doesNotExist'), '');
      assert.equal(i18n.t('msg_doesNotExist'), '');
      assert.equal(i18n.t('msg_doesNotExist'), '');
    });

    const aboutKey = warnings.filter((line) => line.includes('msg_doesNotExist'));
    assert.equal(aboutKey.length, 1, 'a missing key warns once, not once per call');

    // A different key is still reported - the memo is per key, not global.
    const more = captureWarnings(() => { i18n.t('msg_alsoMissing'); });
    assert.equal(more.filter((line) => line.includes('msg_alsoMissing')).length, 1);
  });

  test('plural() always passes the count as $1, even when getMessage drops unfilled placeholders', () => {
    // Regression guard for F1: the stub's getMessage strips a `$1` that was not
    // filled, so a plural() that reads the raw template would return " plays".
    const i18n = loadI18n(i18nStub({ catalog: CATALOG, uiLanguage: 'en' }));

    assert.equal(i18n.plural('msg_count_play', 1), '1 play');
    assert.equal(i18n.plural('msg_count_play', 0), '0 plays');
    assert.equal(i18n.plural('msg_count_play', 5), '5 plays');
    assert.equal(i18n.plural('msg_count_play', 1234), '1,234 plays', 'the count is localized');
  });

  test('plural() follows the French rule: 0 takes the singular form', async () => {
    const i18n = await loadReady(i18nStub({ uiLanguage: 'fr', catalog: CATALOG }));
    assert.equal(i18n.plural('msg_count_play', 0), '0 play');
    assert.equal(i18n.plural('msg_count_play', 2), '2 plays');
  });

  test('plural() falls back to _other, and warns only when that fails too', () => {
    const i18n = loadI18n(i18nStub({ catalog: CATALOG, uiLanguage: 'en' }));

    // A base key with only an `_other` form: en at 1 selects `one`, which is
    // absent, so the silent `_other` fallback answers instead.
    const warnings = captureWarnings(() => {
      assert.equal(i18n.plural('msg_partial', 1), 'fallback');
      assert.equal(i18n.plural('msg_partial', 0), 'fallback');
    });
    assert.deepEqual(warnings, [], 'an absent category is walked silently');

    const unwarned = captureWarnings(() => { assert.equal(i18n.plural('msg_missing_base', 1), ''); });
    assert.equal(unwarned.length, 1, 'a fully unresolvable base key does warn');
    assert.ok(unwarned[0].includes('msg_missing_base'));
  });

  test('plural() does not fall back to the bare base key', () => {
    const i18n = loadI18n(i18nStub({ catalog: { msg_thing: { message: '$1 things' } } }));
    const warnings = captureWarnings(() => { assert.equal(i18n.plural('msg_thing', 3), ''); });
    assert.equal(warnings.length, 1);
  });
});

describe('i18n - formatting helpers', () => {
  test('formatNumber follows the active locale and tolerates junk', async () => {
    const en = await loadReady(i18nStub({ uiLanguage: 'en' }));
    const de = await loadReady(i18nStub({ uiLanguage: 'de' }));
    assert.equal(en.formatNumber(1234567), '1,234,567');
    assert.equal(de.formatNumber(1234567), '1.234.567');
    assert.equal(de.formatNumber(1.5, { minimumFractionDigits: 1 }), '1,5');
    assert.equal(en.formatNumber(NaN), '0');
    assert.equal(en.formatNumber(Infinity), '0');
    assert.equal(en.formatNumber(undefined), '0');
  });

  test('formatNumber works for pt_BR (underscore code must not reach Intl)', async () => {
    const i18n = loadI18n(i18nStub({ uiLanguage: 'en', stored: { language: 'pt_BR' } }));
    await i18n.init();
    assert.equal(i18n.getLocale(), 'pt_BR');
    assert.equal(i18n.formatNumber(1234.5, { minimumFractionDigits: 1 }), '1.234,5');
  });

  test('formatBytes: KB with one decimal below 1 MiB, MB with two above', async () => {
    const en = await loadReady(i18nStub({ catalog: EN_UNITS }));
    assert.equal(en.formatBytes(0), '0.0 KB');
    assert.equal(en.formatBytes(512), '0.5 KB');
    assert.equal(en.formatBytes(1536), '1.5 KB');
    assert.equal(en.formatBytes(1048575), '1,024.0 KB');
    assert.equal(en.formatBytes(1048576), '1.00 MB');
    assert.equal(en.formatBytes(1.5 * 1048576), '1.50 MB');
    assert.equal(en.formatBytes(-5), '0.0 KB', 'negative input is clamped');

    const de = await loadReady(i18nStub({ uiLanguage: 'de', catalog: EN_UNITS }));
    assert.equal(de.formatBytes(1536), '1,5 KB', 'the decimal separator is localized');
  });

  test('formatDuration reproduces the English reference output', () => {
    const i18n = loadI18n(i18nStub({ catalog: EN_UNITS }));
    assert.equal(i18n.formatDuration(0), '0 min');
    assert.equal(i18n.formatDuration(45), '< 1 min');
    assert.equal(i18n.formatDuration(120), '2 mins');
    assert.equal(i18n.formatDuration(3665), '1 hr 1 min');
    assert.equal(i18n.formatDuration(52080), '14 hrs 28 mins');
    // A zero part is omitted, and junk never throws.
    assert.equal(i18n.formatDuration(3600), '1 hr');
    assert.equal(i18n.formatDuration(7260), '2 hrs 1 min');
    assert.equal(i18n.formatDuration(-10), '0 min');
    assert.equal(i18n.formatDuration(undefined), '0 min');
    assert.equal(i18n.formatDuration(59.9), '< 1 min');
  });

  test('formatDuration runs through the active locale (fr)', async () => {
    const FR = {
      msg_count_hour_one: { message: '$1 h' },
      msg_count_hour_other: { message: '$1 h' },
      msg_count_minute_one: { message: '$1 min' },
      msg_count_minute_other: { message: '$1 min' },
      msg_durationUnderOneMinute: { message: '< 1 min' }
    };
    const i18n = await loadReady(i18nStub({ uiLanguage: 'fr', catalog: FR }));
    assert.equal(i18n.formatDuration(0), '0 min');
    assert.equal(i18n.formatDuration(3665), '1 h 1 min');
    assert.equal(i18n.formatDuration(52080), '14 h 28 min');
  });

  test('displayArtist translates the stored sentinel only', async () => {
    const i18n = await loadReady(i18nStub({ uiLanguage: 'es', catalog: { msg_artist_unknown: { message: 'Desconocido' } } }));
    assert.equal(i18n.displayArtist('Unknown Artist'), 'Desconocido');
    assert.equal(i18n.displayArtist(''), 'Desconocido');
    assert.equal(i18n.displayArtist('   '), 'Desconocido');
    assert.equal(i18n.displayArtist(null), 'Desconocido');
    assert.equal(i18n.displayArtist(undefined), 'Desconocido');
    assert.equal(i18n.displayArtist('Daft Punk'), 'Daft Punk');
    assert.equal(i18n.displayArtist('Unknown'), 'Unknown', 'only the stored sentinel is special');
  });
});

describe('i18n - localizeDocument', () => {
  function fakeElement(attributes) {
    return {
      attributes,
      title: '',
      placeholder: '',
      textContent: 'inline English',
      labels: {},
      getAttribute(name) { return name in attributes ? attributes[name] : null; },
      setAttribute(name, value) { this.labels[name] = value; }
    };
  }

  test('does one query for all four attributes and applies each sink', () => {
    const i18n = loadI18n(i18nStub({ catalog: {
      msg_a: { message: 'A' }, msg_b: { message: 'B $1' }, msg_c: { message: 'C' }, msg_d: { message: 'D' }
    } }));
    const element = fakeElement({
      'data-i18n': 'msg_a',
      'data-i18n-title': 'msg_b:x',
      'data-i18n-placeholder': 'msg_c',
      'data-i18n-aria-label': 'msg_d'
    });
    const missing = fakeElement({ 'data-i18n': 'msg_nope' });
    const queries = [];
    const scope = { querySelectorAll(selector) { queries.push(selector); return [element, missing]; } };

    captureWarnings(() => i18n.localizeDocument(scope));

    assert.equal(queries.length, 1, 'a single querySelectorAll');
    for (const attribute of ['data-i18n', 'data-i18n-title', 'data-i18n-placeholder', 'data-i18n-aria-label']) {
      assert.ok(queries[0].includes(`[${attribute}]`), `selector covers ${attribute}`);
    }
    assert.equal(element.textContent, 'A');
    assert.equal(element.title, 'B x');
    assert.equal(element.placeholder, 'C');
    assert.equal(element.labels['aria-label'], 'D');
    assert.equal(missing.textContent, 'inline English', 'an unresolvable key leaves the inline English alone');
  });
});

describe('i18n - catalog hand-off and execution context', () => {
  const NATIVE = { msg_greeting: { message: 'Hello, $1!' } };

  test('needsCatalog is false only for English that the browser also speaks', async () => {
    const none = loadI18n(i18nStub({ uiLanguage: 'en' }));
    await none.init();
    assert.equal(none.needsCatalog(), false, 'English, no override');

    const sameEnglish = loadI18n(i18nStub({ uiLanguage: 'en-GB', stored: { language: 'en' } }));
    await sameEnglish.init();
    assert.equal(sameEnglish.needsCatalog(), false, 'English override on an English browser');

    // Native getMessage is not trusted for a non-default locale: Firefox can
    // report `de` while serving the English default.
    const same = loadI18n(i18nStub({ uiLanguage: 'de-AT', stored: { language: 'de' } }));
    await same.init();
    assert.equal(same.needsCatalog(), true, 'override equals the browser locale');

    const followsBrowser = loadI18n(i18nStub({ uiLanguage: 'it' }));
    await followsBrowser.init();
    assert.equal(followsBrowser.needsCatalog(), true, 'no override on a non-English browser');

    const differs = loadI18n(i18nStub({ uiLanguage: 'en', stored: { language: 'fr' } }));
    await differs.init();
    assert.equal(differs.needsCatalog(), true);

    const englishOverride = loadI18n(i18nStub({ uiLanguage: 'fr', stored: { language: 'en' } }));
    await englishOverride.init();
    assert.equal(englishOverride.needsCatalog(), true, 'English override on a French browser');
  });

  test('a non-English browser with no override loads its own catalog (Firefox serves English natively)', async () => {
    const stub = i18nStub({
      uiLanguage: 'it',
      catalog: { msg_greeting: { message: 'Hello, $1!' } },
      protocol: 'moz-extension:',
      fetchCatalogs: { it: { msg_greeting: { message: 'Ciao, $1!' } } }
    });
    const i18n = loadI18n(stub);
    await i18n.init();

    assert.equal(i18n.getOverride(), null);
    assert.equal(i18n.getLocale(), 'it');
    assert.equal(i18n.t('msg_greeting', ['Ada']), 'Ciao, Ada!');
  });

  test('static text is re-localized before subscribers run on a locale change', async () => {
    const stub = i18nStub({ uiLanguage: 'en', protocol: 'chrome-extension:', fetchCatalogs: { de: {} } });
    const order = [];
    stub.document.querySelectorAll = () => { order.push('localize'); return []; };
    const i18n = loadI18n(stub);
    await i18n.init();
    i18n.onLocaleChanged(() => order.push('subscriber'));
    order.length = 0;

    await i18n.setLocale('de');
    assert.ok(order.indexOf('localize') !== -1 && order.indexOf('subscriber') !== -1);
    assert.ok(order.lastIndexOf('localize') < order.indexOf('subscriber'), `got ${order.join(',')}`);
  });

  test('setCatalog installs templates and getMessages serves them back', async () => {
    const i18n = loadI18n(i18nStub({ uiLanguage: 'en', catalog: NATIVE, stored: { language: 'de' } }));
    await i18n.init();
    assert.equal(i18n.getLocale(), 'de');

    assert.deepEqual(i18n.getMessages(['msg_greeting', 'msg_nope']), { msg_greeting: '', msg_nope: '' },
      'without a loaded catalog every key is empty');
    assert.equal(i18n.t('msg_greeting', ['Ada']), 'Hello, Ada!', 'native answers until a catalog is installed');

    i18n.setCatalog('de', { msg_greeting: 'Hallo, $1!', msg_other: { message: 'Anderes' } });
    assert.equal(i18n.t('msg_greeting', ['Ada']), 'Hallo, Ada!');
    assert.equal(i18n.t('msg_other'), 'Anderes');
    assert.deepEqual(i18n.getMessages(['msg_greeting', 'msg_nope']), { msg_greeting: 'Hallo, $1!', msg_nope: '' });
    assert.deepEqual(i18n.getMessages(null), {});
  });

  test('a catalog for a different locale than the resolved one is never consulted', async () => {
    const i18n = loadI18n(i18nStub({ uiLanguage: 'en', catalog: NATIVE, stored: { language: 'de' } }));
    await i18n.init();
    i18n.setCatalog('fr', { msg_greeting: 'Bonjour, $1 !' });
    assert.equal(i18n.t('msg_greeting', ['Ada']), 'Hello, Ada!');
  });

  test('switching locale drops the installed catalog', async () => {
    const i18n = loadI18n(i18nStub({ uiLanguage: 'en', catalog: NATIVE, stored: { language: 'de' } }));
    await i18n.init();
    i18n.setCatalog('de', { msg_greeting: 'Hallo, $1!' });
    await i18n.setLocale('');
    assert.equal(i18n.needsCatalog(), false);
    assert.equal(i18n.t('msg_greeting', ['Ada']), 'Hello, Ada!');
    assert.deepEqual(i18n.getMessages(['msg_greeting']), { msg_greeting: '' });
  });

  test('a content-script context never fetches _locales and never touches <html lang>', async () => {
    const stub = i18nStub({
      uiLanguage: 'en',
      stored: { language: 'de' },
      protocol: 'https:',
      fetchCatalogs: { de: { msg_greeting: { message: 'Hallo, $1!' } } }
    });
    const i18n = loadI18n(stub);
    await i18n.init();

    assert.equal(i18n.getLocale(), 'de', 'the override is still resolved');
    assert.equal(i18n.needsCatalog(), true);
    assert.deepEqual(stub.fetchCalls, [], 'no fetch');
    assert.equal(stub.document.documentElement.lang, 'host-page-lang', 'the host document is left alone');
  });

  test('an extension page fetches the override catalog once and sets <html lang>', async () => {
    const stub = i18nStub({
      uiLanguage: 'en',
      catalog: NATIVE,
      stored: { language: 'de' },
      protocol: 'chrome-extension:',
      fetchCatalogs: { de: { msg_greeting: { message: 'Hallo, $1!' } } }
    });
    const i18n = loadI18n(stub);
    await i18n.init();
    await i18n.init();

    assert.deepEqual(stub.fetchCalls, ['chrome-extension://test-id/_locales/de/messages.json']);
    assert.equal(stub.document.documentElement.lang, 'de');
    assert.equal(i18n.t('msg_greeting', ['Ada']), 'Hallo, Ada!');
    assert.deepEqual(i18n.getMessages(['msg_greeting']), { msg_greeting: 'Hallo, $1!' });
  });

  test('moz-extension pages count as extension pages; a failed fetch falls back to native', async () => {
    const stub = i18nStub({
      uiLanguage: 'en',
      catalog: NATIVE,
      stored: { language: 'it' },
      protocol: 'moz-extension:',
      fetchCatalogs: {}
    });
    const i18n = loadI18n(stub);
    const original = console.warn;
    console.warn = () => {};
    try {
      await i18n.init();
    } finally {
      console.warn = original;
    }
    assert.equal(stub.fetchCalls.length, 1);
    assert.equal(stub.document.documentElement.lang, 'it');
    assert.equal(i18n.t('msg_greeting', ['Ada']), 'Hello, Ada!');
  });
});

describe('i18n - setLocale validation', () => {
  test('rejects an unsupported locale rather than coercing it', async () => {
    for (const unsupported of ['de-AT', 'xx', 'deu', 'pt-PT', 'EN-gb']) {
      const stub = i18nStub();
      const i18n = loadI18n(stub);

      await assert.rejects(
        () => i18n.setLocale(unsupported),
        TypeError,
        `setLocale(${JSON.stringify(unsupported)}) must reject`
      );
      // Nothing was written, so the user is not stranded in a locale we do not
      // ship with no way back.
      assert.deepEqual(stub._sync.writes, [], `setLocale(${JSON.stringify(unsupported)}) must not write`);
    }
  });

  test('accepts every shipped locale and persists it to storage.sync (AD-9)', async () => {
    for (const locale of ['en', 'de', 'es', 'fr', 'it', 'pt_BR']) {
      const stub = i18nStub({ uiLanguage: 'en' });
      const i18n = loadI18n(stub);

      await i18n.setLocale(locale);
      assert.equal(stub._sync.items.language, locale, `${locale} must be persisted`);
      assert.equal(i18n.getOverride(), locale);
      assert.equal(i18n.getLocale(), locale);
    }
  });

  test("'' and null clear the override and hand control back to the browser", async () => {
    for (const cleared of ['', '   ', null, undefined]) {
      const stub = i18nStub({ uiLanguage: 'de-AT', stored: { language: 'fr' } });
      const i18n = loadI18n(stub);
      await i18n.init();
      assert.equal(i18n.getOverride(), 'fr');

      await i18n.setLocale(cleared);
      assert.equal(i18n.getOverride(), null, `setLocale(${JSON.stringify(cleared)}) must clear the override`);
      assert.equal(i18n.getLocale(), 'de', 'and re-resolve against the browser locale');
      assert.equal('language' in stub._sync.items, false, 'and remove the stored key');
    }
  });

  test('the stored override survives init and wins over the browser locale', async () => {
    const stub = i18nStub({ uiLanguage: 'en', stored: { language: 'it' } });
    const i18n = loadI18n(stub);
    await i18n.init();

    assert.equal(i18n.getOverride(), 'it');
    assert.equal(i18n.getLocale(), 'it');
    assert.equal(i18n.getBrowserLocale(), 'en');
  });

  test('init() is idempotent and resolves even with no storage API at all', async () => {
    const i18n = loadI18n({ chrome: { runtime: {}, i18n: { getUILanguage: () => 'fr' } } });
    await assert.doesNotReject(() => i18n.init());
    await i18n.init();
    assert.equal(i18n.getLocale(), 'fr');
  });

  test('onLocaleChanged fires on a switch and stops after unsubscribe', async () => {
    const stub = i18nStub({ uiLanguage: 'en' });
    const i18n = loadI18n(stub);
    await i18n.init();

    const seen = [];
    const unsubscribe = i18n.onLocaleChanged((locale) => { seen.push(locale); });

    await i18n.setLocale('de');
    assert.deepEqual(seen, ['de']);

    unsubscribe();
    await i18n.setLocale('fr');
    assert.deepEqual(seen, ['de'], 'an unsubscribed listener must not fire again');
  });

  test('the storage.onChanged echo of our own write does not re-notify', async () => {
    const stub = i18nStub({ uiLanguage: 'en' });
    let onChanged = null;
    stub.chrome.storage.onChanged = { addListener(fn) { onChanged = fn; } };
    const i18n = loadI18n(stub);
    await i18n.init();

    const seen = [];
    i18n.onLocaleChanged((locale) => seen.push(locale));
    await i18n.setLocale('de');
    onChanged({ language: { newValue: 'de' } }, 'sync');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, ['de'], 'one notification for one switch');

    // A genuine external change (another page) is applied.
    onChanged({ language: { newValue: 'fr' } }, 'sync');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(i18n.getLocale(), 'fr');
    assert.deepEqual(seen, ['de', 'fr']);

    // Other areas and other keys are ignored.
    onChanged({ language: { newValue: 'it' } }, 'local');
    onChanged({ somethingElse: { newValue: 'it' } }, 'sync');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(i18n.getLocale(), 'fr');
  });

  test('init() does not resolve until an externally changed override has its catalog', async () => {
    // The background answers GET_LOCALIZED_MESSAGES behind `await init()`; a
    // content script asks the moment it sees the same storage event.
    const stub = i18nStub({
      uiLanguage: 'en',
      protocol: 'chrome-extension:',
      fetchCatalogs: { de: { msg_albums_other: { message: '$1 Alben' } } }
    });
    let onChanged = null;
    stub.chrome.storage.onChanged = { addListener(fn) { onChanged = fn; } };
    const i18n = loadI18n(stub);
    await i18n.init();

    onChanged({ language: { newValue: 'de' } }, 'sync');
    await i18n.init();
    assert.equal(i18n.needsCatalog(), true);
    assert.equal(i18n.getMessages(['msg_albums_other']).msg_albums_other, '$1 Alben');
  });
});

/**
 * Catalog invariants, read straight from `_locales/*`. These are the contract
 * between the six translations: same keys, same placeholders, plural pairs,
 * brand strings untouched, and nothing but `message` in the translated files.
 */
describe('i18n - catalogs', () => {
  const LOCALES_DIR = join(ROOT, '_locales');
  const i18n = loadI18n();
  const LOCALES = i18n.SUPPORTED_LOCALES;

  // Read per test (not at collection time) so one missing file fails one test
  // with a readable path instead of aborting the whole file.
  function readCatalogs() {
    const catalogs = {};
    for (const locale of LOCALES) {
      catalogs[locale] = JSON.parse(readFileSync(join(LOCALES_DIR, locale, 'messages.json'), 'utf8'));
    }
    return catalogs;
  }
  const placeholders = (entry) => (String(entry.message).match(/\$\d/g) || []).sort().join(' ');

  test('every locale has exactly the key set of en', () => {
    const catalogs = readCatalogs();
    const en = catalogs[i18n.DEFAULT_LOCALE];
    const enKeys = Object.keys(en).sort();
    for (const locale of LOCALES) {
      const keys = Object.keys(catalogs[locale]).sort();
      const missing = enKeys.filter((key) => !(key in catalogs[locale]));
      const extra = keys.filter((key) => !(key in en));
      assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${locale} key set differs from en`);
    }
  });

  test('every message carries the same $n placeholders as en', () => {
    const catalogs = readCatalogs();
    const en = catalogs[i18n.DEFAULT_LOCALE];
    for (const locale of LOCALES) {
      for (const [key, entry] of Object.entries(catalogs[locale])) {
        if (!(key in en)) continue;
        assert.equal(placeholders(entry), placeholders(en[key]), `${locale}/${key}: placeholders differ from en`);
      }
    }
  });

  test('plural forms come in complete pairs, with no _zero and no base+forms clash', () => {
    const catalogs = readCatalogs();
    const en = catalogs[i18n.DEFAULT_LOCALE];
    for (const locale of LOCALES) {
      const keys = Object.keys(catalogs[locale]);
      const set = new Set(keys);
      for (const key of keys) {
        assert.ok(!key.endsWith('_zero'), `${locale}/${key}: _zero forms are not shipped`);
        if (key.endsWith('_one')) {
          assert.ok(set.has(`${key.slice(0, -4)}_other`), `${locale}/${key}: no matching _other`);
        }
        if (key.endsWith('_other')) {
          assert.ok(set.has(`${key.slice(0, -6)}_one`), `${locale}/${key}: no matching _one`);
        }
        assert.ok(
          !(set.has(`${key}_one`) || set.has(`${key}_other`)),
          `${locale}/${key}: is both a plain key and the base of plural forms`
        );
      }
    }
  });

  test('extName and actionTitle are byte-identical in every catalog (AD-7)', () => {
    const catalogs = readCatalogs();
    const en = catalogs[i18n.DEFAULT_LOCALE];
    // The manifest-resolved keys are the only unprefixed ones: `__MSG_extName__`
    // resolves to a catalog key called `extName`.
    for (const key of ['extName', 'actionTitle']) {
      assert.ok(en[key], `the English catalog must define ${key}`);
      for (const locale of LOCALES) {
        const entry = catalogs[locale][key];
        assert.ok(entry, `${locale} must define ${key}`);
        // Buffer comparison, not `===`: "byte-identical" is the actual requirement.
        assert.deepEqual(
          Buffer.from(entry.message, 'utf8'),
          Buffer.from(en[key].message, 'utf8'),
          `${key} differs in ${locale} - the brand name is never translated (AD-7)`
        );
      }
    }
  });

  test('translated catalogs carry only `message` (no description, no placeholders)', () => {
    const catalogs = readCatalogs();
    const en = catalogs[i18n.DEFAULT_LOCALE];
    for (const locale of LOCALES) {
      if (locale === i18n.DEFAULT_LOCALE) continue;
      for (const [key, entry] of Object.entries(catalogs[locale])) {
        assert.deepEqual(Object.keys(entry), ['message'], `${locale}/${key} must hold only a message`);
        assert.equal(typeof entry.message, 'string', `${locale}/${key} message must be a string`);
        assert.ok(entry.message.length > 0, `${locale}/${key} message must not be empty`);
      }
    }
  });

  test('en descriptions do not leak planning jargon', () => {
    const catalogs = readCatalogs();
    const en = catalogs[i18n.DEFAULT_LOCALE];
    const jargon = /AD-\d|wave [A-D]|\bB[1-7]\b|\bA[1-4]\b|fragment/;
    for (const [key, entry] of Object.entries(en)) {
      if (typeof entry.description !== 'string') continue;
      assert.ok(!jargon.test(entry.description), `en/${key}: description mentions planning jargon`);
    }
  });
});
