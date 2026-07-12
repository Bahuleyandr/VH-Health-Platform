// C-2 (audit 2026-06-18) — clinical-safety: retire the legacy bedService
// admit/discharge bypass.
//
// These deep tests exercise the SERVICE path that the bed-board controller
// (bedController.admitPatient / dischargePatient) routes to. The legacy bypass:
//   - admit: unlocked SELECT + conditional UPDATE that occupied a bed with
//     patient_uid / admission_id NULL, no admissions row, no bed_transfers,
//     no canonical timeline/audit event;
//   - discharge: flipped the bed straight to 'available' (skipping the
//     mandatory 'cleaning' turnover — an infection-control bypass), closed no
//     admission, wrote no canonical event, started no cleaning ticket.
//
// We prove the hardened behaviour directly against bedService:
//   * admit -> real admission + full bed back-links + bed_transfers +
//     canonical admission.created (timeline + audit) in one transaction;
//   * discharge -> bed to 'cleaning', admission closed, canonical
//     discharge.completed timeline + audit event.
//
// Self-isolating fixtures (unique phone, unique uid, cleaned before + after).

import prisma from '../lib/prisma.js';
import bedService from '../services/bed/bedService.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'a9999999-9999-4999-8999-999999990c01';
const PATIENT_PHONE = '9000099001';
const DISCHARGER_UID = 'a9999999-9999-4999-8999-999999990c02';
const WARD_NAME = 'BED-C2-WARD';

async function cleanup() {
  await prisma.$executeRawUnsafe(`DELETE FROM bed_transfers WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM beds WHERE bed_number LIKE 'BD-C2-%'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM wards WHERE name = $1`, WARD_NAME).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
    PATIENT_UID, DISCHARGER_UID,
  ).catch(() => {});
}

async function timelineEvents(eventType) {
  return prisma.$queryRawUnsafe(
    `SELECT id, event_type, source_table, source_id
       FROM clinical_timeline_events
      WHERE patient_uid = $1::uuid AND event_type = $2`,
    PATIENT_UID, eventType,
  );
}
async function auditEvents(action) {
  return prisma.$queryRawUnsafe(
    `SELECT id, action FROM clinical_audit_events
      WHERE patient_uid = $1::uuid AND action = $2`,
    PATIENT_UID, action,
  );
}

describe('C-2 bedService admit/discharge — no bypass (deep)', () => {
  let patientId;
  let wardId;
  let bedId;

  beforeAll(async () => {
    await cleanup();
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'C2 Bed Patient', 'PATIENT', true, $3::uuid, NOW())
       RETURNING id`,
      PATIENT_UID, PATIENT_PHONE, TENANT_ID,
    );
    patientId = p[0].id;
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'C2 Discharger', 'NURSING_STAFF', true, $3::uuid, NOW())`,
      DISCHARGER_UID, '9000099002', TENANT_ID,
    );
    const w = await prisma.$queryRawUnsafe(
      `INSERT INTO wards (name, floor, total_beds) VALUES ($1, 1, 2) RETURNING id`,
      WARD_NAME,
    );
    wardId = w[0].id;
    const b = await prisma.$queryRawUnsafe(
      `INSERT INTO beds (ward_id, ward_name, bed_number, bed_type, status, tenant_id)
       VALUES ($1, $2, 'BD-C2-001', 'general', 'available', $3::uuid)
       RETURNING id`,
      wardId, WARD_NAME, TENANT_ID,
    );
    bedId = b[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('admit creates a real admission + full bed back-links + bed_transfers + canonical event (atomic)', async () => {
    const bed = await bedService.admitPatient(
      bedId,
      { patient_id: patientId, patient_name: 'C2 Bed Patient', notes: 'chest pain' },
      'DOCTOR',
      { tenantId: TENANT_ID, actorUid: DISCHARGER_UID },
    );

    // Bed is fully populated — NOT the half-populated legacy row.
    expect(bed.status).toBe('occupied');
    expect(String(bed.patient_uid)).toBe(PATIENT_UID);
    expect(bed.admission_id).toBeTruthy();
    expect(Number(bed.patient_id)).toBe(Number(patientId));

    // Admission row exists and is active, linked to the bed.
    const adm = await prisma.$queryRawUnsafe(
      `SELECT id, status, bed_id, bed_number FROM admissions
        WHERE patient_uid = $1::uuid AND status = 'admitted'`,
      PATIENT_UID,
    );
    expect(adm).toHaveLength(1);
    expect(Number(adm[0].bed_id)).toBe(Number(bedId));

    // bed_transfers admission audit row.
    const xfer = await prisma.$queryRawUnsafe(
      `SELECT id, reason, from_bed_id, to_bed_id, transferred_by FROM bed_transfers
        WHERE patient_uid = $1::uuid AND reason = 'Admission'`,
      PATIENT_UID,
    );
    expect(xfer).toHaveLength(1);
    expect(xfer[0].from_bed_id).toBeNull();
    expect(Number(xfer[0].to_bed_id)).toBe(Number(bedId));
    expect(String(xfer[0].transferred_by)).toBe(DISCHARGER_UID);

    // Canonical admission.created timeline + audit events.
    const tl = await timelineEvents('admission.created');
    expect(tl.length).toBeGreaterThanOrEqual(1);
    const au = await auditEvents('admission.created');
    expect(au.length).toBeGreaterThanOrEqual(1);
  });

  it('saves occupied-bed notes with canonical actor attribution', async () => {
    const bed = await bedService.updateBedNotes(bedId, 'Observe overnight oxygen needs', {
      tenantId: TENANT_ID,
      actorUid: DISCHARGER_UID,
      actorRole: 'NURSING_STAFF',
    });
    expect(bed.notes).toBe('Observe overnight oxygen needs');

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT actor_uid FROM clinical_timeline_events
        WHERE patient_uid = $1::uuid AND event_type = 'bed.notes_updated'
          AND source_table = 'beds' AND source_id = $2`,
      PATIENT_UID, String(bedId),
    );
    const audit = await prisma.$queryRawUnsafe(
      `SELECT actor_uid FROM clinical_audit_events
        WHERE patient_uid = $1::uuid AND action = 'bed.notes_updated'
          AND resource_table = 'beds' AND resource_id = $2`,
      PATIENT_UID, String(bedId),
    );
    expect(timeline).toHaveLength(1);
    expect(audit).toHaveLength(1);
    expect(String(timeline[0].actor_uid)).toBe(DISCHARGER_UID);
    expect(String(audit[0].actor_uid)).toBe(DISCHARGER_UID);
  });

  it('admit rejects when no patient reference resolves (no half-populated bed)', async () => {
    // Fresh available bed.
    const b = await prisma.$queryRawUnsafe(
      `INSERT INTO beds (ward_id, ward_name, bed_number, bed_type, status, tenant_id)
       VALUES ($1, $2, 'BD-C2-NOPT', 'general', 'available', $3::uuid)
       RETURNING id`,
      wardId, WARD_NAME, TENANT_ID,
    );
    await expect(
      bedService.admitPatient(b[0].id, { patient_name: 'Nobody' }, 'DOCTOR', { tenantId: TENANT_ID }),
    ).rejects.toMatchObject({ statusCode: expect.any(Number) });
    const after = await prisma.$queryRawUnsafe(
      `SELECT status, admission_id, patient_uid FROM beds WHERE id = $1`, b[0].id,
    );
    expect(after[0].status).toBe('available');
    expect(after[0].admission_id).toBeNull();
    expect(after[0].patient_uid).toBeNull();
  });

  it('discharge sends bed to CLEANING (not available), closes the admission, writes canonical event', async () => {
    const bed = await bedService.dischargePatient(bedId, {
      tenantId: TENANT_ID,
      dischargedBy: DISCHARGER_UID,
    });

    // Infection-control turnover: cleaning, NOT available.
    expect(bed.status).toBe('cleaning');

    const bedRow = await prisma.$queryRawUnsafe(
      `SELECT status, patient_uid, admission_id FROM beds WHERE id = $1`, bedId,
    );
    expect(bedRow[0].status).toBe('cleaning');
    expect(bedRow[0].patient_uid).toBeNull();
    expect(bedRow[0].admission_id).toBeNull();

    // Admission closed — no open admission left behind.
    const open = await prisma.$queryRawUnsafe(
      `SELECT id FROM admissions WHERE patient_uid = $1::uuid AND status = 'admitted'`,
      PATIENT_UID,
    );
    expect(open).toHaveLength(0);
    const closed = await prisma.$queryRawUnsafe(
      `SELECT id, status, discharged_at FROM admissions WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );
    expect(closed).toHaveLength(1);
    expect(closed[0].status).toBe('discharged');
    expect(closed[0].discharged_at).toBeTruthy();

    // Canonical discharge.completed timeline + audit events.
    const tl = await timelineEvents('discharge.completed');
    expect(tl.length).toBeGreaterThanOrEqual(1);
    const au = await auditEvents('discharge.completed');
    expect(au.length).toBeGreaterThanOrEqual(1);
  });

  it('discharge of a non-occupied (now cleaning) bed is rejected', async () => {
    await expect(
      bedService.dischargePatient(bedId, { tenantId: TENANT_ID, dischargedBy: DISCHARGER_UID }),
    ).rejects.toMatchObject({ statusCode: expect.any(Number) });
  });
});
