/**
 * SOURCE PIN + BEHAVIOURAL PIN for the readiness freshness clock.
 *
 * THE DEFECT. Every instant pre-procedure lab readiness ranks is a Postgres
 * stamp — a result's performed_at, an order's requested_at, a booking's
 * created_at — taken off the DATABASE's clock. The resolver took its `asOf`
 * from `new Date()`, the node process's clock, which in dev, in CI and on the
 * rig is a different clock in a different container running a millisecond or
 * two apart. `withinWindow` and `rankResult` both have a LOWER bound of
 * `age >= 0`, so a row the database stamped a moment ago read as FUTURE-dated
 * and was dropped: the item fell back to not_ordered with a null
 * investigation_id, and the checklist told the ward to order a draw already in
 * flight. It flaked about one run in three, and the deep suite had been
 * backdating its fixtures by a minute to hide it.
 *
 * WHY A SOURCE PIN AS WELL AS A BEHAVIOURAL ONE. The failure is a SKEW, so on
 * any run where the two clocks happen to fall the right way the wrong code
 * passes — which is exactly how it survived review and CI. Only the source
 * shape can be checked unconditionally, which is the same argument
 * scripts/check-timestamptz-clock-comparisons.mjs makes about its own family.
 *
 * The behavioural half below is deterministic for the same reason: it injects
 * the clock through the `db` seam refreshCaseLabReadiness already has and
 * asserts EQUALITY against the injected instant, never closeness to now.
 */

import { readFileSync } from 'node:fs';

import { jest } from '@jest/globals';

const TENANT = '11111111-2222-4333-8444-555555555555';
const PATIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CASE_ID = 42;

// An instant nothing on this machine can produce by accident: a fixed point in
// the past that no process clock will ever read. Equality against it is
// therefore a statement about WHERE the value came from, not about when.
const INJECTED_CLOCK_MS = Date.parse('2026-09-04T06:00:00.000Z');

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
  $executeRawUnsafe: jest.fn(),
  $transaction: jest.fn(),
  $on: jest.fn(),
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  __esModule: true,
  default: prismaMock,
  prismaReadOnly: prismaMock,
  setTenant: jest.fn(),
  setTenantTx: jest.fn(),
  isTenantTransactionClient: () => false,
  circuitBreakerStatus: () => ({}),
  pinSessionTimeZoneToUrl: (url) => url,
  evaluateTenantRlsPosture: () => ({}),
  tenantRlsRuntimeRole: () => null,
  tenantRlsRolePosture: async () => ({}),
  logTenantRlsRolePosture: async () => {},
  rlsDisabledLogLevel: () => 'warn',
  tenantRlsPostureMustFailClosed: () => false,
  ensureTenantRlsRuntimeRoleGrants: async () => {},
}));

const { refreshCaseLabReadiness, resolveItemState } = await import(
  '../../services/clinical/cathLabReadinessService.js'
);

const readSource = (name) => readFileSync(
  new URL(`../../services/clinical/${name}.js`, import.meta.url),
  'utf8',
);
const RULES_SOURCE = readSource('cathLabReadinessRules');
const SERVICE_SOURCE = readSource('cathLabReadinessService');

/**
 * Blank comments and string/template bodies so PROSE cannot satisfy or violate
 * an assertion about code. Both files discuss `new Date()` at length — they
 * have to, it is the defect they were written against — so a naive grep would
 * report the explanation as the offence.
 *
 * Byte-for-byte length-preserving, so an offending line number still means
 * something. Deliberately simple rather than acorn-based: these two files are
 * ordinary ESM and the guard script already owns the parser-grade version.
 */
function blankNonCode(text) {
  const out = [...text];
  let i = 0;
  const blankTo = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === '//') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blankTo(i, stop);
      i = stop;
    } else if (two === '/*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blankTo(i, stop);
      i = stop;
    } else if (text[i] === "'" || text[i] === '"' || text[i] === '`') {
      const quote = text[i];
      let k = i + 1;
      while (k < text.length && text[k] !== quote) {
        if (text[k] === '\\') k += 1;
        k += 1;
      }
      blankTo(i + 1, k);
      i = k + 1;
    } else {
      i += 1;
    }
  }
  return out.join('');
}

const RULES_CODE = blankNonCode(RULES_SOURCE);
const SERVICE_CODE = blankNonCode(SERVICE_SOURCE);

// The two clock readings. `new Date()` with NO argument, and Date.now().
const PROCESS_CLOCK = /new\s+Date\s*\(\s*\)|Date\s*\.\s*now\s*\(\s*\)/g;

const clockReadings = (code) => (code.match(PROCESS_CLOCK) || []);

describe('the readiness freshness path never reads the process clock', () => {
  it.each([
    ['cathLabReadinessRules.js', () => RULES_CODE],
    ['cathLabReadinessService.js', () => SERVICE_CODE],
  ])('%s contains no new Date() and no Date.now()', (_name, code) => {
    expect(clockReadings(code())).toEqual([]);
  });

  it('names the Date constructions that ARE allowed, so the rule is not "no Dates"', () => {
    // A Date built FROM a value is a conversion, not a clock reading, and all
    // three of these are load-bearing:
    //
    //   msToIso(ms)        — writes observed_at / ordered_at from an epoch;
    //   isCalendarDate()   — rejects 2026-13-45 by round-tripping Date.UTC;
    //   dbClockAsOf(tx)    — rebuilds the Date from the DATABASE's epoch twin.
    //
    // Asserted positively so a future edit cannot satisfy the rule above by
    // deleting the conversions instead of the clock.
    expect(RULES_CODE).toContain('new Date(ms).toISOString()');
    expect(RULES_CODE).toContain('new Date(Date.UTC(year, month - 1, day))');
    expect(SERVICE_CODE).toContain('return new Date(ms);');
  });

  it('takes asOf from clock_timestamp(), on the transaction, exactly once', () => {
    // clock_timestamp() and NOT now(): now() is transaction_timestamp(), one
    // instant fixed when the transaction STARTED, so a refresh running on a
    // transaction that has already written would judge freshness at an instant
    // before the rows it exists to see, and drop them by the same `age >= 0`
    // bound this whole lane is about.
    //
    // Read from the RAW source, not the blanked copy: the statement is SQL
    // inside a string literal, which blankNonCode deliberately erases.
    const calls = SERVICE_SOURCE.match(/EXTRACT\(EPOCH FROM clock_timestamp\(\)\)/g) || [];
    // Exactly one: clock_timestamp() is volatile, so a second call — a twin
    // selected beside the column, say — would be a second, different instant.
    expect(calls).toHaveLength(1);
    expect(SERVICE_SOURCE).toContain(
      'SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS as_of_epoch_ms',
    );
    // ...and it is what the refresh actually uses.
    expect(SERVICE_CODE).toContain('const asOf = await dbClockAsOf(tx);');
  });

  it('resolveItemState has no asOf default at all', () => {
    // The default was the defect: it substituted the wrong clock silently, and
    // silently is the only way this can go wrong. A missing asOf now throws.
    expect(RULES_CODE).not.toMatch(/asOf\s*=\s*new\s+Date/);
    expect(() => resolveItemState({ item: 'potassium', windowDays: 30 }))
      .toThrow(/requires `asOf`/);
  });
});

/**
 * A client that answers every statement refreshCaseLabReadiness issues, with an
 * INJECTED clock. Matching on the FROM target, like the OpenAPI source pin's
 * stub, so reordering the reads inside the service cannot start feeding one
 * query another's rows.
 */
function stubDb(clockRows) {
  return {
    $queryRawUnsafe: async (sql) => {
      if (/clock_timestamp\s*\(/i.test(sql)) {
        const rows = [{ as_of_epoch_ms: BigInt(INJECTED_CLOCK_MS) }];
        clockRows.push(rows);
        return rows;
      }
      if (/FROM cath_lab_cases/.test(sql)) {
        return [{
          id: 42n,
          tenant_id: TENANT,
          patient_uid: PATIENT,
          encounter_id: null,
          facility_id: 1,
          status: 'scheduled',
          urgency: 'elective',
          actual_start_at: null,
        }];
      }
      if (/FROM cath_lab_readiness_settings/.test(sql)) return [];
      if (/FROM cath_reprocessing_settings/.test(sql)) return [];
      if (/FROM lab_results/.test(sql)) return [];
      if (/FROM investigation_bookings/.test(sql)) return [];
      if (/FROM investigations/.test(sql)) return [];
      if (/FROM lab_specimens/.test(sql)) return [];
      if (/FROM cath_case_lab_readiness_items/.test(sql)) return [];
      if (/FROM cath_lab_readiness_checks/.test(sql)) return [];
      throw new Error(`unstubbed query: ${sql.slice(0, 120)}`);
    },
    $executeRawUnsafe: async () => 1,
  };
}

describe('refreshCaseLabReadiness reports the instant the DATABASE gave it', () => {
  it('asks the transaction for its clock once and returns that exact instant', async () => {
    const clockRows = [];
    const readiness = await refreshCaseLabReadiness({
      tenantId: TENANT, caseId: CASE_ID, db: stubDb(clockRows), context: {},
    });
    // Once. Twice would be two instants, because clock_timestamp() is volatile.
    expect(clockRows).toHaveLength(1);
    // EQUALITY against the injected instant, not closeness to now. A tolerance
    // would pass on the process clock, which is the whole defect: restore
    // `asOf = new Date()` and this is red on every run rather than one in three.
    expect(readiness.evaluated_at).toBe(new Date(INJECTED_CLOCK_MS).toISOString());
    expect(Date.parse(readiness.evaluated_at)).toBe(INJECTED_CLOCK_MS);
  });
});
