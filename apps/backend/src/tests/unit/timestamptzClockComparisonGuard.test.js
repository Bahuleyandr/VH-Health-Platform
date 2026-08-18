/**
 * Pins the timestamptz clock-comparison guard
 * (scripts/check-timestamptz-clock-comparisons.mjs).
 *
 * The guard forbids comparing a driver-materialised database timestamp against
 * the process clock. That comparison is wrong by the DATABASE SESSION timezone
 * offset, which shipped two FAIL-OPEN defects (expired HIU key material and an
 * expired ABHA enrolment OTP each accepted for up to 5h30m on Asia/Kolkata).
 *
 * These assertions matter because the guard is the only thing that can catch a
 * relapse: CI runs a UTC database, so the defect is behaviourally invisible
 * there. A guard that silently stopped matching would be worse than none — so
 * both directions are pinned, and so is the fact that it reads a real corpus.
 */

import { scanSource, ALLOWLIST } from '../../../scripts/check-timestamptz-clock-comparisons.mjs';

const scan = (code) => scanSource(code).map((h) => h.text);

describe('timestamptz clock-comparison guard — detects the defect', () => {
  it.each([
    ['getTime vs Date.now', 'if (new Date(row.expires_at).getTime() < Date.now()) throw x;'],
    ['bare Date vs new Date()', "if (row.expires_at && new Date(row.expires_at) < new Date()) return 'expired';"],
    ['clock on the left', 'const age = Date.now() - new Date(latest.recorded_at).getTime();'],
    ['optional chaining', 'const e = new Date(consent?.expires_at).getTime() <= Date.now();'],
    ['bracket access', "if (new Date(row['expires_at']).getTime() < Date.now()) return null;"],
    ['camelCase column', 'if (new Date(row.expiryDate).getTime() < Date.now()) return null;'],
    ['nested path', 'if (new Date(a.b.c.due_at).getTime() > Date.now()) return null;'],
  ])('flags %s', (_name, code) => {
    expect(scan(code)).toHaveLength(1);
  });
});

describe('timestamptz clock-comparison guard — ignores benign shapes', () => {
  it('ignores the fixed idiom it steers you towards', () => {
    expect(scan(
      'const t = epochMsOrNull(row.expires_at_epoch_ms);\nif (t != null && t < Date.now()) throw x;',
    )).toEqual([]);
  });

  it('ignores a ternary that merely defaults to now', () => {
    expect(scan('const asOf = row.recorded_at ? new Date(row.recorded_at) : new Date();')).toEqual([]);
    expect(scan('const d = p.refresh_expires_at ? new Date(p.refresh_expires_at) : new Date(Date.now() + TTL);')).toEqual([]);
  });

  it('ignores DB-vs-DB comparison and sorting', () => {
    expect(scan('rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));')).toEqual([]);
    expect(scan('if (new Date(row.updated_at) > new Date(other.updated_at)) return row;')).toEqual([]);
  });

  it('ignores formatting', () => {
    expect(scan('const s = new Date(row.created_at).toISOString();')).toEqual([]);
  });

  it('ignores the pattern inside a comment', () => {
    // This is exactly why the guard parses with acorn and blanks comments: the
    // explanatory prose in src/lib/prisma.js quotes the defect verbatim.
    expect(scan('// new Date(row.expires_at) < Date.now() is wrong on a non-UTC session\nconst a = 1;')).toEqual([]);
  });

  it('ignores the pattern inside a string or template literal', () => {
    expect(scan('const msg = "new Date(row.expires_at).getTime() < Date.now()";')).toEqual([]);
    expect(scan('const sql = `new Date(row.expires_at).getTime() < Date.now()`;')).toEqual([]);
  });

  it('ignores a non-column local, which it cannot resolve', () => {
    // Documented recall limit, asserted so the gap is deliberate rather than
    // discovered later: a variable-mediated comparison is invisible here.
    expect(scan('const t = row.expires_at;\nif (new Date(t).getTime() < Date.now()) throw x;')).toEqual([]);
  });
});

describe('timestamptz clock-comparison guard — allowlist', () => {
  it('documents a concrete reason for every exception', () => {
    expect(ALLOWLIST.length).toBeGreaterThan(0);
    for (const entry of ALLOWLIST) {
      expect(entry.file).toMatch(/^src\/.+\.js$/);
      expect(entry.match.length).toBeGreaterThan(3);
      expect(entry.reason.length).toBeGreaterThan(40);
    }
  });

  it('only excuses reasons the guard cannot fix — a delegate read or a DATE column', () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason).toMatch(/delegate|DATE column/i);
    }
  });
});

describe('timestamptz clock-comparison guard — throws rather than skipping unparseable input', () => {
  it('surfaces a parse failure instead of silently reporting zero hits', () => {
    // A silent skip would degrade the guard to zero coverage without anyone
    // noticing, so the script treats a parse failure as an error.
    expect(() => scanSource('function ( { syntax error')).toThrow(/parse failed/);
  });
});
