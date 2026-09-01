/**
 * completeSession — realised session duration.
 *
 * `duration_min` is derived from `actual_start_at_epoch_ms`, the absolute
 * instant twin, not from the driver-materialised `actual_start_at` (PR #881).
 * dialysis.test.js only covers the pure helpers (`computeUrr`, `computeKtv`,
 * the transition table), so this read had no coverage: a dropped twin makes
 * `epochMsOrNull` return null, `duration_min` is stored as NULL, and Kt/V —
 * which takes duration as an input — silently degrades with it.
 *
 * The routing stub keys off SQL text rather than call order because
 * completeSession issues further reads (machine QA log, billing hook) after its
 * transaction commits.
 */

import { jest } from '@jest/globals';

const txQuery = jest.fn();
const outerQuery = jest.fn(async () => []);
const recordCanonicalClinicalEvent = jest.fn(async () => null);

const txStub = { $queryRawUnsafe: txQuery };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: outerQuery },
  setTenantTx: async (_tenantId, fn) => fn(txStub),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent,
}));

jest.unstable_mockModule('../../services/billing/billingV2Service.js', () => ({
  addInvoiceItem: jest.fn(),
  createDraftInvoice: jest.fn(),
}));

const { completeSession } = await import('../../services/clinical/dialysisService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';

let updateParams;

beforeEach(() => {
  txQuery.mockReset();
  outerQuery.mockReset();
  outerQuery.mockResolvedValue([]);
  recordCanonicalClinicalEvent.mockClear();
  updateParams = null;
});

/**
 * `startedMinutesAgo: null` models a session whose actual_start_at was never
 * stamped — a genuine SQL NULL, where a null duration is the correct answer.
 */
function mockSession({ startedMinutesAgo }) {
  const session = {
    id: 9,
    dialysis_patient_id: 4,
    tenant_id: TENANT,
    patient_uid: PATIENT_UID,
    status: 'in_progress',
    modality: 'hd',
    machine_no: 'M-1',
    urea_pre_mg_dl: 100,
    urea_post_mg_dl: 30,
    post_weight_kg: 62,
    actual_uf_l: 2.4,
    actual_start_at: null,
    actual_start_at_epoch_ms: null,
  };
  if (startedMinutesAgo != null) {
    const startedAt = new Date(Date.now() - startedMinutesAgo * 60000);
    session.actual_start_at = startedAt.toISOString();
    session.actual_start_at_epoch_ms = BigInt(startedAt.getTime());
  }

  txQuery.mockImplementation(async (sql, ...params) => {
    const text = String(sql);
    if (text.includes('FROM dialysis_sessions s')) return [session];
    if (text.includes('UPDATE dialysis_sessions')) {
      updateParams = params;
      return [{ ...session, status: 'completed', duration_min: params[0] }];
    }
    throw new Error(`Unexpected tx query in completeSession unit test: ${text}`);
  });
}

test('duration_min is the realised elapsed time, read from the instant twin', async () => {
  mockSession({ startedMinutesAgo: 240 });

  const result = await completeSession({ tenantId: TENANT, id: 9, completed_by: 'nurse-1' });

  // duration_min is bound as $1 of the UPDATE.
  expect(updateParams[0]).toBe(240);
  expect(result.duration_min).toBe(240);
});

test('a session with no recorded start stores a null duration rather than a bogus one', async () => {
  // actual_start_at is a genuine SQL NULL here — null duration is correct, and
  // is emphatically not the ~29,000,000 minutes an epoch-0 fallback would give.
  mockSession({ startedMinutesAgo: null });

  const result = await completeSession({ tenantId: TENANT, id: 9, completed_by: 'nurse-1' });

  expect(updateParams[0]).toBeNull();
  expect(result.duration_min).toBeNull();
});
