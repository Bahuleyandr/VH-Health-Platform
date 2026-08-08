// Phase-3 deep-review fixes — admission/IPD paths, proven against a real DB:
//
//   1. Migration 640 partial unique = DB backstop for one-active-admission-
//      per-patient (the pre-flight check alone loses the concurrent-admit race).
//   2. Attendant passes auto-issued at admit are stamped with the ADMIT
//      TENANT (previously default-tenant, which RLS rejects for every other
//      tenant), and issuance runs in-tx with no swallowed catch.
//   3. issueReplacementAttendantPass actually issues (a stray bulk re-issue
//      call used to hit the (admission_id, pass_index) unique and poison the
//      tx, so every replacement failed).
//   4. Live discharge/transfer start the bed-keyed bed_cleaning_turnaround
//      SLA in the SAME tx as the bed→cleaning flip; a repeat turnover of the
//      same bed re-arms the closed clock; the bed-cleaning-dispatch-sweep
//      re-dispatches missing housekeeping tickets.

import { randomUUID } from 'crypto';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const prisma = (await import('../lib/prisma.js')).default;
const admissionService = (await import('../services/emr/admissionService.js')).default;
const ipdSupportService = (await import('../services/ipd/ipdSupportService.js')).default;
const { sweepMissingBedCleaningDispatches } = await import('../services/staff/housekeepingTaskDispatchService.js');
const { deleteWithAuditBypass } = await import('./helpers/auditBypass.js');

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const T2_TENANT_ID = randomUUID();
const T2_SLUG = `p3t2-${T2_TENANT_ID.slice(0, 8)}`;

const PATIENT_UID = randomUUID();
const T2_PATIENT_UID = randomUUID();
const DOCTOR_UID = randomUUID();
const T2_DOCTOR_UID = randomUUID();
const ADMIN_UID = randomUUID();
const RACE_PATIENT_UID = randomUUID();

const WARD_NAME = `P3-WARD-${randomUUID().slice(0, 6)}`;
const BED_A = `P3-BED-A-${randomUUID().slice(0, 6)}`;
const BED_B = `P3-BED-B-${randomUUID().slice(0, 6)}`;
const BED_T2 = `P3-BED-T2-${randomUUID().slice(0, 6)}`;

const ALL_PATIENT_UIDS = [PATIENT_UID, T2_PATIENT_UID, RACE_PATIENT_UID];

let wardId;
let bedAId;
let bedBId;
let bedT2Id;

function phone() {
  return `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
}

async function seedUser({ uid, role, tenantId = DEFAULT_TENANT_ID, name }) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
     VALUES ($1::uuid, $2, $3, $4, true, $5::uuid, NOW())`,
    uid, phone(), name, role, tenantId,
  );
}

async function bedSlaRows(bedId, tenantId = DEFAULT_TENANT_ID) {
  return prisma.$queryRawUnsafe(
    `SELECT id, status, completed_at FROM workflow_sla_instances
      WHERE tenant_id = $1::uuid AND rule_code = 'bed_cleaning_turnaround'
        AND source_table = 'beds' AND source_id = $2`,
    tenantId, String(bedId),
  );
}

async function cleanup() {
  const bedIds = [bedAId, bedBId, bedT2Id].filter(Boolean).map(String);
  if (bedIds.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances WHERE source_table = 'beds' AND source_id = ANY($1::text[])`,
      bedIds,
    ).catch(() => {});
    for (const id of bedIds) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM housekeeping_requests WHERE description LIKE '%bed_id=' || $1 || '.%'`,
        id,
      ).catch(() => {});
    }
  }
  for (const uid of ALL_PATIENT_UIDS) {
    await prisma.$executeRawUnsafe(`DELETE FROM attendant_passes WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM bed_transfers WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await deleteWithAuditBypass(
      prisma,
      `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`,
      uid,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM patient_encounters WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM patient_consents WHERE patient_uid = $1::uuid`, uid).catch(() => {});
  }
  await prisma.$executeRawUnsafe(`DELETE FROM beds WHERE bed_number IN ($1, $2, $3)`, BED_A, BED_B, BED_T2).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM wards WHERE name = $1`, WARD_NAME).catch(() => {});
  for (const uid of [...ALL_PATIENT_UIDS, DOCTOR_UID, T2_DOCTOR_UID, ADMIN_UID]) {
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, uid).catch(() => {});
  }
  // Admit-time staff notifications / outbox rows FK the fixture tenant.
  for (const table of ['notifications', 'notification_outbox', 'event_outbox', 'audit_logs']) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = $1::uuid`, T2_TENANT_ID).catch(() => {});
  }
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, T2_TENANT_ID).catch(() => {});
}

d('Phase-3 admission/IPD fixes (deep)', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, 'P3 Fixture Tenant')`,
      T2_TENANT_ID, T2_SLUG,
    );

    await seedUser({ uid: PATIENT_UID, role: 'PATIENT', name: 'P3 Patient' });
    await seedUser({ uid: RACE_PATIENT_UID, role: 'PATIENT', name: 'P3 Race Patient' });
    await seedUser({ uid: DOCTOR_UID, role: 'DOCTOR', name: 'P3 Doctor' });
    await seedUser({ uid: ADMIN_UID, role: 'ADMIN', name: 'P3 Admin' });
    await seedUser({ uid: T2_PATIENT_UID, role: 'PATIENT', tenantId: T2_TENANT_ID, name: 'P3 T2 Patient' });
    await seedUser({ uid: T2_DOCTOR_UID, role: 'DOCTOR', tenantId: T2_TENANT_ID, name: 'P3 T2 Doctor' });

    for (const [uid, tenantId] of [
      [PATIENT_UID, DEFAULT_TENANT_ID],
      [RACE_PATIENT_UID, DEFAULT_TENANT_ID],
      [T2_PATIENT_UID, T2_TENANT_ID],
    ]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO patient_consents (patient_uid, consent_type, granted, status, tenant_id)
         VALUES ($1::uuid, 'treatment', true, 'active', $2::uuid)`,
        uid, tenantId,
      );
    }

    const w = await prisma.$queryRawUnsafe(
      `INSERT INTO wards (name, floor, total_beds) VALUES ($1, 1, 3) RETURNING id`,
      WARD_NAME,
    );
    wardId = w[0].id;
    const mkBed = async (bedNumber, tenantId) => {
      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO beds (ward_id, ward_name, bed_number, bed_type, status, tenant_id)
         VALUES ($1, $2, $3, 'general', 'available', $4::uuid) RETURNING id`,
        wardId, WARD_NAME, bedNumber, tenantId,
      );
      return rows[0].id;
    };
    bedAId = await mkBed(BED_A, DEFAULT_TENANT_ID);
    bedBId = await mkBed(BED_B, DEFAULT_TENANT_ID);
    bedT2Id = await mkBed(BED_T2, T2_TENANT_ID);
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 120_000);

  // ── Finding 1: DB backstop for the double-active-admission race ────────────

  it('migration 640: a second active admission for the same patient violates ux_admissions_one_active_per_patient', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions (tenant_id, patient_uid, status, admitted_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'admitted', NOW(), NOW())`,
      DEFAULT_TENANT_ID, RACE_PATIENT_UID,
    );

    // Second active row — exactly what the pre-flight race would insert.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO admissions (tenant_id, patient_uid, status, admitted_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'transferred', NOW(), NOW())`,
        DEFAULT_TENANT_ID, RACE_PATIENT_UID,
      ),
    ).rejects.toThrow(/ux_admissions_one_active_per_patient/);

    // A discharged prior admission does not block a re-admission.
    await prisma.$executeRawUnsafe(
      `UPDATE admissions SET status = 'discharged', discharged_at = NOW() WHERE patient_uid = $1::uuid`,
      RACE_PATIENT_UID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions (tenant_id, patient_uid, status, admitted_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'admitted', NOW(), NOW())`,
      DEFAULT_TENANT_ID, RACE_PATIENT_UID,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM admissions WHERE patient_uid = $1::uuid`, RACE_PATIENT_UID,
    );
  }, 30_000);

  it('admitPatient returns a 409 conflict for a patient who already has an active admission', async () => {
    const first = await admissionService.admitPatient({
      patient_uid: PATIENT_UID,
      admitting_doctor: DOCTOR_UID,
      ward: WARD_NAME,
      bed_id: bedAId,
      chief_complaint: 'Deep-test admit',
      admission_type: 'elective',
      created_by: ADMIN_UID,
      tenant_id: DEFAULT_TENANT_ID,
    });
    expect(first.status).toBe('admitted');

    await expect(
      admissionService.admitPatient({
        patient_uid: PATIENT_UID,
        admitting_doctor: DOCTOR_UID,
        ward: WARD_NAME,
        bed_id: bedBId,
        chief_complaint: 'Second concurrent admit',
        admission_type: 'elective',
        created_by: ADMIN_UID,
        tenant_id: DEFAULT_TENANT_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  }, 60_000);

  // ── Finding 2: attendant passes issued in-tx with the admit tenant ─────────

  it('admit auto-issues 2 attendant passes stamped with the admitting tenant (default tenant)', async () => {
    const passes = await prisma.$queryRawUnsafe(
      `SELECT pass_index, tenant_id, status FROM attendant_passes
        WHERE patient_uid = $1::uuid ORDER BY pass_index`,
      PATIENT_UID,
    );
    expect(passes).toHaveLength(2);
    expect(passes.map((p) => p.pass_index)).toEqual([1, 2]);
    expect(passes.every((p) => p.tenant_id === DEFAULT_TENANT_ID)).toBe(true);
  }, 30_000);

  it('a NON-default-tenant admit succeeds and its passes carry that tenant, not the default', async () => {
    const admission = await admissionService.admitPatient({
      patient_uid: T2_PATIENT_UID,
      admitting_doctor: T2_DOCTOR_UID,
      ward: WARD_NAME,
      bed_id: bedT2Id,
      chief_complaint: 'T2 tenant admit',
      admission_type: 'elective',
      created_by: T2_DOCTOR_UID,
      tenant_id: T2_TENANT_ID,
    });
    expect(admission.tenant_id).toBe(T2_TENANT_ID);

    const passes = await prisma.$queryRawUnsafe(
      `SELECT pass_index, tenant_id FROM attendant_passes
        WHERE admission_id = $1 ORDER BY pass_index`,
      admission.id,
    );
    expect(passes).toHaveLength(2);
    expect(passes.every((p) => p.tenant_id === T2_TENANT_ID)).toBe(true);
  }, 60_000);

  // ── Finding 3: replacement attendant pass actually issues ──────────────────

  it('issueReplacementAttendantPass issues pass_index 3 after the auto-issued pair', async () => {
    const admissionRows = await prisma.$queryRawUnsafe(
      `SELECT id FROM admissions WHERE patient_uid = $1::uuid AND status = 'admitted'`,
      PATIENT_UID,
    );
    const admissionId = admissionRows[0].id;

    const replacement = await ipdSupportService.issueReplacementAttendantPass({
      admissionId,
      issuedBy: ADMIN_UID,
      wardId,
      wardName: WARD_NAME,
      notes: 'lost pass',
      tenantId: DEFAULT_TENANT_ID,
    });

    expect(replacement.pass_index).toBe(3);
    expect(replacement.admission_id).toBe(admissionId);
    expect(replacement.tenant_id).toBe(DEFAULT_TENANT_ID);
    expect(replacement.pass_number).toMatch(/^AP-\d{8}-\d{4}$/);
    expect(replacement.expires_at).toBeTruthy();
  }, 30_000);

  // ── Finding 4: bed-cleaning SLA atomic with the live discharge/transfer ────

  it('transferPatient starts an active bed-keyed cleaning SLA for the vacated bed in the transfer tx', async () => {
    await admissionService.transferPatient(
      (await prisma.$queryRawUnsafe(
        `SELECT id FROM admissions WHERE patient_uid = $1::uuid AND status = 'admitted'`,
        PATIENT_UID,
      ))[0].id,
      null,
      bedBId,
      'SLA test transfer',
      ADMIN_UID,
      { tenantId: DEFAULT_TENANT_ID },
    );

    const fromBed = await prisma.$queryRawUnsafe(`SELECT status FROM beds WHERE id = $1`, bedAId);
    expect(fromBed[0].status).toBe('cleaning');
    const sla = await bedSlaRows(bedAId);
    expect(sla).toHaveLength(1);
    expect(sla[0].status).toBe('active');
  }, 60_000);

  it('dischargePatient starts an active bed-keyed cleaning SLA in the discharge tx', async () => {
    const admissionId = (await prisma.$queryRawUnsafe(
      `SELECT id FROM admissions WHERE patient_uid = $1::uuid AND status = 'transferred'`,
      PATIENT_UID,
    ))[0].id;

    await admissionService.dischargePatient(
      admissionId,
      { discharge_type: 'lama' },
      ADMIN_UID,
      { tenantId: DEFAULT_TENANT_ID },
    );

    const bed = await prisma.$queryRawUnsafe(`SELECT status FROM beds WHERE id = $1`, bedBId);
    expect(bed[0].status).toBe('cleaning');
    const sla = await bedSlaRows(bedBId);
    expect(sla).toHaveLength(1);
    expect(sla[0].status).toBe('active');
  }, 60_000);

  it('a repeat turnover of the same bed re-arms the closed cleaning clock', async () => {
    // Close bed B's clock as markBedReady would, and free the bed.
    await prisma.$executeRawUnsafe(
      `UPDATE workflow_sla_instances
          SET status = 'completed', completed_at = NOW(), updated_at = NOW()
        WHERE tenant_id = $1::uuid AND rule_code = 'bed_cleaning_turnaround'
          AND source_table = 'beds' AND source_id = $2`,
      DEFAULT_TENANT_ID, String(bedBId),
    );
    await prisma.$executeRawUnsafe(
      `UPDATE beds SET status = 'available', updated_at = NOW() WHERE id = $1`, bedBId,
    );

    const readmit = await admissionService.admitPatient({
      patient_uid: PATIENT_UID,
      admitting_doctor: DOCTOR_UID,
      ward: WARD_NAME,
      bed_id: bedBId,
      chief_complaint: 'Re-admission for SLA re-arm test',
      admission_type: 'elective',
      created_by: ADMIN_UID,
      tenant_id: DEFAULT_TENANT_ID,
    });
    await admissionService.dischargePatient(
      readmit.id,
      { discharge_type: 'lama' },
      ADMIN_UID,
      { tenantId: DEFAULT_TENANT_ID },
    );

    const sla = await bedSlaRows(bedBId);
    expect(sla).toHaveLength(1); // one row per bed — re-armed, not duplicated
    expect(sla[0].status).toBe('active');
    expect(sla[0].completed_at).toBeNull();
  }, 60_000);

  it('bed-cleaning-dispatch-sweep re-dispatches a cleaning bed with no active housekeeping request', async () => {
    // Simulate a failed post-commit dispatch: cleaning bed, no request rows.
    await prisma.$executeRawUnsafe(
      `DELETE FROM housekeeping_requests WHERE description LIKE '%bed_id=' || $1 || '.%'`,
      String(bedBId),
    );

    const result = await sweepMissingBedCleaningDispatches({ tenantId: DEFAULT_TENANT_ID, limit: 200 });
    expect(result.scanned).toBeGreaterThanOrEqual(1);

    const requests = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM housekeeping_requests
        WHERE description LIKE '%bed_id=' || $1 || '.%'
          AND COALESCE(status, 'open') IN ('open', 'pending', 'assigned', 'in_progress')`,
      String(bedBId),
    );
    expect(requests.length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
