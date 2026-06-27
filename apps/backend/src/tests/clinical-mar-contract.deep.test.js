// OpenAPI Phase 5 — Canonical clinical MAR contract deep test. Proves the 9
// /api/v1/clinical/mar/* response schemas (scripts/openapi/schemas/clinicalMar.mjs)
// against REAL service returns on the QA DB. The MAR routes wrap each service
// payload in the uniform success() envelope (statically covered by the overlay's
// envelope/listEnvelope), so this asserts the INNER `data` payload of every op
// via assertData against the committed component schema — exercising the full
// lifecycle: schedule → administer / miss / hold → patient/overdue/due lists →
// 5-rights verify → administer-with-scan.
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
const { assertData } = await import('./helpers/assertSchema.js');

// The wire format Express produces (Date -> ISO string, BigInt -> number).
const wire = (o) => JSON.parse(JSON.stringify(o));

const TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const NURSE_UID = randomUUID();
const PATIENT_PHONE = `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const NURSE_PHONE = `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

const today = new Date().toISOString().split('T')[0];
const now = () => new Date().toISOString();
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

const ctx = { actorUid: NURSE_UID, actorRole: 'NURSING_STAFF', tenantId: TENANT_ID };

let scheduled = [];

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_administrations WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, NURSE_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_ID).catch(() => {});
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

    // Schedule a batch: one each for administer / miss / hold / verify+scan, plus
    // one in the past for the overdue list. barcode-friendly name on the scan row.
    scheduled = await marService.scheduleMedications(
      PATIENT_UID,
      null,
      [
        { medication_name: 'Paracetamol', dose: '500mg', route: 'oral', scheduled_time: now() },   // 0: verify + scan
        { medication_name: 'Amoxicillin', dose: '250mg', route: 'oral', scheduled_time: now() },   // 1: administer
        { medication_name: 'Ibuprofen', dose: '400mg', route: 'oral', scheduled_time: now() },     // 2: miss
        { medication_name: 'Aspirin', dose: '75mg', route: 'oral', scheduled_time: now() },        // 3: hold
        { medication_name: 'Metformin', dose: '500mg', route: 'oral', scheduled_time: minutesAgo(30) }, // 4: overdue
      ],
      ctx,
    );
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('POST /mar/schedule → array of MarRecord (201 path)', () => {
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
    const rec = await marService.recordMissed(scheduled[2].id, 'Patient refused the dose', NURSE_UID);
    assertData('MarRecord', wire(rec));
    expect(rec.status).toBe('missed');
  });

  it('POST /mar/{id}/hold → MarRecord', async () => {
    const rec = await marService.holdMedication(scheduled[3].id, 'Awaiting senior review', NURSE_UID);
    assertData('MarRecord', wire(rec));
    expect(rec.status).toBe('held');
  });

  it('GET /mar/patient/{patientUid} → array of MarRecord', async () => {
    const rows = await marService.getPatientMAR(PATIENT_UID, today);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) assertData('MarRecord', wire(row));
  });

  it('GET /mar/overdue → array of MarRecord', async () => {
    const rows = await marService.getOverdueMedications(null);
    expect(Array.isArray(rows)).toBe(true);
    for (const row of rows) assertData('MarRecord', wire(row));
    // The past-scheduled Metformin row is overdue + still scheduled.
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
      scanned_barcode: 'Paracetamol',
    });
    assertData('MarVerifyResult', wire(result));
    expect(result.allPassed).toBe(true);
    expect(result.rights).toEqual({ patient: true, drug: true, dose: true, route: true, time: true });
  });

  it('POST /mar/{id}/administer-with-scan → MarRecord', async () => {
    const rec = await marFiveRights.administerWithScan({
      ma_id: scheduled[0].id,
      scanned_patient_uid: PATIENT_UID,
      scanned_barcode: 'Paracetamol',
      administeredBy: NURSE_UID,
      tenantId: TENANT_ID,
    });
    assertData('MarRecord', wire(rec));
    expect(rec.status).toBe('administered');
    expect(rec.all_rights_passed).toBe(true);
  });
});
