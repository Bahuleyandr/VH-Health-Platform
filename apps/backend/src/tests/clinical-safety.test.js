import { randomUUID } from 'crypto';

import prisma from '../lib/prisma.js';
import { administerWithScan, evaluate5Rights } from '../services/clinical/marFiveRightsService.js';
import { getPatientMAR, recordAdministration, scheduleMedications } from '../services/clinical/marService.js';
import { acknowledgeAlert, checkOrder } from '../services/emr/cdsEngine.js';
import { seedReceivedMedicationSupply } from './helpers/medicationEvidenceFixture.js';

const TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const OTHER_PATIENT_UID = randomUUID();
const CLINICIAN_UID = randomUUID();
const PHARMACIST_UID = randomUUID();
const RUN = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

let supply;

async function cleanupFixtures() {
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
      'cds_alerts',
      'patient_allergies',
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

async function seedMedicationAdministration(overrides = {}) {
  // scheduledOffsetMinutes shifts scheduled_time relative to now so a test can
  // force a SOFT (time-window) right failure while patient + drug still match —
  // the only remaining overridable path now that patient/drug mismatch is a
  // non-overridable hard-stop (audit F-H1).
  const offset = Number(overrides.scheduledOffsetMinutes || 0);
  const product = supply.products[overrides.productKey || 'amoxicillin'];
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO medication_administrations (
       tenant_id, patient_uid, medication_name, dose, route, scheduled_time,
       status, clinical_order_id, supply_quantity_per_dose, created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, NOW() + ($6 || ' minutes')::interval,
       'scheduled', $7::int, 1, NOW(), NOW()
     )
     RETURNING id`,
    TENANT_ID,
    overrides.patientUid || PATIENT_UID,
    overrides.medicationName || product.name,
    overrides.dose || product.dose,
    overrides.route || product.route,
    String(offset),
    product.clinicalOrderId,
  );
  return Number(rows[0].id);
}

describe('Clinical safety controls', () => {
  beforeAll(async () => {
    await cleanupFixtures();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
       VALUES ($1::uuid, $2::text, 'Clinical Safety Tenant', 'IN', 'active', NOW(), NOW())`,
      TENANT_ID,
      `clinical-safety-${TENANT_ID.slice(0, 8)}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $5::uuid, 'Clinical Safety Patient', 'PATIENT', TRUE, 'active', NOW()),
         ($2::uuid, $5::uuid, 'Clinical Safety Other Patient', 'PATIENT', TRUE, 'active', NOW()),
         ($3::uuid, $5::uuid, 'Clinical Safety Clinician', 'DOCTOR', TRUE, 'active', NOW()),
         ($4::uuid, $5::uuid, 'Clinical Safety Pharmacist', 'PHARMACY_INCHARGE', TRUE, 'active', NOW())`,
      PATIENT_UID,
      OTHER_PATIENT_UID,
      CLINICIAN_UID,
      PHARMACIST_UID,
      TENANT_ID,
    );
    supply = await seedReceivedMedicationSupply({
      prisma,
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      requesterUid: CLINICIAN_UID,
      pharmacistUid: PHARMACIST_UID,
      receiverUid: CLINICIAN_UID,
      run: `safety-${RUN}`,
      medications: [
        {
          key: 'amoxicillin',
          name: 'Amoxicillin 500mg',
          dose: '500 mg',
          route: 'oral',
          strength: '500 mg',
          form: 'capsule',
          quantity: 20,
        },
        {
          key: 'aspirin',
          name: 'Aspirin 325mg',
          dose: '325 mg',
          route: 'oral',
          strength: '325 mg',
          form: 'tablet',
          quantity: 20,
        },
        {
          key: 'gtn',
          name: 'Glyceryl trinitrate',
          dose: '0.4 mg',
          route: 'sublingual',
          strength: '0.4 mg',
          form: 'tablet',
          quantity: 10,
        },
      ],
    });
  }, 60_000);

  afterAll(async () => {
    await cleanupFixtures();
    await prisma.$disconnect().catch(() => {});
  });

  it('passes all five MAR rights when patient, drug, dose, route, and time match', async () => {
    const maId = await seedMedicationAdministration();

    const result = await evaluate5Rights({
      ma_id: maId,
      scanned_patient_uid: PATIENT_UID,
      scanned_barcode: supply.products.amoxicillin.batchNumber,
      tenantId: TENANT_ID,
    });

    expect(result.allPassed).toBe(true);
    expect(result.rights).toEqual({
      patient: true,
      drug: true,
      dose: true,
      route: true,
      time: true,
    });
  });

  it('blocks MAR administration when a five-rights failure has no override', async () => {
    const maId = await seedMedicationAdministration();

    await expect(
      administerWithScan({
        ma_id: maId,
        scanned_patient_uid: OTHER_PATIENT_UID,
        scanned_barcode: supply.products.amoxicillin.batchNumber,
        administeredBy: CLINICIAN_UID,
        tenantId: TENANT_ID,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: { rights: expect.objectContaining({ patient: false }) },
    });
  });

  it('records the override audit trail when a SOFT right (time) is overridden', async () => {
    // Patient + drug match (no hard-stop); the dose is 3h outside the scheduling
    // window, so the time right fails — that IS overridable with a documented
    // reason, and the override must be audited.
    const maId = await seedMedicationAdministration({ scheduledOffsetMinutes: -180 });

    const updated = await administerWithScan({
      ma_id: maId,
      scanned_patient_uid: PATIENT_UID,
      scanned_barcode: supply.products.amoxicillin.batchNumber,
      administeredBy: CLINICIAN_UID,
      overrideReason: 'Dose given late — patient returned from imaging; documented per policy',
      tenantId: TENANT_ID,
    });

    expect(updated.status).toBe('administered');
    expect(updated.all_rights_passed).toBe(false);
    expect(updated.rights_passed).toMatchObject({ patient: true, drug: true, time: false });
    expect(updated.override_reason).toContain('returned from imaging');
  });

  it('a wrong-patient scan is a NON-overridable hard-stop even WITH a reason (audit F-H1)', async () => {
    const maId = await seedMedicationAdministration();

    await expect(
      administerWithScan({
        ma_id: maId,
        scanned_patient_uid: OTHER_PATIENT_UID, // wristband does not match the order
        scanned_barcode: supply.products.amoxicillin.batchNumber,
        administeredBy: CLINICIAN_UID,
        overrideReason: 'Patient wristband replaced after manual identity verification',
        tenantId: TENANT_ID,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'MAR_PATIENT_MISMATCH',
      details: { hardStop: true, failedRight: 'patient' },
    });

    // The order must remain unadministered.
    const [row] = await prisma.$queryRawUnsafe(
      `SELECT status FROM medication_administrations WHERE id = $1`,
      maId,
    );
    expect(row.status).toBe('scheduled');
  });

  // B4.2 — BCMA server-side two-scan enforcement. The patient-wristband scan
  // ("right patient") AND the medication-barcode scan ("right drug") must both
  // match before a dose is charted; the gate is enforced server-side with its
  // own MAR_TWO_SCAN_REQUIRED code, the two scan timestamps are recorded for an
  // auditable trail, and an override must leave a complete clinical_audit_events
  // entry.
  describe('B4.2 BCMA two-scan enforcement', () => {
    it('rejects administration with a mismatched patient scan (MAR_PATIENT_MISMATCH hard-stop)', async () => {
      const maId = await seedMedicationAdministration();

      await expect(
        administerWithScan({
          ma_id: maId,
          scanned_patient_uid: OTHER_PATIENT_UID, // wristband does not match the MA's patient
          scanned_barcode: supply.products.amoxicillin.batchNumber,
          administeredBy: CLINICIAN_UID,
          tenantId: TENANT_ID,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'MAR_PATIENT_MISMATCH',
        details: { rights: expect.objectContaining({ patient: false }) },
      });
    });

    it('administers on a matching wristband + medication barcode and stamps both scan timestamps', async () => {
      const maId = await seedMedicationAdministration();

      const updated = await administerWithScan({
        ma_id: maId,
        scanned_patient_uid: PATIENT_UID,
        scanned_barcode: supply.products.amoxicillin.batchNumber,
        administeredBy: CLINICIAN_UID,
        tenantId: TENANT_ID,
      });

      expect(updated.status).toBe('administered');
      expect(updated.all_rights_passed).toBe(true);
      expect(updated.patient_scanned_at).not.toBeNull();
      expect(updated.medication_scanned_at).not.toBeNull();

      // The timestamps must also be durable on the row, not just in the RETURNING.
      const [row] = await prisma.$queryRawUnsafe(
        `SELECT patient_scanned_at, medication_scanned_at, all_rights_passed
           FROM medication_administrations WHERE id = $1`,
        maId,
      );
      expect(row.patient_scanned_at).not.toBeNull();
      expect(row.medication_scanned_at).not.toBeNull();
      expect(row.all_rights_passed).toBe(true);
    });

    it('administers a SOFT-right (time) override and writes a clinical_audit_events row carrying the override', async () => {
      // Patient + drug match → no hard-stop; the time right fails (3h late) and
      // is overridden. The administration proceeds and the audit row carries the
      // override. (Patient/drug mismatches can no longer reach administration.)
      const maId = await seedMedicationAdministration({ scheduledOffsetMinutes: -180 });
      const overrideReason = 'Dose given late after theatre delay; identity + drug scans matched';

      const updated = await administerWithScan({
        ma_id: maId,
        scanned_patient_uid: PATIENT_UID,
        scanned_barcode: supply.products.amoxicillin.batchNumber,
        administeredBy: CLINICIAN_UID,
        overrideReason,
        tenantId: TENANT_ID,
      });

      expect(updated.status).toBe('administered');
      expect(updated.override_reason).toBe(overrideReason);

      // A clinical_audit_events row must exist for this administration carrying
      // the override in its metadata (the deep test queries clinical_timeline_events
      // the same way for source_table/source_id).
      const audit = await prisma.$queryRawUnsafe(
        `SELECT action, resource_table, resource_id, metadata
           FROM clinical_audit_events
          WHERE resource_table = 'medication_administrations'
            AND resource_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        String(maId),
      );
      expect(audit.length).toBeGreaterThanOrEqual(1);
      expect(audit[0].action).toBe('mar.administered');
      // Both identity scans matched, so two_scan_override is false; the soft-right
      // override is still recorded.
      expect(audit[0].metadata).toMatchObject({
        two_scan_override: false,
        override_reason: overrideReason,
      });
    });
  });

  it('deduplicates MAR scheduling when carry-over timestamps differ only by milliseconds', async () => {
    const aspirin = supply.products.aspirin;
    const [first] = await scheduleMedications(PATIENT_UID, null, [{
      medication_name: 'Aspirin',
      dose: '325 mg',
      route: 'oral',
      scheduled_time: '2026-05-20T20:39:51.578Z',
      clinical_order_id: aspirin.clinicalOrderId,
      supply_quantity_per_dose: 1,
    }], { actorUid: CLINICIAN_UID, actorRole: 'DOCTOR', tenantId: TENANT_ID });

    const [second] = await scheduleMedications(PATIENT_UID, null, [{
      medication_name: 'Aspirin',
      dose: '325 mg',
      route: 'oral',
      scheduled_time: '2026-05-20T20:39:51.580Z',
      clinical_order_id: aspirin.clinicalOrderId,
      supply_quantity_per_dose: 1,
    }], { actorUid: CLINICIAN_UID, actorRole: 'DOCTOR', tenantId: TENANT_ID });

    expect(second.id).toBe(first.id);
  });

  // ER→ICU MAR carry-over drop. The chest-pain order set (migration 187)
  // seeds STAT Aspirin with route "PO chewed" — a route + administration
  // modifier. The MAR route allowlist used to reject the compound string,
  // so the order-integration / carry-over scheduleMedications call threw,
  // the caller's catch swallowed it, and the time-critical ACS aspirin
  // never appeared on the ICU MAR (GTN, route "sublingual", did carry).
  // The dose must materialise as a chartable MAR row with a valid route.
  // Finding: 2026-05-21-emergency-walk-in-nurse-7d2d873a.
  it('materialises a STAT order with a compound "PO chewed" route as a chartable MAR row', async () => {
    const aspirin = supply.products.aspirin;
    const [row] = await scheduleMedications(PATIENT_UID, null, [{
      medication_name: 'Aspirin 325mg',
      dose: '325mg',
      route: 'PO chewed',
      scheduled_time: '2026-05-21T06:30:00.000Z',
      clinical_order_id: aspirin.clinicalOrderId,
      supply_quantity_per_dose: 1,
    }], { actorUid: CLINICIAN_UID, actorRole: 'DOCTOR', tenantId: TENANT_ID });

    // The compound route is canonicalised to the allowlist value 'oral'
    // (the "chewed" modifier is not an enum value) so the row is valid and
    // visible on the MAR.
    expect(row.id).toBeDefined();
    expect(row.route).toBe('oral');
    expect(row.status).toBe('scheduled');

    // It must show up on the patient's MAR for that day and be chartable.
    const mar = await getPatientMAR(PATIENT_UID, '2026-05-21');
    const aspirinRow = mar.find((m) => m.id === row.id);
    expect(aspirinRow).toBeDefined();
    expect(aspirinRow.medication_name).toBe('Aspirin 325mg');

    // B1 (BCMA): the non-scan path now requires an override reason while
    // MAR_REQUIRE_BARCODE_SCAN is on — bare administration 409s…
    await expect(recordAdministration(row.id, CLINICIAN_UID))
      .rejects.toMatchObject({ code: 'MAR_SCAN_REQUIRED', statusCode: 409 });

    // …and succeeds with a documented no-scan override, persisting it.
    const administered = await recordAdministration(row.id, CLINICIAN_UID, null, null, {
      overrideReason: 'BCMA test override — scanner unavailable in ER bay',
      tenantId: TENANT_ID,
    });
    expect(administered.status).toBe('administered');
    expect(administered.override_reason).toMatch(/scanner unavailable/);
  });

  // The fix must not regress the existing ±1min dedupe: re-running the
  // carry-over for the same compound-route STAT order (createAdmissionFromEr
  // re-schedules every active ER order) must return the same row, not a
  // second one — otherwise the nurse sees a phantom double aspirin dose.
  it('still dedupes a compound-route STAT order on carry-over re-run', async () => {
    const aspirin = supply.products.aspirin;
    const [first] = await scheduleMedications(PATIENT_UID, null, [{
      medication_name: 'Aspirin loading',
      dose: '325mg',
      route: 'PO chewed',
      scheduled_time: '2026-05-21T07:00:00.000Z',
      clinical_order_id: aspirin.clinicalOrderId,
      supply_quantity_per_dose: 1,
    }], { actorUid: CLINICIAN_UID, actorRole: 'DOCTOR', tenantId: TENANT_ID });
    const [second] = await scheduleMedications(PATIENT_UID, null, [{
      medication_name: 'Aspirin loading',
      dose: '325mg',
      route: 'PO chewed and crushed',
      scheduled_time: '2026-05-21T07:00:00.300Z',
      clinical_order_id: aspirin.clinicalOrderId,
      supply_quantity_per_dose: 1,
    }], { actorUid: CLINICIAN_UID, actorRole: 'DOCTOR', tenantId: TENANT_ID });

    expect(second.id).toBe(first.id);
    expect(second.route).toBe('oral');
  });

  it('blocks sibling MAR administration for the same medication slot despite millisecond drift', async () => {
    const gtn = supply.products.gtn;
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO medication_administrations (
         tenant_id, patient_uid, medication_name, dose, route, scheduled_time,
         status, clinical_order_id, supply_quantity_per_dose, created_at, updated_at
       ) VALUES
         ($1::uuid, $2::uuid, 'Glyceryl trinitrate', '0.4 mg', 'sublingual',
          '2026-05-20T20:39:04.386Z'::timestamptz, 'scheduled', $3::int, 1, NOW(), NOW()),
         ($1::uuid, $2::uuid, 'Glyceryl trinitrate', '0.4 mg', 'sublingual',
          '2026-05-20T20:39:04.395Z'::timestamptz, 'scheduled', $3::int, 1, NOW(), NOW())
       RETURNING id`,
      TENANT_ID,
      PATIENT_UID,
      gtn.clinicalOrderId,
    );
    rows.sort((a, b) => a.id - b.id);

    // B1 (BCMA): non-scan administration carries a documented override.
    const noScan = {
      overrideReason: 'BCMA test override — duplicate-guard scenario',
      tenantId: TENANT_ID,
    };
    await recordAdministration(rows[0].id, CLINICIAN_UID, null, null, noScan);

    await expect(recordAdministration(rows[1].id, CLINICIAN_UID, null, null, noScan)).rejects.toMatchObject({
      statusCode: 409,
      code: 'MAR_DUPLICATE_ADMINISTRATION',
      details: { duplicate_id: rows[0].id },
    });
  });

  it('returns an unsafe CDS allergy blocker for a medication allergen match', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_allergies
         (tenant_id, patient_uid, allergy_name, severity, reaction, is_active, created_at)
       VALUES ($1::uuid, $2::uuid, 'amoxicillin', 'severe', 'anaphylaxis', true, NOW())`,
      TENANT_ID,
      PATIENT_UID,
    );

    const result = await checkOrder({
      type: 'medication',
      medication_name: 'Amoxicillin 500mg',
      patient_uid: PATIENT_UID,
    });

    expect(result.safe).toBe(false);
    expect(result.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'allergy',
          severity: 'critical',
          canOverride: true,
        }),
      ]),
    );
  });

  it('persists CDS override acknowledgement with the clinical reason', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO cds_alerts (
         tenant_id, patient_uid, alert_type, severity, title, description, source_data, created_at
       ) VALUES (
         $1::uuid, $2::uuid, 'allergy', 'critical', 'Allergy alert',
         'Ordered medication matches allergy', '{}'::jsonb, NOW()
       )
       RETURNING id`,
      TENANT_ID,
      PATIENT_UID,
    );

    const acknowledged = await acknowledgeAlert(
      rows[0].id,
      CLINICIAN_UID,
      'Benefit outweighs risk after consultant review',
      TENANT_ID,
    );

    expect(acknowledged.acknowledged).toBe(true);
    expect(acknowledged.acknowledged_by).toBe(CLINICIAN_UID);
    expect(acknowledged.override_reason).toContain('consultant review');
  });
});
