/**
 * shared/month-keys.js — maps a YouTube Music history section header to the
 * month its plays are attributed to.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import '../shared/month-keys.js';

const M = globalThis.YTMCMonths;
const NOW = new Date(2026, 9, 21); // 21 Oct 2026, local time

describe('YTMCMonths - month ids', () => {
  test('registers its API on globalThis', () => {
    assert.equal(typeof M.isValidMonthId, 'function');
    assert.equal(typeof M.monthIdFromDate, 'function');
    assert.equal(typeof M.compareMonthIds, 'function');
    assert.equal(typeof M.resolveHistorySectionMonth, 'function');
  });

  test('isValidMonthId accepts only YYYY-MM with a real month', () => {
    for (const ok of ['2026-01', '2026-10', '1999-12']) assert.equal(M.isValidMonthId(ok), true, ok);
    for (const bad of ['2026-00', '2026-13', '2026-1', '26-10', '2026-10-01', '', null, undefined, 202610, {}]) {
      assert.equal(M.isValidMonthId(bad), false, String(bad));
    }
  });

  test('monthIdFromDate zero-pads and uses local time', () => {
    assert.equal(M.monthIdFromDate(new Date(2026, 0, 1)), '2026-01');
    assert.equal(M.monthIdFromDate(new Date(2026, 11, 31, 23, 59)), '2026-12');
    assert.equal(M.monthIdFromDate(new Date(2026, 2, 5).getTime()), '2026-03');
  });

  test('monthIdFromDate falls back to now on missing or invalid input', () => {
    const current = M.monthIdFromDate(new Date());
    assert.equal(M.monthIdFromDate(), current);
    assert.equal(M.monthIdFromDate(new Date('not a date')), current);
  });

  test('compareMonthIds orders chronologically', () => {
    assert.ok(M.compareMonthIds('2025-12', '2026-01') < 0);
    assert.ok(M.compareMonthIds('2026-02', '2026-01') > 0);
    assert.equal(M.compareMonthIds('2026-02', '2026-02'), 0);
  });
});

describe('YTMCMonths - resolveHistorySectionMonth', () => {
  test('relative sections land in the current month', () => {
    for (const h of ['Today', 'Yesterday', 'This week', 'Last week', 'Oggi', 'Ieri', 'Questa settimana', 'Settimana scorsa']) {
      assert.equal(M.resolveHistorySectionMonth(h, NOW), '2026-10', h);
    }
  });

  test('missing or non-string header lands in the current month', () => {
    for (const h of [undefined, null, '', '   ', 42, {}]) {
      assert.equal(M.resolveHistorySectionMonth(h, NOW), '2026-10', String(h));
    }
  });

  test('"MONTH YEAR" headers resolve across supported languages', () => {
    const cases = {
      'September 2025': '2025-09',
      'settembre 2025': '2025-09',
      'März 2024': '2024-03',
      'février 2024': '2024-02',
      'septiembre de 2025': '2025-09',
      'janeiro de 2026': '2026-01',
      'AUGUST 2026': '2026-08'
    };
    for (const [header, expected] of Object.entries(cases)) {
      assert.equal(M.resolveHistorySectionMonth(header, NOW), expected, header);
    }
  });

  test('current month header resolves to the current month', () => {
    assert.equal(M.resolveHistorySectionMonth('October 2026', NOW), '2026-10');
  });

  test('month without year picks the most recent past occurrence', () => {
    assert.equal(M.resolveHistorySectionMonth('March', NOW), '2026-03');
    assert.equal(M.resolveHistorySectionMonth('October', NOW), '2026-10');
    assert.equal(M.resolveHistorySectionMonth('December', NOW), '2025-12');
    assert.equal(M.resolveHistorySectionMonth('novembre', NOW), '2025-11');
  });

  test('future months are clamped to the current month', () => {
    assert.equal(M.resolveHistorySectionMonth('December 2030', NOW), '2026-10');
    assert.equal(M.resolveHistorySectionMonth('November 2026', NOW), '2026-10');
  });

  test('a year boundary is handled (January viewing December sections)', () => {
    const jan = new Date(2027, 0, 3);
    assert.equal(M.resolveHistorySectionMonth('December 2026', jan), '2026-12');
    assert.equal(M.resolveHistorySectionMonth('Last week', jan), '2027-01');
  });

  test('extra locales extend the name table and invalid ones are ignored', () => {
    // Dutch is not in the built-in list.
    assert.equal(M.resolveHistorySectionMonth('mei 2025', NOW, ['nl']), '2025-05');
    assert.doesNotThrow(() => M.resolveHistorySectionMonth('mei 2025', NOW, ['not_a-locale!!']));
  });

  test('defaults `now` to the real current date', () => {
    assert.equal(M.resolveHistorySectionMonth('Today'), M.monthIdFromDate(new Date()));
  });

  test('always returns a valid month id', () => {
    for (const h of ['Today', 'September 2025', 'gibberish 1234', 'May', '2025']) {
      assert.equal(M.isValidMonthId(M.resolveHistorySectionMonth(h, NOW)), true, h);
    }
  });
});
