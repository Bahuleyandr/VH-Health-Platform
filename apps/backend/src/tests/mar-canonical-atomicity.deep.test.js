// Audit §3 (Clinical core & safety) — MAR scheduleMedications / recordMissed /
// holdMedication must persist their canonical clinical_timeline_events +
// clinical_audit_events row INSIDE the same transaction as the
// medication_administrations detail write (was: recordCanonicalMarEvent ran
// outside the tx, swallowed — so a scheduled/missed/held dose could exist with
// no canonical medication-safety record).
//
// recordAdministration is intentionally NOT exercised here for change — it was
// already hardened (its own setTenantTx + 23505 MAR_DUPLICATE_ADMINISTRATION
// mapping) and is left untouched.
//
// Proven against the real marService + real QA DB via a toggle-mock of
// recordCanonicalClinicalEvent (delegates to the real impl unless forced to fail).

import { jest } from '@jest/globals';
import { createHash, randomUUID } from 'crypto';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const ctl = { forceFail: false };
const actualCanonical = await import('../services/clinical/canonicalClinicalPlatformService.js');
jest.unstable_mockModule('../services/clinical/canonicalClinicalPlatformService.js', () => ({
  ...actualCanonical,
  recordCanonicalClinicalEvent: async (...args) => {
    if (ctl.forceFail) throw new Error('forced canonical event failure (test)');
    return actualCanonical.recordCanonicalClinicalEvent(...args);
  },
}));

const prismaModule = await import('../lib/prisma.js');
const prisma = prismaModule.default;
const { setTenantTx } = prismaModule;
const marService = await import('../services/clinical/marService.js');
const orderEntryService = await import('../services/emr/orderEntryService.js');
const { seedReceivedMedicationSupply } = await import('./helpers/medicationEvidenceFixture.js');

const TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const NURSE_UID = randomUUID();
const DOCTOR_UID = randomUUID();
const PHARMACIST_UID = randomUUID();
const ADMIN_UID = randomUUID();
const SCHED_BASE = '2026-07-01T08:00:00Z';
const DRUG = `MAR_ATOM_${randomUUID().slice(0, 8)}`;
const RUN = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

let product;

async function maRows() {
  return prisma.$queryRawUnsafe(
    `SELECT id, status, scheduled_time FROM medication_administrations
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND medication_name = $3
      ORDER BY id`,
    TENANT_ID, PATIENT_UID, DRUG,
  );
}
async function timelineRows(eventType) {
  return prisma.$queryRawUnsafe(
    `SELECT id, event_type, source_table, source_id FROM clinical_timeline_events
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND event_type = $3`,
    TENANT_ID, PATIENT_UID, eventType,
  );
}
async function auditRows(action) {
  return prisma.$queryRawUnsafe(
    `SELECT id, action FROM clinical_audit_events
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND action = $3`,
    TENANT_ID, PATIENT_UID, action,
  );
}

async function cleanupMarRows() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    for (const table of [
      'mar_supply_reconciliation_links',
      'mar_supply_consumptions',
      'mar_administration_command_receipts',
      'mar_transition_command_receipts',
      'medication_safety_reviews',
      'clinical_timeline_events',
      'clinical_audit_events',
      'medication_administrations',
    ]) {
      await tx.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE tenant_id = $1::uuid`,
        TENANT_ID,
      );
    }
  });
}

async function cleanupAll() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    for (const table of [
      'idempotency_keys',
      'task_comments',
      'tasks',
      'notification_outbox',
      'workflow_sla_instances',
      'billing_credit_note_events',
      'billing_credit_notes',
      'ward_indent_financial_events',
      'mar_supply_reconciliation_links',
      'mar_supply_consumptions',
      'mar_administration_command_receipts',
      'mar_transition_command_receipts',
      'medication_safety_reviews',
      'medication_administrations',
      'ward_indent_inventory_receipt_events',
      'ward_indent_inventory_movement_links',
      'ward_indent_inventory_allocations',
      'ward_indent_events',
      'clinical_timeline_events',
      'clinical_audit_events',
      'billing_invoice_items',
      'billing_invoices',
      'pharmacy_schedule_register',
      'pharmacy_stock_movements',
      'pharmacy_inventory_batches',
      'pharmacy_inventory_items',
      'ward_indent_items',
      'ward_indents',
      'clinical_orders',
      'pharmacy_catalog',
      'admissions',
      'beds',
      'wards',
      'audit_logs',
      'users',
    ]) {
      await tx.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE tenant_id = $1::uuid`,
        TENANT_ID,
      );
    }
    await tx.$executeRawUnsafe('DELETE FROM tenants WHERE id = $1::uuid', TENANT_ID);
  }, { timeout: 30_000 });
}

async function seedScheduledRow() {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO medication_administrations
       (tenant_id, patient_uid, medication_name, dose, route, scheduled_time,
        status, clinical_order_id, supply_quantity_per_dose)
     VALUES ($1::uuid, $2::uuid, $3::text, '5 mg', 'oral', $4::timestamptz,
             'scheduled', $5::int, 1)
     RETURNING id`,
    TENANT_ID,
    PATIENT_UID,
    DRUG,
    SCHED_BASE,
    product.clinicalOrderId,
  );
  return Number(rows[0].id);
}

d('MAR canonical atomicity — schedule/missed/held (audit §3)', () => {
  beforeAll(async () => {
    await cleanupAll();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
       VALUES ($1::uuid, $2::text, 'MAR Atomicity Tenant', 'IN', 'active', NOW(), NOW())`,
      TENANT_ID,
      `mar-atomic-${TENANT_ID.slice(0, 8)}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $6::uuid, 'MAR Atomic Patient', 'PATIENT', TRUE, 'active', NOW()),
         ($2::uuid, $6::uuid, 'MAR Atomic Nurse', 'NURSING_STAFF', TRUE, 'active', NOW()),
         ($3::uuid, $6::uuid, 'MAR Atomic Pharmacist', 'PHARMACY_INCHARGE', TRUE, 'active', NOW()),
         ($4::uuid, $6::uuid, 'MAR Atomic Doctor', 'DOCTOR', TRUE, 'active', NOW()),
         ($5::uuid, $6::uuid, 'MAR Atomic Admin', 'ADMIN', TRUE, 'active', NOW())`,
      PATIENT_UID,
      NURSE_UID,
      PHARMACIST_UID,
      DOCTOR_UID,
      ADMIN_UID,
      TENANT_ID,
    );
    const supply = await seedReceivedMedicationSupply({
      prisma,
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      requesterUid: NURSE_UID,
      prescriberUid: DOCTOR_UID,
      pharmacistUid: PHARMACIST_UID,
      receiverUid: NURSE_UID,
      run: `atomic-${RUN}`,
      medications: [{
        key: 'atomic',
        name: DRUG,
        dose: '5 mg',
        route: 'oral',
        strength: '5 mg',
        form: 'tablet',
        quantity: 10,
      }],
    });
    product = supply.products.atomic;
  }, 60_000);
  afterEach(() => { ctl.forceFail = false; });
  afterAll(async () => { await cleanupAll(); await prisma.$disconnect().catch(() => {}); });

  it('scheduleMedications persists the MA row + canonical mar.scheduled timeline + audit atomically', async () => {
    const created = await marService.scheduleMedications(PATIENT_UID, null, [
      {
        medication_name: DRUG,
        dose: '5 mg',
        route: 'oral',
        scheduled_time: SCHED_BASE,
        clinical_order_id: product.clinicalOrderId,
        supply_quantity_per_dose: 1,
      },
    ], { actorUid: NURSE_UID, actorRole: 'NURSING_STAFF', tenantId: TENANT_ID });

    expect(created).toHaveLength(1);
    const rows = await maRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('scheduled');

    const tl = await timelineRows('mar.scheduled');
    expect(tl.length).toBeGreaterThanOrEqual(1);
    expect(tl[0].source_table).toBe('medication_administrations');
    expect(String(tl[0].source_id)).toBe(String(rows[0].id));
    expect((await auditRows('mar.scheduled')).length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('rolls back the scheduled MA row when the canonical write fails (no orphan dose)', async () => {
    await cleanupMarRows();
    ctl.forceFail = true;
    await expect(
      marService.scheduleMedications(PATIENT_UID, null, [
        {
          medication_name: DRUG,
          dose: '5 mg',
          route: 'oral',
          scheduled_time: SCHED_BASE,
          clinical_order_id: product.clinicalOrderId,
          supply_quantity_per_dose: 1,
        },
      ], { actorUid: NURSE_UID, actorRole: 'NURSING_STAFF', tenantId: TENANT_ID }),
    ).rejects.toThrow(/forced canonical event failure/);

    expect(await maRows()).toHaveLength(0);          // MA row rolled back
    expect(await timelineRows('mar.scheduled')).toHaveLength(0);
  }, 30_000);

  it('recordMissed flips status + emits canonical mar.missed atomically; rolls back on canonical failure', async () => {
    await cleanupMarRows();
    const id = await seedScheduledRow();
    const commandKey = `mar-atomic-miss-${RUN}`;

    // Forced failure → status must NOT change to 'missed'.
    ctl.forceFail = true;
    await expect(marService.recordMissed(
      id,
      'patient NPO',
      NURSE_UID,
      { tenantId: TENANT_ID, commandKey },
    )).rejects.toThrow(/forced canonical event failure/);
    let row = await prisma.$queryRawUnsafe(`SELECT status FROM medication_administrations WHERE id = $1`, id);
    expect(row[0].status).toBe('scheduled'); // rolled back
    expect(await timelineRows('mar.missed')).toHaveLength(0);

    // Success → atomic flip + canonical event.
    ctl.forceFail = false;
    await marService.recordMissed(id, 'patient NPO', NURSE_UID, { tenantId: TENANT_ID, commandKey });
    row = await prisma.$queryRawUnsafe(`SELECT status FROM medication_administrations WHERE id = $1`, id);
    expect(row[0].status).toBe('missed');
    expect((await timelineRows('mar.missed')).length).toBeGreaterThanOrEqual(1);
    expect((await auditRows('mar.missed')).length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('holdMedication flips status + emits canonical mar.held atomically; rolls back on canonical failure', async () => {
    await cleanupMarRows();
    const id = await seedScheduledRow();
    const commandKey = `mar-atomic-hold-${RUN}`;

    ctl.forceFail = true;
    await expect(marService.holdMedication(
      id,
      'await review',
      NURSE_UID,
      { tenantId: TENANT_ID, commandKey },
    )).rejects.toThrow(/forced canonical event failure/);
    let row = await prisma.$queryRawUnsafe(`SELECT status, hold_reason FROM medication_administrations WHERE id = $1`, id);
    expect(row[0].status).toBe('scheduled'); // rolled back
    expect(row[0].hold_reason).toBeNull();
    expect(await timelineRows('mar.held')).toHaveLength(0);

    ctl.forceFail = false;
    await marService.holdMedication(id, 'await review', NURSE_UID, { tenantId: TENANT_ID, commandKey });
    row = await prisma.$queryRawUnsafe(`SELECT status, hold_reason FROM medication_administrations WHERE id = $1`, id);
    expect(row[0].status).toBe('held');
    expect(row[0].hold_reason).toBe('await review');
    expect((await timelineRows('mar.held')).length).toBeGreaterThanOrEqual(1);
    expect((await auditRows('mar.held')).length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('requires cancel instead of completing a never-verified medication order', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_orders
         (tenant_id, order_number, patient_uid, order_type, status, ordered_by, details)
       VALUES ($1::uuid, $2::text, $3::uuid, 'medication', 'ordered', $4::uuid, '{}'::jsonb)
       RETURNING id`,
      TENANT_ID,
      `ORD-NEVER-VERIFIED-${RUN}`,
      PATIENT_UID,
      DOCTOR_UID,
    );

    await expect(
      orderEntryService.completeOrder(Number(rows[0].id), DOCTOR_UID),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'MEDICATION_ORDER_COMPLETION_VERIFICATION_REQUIRED',
    });
  });

  it('projects overdue and future MAR rows when a prescriber completes the order', async () => {
    await cleanupMarRows();
    await expect(orderEntryService.completeOrder(
      product.clinicalOrderId,
      ADMIN_UID,
    )).rejects.toMatchObject({
      statusCode: 403,
      code: 'MEDICATION_ORDER_TERMINAL_PRESCRIBER_REQUIRED',
    });
    const firstFutureAt = new Date(Date.now() + 20 * 60_000).toISOString();
    const racedFutureAt = new Date(Date.now() + 40 * 60_000).toISOString();
    const pastAt = new Date(Date.now() - 20 * 60_000).toISOString();
    await marService.scheduleMedications(PATIENT_UID, null, [{
      medication_name: DRUG,
      dose: '5 mg',
      route: 'oral',
      scheduled_time: firstFutureAt,
      clinical_order_id: product.clinicalOrderId,
      supply_quantity_per_dose: 1,
    }, {
      medication_name: DRUG,
      dose: '5 mg',
      route: 'oral',
      scheduled_time: pastAt,
      clinical_order_id: product.clinicalOrderId,
      supply_quantity_per_dose: 1,
    }], { actorUid: NURSE_UID, actorRole: 'NURSING_STAFF', tenantId: TENANT_ID });

    const terminalKey = `terminal-complete-${RUN}`;
    const terminalFingerprint = createHash('sha256')
      .update(JSON.stringify({ action: 'complete', reason: null }))
      .digest('hex');
    const claimRows = await prisma.$queryRawUnsafe(
      `INSERT INTO idempotency_keys
         (tenant_id, user_uid, request_key, request_method, request_path,
          request_body_hash, status)
       VALUES ($1::uuid, $2::uuid, $3::text, 'PUT', $4::text, $5::char(64), 'in_flight')
       RETURNING id`,
      TENANT_ID,
      DOCTOR_UID,
      terminalKey,
      `/api/v1/emr/orders/${product.clinicalOrderId}/terminal`,
      terminalFingerprint,
    );

    const [scheduleResult, completeResult] = await Promise.allSettled([
      marService.scheduleMedications(PATIENT_UID, null, [{
        medication_name: DRUG,
        dose: '5 mg',
        route: 'oral',
        scheduled_time: racedFutureAt,
        clinical_order_id: product.clinicalOrderId,
        supply_quantity_per_dose: 1,
      }], { actorUid: NURSE_UID, actorRole: 'NURSING_STAFF', tenantId: TENANT_ID }),
      orderEntryService.completeOrder(product.clinicalOrderId, DOCTOR_UID, {
        commandKey: terminalKey,
        requestFingerprint: terminalFingerprint,
        httpIdempotencyClaimId: Number(claimRows[0].id),
        requestId: `request-${RUN}`,
      }),
    ]);
    expect(completeResult.status).toBe('fulfilled');
    if (scheduleResult.status === 'rejected') {
      expect(scheduleResult.reason).toMatchObject({
        code: 'MAR_SCHEDULE_ORDER_INACTIVE',
        statusCode: 409,
      });
    }

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, status, scheduled_time
         FROM medication_administrations
        WHERE tenant_id = $1::uuid
          AND clinical_order_id = $2::int
        ORDER BY scheduled_time, id`,
      TENANT_ID,
      product.clinicalOrderId,
    );
    const futureRows = rows.filter((row) => new Date(row.scheduled_time).getTime() >= Date.now());
    const pastRows = rows.filter((row) => new Date(row.scheduled_time).getTime() < Date.now());
    expect(futureRows.length).toBeGreaterThanOrEqual(1);
    expect(futureRows.every((row) => row.status === 'cancelled')).toBe(true);
    expect(pastRows.length).toBeGreaterThanOrEqual(1);
    expect(pastRows.every((row) => row.status === 'cancelled')).toBe(true);

    const projectionEvents = await timelineRows('mar.order_terminally_projected');
    expect(projectionEvents).toHaveLength(rows.length);
    const due = await marService.getDueMedications({
      tenantId: TENANT_ID,
      pastMinutes: 120,
      futureMinutes: 120,
    });
    const overdue = await marService.getOverdueMedications(null, { tenantId: TENANT_ID });
    expect(due.some((row) => Number(row.clinical_order_id) === product.clinicalOrderId)).toBe(false);
    expect(overdue.some((row) => Number(row.clinical_order_id) === product.clinicalOrderId)).toBe(false);
    const terminalReceipts = await prisma.$queryRawUnsafe(
      `SELECT status, response_status, response_body
         FROM idempotency_keys
        WHERE id = $1::int`,
      Number(claimRows[0].id),
    );
    expect(terminalReceipts[0]).toMatchObject({ status: 'complete', response_status: 200 });
    expect(terminalReceipts[0].response_body).toMatchObject({
      success: true,
      message: 'Order completed',
      data: {
        id: product.clinicalOrderId,
        status: 'completed',
        ward_indent_terminal_projection: {
          disposition: 'reconciliation_required',
          ward_indent_status: 'reconciliation_required'
        }
      }
    });

    const replay = await setTenantTx(TENANT_ID, async (tx) => (
      marService.terminallyProjectMedicationOrderDosesTx(tx, {
        tenantId: TENANT_ID,
        order: {
          id: product.clinicalOrderId,
          tenant_id: TENANT_ID,
          order_type: 'medication',
        },
        actorUid: DOCTOR_UID,
        terminalStatus: 'completed',
        reason: 'Medication order course completed by prescriber',
      })
    ));
    expect(replay).toEqual([]);
    expect(await timelineRows('mar.order_terminally_projected')).toHaveLength(rows.length);
  }, 60_000);
});
