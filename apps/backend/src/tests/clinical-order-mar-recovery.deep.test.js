import { randomUUID } from 'node:crypto';

import prisma from '../lib/prisma.js';
import {
  getPatientOrders,
  retryMedicationOrderMarScheduling,
} from '../services/emr/orderEntryService.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = DEFAULT_TENANT_ID;
const PATIENT_UID = randomUUID();
const DOCTOR_UID = randomUUID();
const VALID_ORDER_NUMBER = `MAR-REC-${randomUUID().slice(0, 8)}`;
const INVALID_ORDER_NUMBER = `MAR-BAD-${randomUUID().slice(0, 8)}`;
const PARTIAL_ORDER_NUMBER = `MAR-PART-${randomUUID().slice(0, 8)}`;
const ATOMIC_ORDER_NUMBER = `MAR-ATOM-${randomUUID().slice(0, 8)}`;
const RECEIPT_ORDER_NUMBER = `MAR-RCPT-${randomUUID().slice(0, 8)}`;

async function cleanup() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM medication_administrations WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID,
      DOCTOR_UID,
    );
  });
}

async function insertOrder(orderNumber, details) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_orders
       (tenant_id, order_number, patient_uid, order_type, priority, details,
        status, ordered_by, start_date, created_at, updated_at)
     VALUES
       ($1::uuid, $2, $3::uuid, 'medication', 'routine', $4::jsonb,
        'ordered', $5::uuid, NOW(), NOW(), NOW())
     RETURNING id`,
    TENANT,
    orderNumber,
    PATIENT_UID,
    JSON.stringify(details),
    DOCTOR_UID,
  );
  return Number(rows[0].id);
}

d('MED-03 clinical-order MAR recovery', () => {
  let validOrderId;
  let invalidOrderId;
  let partialOrderId;
  let atomicOrderId;
  let receiptOrderId;

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES
         ($1::uuid, $2, 'MAR Recovery Patient', 'PATIENT', true, $3::uuid, NOW()),
         ($4::uuid, $5, 'MAR Recovery Doctor', 'DOCTOR', true, $3::uuid, NOW())`,
      PATIENT_UID,
      `+9186${String(Date.now()).slice(-8)}`,
      TENANT,
      DOCTOR_UID,
      `+9185${String(Date.now()).slice(-8)}`,
    );
    validOrderId = await insertOrder(VALID_ORDER_NUMBER, {
      medication_name: 'Recovery Test Medicine',
      dose: '5 mg',
      route: 'oral',
      frequency: 'BD',
      duration_days: 1,
      supply_quantity_per_dose: 1,
    });
    invalidOrderId = await insertOrder(INVALID_ORDER_NUMBER, {
      medication_name: 'Incomplete Recovery Medicine',
      frequency: 'OD',
      duration_days: 1,
    });
    const closedSchedule = {
      medication_name: 'Atomic Recovery Medicine',
      dose: '10 mg',
      route: 'oral',
      frequency: 'BD',
      duration_days: 1,
      supply_quantity_per_dose: 1,
    };
    partialOrderId = await insertOrder(PARTIAL_ORDER_NUMBER, closedSchedule);
    atomicOrderId = await insertOrder(ATOMIC_ORDER_NUMBER, closedSchedule);
    receiptOrderId = await insertOrder(RECEIPT_ORDER_NUMBER, closedSchedule);
    await prisma.$executeRawUnsafe(
      `INSERT INTO medication_administrations
         (tenant_id, patient_uid, medication_name, dose, route, scheduled_time,
          status, clinical_order_id, supply_quantity_per_dose)
       VALUES
         ($1::uuid, $2::uuid, 'Atomic Recovery Medicine', '10 mg', 'oral',
          date_trunc('day', NOW()) + INTERVAL '8 hours', 'scheduled', $3::int, 1)`,
      TENANT,
      PATIENT_UID,
      partialOrderId,
    );
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('missing schedule is visible, repaired idempotently, and canonically reconciled', async () => {
    const before = await getPatientOrders(PATIENT_UID, {
      tenantId: TENANT,
      limit: 100,
    });
    const validBefore = before.orders.find((order) => order.id === validOrderId);
    const invalidBefore = before.orders.find((order) => order.id === invalidOrderId);
    expect(validBefore).toMatchObject({
      mar_schedule_status: 'action_required',
      mar_scheduled_dose_count: 0,
      mar_expected_dose_count: 2,
      mar_recovery_endpoint: `/api/v1/emr/orders/${validOrderId}/retry-mar-scheduling`,
    });
    expect(invalidBefore).toMatchObject({
      mar_schedule_status: 'action_required',
      mar_scheduled_dose_count: 0,
      mar_expected_dose_count: null,
    });
    expect(before.orders.find((order) => order.id === partialOrderId)).toMatchObject({
      mar_schedule_status: 'action_required',
      mar_scheduled_dose_count: 1,
      mar_expected_dose_count: 2,
      mar_recovery_endpoint: `/api/v1/emr/orders/${partialOrderId}/retry-mar-scheduling`,
    });

    const first = await retryMedicationOrderMarScheduling({
      tenantId: TENANT,
      orderId: validOrderId,
      actorUid: DOCTOR_UID,
      actorRole: 'DOCTOR',
    });
    const replay = await retryMedicationOrderMarScheduling({
      tenantId: TENANT,
      orderId: validOrderId,
      actorUid: DOCTOR_UID,
      actorRole: 'DOCTOR',
    });

    expect(first.status).toBe('scheduled');
    expect(first.scheduled_dose_count).toBe(2);
    expect(replay.scheduled_dose_ids).toEqual(first.scheduled_dose_ids);

    const marRows = await prisma.$queryRawUnsafe(
      `SELECT id, clinical_order_id, supply_quantity_per_dose
         FROM medication_administrations
        WHERE tenant_id = $1::uuid
          AND clinical_order_id = $2::int
        ORDER BY id`,
      TENANT,
      validOrderId,
    );
    expect(marRows).toHaveLength(2);
    expect(marRows.every((row) => Number(row.clinical_order_id) === validOrderId)).toBe(true);
    expect(marRows.every((row) => Number(row.supply_quantity_per_dose) === 1)).toBe(true);

    const [auditRows, timelineRows] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT id, action, action_status
           FROM clinical_audit_events
          WHERE idempotency_key = $1`,
        `clinical_orders:${validOrderId}:mar_scheduling_recovered`,
      ),
      prisma.$queryRawUnsafe(
        `SELECT id, event_type, event_status
           FROM clinical_timeline_events
          WHERE idempotency_key = $1`,
        `clinical_orders:${validOrderId}:mar_scheduling_recovered`,
      ),
    ]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'mar_scheduling_recovered',
      action_status: 'success',
    });
    expect(timelineRows).toHaveLength(1);
    expect(timelineRows[0]).toMatchObject({
      event_type: 'mar.scheduling_recovered',
      event_status: 'completed',
    });

    const after = await getPatientOrders(PATIENT_UID, {
      tenantId: TENANT,
      limit: 100,
    });
    expect(after.orders.find((order) => order.id === validOrderId)).toMatchObject({
      mar_schedule_status: 'scheduled',
      mar_scheduled_dose_count: 2,
      mar_expected_dose_count: 2,
      mar_recovery_endpoint: null,
    });
  }, 30_000);

  test('recovery never invents missing prescription details', async () => {
    await expect(retryMedicationOrderMarScheduling({
      tenantId: TENANT,
      orderId: invalidOrderId,
      actorUid: DOCTOR_UID,
      actorRole: 'DOCTOR',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'MAR_SCHEDULE_ORDER_DETAILS_INVALID',
      details: { missing_fields: ['dose', 'route'] },
    });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id
         FROM medication_administrations
        WHERE tenant_id = $1::uuid
          AND clinical_order_id = $2::int`,
      TENANT,
      invalidOrderId,
    );
    expect(rows).toHaveLength(0);
  });

  test('serialized recovery rechecks active doctor authority before touching MAR', async () => {
    await prisma.users.update({
      where: { uid: DOCTOR_UID },
      data: { is_active: false }
    });
    try {
      await expect(
        retryMedicationOrderMarScheduling({
          tenantId: TENANT,
          orderId: invalidOrderId,
          actorUid: DOCTOR_UID,
          actorRole: 'DOCTOR'
        })
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'MAR_RECOVERY_ACTIVE_PRESCRIBER_REQUIRED'
      });
    } finally {
      await prisma.users.update({
        where: { uid: DOCTOR_UID },
        data: { is_active: true, role: 'DOCTOR' }
      });
    }
    expect(
      await prisma.$queryRawUnsafe(
        `SELECT id FROM medication_administrations
        WHERE tenant_id = $1::uuid AND clinical_order_id = $2::int`,
        TENANT,
        invalidOrderId
      )
    ).toHaveLength(0);
  });

  test('a forced mid-batch failure rolls back every scheduled dose and canonical event', async () => {
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS test_med03_reject_second_mar_row ON medication_administrations',
    );
    await prisma.$executeRawUnsafe(
      'DROP FUNCTION IF EXISTS public.test_med03_reject_second_mar_row()',
    );
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION public.test_med03_reject_second_mar_row()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $$
       BEGIN
         IF NEW.clinical_order_id = ${atomicOrderId}
            AND EXISTS (
              SELECT 1
                FROM medication_administrations
               WHERE tenant_id = NEW.tenant_id
                 AND clinical_order_id = NEW.clinical_order_id
            ) THEN
           RAISE EXCEPTION 'forced second MAR row failure' USING ERRCODE = 'P0001';
         END IF;
         RETURN NEW;
       END
       $$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER test_med03_reject_second_mar_row
       BEFORE INSERT ON medication_administrations
       FOR EACH ROW EXECUTE FUNCTION public.test_med03_reject_second_mar_row()`,
    );
    try {
      await expect(retryMedicationOrderMarScheduling({
        tenantId: TENANT,
        orderId: atomicOrderId,
        actorUid: DOCTOR_UID,
        actorRole: 'DOCTOR',
      })).rejects.toThrow(/forced second MAR row failure/i);
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS test_med03_reject_second_mar_row ON medication_administrations',
      );
      await prisma.$executeRawUnsafe(
        'DROP FUNCTION IF EXISTS public.test_med03_reject_second_mar_row()',
      );
    }

    const [rows, timeline] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT id FROM medication_administrations
          WHERE tenant_id = $1::uuid AND clinical_order_id = $2::int`,
        TENANT,
        atomicOrderId,
      ),
      prisma.$queryRawUnsafe(
        `SELECT id FROM clinical_timeline_events
          WHERE tenant_id = $1::uuid
            AND payload->>'source_clinical_order_id' = $2::text`,
        TENANT,
        String(atomicOrderId),
      ),
    ]);
    expect(rows).toHaveLength(0);
    expect(timeline).toHaveLength(0);
  });

  test('recovery-receipt failure rolls back the newly completed schedule', async () => {
    const receiptKey = `clinical_orders:${receiptOrderId}:mar_scheduling_recovered`;
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS test_med03_reject_recovery_receipt ON clinical_timeline_events',
    );
    await prisma.$executeRawUnsafe(
      'DROP FUNCTION IF EXISTS public.test_med03_reject_recovery_receipt()',
    );
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION public.test_med03_reject_recovery_receipt()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $$
       BEGIN
         IF NEW.idempotency_key = '${receiptKey}' THEN
           RAISE EXCEPTION 'forced MAR recovery receipt failure' USING ERRCODE = 'P0001';
         END IF;
         RETURN NEW;
       END
       $$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER test_med03_reject_recovery_receipt
       BEFORE INSERT ON clinical_timeline_events
       FOR EACH ROW EXECUTE FUNCTION public.test_med03_reject_recovery_receipt()`,
    );
    try {
      await expect(retryMedicationOrderMarScheduling({
        tenantId: TENANT,
        orderId: receiptOrderId,
        actorUid: DOCTOR_UID,
        actorRole: 'DOCTOR',
      })).rejects.toThrow(/forced MAR recovery receipt failure/i);
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS test_med03_reject_recovery_receipt ON clinical_timeline_events',
      );
      await prisma.$executeRawUnsafe(
        'DROP FUNCTION IF EXISTS public.test_med03_reject_recovery_receipt()',
      );
    }

    expect(await prisma.$queryRawUnsafe(
      `SELECT id FROM medication_administrations
        WHERE tenant_id = $1::uuid AND clinical_order_id = $2::int`,
      TENANT,
      receiptOrderId,
    )).toHaveLength(0);
    expect(await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_timeline_events WHERE idempotency_key = $1`,
      receiptKey,
    )).toHaveLength(0);

    const repaired = await retryMedicationOrderMarScheduling({
      tenantId: TENANT,
      orderId: receiptOrderId,
      actorUid: DOCTOR_UID,
      actorRole: 'DOCTOR',
    });
    expect(repaired).toMatchObject({ status: 'scheduled', scheduled_dose_count: 2 });
  });
});
