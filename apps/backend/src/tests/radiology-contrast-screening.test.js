// Feature wave 1 — contrast/allergy screening in radiology ordering
// (migration 678).
//
// Radiology ordering previously consulted NO allergy store: a patient with a
// documented "iodinated contrast — anaphylaxis" allergy could be ordered a
// contrast CT with no warning anywhere (contrast tracking existed only in the
// cath lab). This suite pins the new gate end to end:
//
//  - a contrast order against a contrast-relevant active allergy is blocked
//    with a structured 409 (RADIOLOGY_CONTRAST_ALLERGY_BLOCKED) carrying the
//    matched allergy and requiresOverride;
//  - an acknowledged override ({ override: { reason } }, prescription-CDS
//    shape) creates the order, stamps contrast_override_reason/by/at,
//    persists the screen evidence, and lands a medication_safety_reviews row
//    plus the canonical timeline/audit pair in the same transaction;
//  - non-contrast orders and clean patients are untouched;
//  - the pre-acquisition contrast-plan amendment (PUT /:id/contrast) runs the
//    same gate and locks once the study leaves 'ordered'.

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const ALLERGIC_PATIENT_UID = 'cf000000-0000-4000-8000-000000000b01';
const CLEAN_PATIENT_UID = 'cf000000-0000-4000-8000-000000000b02';
const DOCTOR_UID = 'cf000000-0000-4000-8000-000000000b03';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const API_KEY = process.env.API_KEY || 'test-api-key';

function doctor() {
  const token = generateTestToken('DOCTOR', { uid: DOCTOR_UID, id: 90101 });
  return {
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (p) => request(app).put(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function cleanupRows() {
  const uids = [ALLERGIC_PATIENT_UID, CLEAN_PATIENT_UID, DOCTOR_UID];
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_safety_reviews WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    ALLERGIC_PATIENT_UID, CLEAN_PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    ALLERGIC_PATIENT_UID, CLEAN_PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    ALLERGIC_PATIENT_UID, CLEAN_PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM radiology_orders WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    ALLERGIC_PATIENT_UID, CLEAN_PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_allergies WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    ALLERGIC_PATIENT_UID, CLEAN_PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
    ...uids,
  ).catch(() => {});
}

describe('radiology contrast/allergy screening at order time (migration 678)', () => {
  beforeAll(async () => {
    await cleanupRows();
    const seedUsers = [
      [ALLERGIC_PATIENT_UID, '9000990001', 'Contrast Allergic Patient', 'PATIENT'],
      [CLEAN_PATIENT_UID, '9000990002', 'Clean History Patient', 'PATIENT'],
      [DOCTOR_UID, '9000990003', 'Dr. Contrast Orderer', 'DOCTOR'],
    ];
    for (const [uid, phone, name, role] of seedUsers) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
         VALUES ($1::uuid, $2, $3, $4, true, NOW())`,
        uid, phone, name, role,
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

  const baseOrder = (patientUid) => ({
    patient_uid: patientUid,
    modality: 'ct',
    body_part: 'Abdomen',
    clinical_indication: 'Staging CT with IV contrast',
  });

  it('blocks a contrast CT for a patient with a documented iodinated-contrast allergy (409, structured)', async () => {
    const res = await doctor().post('/api/v1/radiology/orders')
      .send({ ...baseOrder(ALLERGIC_PATIENT_UID), contrast_planned: true, contrast_agent: 'iohexol' });

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('RADIOLOGY_CONTRAST_ALLERGY_BLOCKED');
    expect(res.body.details.requiresOverride).toBe(true);
    expect(res.body.details.blockers).toHaveLength(1);
    expect(res.body.details.blockers[0]).toMatchObject({
      type: 'CONTRAST_ALLERGY_CONFLICT',
      allergy: 'Iodinated contrast',
      severity: 'SEVERE',
      agent_class: 'iodinated',
    });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM radiology_orders WHERE patient_uid = $1::uuid`,
      ALLERGIC_PATIENT_UID,
    );
    expect(rows).toHaveLength(0);
  });

  it('creates the order under an acknowledged override, persisting evidence + safety review + canonical pair', async () => {
    const res = await doctor().post('/api/v1/radiology/orders')
      .send({
        ...baseOrder(ALLERGIC_PATIENT_UID),
        contrast_planned: true,
        contrast_agent: 'iohexol',
        override: { reason: 'Premedicated: prednisolone + cetirizine per contrast-allergy protocol' },
      });

    expect(res.statusCode).toBe(201);
    const orderId = res.body.data.id;

    const rows = await prisma.$queryRawUnsafe(
      `SELECT contrast_planned, contrast_agent, contrast_allergy_screen,
              contrast_override_reason, contrast_override_by, contrast_override_at
         FROM radiology_orders WHERE id = $1::int`,
      orderId,
    );
    expect(rows[0].contrast_planned).toBe(true);
    expect(rows[0].contrast_agent).toBe('iohexol');
    expect(rows[0].contrast_override_reason).toMatch(/Premedicated/);
    expect(rows[0].contrast_override_by).toBe(DOCTOR_UID);
    expect(rows[0].contrast_override_at).not.toBeNull();
    expect(rows[0].contrast_allergy_screen.safe).toBe(false);
    expect(rows[0].contrast_allergy_screen.blockers).toHaveLength(1);
    expect(rows[0].contrast_allergy_screen.override.reason).toMatch(/Premedicated/);

    // Platform safety-finding vehicle (canonical invariant): the override
    // lands a medication_safety_reviews row in the same transaction.
    const reviews = await prisma.$queryRawUnsafe(
      `SELECT review_type, status, severity, override_required, override_reason, overridden_by, payload
         FROM medication_safety_reviews
        WHERE patient_uid = $1::uuid AND review_type = 'CONTRAST_ALLERGY_CONFLICT'`,
      ALLERGIC_PATIENT_UID,
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0].status).toBe('overridden');
    expect(reviews[0].override_required).toBe(true);
    expect(reviews[0].override_reason).toMatch(/Premedicated/);
    expect(reviews[0].payload.radiology_order_id).toBe(orderId);

    // Canonical timeline + audit pair for the clinical write.
    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type, payload FROM clinical_timeline_events
        WHERE source_table = 'radiology_orders' AND source_id = $1
          AND event_type = 'radiology.order_created'`,
      String(orderId),
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0].payload.contrast_allergy_override).toBe(true);
    expect(timeline[0].payload.contrast_planned).toBe(true);

    const audit = await prisma.$queryRawUnsafe(
      `SELECT action FROM clinical_audit_events
        WHERE resource_table = 'radiology_orders' AND resource_id = $1
          AND action = 'radiology.order_created'`,
      String(orderId),
    );
    expect(audit).toHaveLength(1);
  });

  it('passes a contrast order clean for a patient with no contrast-relevant allergy', async () => {
    const res = await doctor().post('/api/v1/radiology/orders')
      .send({ ...baseOrder(CLEAN_PATIENT_UID), contrast_planned: true });

    expect(res.statusCode).toBe(201);
    expect(res.body.data.contrast_planned).toBe(true);
    expect(res.body.data.contrast_override_reason).toBeNull();
    expect(res.body.data.contrast_allergy_screen.safe).toBe(true);
    expect(res.body.data.contrast_allergy_screen.blockers).toHaveLength(0);
  });

  it('leaves non-contrast orders unscreened even for an allergic patient', async () => {
    const res = await doctor().post('/api/v1/radiology/orders')
      .send({ ...baseOrder(ALLERGIC_PATIENT_UID), clinical_indication: 'Non-contrast KUB' });

    expect(res.statusCode).toBe(201);
    expect(res.body.data.contrast_planned).toBe(false);
    expect(res.body.data.contrast_agent).toBeNull();
    expect(res.body.data.contrast_allergy_screen).toEqual({});
  });

  describe('pre-acquisition contrast-plan amendment (PUT /:id/contrast)', () => {
    let plainOrderId;

    beforeAll(async () => {
      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO radiology_orders
           (patient_uid, modality, body_part, clinical_indication,
            priority, status, ordered_by, tenant_id, created_at, updated_at)
         VALUES ($1::uuid, 'ct', 'Chest', 'Initially non-contrast HRCT',
                 'routine', 'ordered', $2::uuid, $3::uuid, NOW(), NOW())
         RETURNING id`,
        ALLERGIC_PATIENT_UID, DOCTOR_UID, TENANT_ID,
      );
      plainOrderId = rows[0].id;
    });

    it('blocks protocolling contrast onto an existing order for an allergic patient', async () => {
      const res = await doctor().put(`/api/v1/radiology/${plainOrderId}/contrast`)
        .send({ contrast_planned: true });

      expect(res.statusCode).toBe(409);
      expect(res.body.code).toBe('RADIOLOGY_CONTRAST_ALLERGY_BLOCKED');
      expect(res.body.details.blockers[0].allergy).toBe('Iodinated contrast');

      const rows = await prisma.$queryRawUnsafe(
        `SELECT contrast_planned FROM radiology_orders WHERE id = $1::int`,
        plainOrderId,
      );
      expect(rows[0].contrast_planned).toBe(false);
    });

    it('amends the plan under an acknowledged override and emits the canonical amendment event', async () => {
      const res = await doctor().put(`/api/v1/radiology/${plainOrderId}/contrast`)
        .send({
          contrast_planned: true,
          contrast_agent: 'iodixanol',
          override: { reason: 'Prior reaction reviewed; premedication chart signed' },
        });

      expect(res.statusCode).toBe(200);
      expect(res.body.data.contrast_planned).toBe(true);
      expect(res.body.data.contrast_agent).toBe('iodixanol');
      expect(res.body.data.contrast_override_reason).toMatch(/premedication chart/i);

      const timeline = await prisma.$queryRawUnsafe(
        `SELECT event_type, payload FROM clinical_timeline_events
          WHERE source_table = 'radiology_orders' AND source_id = $1
            AND event_type = 'radiology.contrast_plan_updated'`,
        String(plainOrderId),
      );
      expect(timeline).toHaveLength(1);
      expect(timeline[0].payload.contrast_allergy_override).toBe(true);
    });

    it('locks the contrast plan once the study is no longer awaiting acquisition', async () => {
      await prisma.$executeRawUnsafe(
        `UPDATE radiology_orders SET status = 'acquired' WHERE id = $1::int`,
        plainOrderId,
      );
      const res = await doctor().put(`/api/v1/radiology/${plainOrderId}/contrast`)
        .send({ contrast_planned: false });

      expect(res.statusCode).toBe(409);
      expect(res.body.code).toBe('RADIOLOGY_CONTRAST_PLAN_LOCKED');
    });
  });
});
