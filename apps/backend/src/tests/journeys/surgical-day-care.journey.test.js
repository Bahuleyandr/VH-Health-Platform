// Journey: surgical-day-care (swarm journey #9) — deterministic in-CI replacement.
//
// A same-day surgical patient is registered, admitted to a day-care bed,
// taken through the operating theatre, and discharged the same day. Flow
// through the REAL API surface across roles:
//   1. Receptionist registers the day-care surgical walk-in (OPD appointment).
//   2. Admissions desk admits the (consented) patient to a day-care bed,
//      naming the operating surgeon (canonical: admission.created; bed →
//      occupied). RBAC: a non-clinical GENERAL role cannot admit.
//   3. Ward/pre-op nurse records pre-op vitals (canonical: vitals.recorded)
//      and completes the structured pre-op checklist on the surgical surface.
//   4. The OT case is scheduled on the theatre board (status 'scheduled'),
//      wired to the admission encounter.
//   5. The OT case runs the theatre state machine
//      scheduled → pre_op → in_progress → post_op → completed, gated by the
//      WHO time-out + finalized anaesthesia record + finalized intraop note +
//      correct instrument counts. State negative: SCHEDULED → IN_PROGRESS is
//      rejected (must go via pre_op).
//   6. The surgeon places a post-op order (canonical: order.created).
//   7. The patient is discharged the same day (admission → discharged, bed
//      released to cleaning). Terminal negative: a second discharge is blocked.
//   8. The patient's canonical timeline carries the day-care clinical events.
//
// Assertions: admit RBAC + day_care admission type, the OT case state machine
// (incl. an illegal-transition rejection), the admission discharge state
// machine + bed release, and the canonical clinical-timeline invariant on
// every clinical write.
//
// Deterministic: per-run fixtures (unique uid/phone/ward/department suffix);
// surgeon + nurse authorised by an explicit care-team grant AND the admitting
// relationship; OT readiness sub-records + the day-care discharge readiness
// prerequisites are seeded with the same authoritative shape the
// theatre-deep / admission-deep suites use, so the real theatre/discharge
// APIs are exercised end-to-end without time-of-day dependence.

import {
  describeJourney,
  roleClient,
  runSuffix,
  seedUser,
  seedDoctor,
  seedTreatmentConsent,
  seedWardWithBeds,
  grantCareTeam,
  assertCanonicalClinicalWrite,
  cleanupJourney,
  CANONICAL_EVENTS,
  DEFAULT_TENANT,
  prisma,
} from './_journeyHarness.js';

const RUN = runSuffix();
const ADMIN_UID = `b5000001-0000-4000-8000-${RUN.padStart(12, '0')}`;
const SURGEON_UID = `b5000002-0000-4000-8000-${RUN.padStart(12, '0')}`;
const ANESTHETIST_UID = `b5000003-0000-4000-8000-${RUN.padStart(12, '0')}`;
const NURSE_UID = `b5000004-0000-4000-8000-${RUN.padStart(12, '0')}`;
const PATIENT_UID = `b5000005-0000-4000-8000-${RUN.padStart(12, '0')}`;
const RECEPTIONIST_UID = `b5000006-0000-4000-8000-${RUN.padStart(12, '0')}`;
const WARD_NAME = `JDayCareWard-${RUN}`;
const BED_A = `JDC-BED-A-${RUN}`;
const DEPARTMENT = `JSurgicalDayCare-${RUN}`;
const PATIENT_PHONE = `96601${RUN}`;
const SURGEON_PHONE = `+9196602${RUN}`;
const ANESTHETIST_PHONE = `+9196603${RUN}`;
const NURSE_PHONE = `+9196604${RUN}`;
const RECEPTIONIST_PHONE = `96605${RUN}`;

describeJourney('Journey: surgical-day-care', () => {
  let receptionist;
  let admin;
  let surgeon;
  let anesthetist;
  let nurse;
  let general;

  let surgeonUserId;
  let patientId;
  let bedAId;
  let appointmentId;
  let admissionId;
  let admissionEncounterId;
  let otScheduleId;

  // Inline teardown for the per-journey fixtures the shared cleanupJourney
  // does not own (OT schedule + its child docs, and the day-care discharge
  // readiness prerequisites). Keyed by this run's patient/admission so it is
  // safe and isolated from sibling suites on the shared vhhealth_test DB.
  async function cleanupSurgicalExtras() {
    const swallow = (p) => p.catch(() => {});
    const otIds = await prisma
      .$queryRawUnsafe(`SELECT id FROM ot_schedules WHERE patient_uid = $1::uuid`, PATIENT_UID)
      .catch(() => []);
    const ids = otIds.map((r) => r.id);
    if (ids.length) {
      await swallow(prisma.$executeRawUnsafe(`DELETE FROM anesthesia_records WHERE ot_schedule_id = ANY($1::int[])`, ids));
      await swallow(prisma.$executeRawUnsafe(`DELETE FROM intraop_notes WHERE ot_schedule_id = ANY($1::int[])`, ids));
      await swallow(prisma.$executeRawUnsafe(`DELETE FROM postop_notes WHERE ot_schedule_id = ANY($1::int[])`, ids));
      await swallow(prisma.$executeRawUnsafe(`DELETE FROM preop_checklists WHERE ot_schedule_id = ANY($1::int[])`, ids));
      await swallow(prisma.$executeRawUnsafe(`DELETE FROM surgical_safety_checklists WHERE ot_schedule_id = ANY($1::int[])`, ids));
      await swallow(prisma.$executeRawUnsafe(`DELETE FROM ot_schedules WHERE id = ANY($1::int[])`, ids));
    }
    await swallow(prisma.$executeRawUnsafe(`DELETE FROM follow_up_plans WHERE patient_uid = $1::uuid`, PATIENT_UID));
    await swallow(prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE patient_uid = $1::uuid`, PATIENT_UID));
    if (admissionId) {
      await swallow(prisma.$executeRawUnsafe(`DELETE FROM discharge_consults WHERE admission_id = $1::int`, admissionId));
      await swallow(prisma.$executeRawUnsafe(
        `DELETE FROM housekeeping_requests WHERE description LIKE $1`,
        `%admission #${admissionId}%`,
      ));
    }
  }

  beforeAll(async () => {
    await cleanupSurgicalExtras();
    await cleanupJourney({
      patientUids: [PATIENT_UID],
      staffUids: [ADMIN_UID, SURGEON_UID, ANESTHETIST_UID, NURSE_UID, RECEPTIONIST_UID],
      phones: [PATIENT_PHONE, RECEPTIONIST_PHONE],
      departments: [DEPARTMENT],
      wardNames: [WARD_NAME],
      bedNumbers: [BED_A],
    });

    const adminRow = await seedUser({ uid: ADMIN_UID, phone: `+9196600${RUN}`, name: `Adm Officer ${RUN}`, role: 'ADMIN' });
    const surgeonProfile = await seedDoctor({
      uid: SURGEON_UID, phone: SURGEON_PHONE, name: `Dr Surgeon ${RUN}`, department: DEPARTMENT,
    });
    surgeonUserId = surgeonProfile.userId;
    const anesthRow = await seedUser({ uid: ANESTHETIST_UID, phone: ANESTHETIST_PHONE, name: `Dr Anaesth ${RUN}`, role: 'ANESTHETIST' });
    const nurseRow = await seedUser({ uid: NURSE_UID, phone: NURSE_PHONE, name: `OT Nurse ${RUN}`, role: 'NURSING_STAFF' });

    const patient = await seedUser({ uid: PATIENT_UID, phone: `+91${PATIENT_PHONE}`, name: `DayCare Patient ${RUN}`, role: 'PATIENT', gender: 'F' });
    patientId = patient.id;
    await seedTreatmentConsent(PATIENT_UID);

    const recep = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, $3, 'RECEPTIONIST', true, NOW()) RETURNING id`,
      RECEPTIONIST_UID, `+91${RECEPTIONIST_PHONE}`, `Reception ${RUN}`,
    );

    const ward = await seedWardWithBeds({ wardName: WARD_NAME, bedNumbers: [BED_A] });
    [bedAId] = ward.bedIds;
    // Day-care admissions must allocate a bed from the day_care pool
    // (admissionService bed-pool match, migration 171). The shared
    // seedWardWithBeds leaves bed_type NULL, so stamp this bed as day_care.
    await prisma.$executeRawUnsafe(
      `UPDATE beds SET bed_type = 'day_care' WHERE id = $1::int`, bedAId,
    );

    receptionist = roleClient('RECEPTIONIST', { uid: RECEPTIONIST_UID, id: recep[0].id });
    admin = roleClient('ADMIN', { uid: ADMIN_UID, id: adminRow.id });
    surgeon = roleClient('DOCTOR', { uid: SURGEON_UID, id: surgeonUserId, phone: SURGEON_PHONE });
    anesthetist = roleClient('ANESTHETIST', { uid: ANESTHETIST_UID, id: anesthRow.id, phone: ANESTHETIST_PHONE });
    nurse = roleClient('NURSING_STAFF', { uid: NURSE_UID, id: nurseRow.id, phone: NURSE_PHONE });
    general = roleClient('GENERAL', { uid: ADMIN_UID, id: adminRow.id });

    // The OT nurse needs a care-team relationship for the pre-op vitals write;
    // the operating surgeon gets an admission relationship from being the
    // admitting doctor (step 2). Belt-and-braces care-team grant for the
    // surgeon too so the post-op order guard resolves deterministically.
    await grantCareTeam({ patientUid: PATIENT_UID, staffUid: NURSE_UID, staffRole: 'NURSING_STAFF', memberName: `DayCare Patient ${RUN}` });
    await grantCareTeam({ patientUid: PATIENT_UID, staffUid: SURGEON_UID, staffRole: 'DOCTOR', memberName: `DayCare Patient ${RUN}` });
  });

  afterAll(async () => {
    await cleanupSurgicalExtras();
    await cleanupJourney({
      patientUids: [PATIENT_UID],
      staffUids: [ADMIN_UID, SURGEON_UID, ANESTHETIST_UID, NURSE_UID, RECEPTIONIST_UID],
      phones: [PATIENT_PHONE, RECEPTIONIST_PHONE],
      departments: [DEPARTMENT],
      wardNames: [WARD_NAME],
      bedNumbers: [BED_A],
    });
    await prisma.$disconnect().catch(() => {});
  });

  describe('Step 1 — receptionist registers the day-care surgical walk-in', () => {
    it('registers the patient + creates the OPD appointment, auto-assigning the surgeon', async () => {
      const res = await receptionist.post('/api/v1/appointments/walk-in').send({
        patient_name: `DayCare Patient ${RUN}`,
        patient_phone: PATIENT_PHONE,
        patient_gender: 'F',
        department: DEPARTMENT,
        reason: 'Pre-op review for planned day-care cataract surgery',
        visit_type: 'NEW',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeDefined();
      // Auto-assignment picks the only doctor (the surgeon) in this department.
      expect(res.body.data.doctor_id).toBe(surgeonUserId);

      appointmentId = res.body.data.id;
      // The walk-in registers against the patient we seeded (same phone).
      expect(res.body.data.patient_id).toBe(patientId);
    });
  });

  describe('Step 2 — admissions desk admits to a day-care bed', () => {
    it('forbids a non-clinical GENERAL role from admitting', async () => {
      const res = await general.post('/api/v1/emr/admit').send({ patient_uid: PATIENT_UID });
      expect(res.statusCode).toBe(403);
    });

    it('admits the consented patient as a day_care case and writes the canonical admission triple', async () => {
      const res = await admin.post('/api/v1/emr/admit').send({
        patient_uid: PATIENT_UID,
        admitting_doctor: SURGEON_UID,
        chief_complaint: 'Planned day-care cataract surgery, right eye',
        admitting_diagnosis: 'Senile cataract, right eye',
        admission_type: 'day_care',
        priority: 'routine',
        department: DEPARTMENT,
        bed_id: bedAId,
        room_category: 'day_care',
        code_status: 'full_code',
      });
      expect(res.statusCode).toBe(201);
      admissionId = res.body.data?.admission?.id;
      expect(admissionId).toBeDefined();
      admissionEncounterId = res.body.data?.admission?.encounter_id || null;

      // Persisted as a day_care admission occupying the seeded bed.
      const adm = await prisma.$queryRawUnsafe(
        `SELECT status, admission_type, bed_id FROM admissions WHERE id = $1`, admissionId);
      expect(adm[0].status).toBe('admitted');
      expect(adm[0].admission_type).toBe('day_care');

      const bed = await prisma.$queryRawUnsafe(`SELECT status FROM beds WHERE id = $1`, bedAId);
      expect(String(bed[0].status).toLowerCase()).toBe('occupied');

      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.admissionCreated, sourceId: admissionId, patientUid: PATIENT_UID,
      });
    });
  });

  describe('Step 3 — pre-op nurse records vitals + structured pre-op checklist', () => {
    it('records pre-op vitals and writes the canonical vitals triple', async () => {
      const res = await nurse.post('/api/v1/emr/vitals').send({
        patient_uid: PATIENT_UID,
        heart_rate: 74,
        systolic_bp: 126,
        diastolic_bp: 78,
        temperature: 36.6,
        spo2: 99,
        respiratory_rate: 15,
      });
      expect(res.statusCode).toBe(201);
      const vitalsId = res.body.data?.vitals?.id;
      expect(vitalsId).toBeTruthy();
      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.vitalsRecorded, sourceId: vitalsId, patientUid: PATIENT_UID,
      });
    });
  });

  describe('Step 4 — OT case scheduled on the theatre board', () => {
    it('schedules the surgery wired to the admission encounter (status scheduled)', async () => {
      const res = await admin.post('/api/v1/theatre/schedule').send({
        patient_uid: PATIENT_UID,
        encounter_id: admissionEncounterId, // UUID encounter accepted (stored null) — see scheduleSurgery
        surgeon: SURGEON_UID,
        anesthetist: ANESTHETIST_UID,
        procedure_name: 'Right eye cataract surgery (phacoemulsification + IOL)',
        procedure_code: 'right-eye-cataract',
        ot_room: `OT-DC-${RUN}`.slice(0, 20),
        scheduled_date: new Date().toISOString().slice(0, 10),
        scheduled_time: '10:00',
        estimated_duration: 45,
        blood_arranged: false,
        consent_obtained: true,
      });
      expect(res.statusCode).toBe(201);
      otScheduleId = res.body.data?.id;
      expect(otScheduleId).toBeDefined();
      expect(res.body.data.status).toBe('scheduled');
      expect(res.body.data.surgeon).toBe(SURGEON_UID);
    });

    it('lets the OT nurse complete the structured pre-op checklist', async () => {
      const res = await nurse.put(`/api/v1/surgical/preop/${otScheduleId}`).send({
        patient_uid: PATIENT_UID,
        consent_signed: true,
        npo_status_confirmed: true,
        site_marked: true,
        site_marked_by: NURSE_UID,
        allergies_reviewed: true,
        preop_labs_reviewed: true,
        patient_identity_verified: true,
        procedure_verified: true,
        anesthesia_consent: true,
        status: 'complete',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.completed_by).toBe(NURSE_UID);
    });
  });

  describe('Step 5 — OT case runs the theatre state machine', () => {
    it('rejects SCHEDULED → IN_PROGRESS (must go via pre_op)', async () => {
      const res = await admin.put(`/api/v1/theatre/${otScheduleId}/status`).send({ status: 'in_progress' });
      // Service throws AppError.invalidTransition — 400, or 500 if surfaced via next(err).
      expect([400, 500]).toContain(res.statusCode);
      const row = await prisma.$queryRawUnsafe(`SELECT status FROM ot_schedules WHERE id = $1`, otScheduleId);
      expect(row[0].status).toBe('scheduled');
    });

    it('advances scheduled → pre_op → in_progress after the WHO time-out', async () => {
      const preOp = await admin.put(`/api/v1/theatre/${otScheduleId}/status`).send({ status: 'pre_op' });
      expect(preOp.statusCode).toBe(200);
      expect(preOp.body.data.status).toBe('pre_op');

      // WHO surgical safety time-out, recorded + confirmed by the surgeon on
      // the surgical surface — gates the move into in_progress.
      const timeout = await surgeon.put(`/api/v1/surgical/safety/${otScheduleId}/time_out`).send({
        patient_uid: PATIENT_UID,
        all_items_confirmed: true,
        status: 'complete',
        items: [{ item: 'patient_procedure_site_confirmed', confirmed: true }],
        metadata: {
          scheduled_side: 'right',
          marked_side: 'right',
          patient_identity_verified: true,
          procedure_verified: true,
          antibiotic_prophylaxis_confirmed: true,
        },
      });
      expect(timeout.statusCode).toBe(200);
      expect(timeout.body.data.status).toBe('complete');

      const inProgress = await admin.put(`/api/v1/theatre/${otScheduleId}/status`).send({ status: 'in_progress' });
      expect(inProgress.statusCode).toBe(200);
      expect(inProgress.body.data.status).toBe('in_progress');
    });

    it('finalizes the intraop note + anaesthesia record, then closes the case post_op → completed', async () => {
      // Surgeon's intraop note (counts correct) — finalized + signed.
      const intraop = await surgeon.post('/api/v1/surgical/intraop').send({
        ot_schedule_id: otScheduleId,
        patient_uid: PATIENT_UID,
        procedure_performed: 'Right eye phacoemulsification with posterior-chamber IOL',
        sponge_count_correct: true,
        sharp_count_correct: true,
        instrument_count_correct: true,
      });
      expect(intraop.statusCode).toBe(201);
      const intraopId = intraop.body.data.id;
      expect(intraopId).toBeTruthy();
      const intraopSigned = await surgeon.patch(`/api/v1/surgical/intraop/${intraopId}/finalize`).send({});
      expect(intraopSigned.statusCode).toBe(200);
      expect(intraopSigned.body.data.status).toBe('finalized');

      // Anaesthetist's record — saved + finalized in one upsert.
      const anesth = await anesthetist.put(`/api/v1/surgical/anesthesia/${otScheduleId}`).send({
        patient_uid: PATIENT_UID,
        technique: 'mac',
        agents_used: [{ name: 'midazolam', dose: '2 mg', route: 'IV' }],
        status: 'finalized',
      });
      expect(anesth.statusCode).toBe(200);
      expect(anesth.body.data.status).toBe('finalized');

      // WHO surgical safety sign-out (the third phase) — the final
      // count/specimen/concerns read-aloud before the patient leaves the room.
      // The case-close gate (audit 2026-06-18 §3 fix #4) requires it complete
      // (or an authorized override) before post_op/completed.
      const signOut = await surgeon.put(`/api/v1/surgical/safety/${otScheduleId}/sign_out`).send({
        patient_uid: PATIENT_UID,
        all_items_confirmed: true,
        status: 'complete',
        items: [{ item: 'instrument_sponge_needle_counts_correct', confirmed: true }],
      });
      expect(signOut.statusCode).toBe(200);
      expect(signOut.body.data.status).toBe('complete');

      for (const target of ['post_op', 'completed']) {
        const res = await admin.put(`/api/v1/theatre/${otScheduleId}/status`).send({ status: target });
        expect(res.statusCode).toBe(200);
        expect(res.body.data.status).toBe(target);
      }
      const row = await prisma.$queryRawUnsafe(`SELECT status FROM ot_schedules WHERE id = $1`, otScheduleId);
      expect(row[0].status).toBe('completed');
    });
  });

  describe('Step 6 — surgeon places a post-op order', () => {
    it('creates a post-op medication order and writes the canonical order triple', async () => {
      const res = await surgeon.post('/api/v1/emr/orders').send({
        patient_uid: PATIENT_UID,
        order_type: 'medication',
        priority: 'routine',
        details: {
          drug_name: 'Moxifloxacin 0.5% eye drops',
          dose: '1 drop',
          route: 'topical (right eye)',
          frequency: 'QID',
          reason: 'Post-op infection prophylaxis',
        },
      });
      expect(res.statusCode).toBe(201);
      const order = res.body.data?.order || res.body.data;
      const orderId = order?.id;
      expect(orderId).toBeTruthy();
      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.orderCreated, sourceId: orderId, patientUid: PATIENT_UID,
      });
    });
  });

  describe('Step 7 — patient is discharged the same day', () => {
    it('discharges home (admission → discharged) and releases the bed', async () => {
      // Stage the day-care discharge readiness prerequisites the same way the
      // admission-deep happy-path does (authoritative recipe): the discharge
      // cascade markers, a finalized fully-paid invoice, an open POD1 follow-up,
      // and all opened discharge consults completed. The discharge itself then
      // goes through the real POST /:id/discharge API.
      await prisma.$executeRawUnsafe(
        `UPDATE admissions
            SET discharge_initiated_at = NOW(),
                summary_signed_at = NOW(),
                discharge_drugs_dispensed_at = NOW(),
                billing_closed_at = NOW()
          WHERE id = $1`,
        admissionId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO billing_invoices
           (patient_uid, admission_id, invoice_type, status,
            subtotal, total_amount, amount_paid, amount_due, issued_at)
         VALUES ($1::uuid, $2, 'IP', 'PAID', 1000, 1000, 1000, 0, NOW())`,
        PATIENT_UID, admissionId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO follow_up_plans
           (tenant_id, patient_uid, origin_kind, reason, status, due_at)
         VALUES ($1::uuid, $2::uuid, 'admission_discharge',
                 'POD1 review for day-care cataract surgery', 'open',
                 NOW() + INTERVAL '1 day')`,
        DEFAULT_TENANT, PATIENT_UID,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO discharge_consults
           (admission_id, patient_uid, consult_type, requested_at, requested_by,
            completed_at, completed_by, notes, tenant_id)
         SELECT $1::int, $2::uuid, consult_type, NOW(), $3::uuid,
                NOW(), $3::uuid, 'Completed for day-care discharge',
                $4::uuid
           FROM unnest(ARRAY['dietary', 'family_counselling', 'pharmacy', 'physiotherapy', 'billing']) AS consult_type
         ON CONFLICT (admission_id, consult_type)
         DO UPDATE SET completed_at = EXCLUDED.completed_at,
                       completed_by = EXCLUDED.completed_by,
                       notes = EXCLUDED.notes,
                       updated_at = NOW()`,
        admissionId, PATIENT_UID, ADMIN_UID, DEFAULT_TENANT,
      );

      const res = await admin.post(`/api/v1/emr/${admissionId}/discharge`).send({
        discharge_type: 'home',
        discharge_summary: { notes: 'Day-care cataract surgery uneventful; review POD1.' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data?.admission?.status).toBe('discharged');

      // Admission is discharged and the bed is released to housekeeping.
      const adm = await prisma.$queryRawUnsafe(
        `SELECT status, discharge_type, discharged_at FROM admissions WHERE id = $1`, admissionId);
      expect(adm[0].status).toBe('discharged');
      expect(adm[0].discharge_type).toBe('home');
      expect(adm[0].discharged_at).not.toBeNull();

      const bed = await prisma.$queryRawUnsafe(
        `SELECT status, patient_uid FROM beds WHERE id = $1`, bedAId);
      expect(String(bed[0].status).toLowerCase()).toBe('cleaning');
      expect(bed[0].patient_uid).toBeNull();

      const audits = await prisma.$queryRawUnsafe(
        `SELECT action FROM audit_logs WHERE resource_id = $1 AND action = 'DISCHARGE_PATIENT'`,
        String(admissionId));
      expect(audits.length).toBeGreaterThanOrEqual(1);
    });

    it('blocks a second discharge attempt (terminal state)', async () => {
      const res = await admin.post(`/api/v1/emr/${admissionId}/discharge`).send({
        discharge_type: 'home',
        discharge_summary: { notes: 'duplicate' },
      });
      expect([400, 409]).toContain(res.statusCode);
    });
  });

  describe('Step 8 — canonical patient timeline reflects the day-care episode', () => {
    it('carries the surgical day-care clinical events on the patient timeline', async () => {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT event_type FROM clinical_timeline_events WHERE patient_uid = $1::uuid`,
        PATIENT_UID);
      const types = rows.map((r) => r.event_type);
      expect(types).toEqual(expect.arrayContaining([
        'admission.created', 'vitals.recorded', 'order.created',
      ]));
    });
  });
});
