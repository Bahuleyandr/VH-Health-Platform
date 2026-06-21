// MEDIUM (audit 2026-06-18 §4) — a high-NEWS2 (>=5) escalation failure must be
// LOUD (propagate), not swallowed.
//
// Defect: recordNEWS2 queued the >=5 alert in a try/catch that downgraded any
// failure to logger.error + continue — a deteriorating patient's escalation
// could be lost while the call returned "success".
//
// Fix proven here (unit; outbox + persistence module-mocked):
//   1. A >=5 NEWS2 whose escalation enqueue FAILS makes recordNEWS2 throw
//      (loud) — the caller / Sentry sees it.
//   2. A <5 NEWS2 enqueue failure stays best-effort (no throw) — a routine
//      monitoring nudge must never block clinical recording.
//   3. The news2_scores row is still persisted before escalation in both cases.

import { jest } from '@jest/globals';

const outboxControl = { throwError: null };
const queueSpy = jest.fn(async () => {
  if (outboxControl.throwError) throw outboxControl.throwError;
  return { queued: true };
});

jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  default: { queue: queueSpy },
  queue: queueSpy,
}));

// Stub the CDS surfacing dynamic import so it never touches a DB.
jest.unstable_mockModule('../../services/cds/deteriorationEarlyWarningService.js', () => ({
  surfaceNews2Cds: jest.fn(async () => null),
}));

// Mock prisma so the news2_scores INSERT is observable without a real DB.
const insertSpy = jest.fn(async () => [{
  id: 4242, patient_uid: 'x', total_score: 0, clinical_risk: 'high',
  recorded_by: 'y', recorded_at: new Date(), created_at: new Date(),
}]);
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: insertSpy },
  setTenantTx: jest.fn(),
}));

const { recordNEWS2 } = await import('../../services/clinical/news2Service.js');

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

describe('NEWS2 escalation loudness (MEDIUM §4)', () => {
  beforeEach(() => {
    outboxControl.throwError = null;
    queueSpy.mockClear();
    insertSpy.mockClear();
  });

  test('>=5: an escalation enqueue failure PROPAGATES (loud)', async () => {
    outboxControl.throwError = new Error('outbox down');
    await expect(recordNEWS2('p-uid', CRITICAL_VITALS, 'r-uid'))
      .rejects.toThrow(/outbox down|escalation/i);
    // Row was persisted before escalation was attempted.
    expect(insertSpy).toHaveBeenCalled();
    expect(queueSpy).toHaveBeenCalledTimes(1);
  });

  test('<5: an escalation enqueue failure stays best-effort (no throw)', async () => {
    outboxControl.throwError = new Error('outbox down');
    // Score is below 5 → no alert queued at all, so nothing to fail loudly on.
    await expect(recordNEWS2('p-uid', LOW_VITALS, 'r-uid')).resolves.toBeTruthy();
    expect(insertSpy).toHaveBeenCalled();
  });

  test('>=5 happy path: escalation succeeds, returns the persisted record', async () => {
    const record = await recordNEWS2('p-uid', CRITICAL_VITALS, 'r-uid');
    expect(record).toBeTruthy();
    expect(queueSpy).toHaveBeenCalledTimes(1);
  });
});
