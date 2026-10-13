/**
 * YTMusic Counter - Localization runtime
 *
 * Loaded as a classic script in the popup and (via a side-effect ESM import) in
 * the Details page, the content script and the background script, for the same
 * reason as shared/messaging.js: one implementation, every consumer.
 *
 * Why it exists:
 *   `chrome.i18n.getMessage()` is the right tool for the browser locale, but it
 *   can never answer "this key, in German" - it is hard-wired to the browser UI
 *   language and is read-only. An in-app language switcher therefore needs a
 *   second path, and having two paths is exactly where localization bugs live.
 *
 * The two paths, in order:
 *
 *   1. Native (`extBrowser.i18n.getMessage`). Synchronous on both engines -
 *      note that it must NOT be awaited, the promise is not returned. Only
 *      trusted for the default locale (English): which language it answers in
 *      is the engine's decision, and Firefox can serve English while
 *      `getUILanguage()` reports another language. It is also the fallback when
 *      a catalog cannot be loaded.
 *   2. Self-loaded catalog, used for every other locale. Extension pages (popup, Details, background) fetch
 *      `_locales/<code>/messages.json` themselves, once, and look keys up by
 *      hand. A content script cannot (the request would go to the host page's
 *      origin), so it asks the background for the raw templates through
 *      `getMessages()` and installs them with `setCatalog()`; `needsCatalog()`
 *      tells it whether that is necessary at all.
 *
 * Because path 2 does its own lookup, we also own the locale fallback chain
 * (AD-5), implemented deterministically instead of depending on engine quirks:
 *
 *   requested -> regionless/scriptless variant -> default_locale ('en')
 *
 * Plurals (AD-6). The category comes from `Intl.PluralRules`, never a
 * `count === 1 ?` ternary: French treats 0 as singular. Every counted noun
 * ships `<base>_one` and `<base>_other`; `plural()` always passes the count as
 * `$1`. Brazilian Portuguese is the one deviation: CLDR says `one` for 0, the
 * language says "0 reproducoes", so `selectPluralCategory` returns `other`.
 */
(function (root) {
  'use strict';

  /**
   * `browser.*` when the engine provides it (Firefox), else `chrome.*`. Left
   * undefined outside an extension context (plain Node, as in tests); every
   * call site below tolerates that instead of throwing.
   */
  const extBrowser =
    typeof root.browser !== 'undefined' && root.browser && root.browser.runtime
      ? root.browser
      : root.chrome;

  /** Fallback locale. Must match `default_locale` in manifest.json. */
  const DEFAULT_LOCALE = 'en';

  /** Locales we ship catalogs for. `setLocale()` accepts nothing else. */
  const SUPPORTED_LOCALES = ['en', 'de', 'es', 'fr', 'it', 'pt_BR'];

  /**
   * AD-9: the override lives in `storage.sync`, not `storage.local`, because
   * "Reset All Data" calls `storage.local.clear()` and would otherwise eat the
   * user's language.
   */
  const OVERRIDE_STORAGE_KEY = 'language';

  /** Storage area holding the override. Named so the onChanged filter is explicit. */
  const SYNC_AREA = 'sync';

  /**
   * AD-8: the artist sentinel the scanner persists (and export bundles carry)
   * when a track has no artist. It is translated only where it is displayed.
   */
  const UNKNOWN_ARTIST_SENTINEL = 'Unknown Artist';

  /** Resolved locale, e.g. 'pt_BR'. Default until `init()` runs. */
  let resolvedLocale = DEFAULT_LOCALE;

  /** Raw browser UI language, e.g. 'de-AT'. */
  let browserLocale = DEFAULT_LOCALE;

  /** Stored override, or null when the user follows the browser. */
  let overrideLocale = null;

  /** Loaded `{key: entry}` catalog, or null on the native path. */
  let catalog = null;

  /** Locale `catalog` belongs to; a stale catalog is never consulted. */
  let catalogLocale = null;

  /** Memoised `init()` work; `init()` is idempotent and returns this. */
  let initPromise = null;

  /** Guards against a slow catalog fetch committing after a newer resolution. */
  let applyGeneration = 0;

  /** Whether the `storage.onChanged` bridge has been attached. */
  let listeningForExternalChanges = false;

  /** Locale change subscribers. */
  const localeListeners = new Set();

  /** Keys already reported missing, so one bad key logs once per context. */
  const missingKeys = new Set();

  /** Memoised Intl objects, keyed by locale (and options for numbers). */
  const numberFormatters = new Map();
  const pluralRules = new Map();

  // ---------------------------------------------------------------------------
  // Locale plumbing (pure, exported, safe to call from tests without an extension)
  // ---------------------------------------------------------------------------

  /**
   * Trims and case-normalizes a locale code, accepting either separator.
   *
   * @param {any} locale
   * @returns {string} '' for null/undefined/empty, otherwise 'pt-BR' style.
   */
  function normalizeLocale(locale) {
    if (typeof locale !== 'string') return '';
    const trimmed = locale.trim().replace(/_/g, '-');
    if (!trimmed) return '';
    // Canonical casing (PT-br -> pt-BR) so comparisons are case-insensitive
    // without dragging Intl into every comparison.
    return trimmed
      .split('-')
      .map((part, index) => (index === 0 ? part.toLowerCase() : part.length === 4
        ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
        : part.toUpperCase()))
      .join('-');
  }

  /**
   * Drops ONE trailing region or script subtag of a BCP 47 tag.
   *
   * `pt-BR` -> `pt`, `zh-Hant-TW` -> `zh-Hant` (-> `zh` on a second call).
   * Deliberately single-step: `localeChain()` is the thing that walks the whole
   * chain, and this is what makes each step of it visible.
   *
   * @param {string} locale
   * @returns {string}
   */
  function stripRegionAndScript(locale) {
    const parts = String(locale || '').split('-').filter(Boolean);
    if (parts.length > 1) {
      const last = parts[parts.length - 1];
      const isRegion = /^[A-Za-z]{2}$/.test(last) || /^\d{3}$/.test(last);
      const isScript = /^[A-Za-z]{4}$/.test(last);
      if (isRegion || isScript) parts.pop();
    }
    return parts.join('-');
  }

  /**
   * The full AD-5 fallback chain for a requested locale, most specific first,
   * always ending at `DEFAULT_LOCALE`. Exported because the chain itself is
   * the contract, not just its result.
   *
   * @param {any} [requested]
   * @returns {string[]}
   */
  function localeChain(requested) {
    const chain = [];
    const normalized = normalizeLocale(requested);
    if (normalized) {
      chain.push(normalized);
      let variant = stripRegionAndScript(normalized);
      while (variant && chain.indexOf(variant) === -1) {
        chain.push(variant);
        variant = stripRegionAndScript(variant);
      }
    }
    if (chain.indexOf(normalizeLocale(DEFAULT_LOCALE)) === -1) {
      chain.push(normalizeLocale(DEFAULT_LOCALE));
    }
    return chain;
  }

  /**
   * Finds the SUPPORTED_LOCALES spelling of a locale, or null.
   *
   * Exact (case/separator-insensitive) on purpose: loosening this to "match
   * the regionless stem" would make `pt_PT` silently become `pt_BR`, which is
   * the wrong language rather than a safe one. Looser requests are handled by
   * the AD-5 chain in `resolveLocale()`, which walks regionless variants as
   * *distinct candidates* and only accepts them when the requested code itself
   * matched nothing.
   *
   * @param {any} locale
   * @returns {string|null} e.g. 'pt_BR', or null when we ship no catalog.
   */
  function matchSupported(locale) {
    const normalized = normalizeLocale(locale);
    if (!normalized) return null;
    return SUPPORTED_LOCALES.find((entry) => normalizeLocale(entry) === normalized) || null;
  }

  /**
   * AD-5: resolves a requested locale to one we actually ship, walking
   * requested -> regionless/scriptless -> default. Never returns an
   * unsupported code, so a bad `?lang=xx` cannot blank the UI.
   *
   * @param {any} [requested]
   * @returns {string} A member of SUPPORTED_LOCALES (or DEFAULT_LOCALE).
   */
  function resolveLocale(requested) {
    for (const candidate of localeChain(requested)) {
      const supported = matchSupported(candidate);
      if (supported) return supported;
    }
    return DEFAULT_LOCALE;
  }

  /**
   * BCP 47 form of a locale for `Intl.*` constructors: `pt_BR` -> `pt-BR`.
   * Intl throws a RangeError on the underscore form, so every constructor in
   * this file goes through here.
   *
   * @param {string} [locale] Defaults to the resolved locale.
   * @returns {string}
   */
  function intlLocale(locale) {
    return normalizeLocale(locale) || normalizeLocale(resolvedLocale) || DEFAULT_LOCALE;
  }

  /**
   * The plural category CLDR assigns to `count` in `locale`.
   *
   * Uses `Intl.PluralRules`, never hand-written rules (AD-6), so adding a locale
   * with 3-6 categories later needs no code change. Never throws: an unknown
   * locale degrades to 'other', which every catalog is required to define.
   * `zero` is never returned - no catalog ships it.
   *
   * One deviation: pt_BR at 0 returns 'other'. CLDR says `one` ("0 reproducao"),
   * Brazilian usage is "0 reproducoes".
   *
   * @param {string} locale Any locale code; `_` separators are accepted.
   * @param {number} count
   * @returns {'one'|'two'|'few'|'many'|'other'}
   */
  function selectPluralCategory(locale, count) {
    const tag = intlLocale(normalizeLocale(locale) ? locale : DEFAULT_LOCALE);
    const value = typeof count === 'number' ? count : Number(count);
    if (!Number.isFinite(value)) return 'other';
    if (value === 0 && tag === 'pt-BR') return 'other';
    try {
      let rules = pluralRules.get(tag);
      if (!rules) {
        rules = new Intl.PluralRules(tag);
        pluralRules.set(tag, rules);
      }
      const category = rules.select(value);
      return category === 'zero' ? 'other' : category;
    } catch (err) {
      return 'other';
    }
  }

  // ---------------------------------------------------------------------------
  // Lookups: native, catalog, substitutions
  // ---------------------------------------------------------------------------

  /**
   * Native `getMessage` only accepts strings, and a stray number or undefined
   * makes it throw or drop the whole message. Coerce once, here.
   *
   * @param {any} subs A scalar, an array, or nothing.
   * @returns {string[]|undefined}
   */
  function stringifySubs(subs) {
    if (subs === undefined || subs === null) return undefined;
    const list = Array.isArray(subs) ? subs : [subs];
    return list.map((value) => (value === undefined || value === null ? '' : String(value)));
  }

  /**
   * Applies Chrome-style positional substitutions to a raw template: `$1`..`$9`
   * take the array and `$$` is a literal `$`. A placeholder without a value is
   * left verbatim so a bad catalog is visible rather than silently blanked.
   * The lookbehind keeps currency such as "US$5" from being eaten.
   *
   * @param {string} template
   * @param {string[]|undefined} subs
   * @returns {string}
   */
  function applySubstitutions(template, subs) {
    if (typeof template !== 'string' || !template) return '';
    if (!subs) return template;
    return template.replace(/(?<![A-Za-z0-9_])\$(\$|\d{1,2})/g, (match, token) => {
      if (token === '$') return '$';
      const value = subs[Number(token) - 1];
      return value === undefined ? match : value;
    });
  }

  /**
   * Reports a key that no path could resolve, once per key per context. A
   * missing key is a build-time bug (the build validates literals against the
   * English catalog), so it is logged loudly but never thrown - a blank label
   * is strictly better than a dead event handler.
   *
   * @param {any} key
   */
  function warnMissing(key) {
    const name = String(key);
    if (missingKeys.has(name)) return;
    missingKeys.add(name);
    console.warn('[i18n] Missing message key:', name);
  }

  /**
   * Synchronous `extBrowser.i18n.getMessage`. Deliberately not awaited: the
   * Chrome build returns the string, and awaiting it would turn every label
   * into a Promise.
   *
   * @param {string} key
   * @param {string[]} [substitutions]
   * @returns {string} '' outside an extension context or for a missing key.
   */
  function nativeGetMessage(key, substitutions) {
    if (!extBrowser || !extBrowser.i18n || typeof extBrowser.i18n.getMessage !== 'function') return '';
    try {
      const value = substitutions === undefined
        ? extBrowser.i18n.getMessage(key)
        : extBrowser.i18n.getMessage(key, substitutions);
      return typeof value === 'string' ? value : '';
    } catch (err) {
      return '';
    }
  }

  /**
   * Raw template from the loaded catalog, or null (also for an empty template,
   * which `getMessages()` uses to say "I do not have this one").
   *
   * The `catalogLocale !== resolvedLocale` guard makes "never answer from a
   * catalog that is not the resolved locale" an enforced invariant rather than
   * a consequence of remembering to clear things in the right order.
   *
   * @param {string} key
   * @returns {string|null}
   */
  function catalogGet(key) {
    if (!catalog || catalogLocale !== resolvedLocale) return null;
    if (!Object.prototype.hasOwnProperty.call(catalog, key)) return null;
    const entry = catalog[key];
    const message = typeof entry === 'string' ? entry : entry && entry.message;
    return typeof message === 'string' && message ? message : null;
  }

  /**
   * Quiet lookup: the loaded catalog first, then the native path, '' when
   * neither has the key. `plural()` relies on it being silent.
   *
   * @param {string} key
   * @param {any} [substitutions]
   * @returns {string}
   */
  function lookup(key, substitutions) {
    const subs = stringifySubs(substitutions);
    const fromCatalog = catalogGet(key);
    if (fromCatalog !== null) return applySubstitutions(fromCatalog, subs);
    // Either the native path is active (AD-1) or the chosen catalog does not
    // define the key; the browser locale beats a blank label in both cases.
    return nativeGetMessage(key, subs);
  }

  /**
   * Resolves a key and warns once if nothing has it. Never throws and never
   * returns undefined.
   *
   * @param {string} key
   * @param {any} [substitutions] Positional array or a single value; each is
   *   coerced to a string.
   * @returns {string}
   */
  function t(key, substitutions) {
    if (typeof key !== 'string' || !key) {
      warnMissing(key);
      return '';
    }
    const value = lookup(key, substitutions);
    if (!value) warnMissing(key);
    return value;
  }

  /**
   * Resolves `<base>_<category>` -> `<base>_other` with the count as `$1`.
   * Shared by `plural()` and by `formatDuration()`, which needs to show 0 with
   * the singular form.
   *
   * @param {string} baseKey
   * @param {number} count
   * @param {string} category
   * @returns {string}
   */
  function pluralForm(baseKey, count, category) {
    if (typeof baseKey !== 'string' || !baseKey) {
      warnMissing(baseKey);
      return '';
    }
    const subs = [formatNumber(count)];
    // An absent `<base>_one` is legitimate for a message that only ships
    // `_other`, so the chain is walked silently; only a total miss is reported.
    const value = lookup(`${baseKey}_${category}`, subs) || lookup(`${baseKey}_other`, subs);
    if (!value) warnMissing(baseKey);
    return value;
  }

  /**
   * AD-6 plural lookup: `<base>_<category>` -> `<base>_other` -> ''. The
   * (localized) count is always `$1` of the template.
   *
   * @param {string} baseKey
   * @param {number} count
   * @returns {string} '' when nothing resolves.
   */
  function plural(baseKey, count) {
    return pluralForm(baseKey, count, selectPluralCategory(resolvedLocale, count));
  }

  // ---------------------------------------------------------------------------
  // Formatting helpers (one implementation for every context)
  // ---------------------------------------------------------------------------

  /**
   * Locale-aware number formatting, memoised per locale and options. Follows
   * the override, which `Number.prototype.toLocaleString()` does not.
   *
   * @param {number} n
   * @param {Intl.NumberFormatOptions} [opts]
   * @returns {string} '0' for a non-finite input.
   */
  function formatNumber(n, opts) {
    const value = Number(n);
    if (!Number.isFinite(value)) return '0';
    const tag = intlLocale();
    const cacheKey = opts ? `${tag}|${JSON.stringify(opts)}` : tag;
    try {
      let formatter = numberFormatters.get(cacheKey);
      if (!formatter) {
        formatter = new Intl.NumberFormat(tag, opts);
        numberFormatters.set(cacheKey, formatter);
      }
      return formatter.format(value);
    } catch (err) {
      return String(value);
    }
  }

  /**
   * Cover-cache style size label. Binary divisor: below 1 MiB it is KB with one
   * decimal, otherwise MB with two.
   *
   * @param {number} bytes
   * @returns {string}
   */
  function formatBytes(bytes) {
    const value = Number(bytes);
    const size = Number.isFinite(value) && value > 0 ? value : 0;
    if (size < 1024 * 1024) {
      return t('msg_cache_size_kb', [formatNumber(size / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })]);
    }
    return t('msg_cache_size_mb', [formatNumber(size / (1024 * 1024), { minimumFractionDigits: 2, maximumFractionDigits: 2 })]);
  }

  /**
   * Compact listening time: `0 min`, `< 1 min`, `2 mins`, `1 hr 1 min`,
   * `14 hrs 28 mins` in English. A zero part is omitted.
   *
   * @param {number} seconds
   * @returns {string}
   */
  function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    // Zero shows the singular form ("0 min"): the units are abbreviations, and
    // the plural form would read "0 mins" in English.
    if (total === 0) return pluralForm('msg_count_minute', 0, 'one');
    if (total < 60) return t('msg_durationUnderOneMinute');

    const totalMinutes = Math.floor(total / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    const parts = [];
    if (hours > 0) parts.push(plural('msg_count_hour', hours));
    if (minutes > 0) parts.push(plural('msg_count_minute', minutes));
    return parts.join(' ');
  }

  /**
   * The text to show for a stored artist name. AD-8: the sentinel is persisted
   * in English and translated only at display time.
   *
   * @param {any} name
   * @returns {string}
   */
  function displayArtist(name) {
    const text = typeof name === 'string' ? name : '';
    const trimmed = text.trim();
    if (trimmed && trimmed !== UNKNOWN_ARTIST_SENTINEL) return text;
    return t('msg_artist_unknown') || 'Unknown';
  }

  // ---------------------------------------------------------------------------
  // Catalog hand-off (content script <-> background)
  // ---------------------------------------------------------------------------

  /**
   * Raw templates for the active locale, for serving a content script.
   *
   * @param {string[]} keys
   * @returns {Object<string, string>} Key -> template; '' for keys the loaded
   *   catalog lacks, and '' for every key when no catalog is loaded.
   */
  function getMessages(keys) {
    const result = {};
    if (!Array.isArray(keys)) return result;
    for (const key of keys) {
      if (typeof key !== 'string' || key === '__proto__') continue;
      result[key] = catalogGet(key) || '';
    }
    return result;
  }

  /**
   * Installs `{key: template}` as the active catalog for `locale`, as if it had
   * been fetched. Only effective while `locale` is the resolved locale.
   *
   * @param {string} locale
   * @param {Object<string, string|{message: string}>} messages
   */
  function setCatalog(locale, messages) {
    if (!messages || typeof messages !== 'object') return;
    catalog = messages;
    catalogLocale = matchSupported(locale) || normalizeLocale(locale);
  }

  /**
   * Whether the self-loaded catalog (not native `getMessage`) must answer.
   *
   * True for every non-default locale, with or without an override. Native
   * `getMessage` is only trusted for the default locale, because the language
   * it answers in is chosen by the engine and does not always match
   * `getUILanguage()`: Firefox can report `it` while serving the English
   * default for an extension, so "the override equals the browser locale" is
   * not proof that native speaks that language. It is also true when an override
   * resolves to something other than the browser's own locale.
   *
   * @returns {boolean}
   */
  function needsCatalog() {
    if (resolvedLocale !== DEFAULT_LOCALE) return true;
    return Boolean(overrideLocale) && resolveLocale(browserLocale) !== resolvedLocale;
  }

  // ---------------------------------------------------------------------------
  // Context + storage.sync plumbing (override lives here per AD-9)
  // ---------------------------------------------------------------------------

  /**
   * True on the extension's own pages and workers. Anywhere else (a content
   * script, whose `location` is the host page) the runtime must not fetch
   * `_locales` or touch the host document.
   *
   * @returns {boolean}
   */
  function isExtensionPage() {
    const protocol = root.location && root.location.protocol;
    return protocol === 'chrome-extension:' || protocol === 'moz-extension:';
  }

  /** @returns {object|null} `storage.sync`, or null when unavailable. */
  function syncArea() {
    return (extBrowser && extBrowser.storage && extBrowser.storage[SYNC_AREA]) || null;
  }

  /**
   * Reads the stored override. Resolves to `{}` rather than rejecting: storage
   * can genuinely be unavailable (tests, revoked permissions), and localization
   * must never be the thing that breaks a page.
   *
   * @returns {Promise<any>}
   */
  function readOverrideFromStorage() {
    const area = syncArea();
    if (!area || typeof area.get !== 'function') return Promise.resolve({});
    try {
      return Promise.resolve(area.get(OVERRIDE_STORAGE_KEY)).then((items) => items || {}, () => ({}));
    } catch (err) {
      return Promise.resolve({});
    }
  }

  /**
   * Writes (or clears) the override. Never rejects - a failed preference write
   * must not strand the UI in the old locale mid-switch.
   *
   * @param {string|null} value
   * @returns {Promise<void>}
   */
  function writeOverrideToStorage(value) {
    const area = syncArea();
    if (!area) return Promise.resolve();
    const clear = value === null;
    const method = clear && typeof area.remove === 'function' ? 'remove' : 'set';
    if (typeof area[method] !== 'function') return Promise.resolve();
    try {
      return Promise.resolve(area[method](clear ? OVERRIDE_STORAGE_KEY : { [OVERRIDE_STORAGE_KEY]: value }))
        .then(() => {}, () => {});
    } catch (err) {
      return Promise.resolve();
    }
  }

  /**
   * Bridges `storage.onChanged` so a language switch in the popup reaches an
   * already-open Details tab, the background and content scripts. Skipped where
   * the API is absent; the flag keeps `init()` idempotent.
   */
  function attachStorageListener() {
    if (listeningForExternalChanges) return;
    listeningForExternalChanges = true;
    const storage = extBrowser && extBrowser.storage;
    if (!storage || !storage.onChanged || typeof storage.onChanged.addListener !== 'function') return;
    try {
      storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== SYNC_AREA || !changes || !Object.prototype.hasOwnProperty.call(changes, OVERRIDE_STORAGE_KEY)) {
          return;
        }
        const change = changes[OVERRIDE_STORAGE_KEY] || {};
        const next = typeof change.newValue === 'string' && change.newValue.trim()
          ? change.newValue.trim()
          : null;
        // Our own write: setLocale() records the new override before writing,
        // so the echo of that write lands here as "no change".
        if (next === overrideLocale) return;
        overrideLocale = next;
        const applying = applyResolvedLocale();
        // init() must not report "ready" while this catalog is still loading:
        // the background answers GET_LOCALIZED_MESSAGES behind `await init()`,
        // and a content script asks the instant it sees the same storage event.
        initPromise = applying.then(() => {}, () => {});
        applying.then(announceLocaleChange, () => {});
      });
    } catch (err) {
      /* a revoked storage API is not worth failing over */
    }
  }

  // ---------------------------------------------------------------------------
  // Locale resolution lifecycle
  // ---------------------------------------------------------------------------

  /**
   * The raw browser UI language, guarded for contexts without `i18n`.
   *
   * @returns {string}
   */
  function readBrowserLocale() {
    try {
      if (!extBrowser || !extBrowser.i18n || typeof extBrowser.i18n.getUILanguage !== 'function') {
        return DEFAULT_LOCALE;
      }
      const language = extBrowser.i18n.getUILanguage();
      return typeof language === 'string' && language.trim() ? language.trim() : DEFAULT_LOCALE;
    } catch (err) {
      return DEFAULT_LOCALE;
    }
  }

  /**
   * Fetches and parses one catalog. Resolves null on any failure - never
   * rejects - because every caller treats "no catalog" as "use native".
   *
   * @param {string} locale
   * @returns {Promise<any|null>}
   */
  function loadCatalog(locale) {
    if (!extBrowser || !extBrowser.runtime || typeof extBrowser.runtime.getURL !== 'function') {
      return Promise.resolve(null);
    }
    if (typeof root.fetch !== 'function') return Promise.resolve(null);
    return Promise.resolve()
      .then(() => root.fetch(extBrowser.runtime.getURL(`_locales/${locale}/messages.json`)))
      .then((response) => {
        if (!response || (typeof response.ok === 'boolean' && !response.ok)) {
          throw new Error(`catalog request failed: ${response && response.status}`);
        }
        return response.json();
      })
      .then((data) => (data && typeof data === 'object' ? data : null))
      .catch(() => null);
  }

  /**
   * Keeps `<html lang>` honest so the browser applies the right hyphenation,
   * font and screen-reader pronunciation. Extension pages only: the host
   * document of a content script is not ours to rewrite.
   */
  function applyDocumentLang() {
    if (!isExtensionPage()) return;
    try {
      const doc = root.document;
      if (!doc || !doc.documentElement) return;
      doc.documentElement.lang = normalizeLocale(resolvedLocale);
    } catch (err) {
      /* a detached or cross-origin document is not worth failing over */
    }
  }

  /**
   * Re-derives the resolved locale and loads the override catalog if one is
   * needed. Generation-guarded so a slow fetch from a superseded resolution
   * cannot install a stale catalog.
   *
   * @returns {Promise<string>} the resolved locale
   */
  function applyResolvedLocale() {
    const generation = ++applyGeneration;
    browserLocale = readBrowserLocale();
    resolvedLocale = overrideLocale ? resolveLocale(overrideLocale) : resolveLocale(browserLocale);
    catalog = null;
    catalogLocale = null;
    applyDocumentLang();

    // The catalog is only worth fetching when native cannot answer (AD-1), and
    // only where this context can read the extension's files at all.
    if (!needsCatalog() || !isExtensionPage()) return Promise.resolve(resolvedLocale);

    const target = resolvedLocale;
    return loadCatalog(target).then((loaded) => {
      if (generation !== applyGeneration) return resolvedLocale;
      if (loaded) {
        catalog = loaded;
        catalogLocale = target;
      } else {
        // Fetch failed (packaged without _locales). Stay quiet and let lookups
        // fall through to native - a loud failure would be worse than English.
        console.warn('[i18n] Could not load catalog for', target + '; falling back to the browser locale.');
      }
      return resolvedLocale;
    });
  }

  /**
   * Re-renders the page's static text (extension pages only), then tells
   * subscribers. In that order on purpose: a subscriber re-renders JS-built
   * text into nodes that also carry a `data-i18n` placeholder (for example
   * `#totalTimeStat`), and a later `localizeDocument()` would overwrite it with
   * the placeholder again.
   */
  function announceLocaleChange() {
    if (isExtensionPage()) localizeDocument();
    notifyLocaleChanged();
  }

  /**
   * Loads the runtime: reads the override, resolves the locale, loads the
   * override catalog and sets `<html lang>` (extension pages only), and
   * attaches the storage bridge. Idempotent - concurrent and repeat callers
   * share one Promise.
   *
   * @returns {Promise<void>} Always resolves; never rejects.
   */
  function init() {
    if (initPromise) return initPromise;
    initPromise = readOverrideFromStorage()
      .then((items) => {
        const stored = items && items[OVERRIDE_STORAGE_KEY];
        overrideLocale = typeof stored === 'string' && stored.trim() ? stored.trim() : null;
        return applyResolvedLocale();
      })
      .then(() => {
        attachStorageListener();
      })
      .catch(() => {
        // Belt and braces: init() resolving is the contract every call site is
        // allowed to rely on.
      });
    return initPromise;
  }

  /**
   * @returns {string} The locale in use, e.g. 'pt_BR'. Safe before `init()`.
   */
  function getLocale() {
    return resolvedLocale;
  }

  /**
   * @returns {string|null} The stored override, or null to follow the browser.
   */
  function getOverride() {
    return overrideLocale;
  }

  /**
   * @returns {string} The raw browser UI language, e.g. 'de-AT'.
   */
  function getBrowserLocale() {
    return browserLocale;
  }

  /**
   * Switches language in-app.
   *
   * Passing `''` or `null` clears the override and hands control back to the
   * browser locale. Anything that is not `''`/`null`/a member of
   * SUPPORTED_LOCALES is a programming error and **rejects** rather than being
   * silently coerced: a language picker that quietly stores 'deu' shows the user
   * English and leaves them with no way back. Callers should catch.
   *
   * @param {string|null} locale
   * @returns {Promise<void>}
   */
  function setLocale(locale) {
    const clears = locale === null || locale === undefined || (typeof locale === 'string' && !locale.trim());
    let next = null;

    if (!clears) {
      const matched = matchSupported(locale);
      if (!matched) {
        return Promise.reject(new TypeError(
          `[i18n] Unsupported locale ${JSON.stringify(locale)}. Expected one of: ` +
          `${SUPPORTED_LOCALES.join(', ')}, or '' to follow the browser.`
        ));
      }
      next = matched;
    }

    return init().then(() => {
      if (next === overrideLocale) return undefined;
      // Recorded before the write so the storage.onChanged echo of our own
      // write compares equal and is ignored.
      overrideLocale = next;
      return writeOverrideToStorage(next)
        .then(() => applyResolvedLocale())
        // Re-render here so an open popup/Details page switches without a
        // reload; JS-built text is the caller's onLocaleChanged job.
        .then(announceLocaleChange);
    });
  }

  /**
   * Subscribes to locale changes. The callback receives the new resolved
   * locale; it is called after the catalog is ready, so `t()` is valid inside.
   *
   * @param {(locale: string) => void} callback
   * @returns {() => void} unsubscribe
   */
  function onLocaleChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    localeListeners.add(callback);
    return () => {
      localeListeners.delete(callback);
    };
  }

  /** Invokes every subscriber, isolating failures so one bad render cannot stop the rest. */
  function notifyLocaleChanged() {
    for (const callback of Array.from(localeListeners)) {
      try {
        callback(resolvedLocale);
      } catch (err) {
        console.warn('[i18n] A locale change listener threw:', err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // DOM pass (AD-2 / AD-3: __MSG_*__ does not work in extension HTML)
  // ---------------------------------------------------------------------------

  /**
   * The supported `data-i18n*` attributes and their DOM sinks. They are listed
   * together on purpose: deriving the attribute from the property is how
   * `data-i18n` silently turns into `data-i18n-textContent`.
   */
  const DOM_BINDINGS = [
    ['data-i18n', (element, value) => { element.textContent = value; }],
    ['data-i18n-title', (element, value) => { element.title = value; }],
    ['data-i18n-placeholder', (element, value) => { element.placeholder = value; }],
    ['data-i18n-aria-label', (element, value) => { element.setAttribute('aria-label', value); }]
  ];

  const DOM_SELECTOR = DOM_BINDINGS.map(([attribute]) => `[${attribute}]`).join(',');

  /**
   * Applies the supported `data-i18n*` attributes inside `root`.
   *
   *   data-i18n="key"                 -> element.textContent
   *   data-i18n="key:a,b"             -> textContent, positional subs, comma separated
   *   data-i18n-title="key"           -> element.title
   *   data-i18n-placeholder="key"     -> element.placeholder
   *   data-i18n-aria-label="key"      -> setAttribute('aria-label', ...)
   *
   * AD-3 note: the English text stays inline in the HTML, so an unresolvable key
   * must leave the node untouched rather than blanking it. That is why an empty
   * translation is a no-op below and not `textContent = ''`.
   *
   * @param {ParentNode} [rootNode] Defaults to `document`.
   * @returns {void}
   */
  function localizeDocument(rootNode) {
    const scope = rootNode || root.document;
    if (!scope || typeof scope.querySelectorAll !== 'function') return;

    let nodes;
    try {
      nodes = scope.querySelectorAll(DOM_SELECTOR);
    } catch (err) {
      return;
    }
    if (!nodes || typeof nodes.length !== 'number') return;

    for (let index = 0; index < nodes.length; index += 1) {
      const element = nodes[index];
      if (!element || typeof element.getAttribute !== 'function') continue;
      for (const [attribute, apply] of DOM_BINDINGS) {
        const parsed = parseDataI18n(element.getAttribute(attribute));
        if (!parsed) continue;
        const value = t(parsed.key, parsed.substitutions);
        // An empty result means "no translation", never "translate to nothing":
        // AD-3 keeps the English inline so a failed lookup must not blank it.
        if (value) apply(element, value);
      }
    }
  }

  /**
   * Parses `"key"` or `"key:a,b,c"`.
   *
   * The values after the colon are **literal** substitution text taken from the
   * document - an attribute cannot know a play count - and they are assigned to
   * `$1`, `$2`, ... in order. Anything dynamic must come from a JS call to
   * `t()`/`plural()`. Note the caller is responsible for the literal values
   * being safe to place as text; the module only ever assigns textContent or a
   * plain attribute value and never builds HTML (I-8).
   *
   * @param {string|null} raw
   * @returns {{key: string, substitutions: string[]|null}|null}
   */
  function parseDataI18n(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;

    const separator = trimmed.indexOf(':');
    if (separator === -1) return { key: trimmed, substitutions: null };

    const key = trimmed.slice(0, separator).trim();
    if (!key) return null;

    const values = trimmed.slice(separator + 1).split(',').map((part) => part.trim());
    while (values.length && values[values.length - 1] === '') values.pop();
    return { key, substitutions: values.length ? values : null };
  }

  root.YTMCI18n = {
    DEFAULT_LOCALE,
    SUPPORTED_LOCALES,
    init,
    t,
    plural,
    localizeDocument,
    getLocale,
    getOverride,
    getBrowserLocale,
    setLocale,
    onLocaleChanged,
    resolveLocale,
    localeChain,
    matchSupported,
    normalizeLocale,
    selectPluralCategory,
    intlLocale,
    formatNumber,
    formatBytes,
    formatDuration,
    displayArtist,
    getMessages,
    setCatalog,
    needsCatalog
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
