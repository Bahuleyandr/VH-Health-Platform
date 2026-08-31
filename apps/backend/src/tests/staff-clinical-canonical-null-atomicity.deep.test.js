// Fault injection through the real tenant transaction: when the canonical
// timeline INSERT returns no row, recordCanonicalClinicalEvent must reject and
// the staff-facing clinical detail mutation must roll back with it.

import { createHash, randomUUID } from 'crypto';
import { jest } from '@jest/globals';

const emptyActiveTherapySha256 = createHash('sha256')
  .update(JSON.stringify({ evidence: [], blockers: [] }))
  .digest('hex');

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const ctl = { nullCanonicalTimeline: false, beforeTenantTx: null };

const actualPrismaModule = await import('../lib/prisma.js');

function canonicalFaultProxy(tx) {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === '$queryRawUnsafe') {
        return async (sql, ...params) => {
          if (ctl.nullCanonicalTimeline && /INSERT\s+INTO\s+clinical_timeline_events/i.test(String(sql))) {
            return [];
          }
          return target.$queryRawUnsafe(sql, ...params);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

jest.unstable_mockModule('../lib/prisma.js', () => ({
  ...actualPrismaModule,
  setTenantTx: async (tenantId, fn, options) => {
    if (ctl.beforeTenantTx) {
      const hook = ctl.beforeTenantTx;
      ctl.beforeTenantTx = null;
      await hook();
    }
    return actualPrismaModule.setTenantTx(
      tenantId,
      (tx) => fn(canonicalFaultProxy(tx)),
      options,
    );
  },
}));

// pharmacistVerificationService imports the active-therapy authority from this
// module, so the substitute has to carry it on both surfaces. Like the safety
// verdict above it is neutralised rather than exercised: the genuine
// empty-snapshot digest with no blockers keeps the caller's fail-closed
// reconciliation gate open, leaving the canonical-null fault the only failure
// this suite injects.
const loadActiveTherapySnapshotStub = () => jest.fn(async () => ({
  medications: [],
  evidence: [],
  blockers: [],
  sha256: emptyActiveTherapySha256,
}));

jest.unstable_mockModule('../utils/clinical/prescriptionSafetyCheck.js', () => ({
  checkAntithromboticInteractions: jest.fn(() => []),
  loadActiveTherapySnapshot: loadActiveTherapySnapshotStub(),
  validatePrescriptionSafety: jest.fn(async () => ({
    safe: true,
    blockers: [],
    warnings: [],
    reviews: [],
  })),
  default: {
    checkAntithromboticInteractions: jest.fn(() => []),
    loadActiveTherapySnapshot: loadActiveTherapySnapshotStub(),
    validatePrescriptionSafety: jest.fn(async () => ({
      safe: true,
      blockers: [],
      warnings: [],
      reviews: [],
    })),
  },
}));

jest.unstable_mockModule('../utils/r2Storage.js', () => ({
  uploadFileToR2: jest.fn(async () => ({ ok: true })),
  getSignedFileUrl: jest.fn(async () => 'https://example.invalid/prescription.pdf'),
}));
jest.unstable_mockModule('../utils/notifications/notificationDispatcher.js', () => ({
  dispatch: jest.fn(async () => ({ ok: true })),
}));
jest.unstable_mockModule('../services/maternity/maternityService.js', () => ({
  maybePropagateAncSupplements: jest.fn(async () => null),
}));
jest.unstable_mockModule('../services/patient/medicationReminderService.js', () => ({
  createPrescriptionReminders: jest.fn(async () => []),
}));
jest.unstable_mockModule('../utils/logAudit.js', () => ({
  logAudit: jest.fn(async () => null),
}));

const prisma = (await import('../lib/prisma.js')).default;
const {
  createPrescription,
  signPrescription,
  updatePrescription,
} = await import('../controllers/prescription/ePrescriptionController.js');
const {
  addDiagnosis,
  updateDiagnosisStatus,
} = await import('../services/emr/diagnosisService.js');
const referralService = (await import('../services/referral/referralService.js')).default;
const { correctVitals } = await import('../services/emr/vitalsChartService.js');
const admissionService = (await import('../services/emr/admissionService.js')).default;
const { deleteWithAuditBypass } = await import('./helpers/auditBypass.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = randomUUID();
const DOCTOR_UID = randomUUID();
const PATIENT_PHONE = `4${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
const DOCTOR_PHONE = `3${PATIENT_PHONE.slice(1)}`;

let patientId;
let doctorId;
let prescriptionId;

function makeReqRes(body = {}, params = {}) {
  const req = {
    body,
    params,
    user: { id: doctorId, uid: DOCTOR_UID, role: 'DOCTOR' },
    tenantId: TENANT_ID,
    protocol: 'https',
    get: () => 'vh.test',
  };
  const res = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
  return { req, res };
}

async function seedReferral({ status = 'pending', firstSeenAt = null } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO referrals
       (tenant_id, referral_number, patient_uid, referring_doctor,
        referred_to_doctor, referred_to_department, referral_type, reason,
        urgency, priority, status, requester_id, performer_id,
        first_seen_at, first_seen_by, source, created_at, updated_at)
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $4::uuid, 'Cardiology',
             'internal', 'Canonical null transition proof', 'routine', 'ROUTINE',
             $5, $4::uuid, $4::uuid, $6, NULL, 'ward', NOW(), NOW())
     RETURNING id`,
    TENANT_ID,
    `REF-NULL-${randomUUID().slice(0, 12)}`,
    PATIENT_UID,
    DOCTOR_UID,
    status,
    firstSeenAt,
  );
  return rows[0].id;
}

async function referralState(id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT status, accepted_at, completed_at, response_notes, first_seen_at
       FROM referrals WHERE id = $1`,
    id,
  );
  return rows[0];
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM workflow_sla_instances WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
    TENANT_ID,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM prescription_safety_overrides WHERE prescription_id IN
       (SELECT id FROM e_prescriptions WHERE patient_uid = $1::uuid)`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_safety_reviews WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM e_prescriptions WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM discharge_consults WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM admissions WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_code_bindings WHERE resource_type = 'diagnosis'
       AND patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM diagnoses WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM referrals WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await deleteWithAuditBypass(
    prisma,
    `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
    PATIENT_UID,
    DOCTOR_UID,
  ).catch(() => {});
}

d('staff clinical writes roll back on canonical null results', () => {
  beforeAll(async () => {
    await cleanup();
    const patient = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Canonical Null Rx Patient', 'PATIENT', true, $3::uuid, NOW())
       RETURNING id`,
      PATIENT_UID,
      PATIENT_PHONE,
      TENANT_ID,
    );
    patientId = patient[0].id;
    const doctor = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Canonical Null Rx Doctor', 'DOCTOR', true, $3::uuid, NOW())
       RETURNING id`,
      DOCTOR_UID,
      DOCTOR_PHONE,
      TENANT_ID,
    );
    doctorId = doctor[0].id;
  });

  afterEach(() => {
    ctl.nullCanonicalTimeline = false;
    ctl.beforeTenantTx = null;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('rolls back e-prescription create, edit, and sign', async () => {
    ctl.nullCanonicalTimeline = true;
    const failedCreate = makeReqRes({
      patient_id: patientId,
      doctor_id: doctorId,
      diagnosis: 'Canonical null create',
      medications: [{ name: 'Paracetamol 500', dose: '1 tablet', frequency: 'OD' }],
    });
    await createPrescription(failedCreate.req, failedCreate.res);
    expect(failedCreate.res.statusCode).toBe(500);
    const failedCreates = await prisma.$queryRawUnsafe(
      `SELECT id FROM e_prescriptions WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );
    expect(failedCreates).toHaveLength(0);

    ctl.nullCanonicalTimeline = false;
    const created = makeReqRes({
      patient_id: patientId,
      doctor_id: doctorId,
      diagnosis: 'Canonical null edit and sign',
      medications: [{ name: 'Paracetamol 500', dose: '1 tablet', frequency: 'OD' }],
    });
    await createPrescription(created.req, created.res);
    expect(created.res.statusCode).toBe(201);
    prescriptionId = created.res.payload.data.id;

    ctl.nullCanonicalTimeline = true;
    const edit = makeReqRes({
      medications: [{ name: 'Paracetamol 650', dose: '1 tablet', frequency: 'BD' }],
    }, { id: String(prescriptionId) });
    await updatePrescription(edit.req, edit.res);
    expect(edit.res.statusCode).toBe(500);
    const afterEdit = await prisma.$queryRawUnsafe(
      `SELECT revision, medications FROM e_prescriptions WHERE id = $1`,
      prescriptionId,
    );
    expect(afterEdit[0].revision).toBe(1);
    expect(afterEdit[0].medications[0].name).toBe('Paracetamol 500');

    const sign = makeReqRes({}, { id: String(prescriptionId) });
    await signPrescription(sign.req, sign.res);
    expect(sign.res.statusCode).toBe(500);
    const afterSign = await prisma.$queryRawUnsafe(
      `SELECT lifecycle_status, signed_at, signed_by, locked_at, locked_by
         FROM e_prescriptions WHERE id = $1`,
      prescriptionId,
    );
    expect(afterSign[0].lifecycle_status).toBe('draft');
    expect(afterSign[0].signed_at).toBeNull();
    expect(afterSign[0].signed_by).toBeNull();
    expect(afterSign[0].locked_at).toBeNull();
    expect(afterSign[0].locked_by).toBeNull();

    ctl.nullCanonicalTimeline = false;
    const successfulEdit = makeReqRes({
      medications: [{ name: 'Paracetamol 650', dose: '1 tablet', frequency: 'BD' }],
    }, { id: String(prescriptionId) });
    await updatePrescription(successfulEdit.req, successfulEdit.res);
    expect(successfulEdit.res.statusCode).toBe(200);
    expect(successfulEdit.res.payload.data.revision).toBe(2);

    const successfulSign = makeReqRes({}, { id: String(prescriptionId) });
    await signPrescription(successfulSign.req, successfulSign.res);
    expect(successfulSign.res.statusCode).toBe(200);
    expect(successfulSign.res.payload.data.lifecycle_status).toBe('signed');
    expect(successfulSign.res.payload.data.signed_at).toBeTruthy();

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type, actor_uid, actor_role FROM clinical_timeline_events
        WHERE patient_uid = $1::uuid AND source_table = 'e_prescriptions'
          AND source_id = $2
        ORDER BY occurred_at`,
      PATIENT_UID,
      String(prescriptionId),
    );
    const audit = await prisma.$queryRawUnsafe(
      `SELECT action, actor_uid, actor_role FROM clinical_audit_events
        WHERE patient_uid = $1::uuid AND resource_table = 'e_prescriptions'
          AND resource_id = $2
        ORDER BY occurred_at`,
      PATIENT_UID,
      String(prescriptionId),
    );
    expect(timeline.map((row) => row.event_type)).toEqual([
      'prescription.created',
      'prescription.edited',
      'prescription.signed',
    ]);
    expect(audit.map((row) => row.action)).toEqual([
      'prescription.created',
      'prescription.edited',
      'prescription.signed',
    ]);
    expect(timeline.every((row) => String(row.actor_uid) === DOCTOR_UID && row.actor_role === 'DOCTOR')).toBe(true);
    expect(audit.every((row) => String(row.actor_uid) === DOCTOR_UID && row.actor_role === 'DOCTOR')).toBe(true);
  }, 30_000);

  it('rolls back diagnosis add and status changes', async () => {
    ctl.nullCanonicalTimeline = true;
    await expect(addDiagnosis({
      tenant_id: TENANT_ID,
      patient_uid: PATIENT_UID,
      description: 'Canonical null diagnosis',
      diagnosed_by: DOCTOR_UID,
      actor_role: 'DOCTOR',
    })).rejects.toMatchObject({ code: 'CANONICAL_TIMELINE_REQUIRED' });
    const failedAdds = await prisma.$queryRawUnsafe(
      `SELECT id FROM diagnoses WHERE patient_uid = $1::uuid
        AND description = 'Canonical null diagnosis'`,
      PATIENT_UID,
    );
    expect(failedAdds).toHaveLength(0);

    ctl.nullCanonicalTimeline = false;
    const diagnosisRows = await prisma.$queryRawUnsafe(
      `INSERT INTO diagnoses
         (tenant_id, patient_uid, description, diagnosis_type, status, diagnosed_by, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'Status rollback diagnosis', 'secondary', 'active', $3::uuid, NOW(), NOW())
       RETURNING id`,
      TENANT_ID,
      PATIENT_UID,
      DOCTOR_UID,
    );
    const diagnosisId = diagnosisRows[0].id;
    ctl.nullCanonicalTimeline = true;
    await expect(updateDiagnosisStatus(diagnosisId, 'resolved', null, DOCTOR_UID, {
      tenantId: TENANT_ID,
      actorRole: 'DOCTOR',
    })).rejects.toMatchObject({ code: 'CANONICAL_TIMELINE_REQUIRED' });
    const diagnosis = await prisma.$queryRawUnsafe(
      `SELECT status, resolved_date FROM diagnoses WHERE id = $1`,
      diagnosisId,
    );
    expect(diagnosis[0].status).toBe('active');
    expect(diagnosis[0].resolved_date).toBeNull();
  });

  it('does not edit or re-sign a prescription whose state changed after preflight', async () => {
    const seedDraft = async (label) => {
      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO e_prescriptions
           (tenant_id, patient_id, patient_uid, doctor_id, doctor_uid, diagnosis,
            medications, status, lifecycle_status, revision, created_by, updated_at)
         VALUES ($1::uuid, $2, $3::uuid, $4, $5::uuid, $6,
                 '[{"name":"Original medicine"}]'::jsonb,
                 'active', 'draft', 1, $4, NOW())
         RETURNING id`,
        TENANT_ID,
        patientId,
        PATIENT_UID,
        doctorId,
        DOCTOR_UID,
        label,
      );
      return rows[0].id;
    };

    const editId = await seedDraft('Edit race proof');
    ctl.beforeTenantTx = () => prisma.$executeRawUnsafe(
      `UPDATE e_prescriptions
          SET signed_at=NOW(), signed_by=$2::uuid, locked_at=NOW(), locked_by=$2::uuid,
              lifecycle_status='signed', updated_at=NOW()
        WHERE id=$1`,
      editId,
      DOCTOR_UID,
    );
    const edit = makeReqRes({
      medications: [{ name: 'Unsafe late edit' }],
    }, { id: String(editId) });
    await updatePrescription(edit.req, edit.res);
    expect(edit.res.statusCode).toBe(409);
    const afterEditRace = await prisma.$queryRawUnsafe(
      `SELECT lifecycle_status, revision, medications FROM e_prescriptions WHERE id=$1`,
      editId,
    );
    expect(afterEditRace[0].lifecycle_status).toBe('signed');
    expect(afterEditRace[0].revision).toBe(1);
    expect(afterEditRace[0].medications[0].name).toBe('Original medicine');

    const signId = await seedDraft('Sign race proof');
    ctl.beforeTenantTx = () => prisma.$executeRawUnsafe(
      `UPDATE e_prescriptions
          SET signed_at=NOW(), signed_by=$2::uuid, locked_at=NOW(), locked_by=$2::uuid,
              lifecycle_status='signed', updated_at=NOW()
        WHERE id=$1`,
      signId,
      DOCTOR_UID,
    );
    const sign = makeReqRes({}, { id: String(signId) });
    await signPrescription(sign.req, sign.res);
    expect(sign.res.statusCode).toBe(409);
    const afterSignRace = await prisma.$queryRawUnsafe(
      `SELECT lifecycle_status, signed_at, signed_by FROM e_prescriptions WHERE id=$1`,
      signId,
    );
    expect(afterSignRace[0].lifecycle_status).toBe('signed');
    expect(afterSignRace[0].signed_at).toBeTruthy();
    expect(String(afterSignRace[0].signed_by)).toBe(DOCTOR_UID);
  });

  it('rolls back referral accept, seen, complete, and decline transitions', async () => {
    ctl.nullCanonicalTimeline = true;

    const acceptId = await seedReferral();
    await expect(referralService.acceptReferral(acceptId, DOCTOR_UID, {
      actorRole: 'DOCTOR', tenantId: TENANT_ID,
    })).rejects.toMatchObject({ code: 'CANONICAL_TIMELINE_REQUIRED' });
    expect(await referralState(acceptId)).toMatchObject({ status: 'pending', accepted_at: null });

    const seenId = await seedReferral();
    await expect(referralService.markReferralSeen(seenId, DOCTOR_UID, {
      actorRole: 'DOCTOR', tenantId: TENANT_ID,
    })).rejects.toMatchObject({ code: 'CANONICAL_TIMELINE_REQUIRED' });
    expect((await referralState(seenId)).first_seen_at).toBeNull();

    const completeId = await seedReferral({ status: 'accepted' });
    await expect(referralService.completeReferral(completeId, 'Cardiology review complete', {
      actorUid: DOCTOR_UID, actorRole: 'DOCTOR', tenantId: TENANT_ID,
    })).rejects.toMatchObject({ code: 'CANONICAL_TIMELINE_REQUIRED' });
    expect(await referralState(completeId)).toMatchObject({
      status: 'accepted', completed_at: null, response_notes: null,
    });

    const declineId = await seedReferral();
    await expect(referralService.declineReferral(declineId, 'Service unavailable', {
      actorUid: DOCTOR_UID, actorRole: 'DOCTOR', tenantId: TENANT_ID,
    })).rejects.toMatchObject({ code: 'CANONICAL_TIMELINE_REQUIRED' });
    expect(await referralState(declineId)).toMatchObject({
      status: 'pending', response_notes: null,
    });
  });

  it('rolls back vitals correction and discharge work-item/dispense completion', async () => {
    const vitalRows = await prisma.$queryRawUnsafe(
      `INSERT INTO vitals_chart
         (tenant_id, patient_uid, heart_rate, recorded_by, recorded_at)
       VALUES ($1::uuid, $2::uuid, 80, $3::uuid, NOW())
       RETURNING id`,
      TENANT_ID,
      PATIENT_UID,
      DOCTOR_UID,
    );
    const vitalsId = vitalRows[0].id;
    ctl.nullCanonicalTimeline = true;
    await expect(correctVitals(vitalsId, {
      heart_rate: 92,
      corrected_by: DOCTOR_UID,
      actor_role: 'DOCTOR',
      tenantId: TENANT_ID,
    })).rejects.toMatchObject({ code: 'CANONICAL_TIMELINE_REQUIRED' });
    const vital = await prisma.$queryRawUnsafe(
      `SELECT heart_rate::text AS heart_rate FROM vitals_chart WHERE id = $1`,
      vitalsId,
    );
    expect(vital[0].heart_rate).toBe('80.00');

    ctl.nullCanonicalTimeline = false;
    const admissionRows = await prisma.$queryRawUnsafe(
      `INSERT INTO admissions
         (tenant_id, patient_uid, status, discharge_initiated_at,
          discharge_summary, admitted_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'admitted', NOW(),
               '{"medication_reconciliation":{"status":"complete"}}'::jsonb,
               NOW(), NOW())
       RETURNING id`,
      TENANT_ID,
      PATIENT_UID,
    );
    const admissionId = admissionRows[0].id;
    const consultRows = await prisma.$queryRawUnsafe(
      `INSERT INTO discharge_consults
         (tenant_id, admission_id, patient_uid, consult_type, requested_at, requested_by)
       VALUES ($1::uuid, $2, $3::uuid, 'family_counselling', NOW(), $4::uuid)
       RETURNING id`,
      TENANT_ID,
      admissionId,
      PATIENT_UID,
      DOCTOR_UID,
    );
    const consultId = consultRows[0].id;

    ctl.nullCanonicalTimeline = true;
    await expect(admissionService.completeDischargeConsult(
      admissionId,
      'family_counselling',
      DOCTOR_UID,
      'Family counselled about home care',
      { tenantId: TENANT_ID, role: 'COUNSELLOR' },
    )).rejects.toMatchObject({ code: 'CANONICAL_TIMELINE_REQUIRED' });
    const consult = await prisma.$queryRawUnsafe(
      `SELECT completed_at, completed_by, notes FROM discharge_consults WHERE id = $1`,
      consultId,
    );
    expect(consult[0].completed_at).toBeNull();
    expect(consult[0].completed_by).toBeNull();
    expect(consult[0].notes).toBeNull();

    await expect(admissionService.markDischargeDrugsDispensed(
      admissionId,
      DOCTOR_UID,
      { tenantId: TENANT_ID, actorRole: 'PHARMACY_STAFF' },
    )).rejects.toMatchObject({ code: 'CANONICAL_TIMELINE_REQUIRED' });
    const admission = await prisma.$queryRawUnsafe(
      `SELECT discharge_drugs_dispensed_at FROM admissions WHERE id = $1`,
      admissionId,
    );
    expect(admission[0].discharge_drugs_dispensed_at).toBeNull();
  });
});
