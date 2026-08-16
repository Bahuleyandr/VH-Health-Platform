// PR #875 follow-up — staff CPOE radiology orders must reach the radiology
// worklist and the migration-678 contrast/allergy screening gate.
//
// Before this bridge a CPOE `order_type: 'radiology'` order lived ONLY in
// clinical_orders: radiologyService.getWorklist never saw it and no allergy
// store was consulted. This suite pins the bridge end to end at the service
// boundary (counter-sale deep-test idiom):
//
//  - a clean-history contrast-presumed CT order creates BOTH rows — the
//    clinical_orders detail row and the radiology_orders worklist row — with
//    the screen evidence persisted and the canonical pairs for each;
//  - a contrast CT for a patient with a documented iodinated-contrast allergy
//    is a 409 RADIOLOGY_CONTRAST_ALLERGY_BLOCKED with NO row written anywhere;
//  - the acknowledged override (details.contrast_override_reason) creates the
//    order, stamps the override onto the worklist row, and lands a
//    medication_safety_reviews row;
//  - a plain film is not contrast-presumed and sails through for the same
//    allergic patient;
//  - a radiology order with no resolvable modality is a fail-closed 400.

import prisma from '../lib/prisma.js';
import { createOrder, createOrdersBulk } from '../services/emr/orderEntryService.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ALLERGIC_PATIENT_UID = 'cb000000-0000-4000-8000-000000000c01';
const CLEAN_PATIENT_UID = 'cb000000-0000-4000-8000-000000000c02';
const DOCTOR_UID = 'cb000000-0000-4000-8000-000000000c03';

async function cleanupRows() {
  const patientUids = [ALLERGIC_PATIENT_UID, CLEAN_PATIENT_UID];
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_safety_reviews WHERE patient_uid = ANY($1::uuid[])`,
    patientUids,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid = ANY($1::uuid[])`,
    patientUids,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events WHERE patient_uid = ANY($1::uuid[])`,
    patientUids,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM radiology_orders WHERE patient_uid = ANY($1::uuid[])`,
    patientUids,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_orders WHERE patient_uid = ANY($1::uuid[])`,
    patientUids,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_allergies WHERE patient_uid = ANY($1::uuid[])`,
    patientUids,
  ).catch(() => {});
  const fixtureUids = [...patientUids, DOCTOR_UID];
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid = ANY($1::uuid[])`,
    fixtureUids,
  ).catch(() => {});
}

beforeAll(async () => {
  await cleanupRows();
  const seedUsers = [
    [ALLERGIC_PATIENT_UID, '9000990011', 'CPOE Contrast Allergic Patient', 'PATIENT'],
    [CLEAN_PATIENT_UID, '9000990012', 'CPOE Clean History Patient', 'PATIENT'],
    [DOCTOR_UID, '9000990013', 'Dr. CPOE Orderer', 'DOCTOR'],
  ];
  for (const [uid, phone, name, role] of seedUsers) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, $3, $4, true, $5::uuid, NOW())`,
      uid, phone, name, role, TENANT_ID,
    );
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO patient_allergies (patient_uid, allergy_name, severity, is_active, tenant_id)
     VALUES ($1::uuid, 'Iodinated contrast', 'SEVERE', true, $2::uuid)`,
    ALLERGIC_PATIENT_UID, TENANT_ID,
  );
});

afterAll(async () => {
  await cleanupRows();
  await prisma.$disconnect().catch(() => {});
});

async function radiologyRowsFor(patientUid) {
  return prisma.$queryRawUnsafe(
    `SELECT id, modality, body_part, priority, status, contrast_planned, contrast_agent,
            contrast_allergy_screen, contrast_override_reason, contrast_override_by, notes
       FROM radiology_orders
      WHERE patient_uid = $1::uuid
      ORDER BY id`,
    patientUid,
  );
}

describe('CPOE radiology order → worklist + contrast gate bridge', () => {
  test('a clean-history CT order creates the clinical order AND the screened worklist row', async () => {
    const { order, cds_warnings } = await createOrder({
      patient_uid: CLEAN_PATIENT_UID,
      order_type: 'radiology',
      priority: 'urgent',
      details: { test_name: 'CT abdomen/pelvis with contrast', reason: 'Query perforation' },
      ordered_by: DOCTOR_UID,
      tenantId: TENANT_ID,
    });
    expect(order.id).toBeTruthy();
    expect(order.order_type).toBe('radiology');
    // The derived plan is stamped onto the persisted details.
    expect(order.details.modality).toBe('ct');
    expect(order.details.body_part).toBe('CT abdomen/pelvis with contrast');
    expect(Array.isArray(cds_warnings)).toBe(true);

    // Worklist row materialized with the presumed-contrast screen evidence.
    const rows = await radiologyRowsFor(CLEAN_PATIENT_UID);
    expect(rows).toHaveLength(1);
    expect(rows[0].modality).toBe('ct');
    expect(rows[0].status).toBe('ordered');
    expect(rows[0].priority).toBe('urgent');
    expect(rows[0].contrast_planned).toBe(true);
    expect(rows[0].contrast_allergy_screen).toMatchObject({
      status: 'completed',
      intent_source: 'modality_presumed',
    });
    expect(rows[0].notes).toContain(`clinical_order_id:${order.id};`);

    // Canonical pairs exist for BOTH detail rows.
    const timeline = await prisma.$queryRawUnsafe(
      `SELECT source_table, event_type FROM clinical_timeline_events WHERE patient_uid = $1::uuid`,
      CLEAN_PATIENT_UID,
    );
    const byTable = timeline.map((r) => `${r.source_table}:${r.event_type}`);
    expect(byTable).toContain('clinical_orders:order.created');
    expect(byTable).toContain('radiology_orders:radiology.order_created');
    const audit = await prisma.$queryRawUnsafe(
      `SELECT resource_table FROM clinical_audit_events WHERE patient_uid = $1::uuid`,
      CLEAN_PATIENT_UID,
    );
    expect(audit.map((r) => r.resource_table)).toEqual(
      expect.arrayContaining(['clinical_orders', 'radiology_orders']),
    );
  });

  test('a contrast CT for a documented contrast allergy is blocked 409 with NO rows written', async () => {
    let err;
    try {
      await createOrder({
        patient_uid: ALLERGIC_PATIENT_UID,
        order_type: 'radiology',
        details: { test_name: 'CT Brain with contrast', reason: 'Staging' },
        ordered_by: DOCTOR_UID,
        tenantId: TENANT_ID,
      });
    } catch (e) { err = e; }
    expect(err).toMatchObject({ statusCode: 409, code: 'RADIOLOGY_CONTRAST_ALLERGY_BLOCKED' });
    expect(err.details.requiresOverride).toBe(true);
    expect(err.details.blockers[0]).toMatchObject({
      type: 'CONTRAST_ALLERGY_CONFLICT',
      allergy: 'Iodinated contrast',
    });

    const clinical = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_orders WHERE patient_uid = $1::uuid`,
      ALLERGIC_PATIENT_UID,
    );
    expect(clinical).toHaveLength(0);
    expect(await radiologyRowsFor(ALLERGIC_PATIENT_UID)).toHaveLength(0);
  });

  test('the acknowledged override creates the order and lands on the worklist row + safety review', async () => {
    const { order } = await createOrder({
      patient_uid: ALLERGIC_PATIENT_UID,
      order_type: 'radiology',
      details: {
        test_name: 'CT Brain with contrast',
        reason: 'Staging — benefit outweighs risk',
        contrast_override_reason: 'Premedicated per ACR protocol; radiologist informed',
      },
      ordered_by: DOCTOR_UID,
      tenantId: TENANT_ID,
    });
    expect(order.id).toBeTruthy();

    const rows = await radiologyRowsFor(ALLERGIC_PATIENT_UID);
    expect(rows).toHaveLength(1);
    expect(rows[0].contrast_override_reason).toBe('Premedicated per ACR protocol; radiologist informed');
    expect(String(rows[0].contrast_override_by)).toBe(DOCTOR_UID);
    expect(rows[0].contrast_allergy_screen).toMatchObject({ status: 'completed' });
    expect(rows[0].contrast_allergy_screen.override).toMatchObject({
      reason: 'Premedicated per ACR protocol; radiologist informed',
    });

    const reviews = await prisma.$queryRawUnsafe(
      `SELECT status FROM medication_safety_reviews WHERE patient_uid = $1::uuid`,
      ALLERGIC_PATIENT_UID,
    );
    expect(reviews.length).toBeGreaterThanOrEqual(1);
  });

  test('a plain film is not contrast-presumed and is not blocked for the allergic patient', async () => {
    const { order } = await createOrder({
      patient_uid: ALLERGIC_PATIENT_UID,
      order_type: 'radiology',
      details: { test_name: 'X-Ray Chest PA', reason: 'Pre-op workup' },
      ordered_by: DOCTOR_UID,
      tenantId: TENANT_ID,
    });
    expect(order.id).toBeTruthy();
    const rows = await radiologyRowsFor(ALLERGIC_PATIENT_UID);
    const film = rows.find((r) => r.modality === 'xray');
    expect(film).toBeTruthy();
    expect(film.contrast_planned).toBe(false);
    expect(film.contrast_allergy_screen).toMatchObject({ intent_source: 'modality_not_presumed' });
  });

  test('bulk ordering surfaces the blocked item index and writes nothing', async () => {
    let err;
    try {
      await createOrdersBulk([
        {
          patient_uid: CLEAN_PATIENT_UID,
          order_type: 'investigation',
          details: { test_name: 'CBC' },
        },
        {
          patient_uid: ALLERGIC_PATIENT_UID,
          order_type: 'radiology',
          details: { test_name: 'CECT Abdomen' },
        },
      ], { ordered_by: DOCTOR_UID, tenantId: TENANT_ID });
    } catch (e) { err = e; }
    expect(err).toMatchObject({ statusCode: 409, code: 'RADIOLOGY_CONTRAST_ALLERGY_BLOCKED' });
    expect(err.message).toContain('Order #2');
    expect(err.details.order_index).toBe(1);
  });

  test('a radiology order with no resolvable modality fails closed (400)', async () => {
    let err;
    try {
      await createOrder({
        patient_uid: CLEAN_PATIENT_UID,
        order_type: 'radiology',
        details: { test_name: 'general imaging' },
        ordered_by: DOCTOR_UID,
        tenantId: TENANT_ID,
      });
    } catch (e) { err = e; }
    expect(err).toMatchObject({ statusCode: 400, code: 'RADIOLOGY_ORDER_MODALITY_REQUIRED' });
  });
});
