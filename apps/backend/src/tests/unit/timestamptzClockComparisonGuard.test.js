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
 *
 * ARM 2 (DATE columns) is pinned the same way and one step further. Its subject
 * is not a regex but an ENUMERATION — the DATE columns that actually reach a
 * clock comparison — because most of those sites are variable-mediated and no
 * detector can see them. So the thing that can silently rot is the enumeration
 * itself, and what is pinned is its SIZE: a snapshot of the columns that REACH
 * a clock, never of the columns that exist. A snapshot of the existing set
 * would have stayed green through all three defects.
 */

import {
  ALLOWLIST,
  DATE_CLOCK_REACHING_COLUMNS,
  DATE_CLOCK_SITES,
  DATE_COLUMNS,
  DATE_FIXED_SITES,
  DATE_NEXT_SLICE,
  columnOf,
  scanSource,
} from '../../../scripts/check-timestamptz-clock-comparisons.mjs';

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
  it('ignores both fixed idioms it steers you towards', () => {
    // The guard blesses two null branches, not one: an authorization gate must
    // fail CLOSED ("== null ||"), while a capability/TTL field whose NULL means
    // "no expiry configured" may fail open ("!= null &&"). Pinning only the
    // permissive form is what let it read as the single blessed recipe, which
    // is how PR #881 converted two ABDM consent gates into a fail-open. Both
    // shapes must stay invisible to the detector.
    expect(scan(
      'const t = epochMsOrNull(row.expires_at_epoch_ms);\nif (t == null || t < Date.now()) throw x;',
    )).toEqual([]);
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

describe('clock-comparison guard, ARM 1 — allowlist', () => {
  it('documents a concrete reason for every exception', () => {
    expect(ALLOWLIST.length).toBeGreaterThan(0);
    for (const entry of ALLOWLIST) {
      expect(entry.file).toMatch(/^src\/.+\.js$/);
      expect(entry.match.length).toBeGreaterThan(3);
      expect(entry.reason.length).toBeGreaterThan(40);
    }
  });

  it('only excuses the one reason the guard cannot fix — a Prisma delegate read', () => {
    // NARROWED, deliberately. This used to read /delegate|DATE column/i, and
    // that second alternative is what let `staff.hire_date` sit here excused for
    // being a DATE — the reasoning that put the whole DATE class outside this
    // guard, and that PR #1022 became the third defect to walk through. A DATE
    // is not an exception any more; it is arm 2, with its own prescription.
    for (const entry of ALLOWLIST) {
      expect(entry.reason).toMatch(/delegate/i);
      expect(entry.reason).not.toMatch(/DATE column/i);
    }
  });

  it('POPULATION SNAPSHOT: three reviewed timestamptz exceptions', () => {
    // Was four. hire_date left for arm 2; the three that remain are the Prisma
    // model-delegate reads a computed epoch column cannot be attached to.
    expect(ALLOWLIST).toHaveLength(3);
  });
});

describe('clock-comparison guard, ARM 2 — DATE columns', () => {
  it('classifies a hit by the COLUMN, so a DATE never gets arm 1 advice', () => {
    // The same expression shape, two different prescriptions. expires_at is a
    // timestamptz and wants the epoch twin; expiry_date is a DATE, and an epoch
    // twin of it would re-freeze the same arbitrary midnight.
    expect(columnOf('new Date(row.expires_at).getTime() < Date.now()')).toBeNull();
    expect(columnOf('new Date(row.expiry_date).getTime() < Date.now()')).toBe('expiry_date');
  });

  it('knows the DATE columns that wear an instant name', () => {
    // The trap that makes name-based classification useless: these are DATE
    // columns whose names end in the suffix this codebase uses for instants, so
    // arm 1 would confidently hand every one of them an epoch twin.
    for (const name of ['renewal_due_at', 'tested_at', 'installed_at', 'enrolled_at',
      'registered_at', 'last_certified_at', 'undertaking_signed_at']) {
      expect(DATE_COLUMNS.has(name)).toBe(true);
    }
  });

  it('catches local midnight from the process zone, not only a bare clock', () => {
    // `new Date(new Date().toDateString())` is the shape three of the gates in
    // the registry were written in, and it is MORE misleading than Date.now()
    // because it looks like a day comparison. It is local midnight in whatever
    // zone the PROCESS happens to run in.
    expect(scanSource(
      'if (new Date(unit.expiry_date) < new Date(new Date().toDateString())) throw x;',
    )).toHaveLength(1);
  });

  it('every registry entry says what the comparison DECIDES', () => {
    // Triage is by consequence, not by how often a column appears: an
    // authorisation gate off by five and a half hours is an access decision, a
    // printed age is a cosmetic one.
    expect(DATE_CLOCK_SITES.length).toBeGreaterThan(0);
    for (const site of DATE_CLOCK_SITES) {
      expect(site.file).toMatch(/^src\/.+\.js$/);
      expect(DATE_COLUMNS.has(site.column)).toBe(true);
      expect(site.decides.length).toBeGreaterThan(20);
      expect(['fixed', 'next_slice']).toContain(site.status);
      if (site.status === 'fixed') {
        // What it used to say, so a revert is detectable rather than merely absent.
        expect(site.was.length).toBeGreaterThan(10);
      } else {
        // What it still says, so the deferral cannot outlive the code.
        expect(site.match.length).toBeGreaterThan(10);
        expect(site.deferred.length).toBeGreaterThan(40);
      }
    }
  });

  it('POPULATION SNAPSHOT: the columns that REACH a clock, not the ones that exist', () => {
    // THE POINT OF THIS ASSERTION. 112 DATE columns exist; 13 of them reach a
    // clock comparison. Snapshotting the 112 would sit green while the reaching
    // set grew — which is exactly the failure arm 2 was added for. Remove a
    // column from the registry and this goes red.
    expect(DATE_CLOCK_REACHING_COLUMNS).toHaveLength(13);
    expect(DATE_COLUMNS.size).toBe(112);
    expect(DATE_CLOCK_REACHING_COLUMNS.length).toBeLessThan(DATE_COLUMNS.size);
    // Derived from the registry, never transcribed beside it.
    expect(DATE_CLOCK_REACHING_COLUMNS)
      .toEqual([...new Set(DATE_CLOCK_SITES.map((site) => site.column))].sort());
  });

  it('POPULATION SNAPSHOT: 27 sites, 6 on the rail and 21 reviewed deferrals', () => {
    expect(DATE_CLOCK_SITES).toHaveLength(27);
    expect(DATE_FIXED_SITES).toHaveLength(6);
    expect(DATE_NEXT_SLICE).toHaveLength(21);
    expect(DATE_FIXED_SITES.length + DATE_NEXT_SLICE.length).toBe(DATE_CLOCK_SITES.length);
  });

  it('fixed the AUTHORISATION gates first', () => {
    // The triage rule, asserted rather than left in prose: every entry that
    // decides ACCESS is on the rail, and nothing deferred is one.
    const gates = DATE_CLOCK_SITES.filter(
      (site) => /authorisation gate|validation gate/i.test(site.decides),
    );
    expect(gates.length).toBeGreaterThan(0);
    for (const gate of gates) expect(gate.status).toBe('fixed');
  });

  it('neither arm is looking at an empty population', () => {
    expect(ALLOWLIST.length).toBeGreaterThan(0);
    expect(DATE_COLUMNS.size).toBeGreaterThan(0);
    expect(DATE_CLOCK_SITES.length).toBeGreaterThan(0);
    expect(DATE_CLOCK_REACHING_COLUMNS.length).toBeGreaterThan(0);
  });
});

describe('timestamptz clock-comparison guard — throws rather than skipping unparseable input', () => {
  it('surfaces a parse failure instead of silently reporting zero hits', () => {
    // A silent skip would degrade the guard to zero coverage without anyone
    // noticing, so the script treats a parse failure as an error.
    expect(() => scanSource('function ( { syntax error')).toThrow(/parse failed/);
  });
});
