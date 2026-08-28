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
import { randomUUID } from 'crypto';

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

const prisma = (await import('../lib/prisma.js')).default;
const marService = await import('../services/clinical/marService.js');
const { seedReceivedMedicationSupply } = await import('./helpers/medicationEvidenceFixture.js');

const TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const NURSE_UID = randomUUID();
const PHARMACIST_UID = randomUUID();
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
         ($1::uuid, $4::uuid, 'MAR Atomic Patient', 'PATIENT', TRUE, 'active', NOW()),
         ($2::uuid, $4::uuid, 'MAR Atomic Nurse', 'NURSING_STAFF', TRUE, 'active', NOW()),
         ($3::uuid, $4::uuid, 'MAR Atomic Pharmacist', 'PHARMACY_INCHARGE', TRUE, 'active', NOW())`,
      PATIENT_UID,
      NURSE_UID,
      PHARMACIST_UID,
      TENANT_ID,
    );
    const supply = await seedReceivedMedicationSupply({
      prisma,
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      requesterUid: NURSE_UID,
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
});
