// MEDIUM (audit 2026-06-18 §4) + W1-H4 (audit 2026-06-22) — a high-NEWS2 (>=5)
// escalation failure must be LOUD (propagate), not swallowed, AND it must route
// to a REAL assigned recipient (the results-inbox producer), not a recipient-less
// notification_outbox row that dead-letters to nobody.
//
// Defects:
//   §4   recordNEWS2 queued the >=5 alert in a try/catch that downgraded any
//        failure to logger.error + continue — a deteriorating patient's
//        escalation could be lost while the call returned "success".
//   W1-H4 escalateNews2 queued into notification_outbox with NO recipient — the
//        drain dead-lettered it after 3 retries, so it reached no one even on
//        the "happy" path.
//
// Fix proven here (unit; results-inbox producer + persistence module-mocked):
//   1. A >=5 NEWS2 whose escalation producer THROWS makes recordNEWS2 throw
//      (loud) — the caller / Sentry sees it.
//   2. A >=5 NEWS2 whose producer returns { created: false } (no assigned task)
//      ALSO throws loud — a deteriorating-patient alert that reached no one must
//      never look like success (the W1-H4 regression guard).
//   3. A <5 NEWS2 producer failure stays best-effort (no throw) — a routine
//      monitoring nudge must never block clinical recording.
//   4. The news2_scores row is still persisted before escalation in all cases.

import { jest } from '@jest/globals';

// The shared results-inbox producer is the recipient-bearing escalation path.
const inboxControl = { throwError: null, result: { created: true, taskId: 99 } };
const enqueueSpy = jest.fn(async () => {
  if (inboxControl.throwError) throw inboxControl.throwError;
  return inboxControl.result;
});

jest.unstable_mockModule('../../services/results/resultsInboxService.js', () => ({
  enqueueCriticalResultTask: enqueueSpy,
}));

// Stub the CDS surfacing dynamic import so it never touches a DB.
const surfaceNews2CdsSpy = jest.fn(async () => null);
jest.unstable_mockModule('../../services/cds/deteriorationEarlyWarningService.js', () => ({
  surfaceNews2Cds: surfaceNews2CdsSpy,
}));

// Mock prisma so the news2_scores INSERT is observable without a real DB.
// setTenantTx runs its callback with a tx client backed by the same spy —
// recordNEWS2 now wraps the persist + canonical emit in a tenant-scoped tx.
const dbControl = { tenantLookupError: null, recordedAt: new Date('2026-08-11T05:00:00.000Z') };
const insertSpy = jest.fn(async (sql) => {
  if (String(sql).includes('SELECT tenant_id::text AS tenant_id')) {
    if (dbControl.tenantLookupError) throw dbControl.tenantLookupError;
    return [{ tenant_id: '00000000-0000-4000-8000-0000000000a1' }];
  }
  return [{
    id: 4242, patient_uid: 'x', total_score: 0, clinical_risk: 'high',
    recorded_by: 'y', recorded_at: dbControl.recordedAt, created_at: new Date(),
  }];
});
const setTenantTxSpy = jest.fn(async (_tenantId, fn) => fn({ $queryRawUnsafe: insertSpy }));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: insertSpy },
  setTenantTx: setTenantTxSpy,
}));

// Stub the canonical emit — this suite pins escalation loudness, not the
// timeline invariant (news2-standalone-canonical.deep.test.js pins that).
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  cancelWorkflowSla: jest.fn(),
  recordCanonicalClinicalEvent: jest.fn(async () => ({ timeline: { id: 1 }, audit: { id: 1 } })),
}));

const { escalateNews2, persistNews2, recordNEWS2 } = await import('../../services/clinical/news2Service.js');

// Vitals that score >=7 (high): RR26(3)+SpO2 90 scale1(3)+O2(2)+T37(0)+SBP95(2)+HR130(2)+A(0)=12
const CRITICAL_VITALS = {
  respiration_rate: 26, spo2: 90, supplemental_o2: true,
  temperature: 37, systolic_bp: 95, heart_rate: 130, consciousness: 'A',
};
// Vitals that score in 1..4 (low_to_medium, below the >=5 escalation threshold):
// RR 21 (2) only.
const LOW_VITALS = {
  respiration_rate: 21, spo2: 98, temperature: 37, systolic_bp: 120, heart_rate: 72, consciousness: 'A',
};

describe('NEWS2 escalation loudness + recipient (MEDIUM §4 / W1-H4)', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-11T05:00:00.000Z'));
    inboxControl.throwError = null;
    inboxControl.result = { created: true, taskId: 99 };
    dbControl.tenantLookupError = null;
    dbControl.recordedAt = new Date('2026-08-11T05:00:00.000Z');
    enqueueSpy.mockClear();
    surfaceNews2CdsSpy.mockClear();
    insertSpy.mockClear();
    setTenantTxSpy.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('persists the source observation timestamp instead of defaulting NEWS2 to now', async () => {
    const sourceRecordedAt = new Date('2026-08-11T03:45:00.000Z');

    await persistNews2('p-uid', LOW_VITALS, 'r-uid', {
      recordedAt: sourceRecordedAt,
    });

    const insert = insertSpy.mock.calls.find(([sql]) => /INSERT INTO news2_scores/.test(sql));
    expect(insert).toBeDefined();
    expect(insert[0]).toMatch(/recorded_at/);
    expect(insert[0]).toMatch(/to_timestamp\(\$17::double precision/);
    expect(insert).toContain(sourceRecordedAt.getTime());
  });

  test('a stale historical NEWS2 persists but cannot create tasks or CDS alerts', async () => {
    const record = {
      id: 4242,
      recorded_at: new Date('2023-08-11T05:00:00.000Z'),
    };
    const computed = {
      totalScore: 12,
      clinicalRisk: 'high',
      escalationAction: 'Emergency response',
      scores: { spo2: 3 },
      anyParamThree: true,
    };

    await expect(escalateNews2('p-uid', record, computed, {
      tenantId: '00000000-0000-4000-8000-0000000000a1',
    })).resolves.toMatchObject({ skipped: true, reason: 'stale_observation' });

    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(surfaceNews2CdsSpy).not.toHaveBeenCalled();
  });

  test('tenant lookup fault rejects before writing under a default tenant', async () => {
    dbControl.tenantLookupError = new Error('tenant lookup unavailable');

    await expect(recordNEWS2('p-uid', CRITICAL_VITALS, 'r-uid'))
      .rejects.toThrow('tenant lookup unavailable');
    expect(setTenantTxSpy).not.toHaveBeenCalled();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  test('>=5: a producer THROW propagates (loud)', async () => {
    inboxControl.throwError = new Error('inbox down');
    await expect(recordNEWS2('p-uid', CRITICAL_VITALS, 'r-uid'))
      .rejects.toThrow(/inbox down|escalation/i);
    // Row was persisted before escalation was attempted.
    expect(insertSpy).toHaveBeenCalled();
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  test('>=5: a producer FAILURE (created:false WITH an error) throws loud (W1-H4)', async () => {
    inboxControl.result = { created: false, error: 'no recipient resolvable' };
    await expect(recordNEWS2('p-uid', CRITICAL_VITALS, 'r-uid'))
      .rejects.toThrow(/failed to create a task|escalation/i);
    expect(insertSpy).toHaveBeenCalled();
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  test('>=5: an idempotency conflict (created:false, NO error) is a safe no-op (no throw)', async () => {
    // enqueueCriticalResultTask returns created:false WITHOUT an error when an
    // OPEN task for this score already exists (a duplicate/retry escalation). The
    // alert already reached a recipient, so the service must NOT throw — doing so
    // would crash the caller on any re-escalation of the same score.
    inboxControl.result = { created: false, taskId: null };
    await expect(recordNEWS2('p-uid', CRITICAL_VITALS, 'r-uid')).resolves.toBeTruthy();
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  test('<5: a producer failure stays best-effort (no throw)', async () => {
    inboxControl.throwError = new Error('inbox down');
    // Score is below 5 → no alert produced at all, so nothing to fail loudly on.
    await expect(recordNEWS2('p-uid', LOW_VITALS, 'r-uid')).resolves.toBeTruthy();
    expect(insertSpy).toHaveBeenCalled();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  test('>=5 happy path: an assigned task is created, returns the persisted record', async () => {
    const record = await recordNEWS2('p-uid', CRITICAL_VITALS, 'r-uid');
    expect(record).toBeTruthy();
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    // The producer was asked for a deliverable critical task for this score.
    const arg = enqueueSpy.mock.calls[0][0];
    expect(arg).toMatchObject({ source: 'news2', resourceType: 'news2_score' });
    expect(arg.severity).toBe('critical'); // 12 >= 7
  });
});
