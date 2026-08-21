/**
 * Subsystem invariant: ABDM never compares a driver-materialised timestamptz
 * against the clock.
 *
 * A `timestamptz` read back through the pg driver is materialised as a JS Date
 * shifted by the DATABASE SESSION timezone, so `new Date(row.some_at) < Date.now()`
 * is correct only when that session happens to be UTC. Three separate defects of
 * this shape shipped in this subsystem:
 *
 *   - HIU consent expiry           — denied valid reads on a negative-offset session
 *   - HIU key-material expiry (x2) — accepted EXPIRED key material on a positive
 *                                    offset (fail-open; +5:30 on Asia/Kolkata)
 *   - ABHA enrolment OTP expiry    — same fail-open shape
 *   - HIU page-claim freshness / webhook replay window — shifted either way
 *
 * The PRIMARY defence is now the connection-level session pin in
 * `src/lib/prisma.js` (`pinSessionTimeZoneToUrl`), guarded by
 * `prismaSessionTimeZone.test.js` — it forces every session to UTC and so fixes
 * this class everywhere at once, including the typed model delegates, which are
 * skewed identically and cannot be fixed with a computed column.
 *
 * This file is the second layer: within ABDM, the safety-critical subsystem
 * where the fail-open cases lived, instants are read as an epoch-millisecond
 * twin (`(EXTRACT(EPOCH FROM col) * 1000)::bigint AS col_epoch_ms`) via
 * `epochMsOrNull` from `src/utils/dbInstant.js`, so consent and credential
 * expiry stay correct even if the pin is ever lost or overridden.
 *
 * It is a SOURCE-shape assertion on purpose. CI runs a UTC database, so every
 * one of those defects is behaviourally invisible there — a relapse would ship
 * green. Only the shape can be checked in CI.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const GUARDED_DIRS = ['../../services/abdm/', '../../services/abdmFull/'];

// Matches a Date built from anything whose name ends in `_at` — i.e. a database
// timestamp column. Deliberately not narrowed to `.getTime()` or `Date.now()`:
// the comparison is often several lines away from the construction, and the
// safe habit is to never materialise one of these at all.
const DRIVER_DATE = /new Date\([^)]*_at[^)]*\)/g;

function collectOffenders() {
  const offenders = [];
  for (const dir of GUARDED_DIRS) {
    const abs = fileURLToPath(new URL(dir, import.meta.url));
    for (const name of readdirSync(abs)) {
      if (!name.endsWith('.js')) continue;
      const source = readFileSync(path.join(abs, name), 'utf8');
      for (const hit of source.match(DRIVER_DATE) ?? []) {
        offenders.push(`${path.basename(dir)}/${name}: ${hit}`);
      }
    }
  }
  return offenders;
}

describe('ABDM instant comparisons', () => {
  it('never builds a JS Date from a timestamptz column', () => {
    expect(collectOffenders()).toEqual([]);
  });

  it('guards every ABDM service file, so the invariant cannot be sidestepped', () => {
    // A regex that silently matches nothing would pass the assertion above
    // forever. Pin that the sweep actually reads a meaningful corpus.
    let files = 0;
    for (const dir of GUARDED_DIRS) {
      const abs = fileURLToPath(new URL(dir, import.meta.url));
      files += readdirSync(abs).filter((n) => n.endsWith('.js')).length;
    }
    expect(files).toBeGreaterThanOrEqual(5);
    expect('new Date(row.received_at).getTime()'.match(DRIVER_DATE)).not.toBeNull();
  });
});
