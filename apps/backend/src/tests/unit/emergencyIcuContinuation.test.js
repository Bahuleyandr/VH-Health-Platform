// Unit tests: Stage 5 emergency/ICU continuation cluster.
//
// Regression-guards the validation boundaries of the 6-finding fix —
// every assertion here exercises a code path that throws BEFORE any DB
// I/O, so the suite needs no Postgres. prisma is mocked with a recursive
// proxy purely so a regression that *reaches* a query fails loudly
// instead of attempting a real connection.
//
// Findings covered:
//   2026-05-09-emergency-walk-in-doctor-no-admission-note-type
//   2026-05-09-emergency-walk-in-doctor-no-ecg-order-type
//   2026-05-09-emergency-walk-in-doctor-er-encounter-id-gap
//   2026-05-09-emergency-walk-in-nurse-icu-no-npo-patch-route
//   2026-05-08-emergency-walk-in-doctor-er-to-icu-no-continuation

import { jest } from '@jest/globals';

// Recursive proxy — prisma.<anything>.<anything>(...) is callable and
// rejects. These tests never legitimately reach it.
function makeStub() {
  const fn = async () => {
    throw new Error('prisma must not be reached in validation-boundary tests');
  };
  return new Proxy(fn, {
    get: (_t, prop) => (prop === 'then' ? undefined : makeStub()),
  });
}
const prismaStub = makeStub();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaStub,
  isTenantTransactionClient: () => true,
  prisma: prismaStub,
  prismaReadOnly: prismaStub,
  setTenant: jest.fn(),
  circuitBreakerStatus: jest.fn(() => ({})),
  setTenantTx: async (_tenantId, fn) => fn(prismaStub),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(prismaStub),
  pickTenantClient: () => prismaStub,
}));

const { createNote } = await import('../../services/emr/clinicalNotesService.js');
const { createOrder } = await import('../../services/emr/orderEntryService.js');
const {
  buildIcuMarCarryoverReviewPath,
  carryMedicationOrdersToMar,
  createAdmissionFromEr,
  escalateIcuMarCarryoverFailure,
  updateAdmissionFasting,
} = await import('../../services/clinical/icuService.js');

test('ICU MAR carryover alerts use the governed Staff recovery route', () => {
  expect(buildIcuMarCarryoverReviewPath({
    patientUid: '11111111-1111-4111-8111-111111111111',
    admissionId: 73,
  })).toBe('/emr/orders/11111111-1111-4111-8111-111111111111?icu_mar_review=73');
  expect(() => buildIcuMarCarryoverReviewPath({
    patientUid: 'not-a-patient',
    admissionId: 73,
  })).toThrow(/exact patient and admission identity/i);
});

describe('clinical notes — admission/er/transfer note types', () => {
  it('rejects an unknown note_type and advertises the new types', async () => {
    await expect(createNote({
      patient_uid: 'p', author_uid: 'a', author_role: 'DOCTOR',
      note_type: 'not_a_real_type', content: { x: 1 },
    })).rejects.toThrow(/Invalid note_type/);

    let err;
    try {
      await createNote({
        patient_uid: 'p', author_uid: 'a', author_role: 'DOCTOR',
        note_type: 'not_a_real_type', content: { x: 1 },
      });
    } catch (e) { err = e; }
    expect(err.message).toContain('admission_note');
    expect(err.message).toContain('er_note');
    expect(err.message).toContain('transfer_note');
  });

  it('recognises admission_note and enforces its H&P content fields', async () => {
    let err;
    try {
      await createNote({
        patient_uid: 'p', author_uid: 'a', author_role: 'DOCTOR',
        note_type: 'admission_note', content: {},
      });
    } catch (e) { err = e; }
    // Recognised type — fails on missing content, NOT on "Invalid note_type".
    expect(err.message).not.toMatch(/Invalid note_type/);
    expect(err.message).toContain('Missing required content fields for admission_note');
    for (const f of ['chief_complaint', 'history_of_present_illness', 'assessment', 'plan']) {
      expect(err.message).toContain(f);
    }
  });

  it('recognises er_note and transfer_note with their own required fields', async () => {
    let erErr;
    try {
      await createNote({
        patient_uid: 'p', author_uid: 'a', author_role: 'DOCTOR',
        note_type: 'er_note', content: {},
      });
    } catch (e) { erErr = e; }
    expect(erErr.message).toContain('Missing required content fields for er_note');
    expect(erErr.message).toContain('chief_complaint');

    let trErr;
    try {
      await createNote({
        patient_uid: 'p', author_uid: 'a', author_role: 'DOCTOR',
        note_type: 'transfer_note', content: {},
      });
    } catch (e) { trErr = e; }
    expect(trErr.message).toContain('Missing required content fields for transfer_note');
    expect(trErr.message).toContain('reason_for_transfer');
    expect(trErr.message).toContain('clinical_summary');
  });
});

describe('order entry — ecg/radiology/procedure order types', () => {
  it('rejects an unknown order_type and advertises the new types', async () => {
    let err;
    try {
      await createOrder({
        order_type: 'not_a_real_type', patient_uid: 'p',
        details: { x: 1 }, ordered_by: 'd',
      });
    } catch (e) { err = e; }
    expect(err.message).toMatch(/Invalid order_type/);
    expect(err.message).toContain('ecg');
    expect(err.message).toContain('radiology');
    expect(err.message).toContain('procedure');
  });

  it('lets ecg, radiology, and procedure past the order_type gate', async () => {
    for (const t of ['ecg', 'radiology', 'procedure']) {
      let err;
      try {
        await createOrder({
          order_type: t, patient_uid: 'p', details: { test_name: t }, ordered_by: 'd',
        });
      } catch (e) { err = e; }
      // It still throws (mocked prisma downstream) — but NOT for an
      // invalid type. That proves the type passed validation.
      expect(err).toBeDefined();
      expect(err.message).not.toMatch(/Invalid order_type/);
    }
  });

  it('rejects a non-integer er_visit_id before any DB lookup', async () => {
    await expect(createOrder({
      order_type: 'nursing', patient_uid: 'p',
      details: { description: 'obs' }, ordered_by: 'd',
      er_visit_id: 'not-a-number',
    })).rejects.toThrow(/er_visit_id must be an integer/);
  });
});

describe('icu — fasting PATCH + admit-from-ER guards', () => {
  it('updateAdmissionFasting rejects an empty patch', async () => {
    await expect(updateAdmissionFasting({ tenantId: 't', id: 1 }))
      .rejects.toThrow(/At least one of npo_from, fasting_until, pre_op_status/);
  });

  it('createAdmissionFromEr rejects a non-numeric emergency visit id', async () => {
    await expect(createAdmissionFromEr({ tenantId: 't', emergencyVisitId: 'abc' }))
      .rejects.toThrow(/numeric emergency visit id/);
  });
});

describe('icu — ER medication MAR continuation recovery', () => {
  it('persists the exact ICU alert obligation with canonical failure evidence when queueing fails', async () => {
    const recordCanonicalClinicalEvent = jest.fn(async () => ({
      timeline: { id: 'timeline-1' },
      audit: { id: 'audit-1' },
    }));
    const persistClinicalAlertFailureWithCanonical = jest.fn(
      async ({ obligation, recordCanonical }) => {
        const stored = { id: 815, ...obligation };
        const canonical = await recordCanonical({}, stored);
        return { obligation: stored, canonical };
      },
    );
    const result = await escalateIcuMarCarryoverFailure({
      admission: { id: 73 },
      visit: {
        id: 61,
        tenant_id: '00000000-0000-4000-8000-000000000001',
        patient_uid: '11111111-1111-4111-8111-111111111111',
        encounter_id: '22222222-2222-4222-8222-222222222222',
      },
      actorUid: '33333333-3333-4333-8333-333333333333',
      actorRole: 'DOCTOR',
      err: Object.assign(new Error('query failed'), { code: 'MAR_QUERY_FAILED' }),
      deps: {
        queueClinicalAlertFanout: jest.fn(async () => {
          throw new Error('outbox unavailable');
        }),
        recordCanonicalClinicalEvent,
        persistClinicalAlertFailureWithCanonical,
      },
    });

    expect(result).toEqual({
      alertQueued: false,
      canonicalRecorded: true,
      reviewPath: '/emr/orders/11111111-1111-4111-8111-111111111111?icu_mar_review=73',
    });
    expect(persistClinicalAlertFailureWithCanonical).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: '00000000-0000-4000-8000-000000000001',
        obligation: expect.objectContaining({
          sourceTable: 'icu_admissions',
          sourceId: '73',
          failureKind: 'icu_mar_carryover_query',
          failureCode: 'MAR_QUERY_FAILED',
          notificationIntent: expect.objectContaining({
            channel: 'push',
            sourceEventKey: 'icu_admissions:73:icu.mar_carryover_failed:alert',
            templateVersion: 'clinical-alert-icu-mar-carryover-failure.v1',
          }),
        }),
      }),
    );
    expect(recordCanonicalClinicalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'icu.mar_carryover_failed',
        payload: expect.objectContaining({ alert_recovery_obligation_id: 815 }),
      }),
      { db: {}, strict: true },
    );
  });

  it('continues independent orders and returns a doctor-actionable durable failure receipt', async () => {
    const orders = [
      { id: 41, order_number: 'ORD-41', order_type: 'medication' },
      { id: 42, order_number: 'ORD-42', order_type: 'medication' },
    ];
    const schedule = jest.fn(async (order) => {
      if (order.id === 42) {
        throw Object.assign(new Error('transient schedule fault'), { code: 'MAR_TRANSIENT' });
      }
      return [{ id: 901, clinical_order_id: 41 }];
    });
    const escalate = jest.fn(async () => ({
      alertQueued: true,
      auditRecorded: true,
    }));

    const result = await carryMedicationOrdersToMar(orders, {
      actorUid: '11111111-1111-4111-8111-111111111111',
      actorRole: 'DOCTOR',
      deps: {
        scheduleMedicationOrderOnMar: schedule,
        escalateOrderIntegrationFailure: escalate,
      },
    });

    expect(schedule).toHaveBeenCalledTimes(2);
    expect(result.medications).toEqual([{ id: 901, clinical_order_id: 41 }]);
    expect(result.active_order_count).toBe(2);
    expect(result.failures).toEqual([{
      order_id: 42,
      order_number: 'ORD-42',
      error_code: 'MAR_TRANSIENT',
      alert_queued: true,
      audit_recorded: true,
      recovery_endpoint: '/api/v1/emr/orders/42/retry-mar-scheduling',
      requires_doctor_authority: true,
    }]);
    expect(escalate).toHaveBeenCalledWith(expect.objectContaining({
      order: orders[1],
      stage: 'mar_carryover',
    }));
  });

  it('does not abandon later orders when the escalation adapter also fails', async () => {
    const orders = [
      { id: 51, order_number: 'ORD-51', order_type: 'medication' },
      { id: 52, order_number: 'ORD-52', order_type: 'medication' },
    ];
    const schedule = jest.fn(async (order) => {
      if (order.id === 51) throw new Error('schedule fault');
      return [{ id: 902, clinical_order_id: 52 }];
    });
    const result = await carryMedicationOrdersToMar(orders, {
      deps: {
        scheduleMedicationOrderOnMar: schedule,
        escalateOrderIntegrationFailure: jest.fn(async () => {
          throw new Error('escalation fault');
        }),
      },
    });

    expect(schedule).toHaveBeenCalledTimes(2);
    expect(result.medications).toEqual([{ id: 902, clinical_order_id: 52 }]);
    expect(result.failures).toEqual([expect.objectContaining({
      order_id: 51,
      alert_queued: false,
      audit_recorded: false,
    })]);
  });
});
