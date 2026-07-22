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
const { updateAdmissionFasting, createAdmissionFromEr } = await import('../../services/clinical/icuService.js');

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
