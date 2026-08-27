// OpenAPI Phase 5 — Canonical clinical MAR contract deep test. Proves the 9
// /api/v1/clinical/mar/* response schemas (scripts/openapi/schemas/clinicalMar.mjs)
// against REAL service returns on the QA DB. The MAR routes wrap each service
// payload in the uniform success() envelope (statically covered by the overlay's
// envelope/listEnvelope), so this asserts the INNER `data` payload of every op
// via assertData against the committed component schema — exercising the full
// lifecycle: clinical order + ward custody → schedule → administer / miss /
// hold → patient/overdue/due lists → 5-rights verify → administer-with-scan.
// The public /mar/schedule route is readiness-only; its empty-batch contract is
// covered statically in marRouteClosureContracts.test.js. This deep fixture
// exercises the internal clinical-order scheduler that owns real MAR rows.
//
// Service returns are raw prisma rows (Date objects, etc.); we JSON-roundtrip
// each one first so it matches the wire format Express actually serialises.
//
// Self-isolating fixtures (unique tenant + patient + nurse).

import { randomUUID } from 'crypto';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const prisma = (await import('../lib/prisma.js')).default;
const marService = await import('../services/clinical/marService.js');
const marFiveRights = await import('../services/clinical/marFiveRightsService.js');
const {
  approveWardIndent,
  createWardIndent,
  issueWardIndent,
  receiveWardIndent,
  reserveWardIndent,
} = await import('../services/ipd/ipdSupportService.js');
const { assertData } = await import('./helpers/assertSchema.js');

// The wire format Express produces (Date -> ISO string, BigInt -> number).
const wire = (o) => JSON.parse(JSON.stringify(o));

const TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const NURSE_UID = randomUUID();
const PHARMACIST_UID = randomUUID();
const PATIENT_PHONE = `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const NURSE_PHONE = `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const PHARMACIST_PHONE = `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const RUN = `${process.pid}-${Date.now()}`;
const MEDICATION_NAME = `MAR Contract Medicine ${RUN}`;

const hospitalToday = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
const utcToday = () => new Date().toISOString().split('T')[0];
const minutesFromNow = (m) => new Date(Date.now() + m * 60_000).toISOString();
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

const ctx = { actorUid: NURSE_UID, actorRole: 'NURSING_STAFF', tenantId: TENANT_ID };

let scheduled = [];
let wardId;
let catalogId;
let clinicalOrderId;

async function patientMarRowsForFixtureDay() {
  const dbDates = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT scheduled_time::date::text AS scheduled_date
       FROM medication_administrations
      WHERE patient_uid = $1::uuid
      ORDER BY scheduled_date`,
    PATIENT_UID,
  );
  const candidates = [
    hospitalToday,
    utcToday(),
    ...dbDates.map((row) => row.scheduled_date).filter(Boolean),
  ];

  for (const date of [...new Set(candidates)]) {
    const rows = await marService.getPatientMAR(PATIENT_UID, date);
    if (rows.length >= 4) return rows;
  }
  return marService.getPatientMAR(PATIENT_UID, hospitalToday);
}

async function cleanup() {
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
      'mar_administration_command_receipts',
      'mar_transition_command_receipts',
      'mar_supply_reconciliation_links',
      'mar_supply_consumptions',
      'medication_safety_reviews',
      'medication_administrations',
      'ward_indent_inventory_movement_links',
      'ward_indent_inventory_allocations',
      'ward_indent_events',
      'clinical_timeline_events',
      'clinical_audit_events',
      'billing_invoice_items',
      'billing_invoices',
      'pharmacy_stock_movements',
      'pharmacy_inventory_batches',
      'pharmacy_inventory_items',
      'ward_indent_items',
      'ward_indents',
      'clinical_orders',
      'pharmacy_catalog',
      'wards',
      'users',
    ]) {
      await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = $1::uuid`, TENANT_ID);
    }
    await tx.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_ID);
  });
}

d('Canonical clinical MAR contract (/api/v1/clinical/mar/*)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, 'MAR Contract Tenant')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_ID, `mar-${TENANT_ID.slice(0, 8)}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'MAR Patient', 'PATIENT', true, $3::uuid, NOW())`,
      PATIENT_UID, PATIENT_PHONE, TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'MAR Nurse', 'NURSING_STAFF', true, $3::uuid, NOW())`,
      NURSE_UID, NURSE_PHONE, TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'MAR Pharmacist', 'PHARMACY_INCHARGE', true, $3::uuid, NOW())`,
      PHARMACIST_UID, PHARMACIST_PHONE, TENANT_ID,
    );

    wardId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO wards (tenant_id, name, total_beds, created_at, updated_at)
       VALUES ($1::uuid, $2::text, 10, NOW(), NOW())
       RETURNING id`,
      TENANT_ID,
      `MAR Contract Ward ${RUN}`,
    ))[0].id);
    catalogId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (tenant_id, name, is_active, stock_quantity, unit_price, price, updated_at)
       VALUES ($1::uuid, $2::text, TRUE, 10, 8.00, 8.00, NOW())
       RETURNING id`,
      TENANT_ID,
      MEDICATION_NAME,
    ))[0].id);
    const inventoryItemId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, catalog_id, unit_label, schedule_class, is_narcotic)
       VALUES ($1::uuid, $2::text, $3::text, $4::int, 'unit', 'OTC', FALSE)
       RETURNING id`,
      TENANT_ID,
      `MAR-CONTRACT-${RUN}`,
      MEDICATION_NAME,
      catalogId,
    ))[0].id);
    await prisma.$executeRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, batch_number, expiry_date,
          received_quantity, remaining_quantity, status)
       VALUES ($1::uuid, $2::int, $3::text, (NOW() + INTERVAL '365 days')::date,
               10, 10, 'in_stock')`,
      TENANT_ID,
      inventoryItemId,
      `MAR-CONTRACT-BATCH-${RUN}`,
    );
    clinicalOrderId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_orders
         (tenant_id, order_number, patient_uid, order_type, status,
          ordered_by, details, updated_at)
       VALUES ($1::uuid, $2::text, $3::uuid, 'medication', 'ordered',
               $4::uuid, $5::jsonb, NOW())
       RETURNING id`,
      TENANT_ID,
      `MAR-CONTRACT-${RUN}`,
      PATIENT_UID,
      NURSE_UID,
      JSON.stringify({ medication_name: MEDICATION_NAME, dose: '1 unit', route: 'oral' }),
    ))[0].id);

    const indent = await createWardIndent({
      wardId,
      patientUid: PATIENT_UID,
      indentType: 'pharmacy',
      items: [{
        pharmacy_catalog_id: catalogId,
        clinical_order_id: clinicalOrderId,
        item_name: MEDICATION_NAME,
        quantity_requested: 5,
      }],
      requestedBy: NURSE_UID,
      commandKey: `mar-contract-create-${RUN}`,
      tenantId: TENANT_ID,
    });
    const reserved = await reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACIST_UID,
      expectedVersion: 1,
      commandKey: `mar-contract-reserve-${RUN}`,
      tenantId: TENANT_ID,
    });
    const approved = await approveWardIndent({
      indentId: indent.id,
      approvedBy: PHARMACIST_UID,
      expectedVersion: reserved.state_version,
      commandKey: `mar-contract-approve-${RUN}`,
      tenantId: TENANT_ID,
    });
    const issued = await issueWardIndent({
      indentId: indent.id,
      issuedBy: PHARMACIST_UID,
      expectedVersion: approved.state_version,
      commandKey: `mar-contract-issue-${RUN}`,
      tenantId: TENANT_ID,
    });
    await receiveWardIndent({
      indentId: indent.id,
      receivedBy: NURSE_UID,
      expectedVersion: issued.state_version,
      commandKey: `mar-contract-receive-${RUN}`,
      tenantId: TENANT_ID,
    });

    // Schedule one dose per contract path against the same order-linked exact
    // ward custody. Slots are separated so the sibling-dose dedupe preserves all
    // five legitimate doses while still rejecting duplicate scheduling races.
    scheduled = await marService.scheduleMedications(
      PATIENT_UID,
      null,
      [
        { medication_name: MEDICATION_NAME, dose: '1 unit', route: 'oral', scheduled_time: minutesFromNow(5), clinical_order_id: clinicalOrderId, supply_quantity_per_dose: 1 },
        { medication_name: MEDICATION_NAME, dose: '1 unit', route: 'oral', scheduled_time: minutesFromNow(10), clinical_order_id: clinicalOrderId, supply_quantity_per_dose: 1 },
        { medication_name: MEDICATION_NAME, dose: '1 unit', route: 'oral', scheduled_time: minutesFromNow(15), clinical_order_id: clinicalOrderId, supply_quantity_per_dose: 1 },
        { medication_name: MEDICATION_NAME, dose: '1 unit', route: 'oral', scheduled_time: minutesFromNow(20), clinical_order_id: clinicalOrderId, supply_quantity_per_dose: 1 },
        { medication_name: MEDICATION_NAME, dose: '1 unit', route: 'oral', scheduled_time: minutesAgo(30), clinical_order_id: clinicalOrderId, supply_quantity_per_dose: 1 },
      ],
      ctx,
    );
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('clinical-order scheduling → array of MarRecord', () => {
    expect(scheduled).toHaveLength(5);
    for (const row of scheduled) assertData('MarRecord', wire(row));
    expect(scheduled.every((r) => r.status === 'scheduled')).toBe(true);
  });

  it('POST /mar/{id}/administer → MarRecord', async () => {
    const rec = await marService.recordAdministration(
      scheduled[1].id, NURSE_UID, 'Administered without incident', null,
      { overrideReason: 'Scanner offline — downtime manual entry', tenantId: TENANT_ID },
    );
    assertData('MarRecord', wire(rec));
    expect(rec.status).toBe('administered');
  });

  it('POST /mar/{id}/miss → MarRecord', async () => {
    const rec = await marService.recordMissed(
      scheduled[2].id,
      'Patient refused the dose',
      NURSE_UID,
      { tenantId: TENANT_ID },
    );
    assertData('MarRecord', wire(rec));
    expect(rec.status).toBe('missed');
  });

  it('POST /mar/{id}/hold → MarRecord', async () => {
    const rec = await marService.holdMedication(
      scheduled[3].id,
      'Awaiting senior review',
      NURSE_UID,
      { tenantId: TENANT_ID },
    );
    assertData('MarRecord', wire(rec));
    expect(rec.status).toBe('held');
  });

  it('GET /mar/patient/{patientUid} → array of MarRecord', async () => {
    const rows = await patientMarRowsForFixtureDay();
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) assertData('MarRecord', wire(row));
  });

  it('GET /mar/overdue → array of MarRecord', async () => {
    const rows = await marService.getOverdueMedications(null);
    expect(Array.isArray(rows)).toBe(true);
    for (const row of rows) assertData('MarRecord', wire(row));
    // The past-scheduled order-linked dose is overdue + still scheduled.
    expect(rows.some((r) => r.id === scheduled[4].id)).toBe(true);
  });

  it('GET /mar/due → array of MarDueItem', async () => {
    const rows = await marService.getDueMedications({ pastMinutes: 120, futureMinutes: 60 });
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) assertData('MarDueItem', wire(row));
  });

  it('POST /mar/verify → MarVerifyResult (5-rights dry run, all pass)', async () => {
    const result = await marFiveRights.evaluate5Rights({
      ma_id: scheduled[0].id,
      scanned_patient_uid: PATIENT_UID,
      scanned_barcode: MEDICATION_NAME,
      tenantId: TENANT_ID,
    });
    assertData('MarVerifyResult', wire(result));
    expect(result.allPassed).toBe(true);
    expect(result.rights).toEqual({ patient: true, drug: true, dose: true, route: true, time: true });
  });

  it('POST /mar/{id}/administer-with-scan → MarRecord', async () => {
    const rec = await marFiveRights.administerWithScan({
      ma_id: scheduled[0].id,
      scanned_patient_uid: PATIENT_UID,
      scanned_barcode: MEDICATION_NAME,
      administeredBy: NURSE_UID,
      tenantId: TENANT_ID,
    });
    assertData('MarRecord', wire(rec));
    expect(rec.status).toBe('administered');
    expect(rec.all_rights_passed).toBe(true);
  });
});
