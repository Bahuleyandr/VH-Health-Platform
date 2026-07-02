// Audit §3 (Clinical core & safety) — the bed-cleaning-turnaround SLA must START
// atomically with the discharge/transfer bed→cleaning flip. Previously the SLA
// was only created post-commit + best-effort inside createBedCleaningRequest
// (keyed to housekeeping_requests), so a swallowed dispatch failure could leave a
// bed in 'cleaning' with NO turnaround clock running.
//
// The fix anchors a bed_cleaning_turnaround workflow_sla_instance to the BED
// (source_table='beds', source_id=bedId) inside the discharge/transfer tx, and
// completes it inside markBedReady's tx.
//
// Proven against the real bedManagementService + real QA DB:
//   1. dischargePatient → bed='cleaning' AND an ACTIVE bed-keyed
//      bed_cleaning_turnaround SLA exists, in one tx.
//   2. A forced SLA-start failure ROLLS BACK the discharge (bed stays 'occupied',
//      admission stays open) — no half-discharge without a clock.
//   3. markBedReady completes the bed-keyed SLA.

import { jest } from '@jest/globals';
import { randomUUID } from 'crypto';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const ctl = { forceFailSla: false };
const actualCanonical = await import('../services/clinical/canonicalClinicalPlatformService.js');
jest.unstable_mockModule('../services/clinical/canonicalClinicalPlatformService.js', () => ({
  ...actualCanonical,
  startWorkflowSla: async (...args) => {
    if (ctl.forceFailSla) throw new Error('forced SLA start failure (test)');
    return actualCanonical.startWorkflowSla(...args);
  },
}));

const prisma = (await import('../lib/prisma.js')).default;
const bedService = (await import('../services/bed/bedManagementService.js')).default;
const { deleteWithAuditBypass } = await import('./helpers/auditBypass.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = randomUUID();
const DISCHARGER_UID = randomUUID();
const PATIENT_PHONE = `9000${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
const DISCHARGER_PHONE = `9000${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
const WARD_NAME = `BED-SLA-WARD-${randomUUID().slice(0, 6)}`;
const BED_NO = `BD-SLA-${randomUUID().slice(0, 6)}`;

let patientId;
let wardId;
let bedId;

async function bedSlaRows() {
  return prisma.$queryRawUnsafe(
    `SELECT id, status, source_table, source_id FROM workflow_sla_instances
      WHERE tenant_id = $1::uuid AND rule_code = 'bed_cleaning_turnaround'
        AND source_table = 'beds' AND source_id = $2`,
    TENANT_ID, String(bedId),
  );
}
async function bedRow() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT status, patient_uid, admission_id FROM beds WHERE id = $1`, bedId,
  );
  return rows[0];
}
async function openAdmissions() {
  return prisma.$queryRawUnsafe(
    `SELECT id FROM admissions WHERE patient_uid = $1::uuid AND status = 'admitted'`,
    PATIENT_UID,
  );
}

async function cleanupTxn() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM workflow_sla_instances WHERE source_table = 'beds' AND source_id = $1`,
    String(bedId || 0),
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM bed_transfers WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await deleteWithAuditBypass(
    prisma,
    `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
}

async function cleanupAll() {
  await cleanupTxn();
  await prisma.$executeRawUnsafe(`DELETE FROM beds WHERE bed_number = $1`, BED_NO).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM wards WHERE name = $1`, WARD_NAME).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DISCHARGER_UID,
  ).catch(() => {});
}

// Re-admit the patient to the bed so each test starts from an occupied bed +
// open admission. (dischargePatient consumes that state.)
async function admitFresh() {
  await cleanupTxn();
  await prisma.$executeRawUnsafe(
    `UPDATE beds SET status='occupied', patient_id=$2, patient_uid=$3::uuid, admitted_at=NOW(), updated_at=NOW()
      WHERE id = $1`,
    bedId, patientId, PATIENT_UID,
  );
  const adm = await prisma.$queryRawUnsafe(
    `INSERT INTO admissions (tenant_id, patient_uid, bed_id, bed_number, ward, status, admitted_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'admitted', NOW(), NOW())
     RETURNING id`,
    TENANT_ID, PATIENT_UID, bedId, BED_NO, WARD_NAME,
  );
  return adm[0].id;
}

d('Bed cleaning-turnaround SLA atomicity (audit §3)', () => {
  beforeAll(async () => {
    await cleanupAll();
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Bed SLA Patient', 'PATIENT', true, $3::uuid, NOW())
       RETURNING id`,
      PATIENT_UID, PATIENT_PHONE, TENANT_ID,
    );
    patientId = p[0].id;
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Bed SLA Discharger', 'NURSING_STAFF', true, $3::uuid, NOW())`,
      DISCHARGER_UID, DISCHARGER_PHONE, TENANT_ID,
    );
    const w = await prisma.$queryRawUnsafe(
      `INSERT INTO wards (name, floor, total_beds) VALUES ($1, 1, 1) RETURNING id`, WARD_NAME,
    );
    wardId = w[0].id;
    const b = await prisma.$queryRawUnsafe(
      `INSERT INTO beds (ward_id, ward_name, bed_number, bed_type, status, tenant_id)
       VALUES ($1, $2, $3, 'general', 'available', $4::uuid) RETURNING id`,
      wardId, WARD_NAME, BED_NO, TENANT_ID,
    );
    bedId = b[0].id;
  }, 60_000);

  afterEach(() => { ctl.forceFailSla = false; });

  afterAll(async () => {
    await cleanupAll();
    await prisma.$disconnect().catch(() => {});
  });

  it('dischargePatient flips bed→cleaning AND starts an active bed-keyed cleaning SLA in one tx', async () => {
    await admitFresh();

    const updated = await bedService.dischargePatient(bedId, DISCHARGER_UID, { tenantId: TENANT_ID });
    expect(updated.status).toBe('cleaning');

    const bed = await bedRow();
    expect(bed.status).toBe('cleaning');

    const sla = await bedSlaRows();
    expect(sla).toHaveLength(1);
    expect(sla[0].status).toBe('active');
  }, 30_000);

  it('rolls back the discharge when the cleaning-SLA start fails (bed stays occupied, admission stays open)', async () => {
    await admitFresh();

    ctl.forceFailSla = true;
    await expect(
      bedService.dischargePatient(bedId, DISCHARGER_UID, { tenantId: TENANT_ID }),
    ).rejects.toThrow(/forced SLA start failure/);

    // Atomic rollback: the bed must NOT have flipped to cleaning, the admission
    // must still be open, and no orphan SLA row may exist.
    const bed = await bedRow();
    expect(bed.status).toBe('occupied');
    expect(String(bed.patient_uid)).toBe(PATIENT_UID);
    expect((await openAdmissions()).length).toBe(1);
    expect(await bedSlaRows()).toHaveLength(0);
  }, 30_000);

  it('markBedReady completes the bed-keyed cleaning SLA', async () => {
    await admitFresh();
    await bedService.dischargePatient(bedId, DISCHARGER_UID, { tenantId: TENANT_ID });
    expect((await bedSlaRows())[0].status).toBe('active');

    await bedService.markBedReady(bedId, {
      actorUid: DISCHARGER_UID,
      cleanerId: DISCHARGER_UID, // direct attestation clears the proof-of-cleaning gate
      tenantId: TENANT_ID,
    });

    const bed = await bedRow();
    expect(bed.status).toBe('available');
    const sla = await bedSlaRows();
    expect(sla).toHaveLength(1);
    expect(['completed', 'breached']).toContain(sla[0].status); // clock closed
  }, 30_000);
});
