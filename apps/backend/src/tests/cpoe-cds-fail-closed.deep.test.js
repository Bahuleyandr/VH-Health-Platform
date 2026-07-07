// MEDIUM (audit 2026-06-18 §4) — CPOE CDS must fail CLOSED on error.
//
// Defect: orderEntryService.runCDSChecks caught ANY exception, pushed a soft
// warning ("CDS safety check could not be completed"), and returned safe:true
// with no blockers — so a MEDICATION order whose safety screening threw was
// created anyway, with screening silently skipped. This diverges from the
// fail-CLOSED prescription path (prescriptionSafetyCheck.validatePrescriptionSafety
// pushes a SAFETY_CHECK_ERROR blocker and returns safe:false on exception).
//
// Fix proven here:
//   1. A CDS exception on a MEDICATION order BLOCKS createOrder (CDS_BLOCKER,
//      400) instead of silently creating the order.
//   2. The same exception on a NON-medication order does NOT block (the safety
//      screen only applies to medications) — order still creates.
//   3. An explicit override-with-reason (data.override.reason) lets the
//      medication order through, and the override is recorded on a
//      medication_safety_reviews row (status='overridden', the SAFETY_CHECK_ERROR
//      finding carried with its reason).
//   4. createOrdersBulk is fail-closed too — a CDS exception on one item aborts
//      the whole batch (no row written).
//
// Mechanism: validatePrescriptionSafety is module-mocked to throw on demand so
// the exception path is deterministic; the real DB + real createOrder
// transaction run otherwise. Self-isolating fixtures.

import { jest } from '@jest/globals';

const safetyControl = { throwError: null };
const validatePrescriptionSafetySpy = jest.fn(async () => {
  if (safetyControl.throwError) throw safetyControl.throwError;
  return { safe: true, warnings: [], blockers: [] };
});
// checkAntithromboticInteractions is pure + cheap — keep the real behaviour by
// returning an empty result (no interactions) so only the thrown-exception path
// under test drives the outcome.
const checkAntithromboticInteractionsSpy = jest.fn(() => ({ warnings: [], blockers: [] }));

jest.unstable_mockModule('../utils/clinical/prescriptionSafetyCheck.js', () => ({
  validatePrescriptionSafety: validatePrescriptionSafetySpy,
  checkAntithromboticInteractions: checkAntithromboticInteractionsSpy,
}));

const prismaModule = await import('../lib/prisma.js');
const prisma = prismaModule.default;
const { applyOrderSet, createOrder, createOrdersBulk, verifyOrder } = await import('../services/emr/orderEntryService.js');

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'cd5c0000-0000-4000-8000-0000000000c1';
const ORDERER_UID = 'cd5c0000-0000-4000-8000-0000000000c2';
const PATIENT_PHONE = `9120${String(Date.now() % 1000000).padStart(6, '0')}`;

let patientId;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_safety_reviews WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid AND source_table = 'clinical_orders'`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid AND resource_table = 'clinical_orders'`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_order_set_items
      WHERE order_set_id IN (
        SELECT id FROM clinical_order_sets
         WHERE tenant_id = $1::uuid AND family_key = 'CDS-APPLY-FAIL-CLOSED'
      )`,
    TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_order_sets
      WHERE tenant_id = $1::uuid AND family_key = 'CDS-APPLY-FAIL-CLOSED'`,
    TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM patient_allergies WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, ORDERER_UID,
  ).catch(() => {});
}

async function orderCount() {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS n FROM clinical_orders WHERE patient_uid = $1::uuid',
    PATIENT_UID,
  );
  return Number(rows[0]?.n ?? 0);
}

d('CPOE CDS fail-closed on exception (MEDIUM §4)', () => {
  beforeAll(async () => {
    await cleanup();
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'CDS FailClosed Patient', 'PATIENT', true, $3::uuid, NOW())
       RETURNING id`,
      PATIENT_UID, PATIENT_PHONE, TENANT_ID,
    );
    patientId = p[0].id;
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'CDS FailClosed Doctor', 'DOCTOR', true, $3::uuid, NOW())`,
      ORDERER_UID, `${PATIENT_PHONE}1`, TENANT_ID,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  beforeEach(() => {
    safetyControl.throwError = null;
    validatePrescriptionSafetySpy.mockClear();
    checkAntithromboticInteractionsSpy.mockClear();
  });

  test('a CDS exception on a MEDICATION order BLOCKS creation (no silent create)', async () => {
    const before = await orderCount();
    safetyControl.throwError = new Error('simulated safety-screen DB fault');

    await expect(createOrder({
      patient_uid: PATIENT_UID,
      order_type: 'medication',
      details: { medication_name: 'Amoxicillin', dose: '500mg', route: 'PO' },
      ordered_by: ORDERER_UID,
      tenantId: TENANT_ID,
    })).rejects.toMatchObject({ code: 'CDS_BLOCKER', statusCode: 400 });

    // No order row was written — fail CLOSED, not silently created.
    expect(await orderCount()).toBe(before);
    expect(validatePrescriptionSafetySpy).toHaveBeenCalledTimes(1);
  });

  test('a CDS exception does NOT block a non-medication order (screen is medication-only)', async () => {
    const before = await orderCount();
    safetyControl.throwError = new Error('this should never be consulted for a lab order');

    const result = await createOrder({
      patient_uid: PATIENT_UID,
      order_type: 'investigation',
      details: { test_name: 'CBC' },
      ordered_by: ORDERER_UID,
      tenantId: TENANT_ID,
    });

    expect(result?.order?.id).toBeTruthy();
    expect(await orderCount()).toBe(before + 1);
    // The medication safety screen is never invoked for a lab order.
    expect(validatePrescriptionSafetySpy).not.toHaveBeenCalled();
  });

  test('an explicit override-with-reason lets the medication order through and records it', async () => {
    const before = await orderCount();
    safetyControl.throwError = new Error('simulated safety-screen DB fault');

    const result = await createOrder({
      patient_uid: PATIENT_UID,
      order_type: 'medication',
      details: { medication_name: 'Ceftriaxone', dose: '1g', route: 'IV' },
      ordered_by: ORDERER_UID,
      tenantId: TENANT_ID,
      override: { reason: 'Manual chart review by attending — patient cleared.' },
    });

    expect(result?.order?.id).toBeTruthy();
    expect(await orderCount()).toBe(before + 1);

    // The override is captured on a medication_safety_reviews row: the
    // SAFETY_CHECK_ERROR finding is recorded with status 'overridden' and the
    // override reason, so the audit trail shows screening was bypassed on
    // explicit clinician override (not silently skipped).
    const reviews = await prisma.$queryRawUnsafe(
      `SELECT status, override_required, override_reason, finding_code, message
         FROM medication_safety_reviews
        WHERE patient_uid = $1::uuid AND clinical_order_id = $2
        ORDER BY id`,
      PATIENT_UID, Number(result.order.id),
    );
    const overrideRow = reviews.find(
      (r) => r.status === 'overridden' && r.override_reason,
    );
    expect(overrideRow).toBeTruthy();
    expect(overrideRow.override_reason).toMatch(/manual chart review/i);
  });

  test('createOrdersBulk is fail-closed — a CDS exception on one item aborts the whole batch', async () => {
    const before = await orderCount();
    safetyControl.throwError = new Error('simulated safety-screen DB fault');

    await expect(createOrdersBulk([
      { patient_uid: PATIENT_UID, order_type: 'investigation', details: { test_name: 'LFT' } },
      { patient_uid: PATIENT_UID, order_type: 'medication', details: { medication_name: 'Metformin', dose: '500mg' } },
    ], { ordered_by: ORDERER_UID, tenantId: TENANT_ID })).rejects.toMatchObject({ code: 'CDS_BLOCKER' });

    // Atomic: NOT EVEN the valid lab order persisted.
    expect(await orderCount()).toBe(before);
  });

  test('applyOrderSet reports the CDS blocker and does not create the medication order', async () => {
    const before = await orderCount();
    const created = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_order_sets
         (tenant_id, code, family_key, version, status, active, title, specialty,
          condition_codes, description, created_by, source)
       VALUES ($1::uuid, 'CDS-APPLY-FAIL-CLOSED-V1', 'CDS-APPLY-FAIL-CLOSED',
               1, 'approved', TRUE, 'CDS apply fail-closed', 'General Medicine',
               ARRAY[]::text[], 'CDS apply-set fixture', $2::uuid, 'authored')
       RETURNING id`,
      TENANT_ID,
      ORDERER_UID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_order_set_items
         (tenant_id, order_set_id, display_order, kind, payload, default_selected)
       VALUES ($1::uuid, $2::int, 1, 'med', $3::jsonb, TRUE)`,
      TENANT_ID,
      Number(created[0].id),
      JSON.stringify({ medication_name: 'Metformin', dose: '500mg', route: 'PO' }),
    );
    safetyControl.throwError = new Error('simulated safety-screen DB fault');

    const result = await applyOrderSet(PATIENT_UID, null, created[0].id, ORDERER_UID, TENANT_ID);

    expect(result).toEqual([
      expect.objectContaining({
        kind: 'med',
        code: 'CDS_BLOCKER',
        error: 'Order template could not be applied',
      }),
    ]);
    expect(await orderCount()).toBe(before);
    expect(validatePrescriptionSafetySpy).toHaveBeenCalledTimes(1);
  });

  test('concurrent verifyOrder on the same order → exactly one verifies (M6 TOCTOU)', async () => {
    safetyControl.throwError = null;
    const created = await createOrder({
      patient_uid: PATIENT_UID,
      order_type: 'investigation',
      details: { test_name: 'ESR' },
      ordered_by: ORDERER_UID,
      tenantId: TENANT_ID,
    });
    const orderId = Number(created.order.id);

    // Two simultaneous verifies. Without the atomic status guard both read
    // status='ordered', both pass the pre-check, and both UPDATE + write a
    // canonical event (duplicate verify). With the WHERE status='ordered' guard,
    // the loser's updateMany matches 0 rows and is rejected as a 409 conflict.
    const results = await Promise.allSettled([
      verifyOrder(orderId, ORDERER_UID),
      verifyOrder(orderId, ORDERER_UID),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ statusCode: 409 });

    // Exactly one order.verified canonical timeline event — no duplicate.
    const evts = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM clinical_timeline_events
        WHERE source_table = 'clinical_orders' AND source_id = $1 AND event_type = 'order.verified'`,
      String(orderId),
    );
    expect(evts[0].n).toBe(1);
  });
});
