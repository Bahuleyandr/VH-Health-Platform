// MEDIUM (audit 2026-06-18 §4) — recordCanonicalClinicalEvent swallow scope.
//
// Defect: isSchemaMissing() matched 42P01 (undefined_table) OR 42703
// (undefined_column) OR a "relation/column does not exist" message regex. On
// schema DRIFT (a real canonical table that's missing a column, or a transient
// fault whose message happens to match), the timeline/audit INSERT was silently
// swallowed (logger.warn + return null) while the caller's detail row had
// already been written — quietly degrading the atomic timeline invariant.
//
// Fix proven here: the swallow is restricted to a genuinely-ABSENT canonical
// table (SQLSTATE 42P01). A 42703 (column drift) and any other error PROPAGATE
// so the in-tx writers (recordCanonicalOrderEvent / recordCanonicalVitalsEvent)
// abort their transaction and the failure surfaces / alarms instead of leaving
// a detail row with no timeline+audit row.
//
// Pure unit test: a hand-rolled fake `db` client whose $queryRawUnsafe throws a
// chosen Prisma-shaped error. No real DB needed.

import { jest } from '@jest/globals';

const {
  recordTimelineEvent,
  recordClinicalAuditEvent,
  recordCanonicalClinicalEvent,
} = await import('../../services/clinical/canonicalClinicalPlatformService.js');

const PATIENT_UID = '00000000-0000-4000-8000-0000000000aa';

// Build a fake transaction-shaped client (has $queryRawUnsafe) that throws a
// Prisma-style error carrying the given SQLSTATE on the FIRST insert call.
function throwingDb(code, message) {
  const err = new Error(message || `error ${code}`);
  err.code = code; // Prisma surfaces driver SQLSTATE on .code for $queryRawUnsafe
  return {
    $queryRawUnsafe: jest.fn(async () => { throw err; }),
  };
}

const baseEvent = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  patientUid: PATIENT_UID,
  eventType: 'order.created',
  action: 'order.created',
  sourceTable: 'clinical_orders',
  sourceId: '1',
  resourceType: 'clinical_order',
  resourceId: '1',
};

describe('canonical swallow narrowing (MEDIUM §4)', () => {
  test('42P01 (table genuinely absent) is SWALLOWED — returns null, does not throw', async () => {
    const db = throwingDb('42P01', 'relation "clinical_timeline_events" does not exist');
    await expect(recordTimelineEvent(baseEvent, { db })).resolves.toBeNull();
  });

  test('42703 (column drift on an existing table) PROPAGATES — does not silently swallow', async () => {
    const db = throwingDb('42703', 'column "occurred_at" does not exist');
    await expect(recordTimelineEvent(baseEvent, { db })).rejects.toThrow(/column .* does not exist/i);
  });

  test('a generic write fault PROPAGATES (atomic invariant cannot silently degrade)', async () => {
    const db = throwingDb('XX000', 'internal server error during insert');
    await expect(recordTimelineEvent(baseEvent, { db })).rejects.toThrow(/internal server error/i);
  });

  test('audit-event writer narrows the same way (42703 propagates)', async () => {
    const db = throwingDb('42703', 'column "after_state" does not exist');
    await expect(recordClinicalAuditEvent(baseEvent, { db })).rejects.toThrow(/column .* does not exist/i);
  });

  test('recordCanonicalClinicalEvent propagates a column-drift fault from its inner writes', async () => {
    const db = throwingDb('42703', 'column "tags" does not exist');
    await expect(recordCanonicalClinicalEvent(baseEvent, { db })).rejects.toThrow(/column .* does not exist/i);
  });

  test('transactional patient writes reject a genuinely-absent canonical table', async () => {
    const db = throwingDb('42P01', 'relation "clinical_timeline_events" does not exist');
    await expect(recordCanonicalClinicalEvent(baseEvent, { db }))
      .rejects.toMatchObject({ code: 'CANONICAL_TIMELINE_REQUIRED' });
  });
});
