/**
 * JAMt - Month Key Helpers
 *
 * Loaded as a classic script in the content script and (via a side effect ESM
 * import) the background script, same pattern as shared/messaging.js.
 *
 * Month ids are `YYYY-MM` strings in LOCAL time. They are the keys of the
 * monthly buckets in storage.local (`month:YYYY-MM`) and of `monthIndex`.
 *
 * The history importer uses resolveHistorySectionMonth() to map a YouTube Music
 * history section header (localized, e.g. "settembre 2025", "Today", "Last week")
 * to the month its plays belong to.
 */
(function (root) {
  'use strict';

  /** Locales always used for month-name matching, before any caller-supplied ones. */
  const BASE_LOCALES = ['en', 'it', 'de', 'es', 'fr', 'pt', 'pt-BR'];

  /** Canonical month id: four-digit year, dash, month 01..12. */
  const MONTH_ID_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

  /** Four-digit year in the 19xx/20xx range, as printed in a section header. */
  const YEAR_RE = /\b(19|20)\d{2}\b/;

  /** Latin letters, including the accented range kept after NFD stripping. */
  const TOKEN_SPLIT_RE = /[^a-z\u00c0-\u024f]+/;

  /** Month-name tables keyed by the locale list that produced them. */
  const tableCache = new Map();

  /**
   * True only for a canonical `YYYY-MM` month id (month 01..12).
   *
   * @param {unknown} id
   * @returns {boolean}
   */
  function isValidMonthId(id) {
    return typeof id === 'string' && MONTH_ID_RE.test(id);
  }

  /**
   * Formats a date as a `YYYY-MM` month id using local time. An invalid or
   * missing date falls back to the current date.
   *
   * @param {Date | number} [date] A Date, or a millisecond timestamp.
   * @returns {string}
   */
  function monthIdFromDate(date = new Date()) {
    let d;
    if (date instanceof Date) {
      d = date;
    } else if (typeof date === 'number') {
      d = new Date(date);
    } else {
      d = new Date();
    }
    if (Number.isNaN(d.getTime())) d = new Date();

    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }

  /**
   * Orders two month ids. Plain string comparison is correct for `YYYY-MM`.
   *
   * @param {string} a
   * @param {string} b
   * @returns {number} Negative if a < b, 0 if equal, positive if a > b.
   */
  function compareMonthIds(a, b) {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  /**
   * Lowercases, strips diacritics and removes dots, so "März." matches "marz"
   * and "sept." matches "sept".
   *
   * @param {string} text
   * @returns {string}
   */
  function normalizeText(text) {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\./g, '');
  }

  /**
   * Builds the normalized month-name lookup tables for a locale list. Long
   * names and short names are kept apart so that a long-name match always wins
   * over a short-name match. Locales the runtime cannot handle are skipped.
   *
   * @param {string[]} locales
   * @returns {{ long: Map<string, number>, short: Map<string, number> }}
   *   Maps normalized name to month number 1..12.
   */
  function buildMonthNameTables(locales) {
    const tables = { long: new Map(), short: new Map() };

    for (const locale of locales) {
      let longFormat;
      let shortFormat;
      try {
        longFormat = new Intl.DateTimeFormat(locale, { month: 'long' });
        shortFormat = new Intl.DateTimeFormat(locale, { month: 'short' });
      } catch (_err) {
        // Invalid BCP47 tag from the document or a caller: ignore it.
        continue;
      }

      for (let m = 0; m < 12; m++) {
        // Mid-month date so no timezone offset can move it into a neighbour month.
        const sample = new Date(2020, m, 15);
        const monthNumber = m + 1;

        const longName = normalizeText(longFormat.format(sample));
        if (longName.length >= 3 && !tables.long.has(longName)) {
          tables.long.set(longName, monthNumber);
        }

        const shortName = normalizeText(shortFormat.format(sample));
        if (shortName.length >= 3 && !tables.short.has(shortName)) {
          tables.short.set(shortName, monthNumber);
        }
      }
    }

    return tables;
  }

  /**
   * Returns the cached month-name tables for the base locales plus any extras.
   *
   * @param {string[]} extraLocales
   * @returns {{ long: Map<string, number>, short: Map<string, number> }}
   */
  function getMonthNameTables(extraLocales) {
    const extras = extraLocales.filter((l) => typeof l === 'string' && l.trim() !== '');
    const locales = [...BASE_LOCALES, ...extras];
    const key = locales.join('|');

    let tables = tableCache.get(key);
    if (!tables) {
      tables = buildMonthNameTables(locales);
      tableCache.set(key, tables);
    }
    return tables;
  }

  /**
   * Maps a YouTube Music history section header to a `YYYY-MM` month id.
   *
   * Rules:
   *   - relative or unrecognized headers ("Today", "Last week", "Oggi") -> current month
   *   - "<MONTH> <YEAR>" -> that month
   *   - "<MONTH>" without a year -> current year if the month is <= the current
   *     month, otherwise the previous year
   *   - a resolved month later than the current month -> clamped to current month
   *
   * @param {string} headerText The section header as shown in the UI.
   * @param {Date | number} [now] Reference time, defaults to the current time.
   * @param {string[]} [extraLocales] Extra BCP47 locales (e.g. the document language).
   * @returns {string} A `YYYY-MM` month id.
   */
  function resolveHistorySectionMonth(headerText, now = new Date(), extraLocales = []) {
    const current = monthIdFromDate(now);
    if (typeof headerText !== 'string' || headerText.trim() === '') return current;

    const curYear = Number(current.slice(0, 4));
    const curMonth = Number(current.slice(5, 7));

    const normalized = normalizeText(headerText);
    const tokens = normalized.split(TOKEN_SPLIT_RE).filter(Boolean);
    const tables = getMonthNameTables(Array.isArray(extraLocales) ? extraLocales : []);

    // Long names across every token first, so "mar" in a longer header cannot
    // shadow a full month name elsewhere in the same header.
    let month = 0;
    for (const token of tokens) {
      if (tables.long.has(token)) {
        month = tables.long.get(token);
        break;
      }
    }
    if (month === 0) {
      for (const token of tokens) {
        if (tables.short.has(token)) {
          month = tables.short.get(token);
          break;
        }
      }
    }

    // No month name: a relative section such as Today, Yesterday or This week.
    if (month === 0) return current;

    const yearMatch = normalized.match(YEAR_RE);
    const year = yearMatch ? Number(yearMatch[0]) : month <= curMonth ? curYear : curYear - 1;
    const id = `${year}-${String(month).padStart(2, '0')}`;

    return compareMonthIds(id, current) > 0 ? current : id;
  }

  root.YTMCMonths = {
    isValidMonthId,
    monthIdFromDate,
    compareMonthIds,
    resolveHistorySectionMonth
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
