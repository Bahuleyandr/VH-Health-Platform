// Journey: dynamic-acute-abdomen (swarm journey #2) — deterministic in-CI replacement.
//
// An acute surgical abdomen walks in (or is brought in) to the ED, is triaged,
// assessed by the surgical on-call, worked up (labs + imaging), referred to the
// surgical team, and admitted for an emergency laparotomy. Flow through the REAL
// API surface across roles:
//   1. Receptionist registers an EMERGENCY walk-in (acute abdomen); this creates
//      the emergency_visits row (status 'arriving') + the ER appointment.
//   2. ED nurse moves the visit arriving → in_triage, sets the ESI priority, and
//      records a triage assessment on the ED surface.
//   3. ED nurse records triage vitals (canonical: vitals.recorded).
//   4. Visit advances in_triage → in_treatment; the surgeon writes the ED
//      assessment note (auto-creates the canonical encounter; canonical:
//      note.created).
//   5. Surgeon orders the workup — bloods (investigation) AND imaging
//      (order_type 'imaging' → radiology) — one canonical order.created each.
//   6. Surgeon raises a surgical referral (canonical: referral.requested); a
//      non-clinical role (lab staff) is refused (RBAC).
//   7. Admissions desk admits the consented patient under the surgeon to a ward
//      bed (canonical: admission.created; bed → occupied), then the ED visit
//      dispositions in_treatment → admitted.
//   8. The patient's canonical timeline reflects every clinical event written.
//
// Assertions: ER visit creation, the ED visit state machine (including an
// illegal-transition rejection), the canonical clinical-timeline invariant on
// every clinical write (vitals / note / orders / referral / admission), the
// referral + admit RBAC gates, and bed state change.
//
// Deterministic: every fixture id is namespaced per-run; the ER visit + patient
// come from the walk-in response (no time-of-day dependence); the surgeon +
// nurse are authorised via explicit care-team grants, and the admitting-doctor
// relationship is resolved automatically by the admit. Models on
// emergency-walk-in (ED registration/triage/state-machine) + walk-in-opd
// (doctor consult note + investigation order).

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
  uidForUserId,
  CANONICAL_EVENTS,
  DEFAULT_TENANT,
  prisma,
} from './_journeyHarness.js';

const RUN = runSuffix();
const SURGEON_UID = `b5000001-0000-4000-8000-${RUN.padStart(12, '0')}`;
const NURSE_UID = `b5000002-0000-4000-8000-${RUN.padStart(12, '0')}`;
const RECEPTIONIST_UID = `b5000003-0000-4000-8000-${RUN.padStart(12, '0')}`;
const ADMIN_UID = `b5000004-0000-4000-8000-${RUN.padStart(12, '0')}`;
const LAB_UID = `b5000005-0000-4000-8000-${RUN.padStart(12, '0')}`;
const DEPARTMENT = `JAcuteAbdomen-${RUN}`; // visit_type EMERGENCY drives the ER-visit path
const WARD_NAME = `JSurgWard-${RUN}`;
const BED_A = `JSBED-A-${RUN}`;
const PATIENT_PHONE = `96601${RUN}`;
const SURGEON_PHONE = `+9196602${RUN}`;
const NURSE_PHONE = `+9196603${RUN}`;
const RECEPTIONIST_PHONE = `96604${RUN}`;
const ADMIN_PHONE = `96605${RUN}`;
const LAB_PHONE = `+9196606${RUN}`;

// The referral service emits this canonical event (referralService.createReferral
// → recordCanonicalClinicalEvent), keyed to the `referrals` detail row — the
// same timeline+audit triple the harness asserts for vitals/notes/orders.
const REFERRAL_REQUESTED = { eventType: 'referral.requested', sourceTable: 'referrals' };

describeJourney('Journey: dynamic-acute-abdomen', () => {
  let receptionist;
  let surgeon;
  let nurse;
  let admin;
  let labClient;
  let surgeonUserId;

  let erVisitId;
  let appointmentId;
  let patientId;
  let patientUid;
  let bedAId;
  let admissionId;

  beforeAll(async () => {
    await cleanupJourney({
      staffUids: [SURGEON_UID, NURSE_UID, RECEPTIONIST_UID, ADMIN_UID, LAB_UID],
      phones: [PATIENT_PHONE, RECEPTIONIST_PHONE, ADMIN_PHONE],
      departments: [DEPARTMENT],
      wardNames: [WARD_NAME],
      bedNumbers: [BED_A],
    });

    const doc = await seedDoctor({
      uid: SURGEON_UID, phone: SURGEON_PHONE, name: `Dr Surgeon ${RUN}`,
      department: DEPARTMENT, specialty: 'General Surgery',
    });
    surgeonUserId = doc.userId;

    const nurseRow = await seedUser({
      uid: NURSE_UID, phone: NURSE_PHONE, name: `ED Nurse ${RUN}`, role: 'NURSING_STAFF',
    });
    const recepRow = await seedUser({
      uid: RECEPTIONIST_UID, phone: `+91${RECEPTIONIST_PHONE}`, name: `ED Reception ${RUN}`, role: 'RECEPTIONIST',
    });
    const adminRow = await seedUser({
      uid: ADMIN_UID, phone: `+91${ADMIN_PHONE}`, name: `Adm Officer ${RUN}`, role: 'ADMIN',
    });
    const labRow = await seedUser({
      uid: LAB_UID, phone: LAB_PHONE, name: `Lab Tech ${RUN}`, role: 'LAB_STAFF',
    });

    receptionist = roleClient('RECEPTIONIST', { uid: RECEPTIONIST_UID, id: recepRow.id });
    surgeon = roleClient('DOCTOR', { uid: SURGEON_UID, id: surgeonUserId, phone: SURGEON_PHONE });
    nurse = roleClient('NURSING_STAFF', { uid: NURSE_UID, id: nurseRow.id, phone: NURSE_PHONE });
    admin = roleClient('ADMIN', { uid: ADMIN_UID, id: adminRow.id });
    // Non-clinical role for the referral RBAC negative (Step 6).
    labClient = roleClient('LAB_STAFF', { uid: LAB_UID, id: labRow.id, phone: LAB_PHONE });

    await prisma.$executeRawUnsafe(
      `INSERT INTO tenant_ed_policies
         (tenant_id, canonical_triage_scale, active, reviewer_uid, reviewed_at,
          activated_by, activated_at, policy_version)
       VALUES ($1::uuid, 'esi', true, $2::uuid, NOW(), $2::uuid, NOW(), $3)
       ON CONFLICT (tenant_id) DO UPDATE SET
         canonical_triage_scale = EXCLUDED.canonical_triage_scale,
         active = EXCLUDED.active,
         reviewer_uid = EXCLUDED.reviewer_uid,
         reviewed_at = EXCLUDED.reviewed_at,
         activated_by = EXCLUDED.activated_by,
         activated_at = EXCLUDED.activated_at,
         policy_version = EXCLUDED.policy_version,
         updated_at = NOW()`,
      DEFAULT_TENANT,
      ADMIN_UID,
      `journey-ed-triage-${RUN}`,
    );

    const ward = await seedWardWithBeds({ wardName: WARD_NAME, bedNumbers: [BED_A] });
    [bedAId] = ward.bedIds;
  });

  afterAll(async () => {
    // referrals.patient_uid / referring_doctor are FKs to users.uid with
    // onDelete NoAction; cleanupJourney does not sweep `referrals`, so clear
    // them first or the user deletes below silently orphan.
    if (patientUid) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM referrals WHERE patient_uid = $1::uuid`, patientUid,
      ).catch(() => {});
    }
    await cleanupJourney({
      patientUids: [patientUid].filter(Boolean),
      staffUids: [SURGEON_UID, NURSE_UID, RECEPTIONIST_UID, ADMIN_UID, LAB_UID],
      phones: [PATIENT_PHONE, RECEPTIONIST_PHONE, ADMIN_PHONE],
      departments: [DEPARTMENT],
      wardNames: [WARD_NAME],
      bedNumbers: [BED_A],
    });
    await prisma.$disconnect().catch(() => {});
  });

  describe('Step 1 — receptionist registers the acute-abdomen emergency walk-in', () => {
    it('creates the ER visit for the surgical emergency', async () => {
      const res = await receptionist.post('/api/v1/appointments/walk-in').send({
        patient_name: `Acute Abdomen ${RUN}`,
        patient_phone: PATIENT_PHONE,
        patient_gender: 'M',
        department: DEPARTMENT,
        reason: 'Severe generalised abdominal pain, guarding — query perforation',
        visit_type: 'EMERGENCY',
        chief_complaint: 'Acute abdomen: peritonism, tachycardia',
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.er_visit_id).not.toBeNull();

      erVisitId = res.body.data.er_visit_id;
      appointmentId = res.body.data.id;
      patientId = res.body.data.patient_id;
      patientUid = await uidForUserId(patientId);
      expect(patientUid).toBeTruthy();

      const ev = await prisma.$queryRawUnsafe(
        `SELECT status, chief_complaint FROM emergency_visits WHERE id = $1`, erVisitId);
      expect(ev[0].status).toBe('arriving');
      expect(ev[0].chief_complaint).toMatch(/[Aa]cute abdomen|peritonism/);

      // A treatment consent so the (non-emergency-typed) admit in Step 7 isn't
      // blocked by the consent gate, and care-team grants so the surgeon +
      // nurse clinical writes + the surgeon's referral resolve deterministically.
      await seedTreatmentConsent(patientUid);
      await grantCareTeam({ patientUid, staffUid: SURGEON_UID, staffRole: 'DOCTOR', memberName: `Acute Abdomen ${RUN}` });
      await grantCareTeam({ patientUid, staffUid: NURSE_UID, staffRole: 'NURSING_STAFF', memberName: `Acute Abdomen ${RUN}` });
    });
  });

  describe('Step 2 — ED nurse triages', () => {
    it('rejects an illegal visit transition (arriving → discharged is not allowed)', async () => {
      const res = await nurse.patch(`/api/v1/ed/visits/${erVisitId}/transition`).send({
        next_status: 'discharged',
      });
      expect(res.statusCode).toBe(400);
      expect(String(res.body.code || res.body.message || '')).toMatch(/transition|invalid/i);
    });

    it('moves the visit arriving → in_triage', async () => {
      const res = await nurse.patch(`/api/v1/ed/visits/${erVisitId}/transition`).send({
        next_status: 'in_triage',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('in_triage');
    });

    it('sets a high triage priority (queue effect)', async () => {
      const res = await nurse.patch(`/api/v1/ed/visits/${erVisitId}/triage-priority`).send({
        triage_priority: 'esi_2',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.triage_priority).toBe('esi_2');
    });

    it('records a triage assessment on the ED surface', async () => {
      const res = await nurse.post('/api/v1/ed/triage-assessments').send({
        emergency_visit_id: erVisitId,
        patient_uid: patientUid,
        assessment_kind: 'esi',
        level: 2,
        presenting_complaint: 'Acute abdomen with peritonism',
        pain_score: 9,
        circulation_concern: true,
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.data.id).toBeTruthy();
    });
  });

  describe('Step 3 — ED nurse records triage vitals', () => {
    it('records vitals and writes the canonical vitals triple', async () => {
      const res = await nurse.post('/api/v1/emr/vitals').send({
        patient_uid: patientUid,
        triage_acuity: 2,
        heart_rate: 116,
        systolic_bp: 104,
        diastolic_bp: 66,
        temperature: 38.6,
        spo2: 96,
        respiratory_rate: 24,
        pain_score: 9,
      });
      expect(res.statusCode).toBe(201);
      const vitalsId = res.body.data?.vitals?.id;
      expect(vitalsId).toBeTruthy();
      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.vitalsRecorded, sourceId: vitalsId, patientUid,
      });
    });
  });

  describe('Step 4 — surgeon assesses the patient', () => {
    it('advances in_triage → in_treatment', async () => {
      const res = await nurse.patch(`/api/v1/ed/visits/${erVisitId}/transition`).send({
        next_status: 'in_treatment',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('in_treatment');
    });

    it('surgeon writes the ED assessment note (auto-creates the encounter; canonical note.created)', async () => {
      // `er_note` is the first-class ED-encounter note type
      // (clinicalNotesService VALID_NOTE_TYPES); its required content fields
      // are chief_complaint / assessment / plan. Binding the note to the ER
      // walk-in's appointment_id is what auto-creates the canonical encounter
      // (clinicalNotesService → ensureEncounterForAppointment, migration 240):
      // the walk-in resolved this department's only active doctor — the
      // surgeon — onto appointments.doctor_id, so the assigned-clinician guard
      // (assertCanWriteAppointmentClinical) admits the surgeon's write.
      const res = await surgeon.post('/api/v1/emr/notes').send({
        patient_uid: patientUid,
        appointment_id: appointmentId,
        note_type: 'er_note',
        content: {
          chief_complaint: 'Acute generalised abdominal pain x 8h',
          history: 'Sudden-onset severe pain, vomiting, no flatus passed.',
          examination: 'Rigid abdomen, generalised guarding + rebound, absent bowel sounds.',
          assessment: 'Acute surgical abdomen — query perforated viscus / peritonitis.',
          plan: 'NBM, IV fluids, analgesia, bloods + erect CXR/CT, refer surgery, admit.',
        },
      });
      expect(res.statusCode).toBe(201);
      const noteId = res.body.data.id;
      expect(noteId).toBeTruthy();
      expect(res.body.data.note_type).toBe('er_note');

      // The note auto-creates the canonical encounter (migration 240 +
      // ensureEncounterForAppointment / ER-encounter linkage).
      const row = await prisma.$queryRawUnsafe(
        `SELECT encounter_id FROM clinical_notes WHERE id = $1::int`, noteId);
      expect(row[0].encounter_id).toMatch(/^[0-9a-f-]{36}$/i);

      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.noteCreated, sourceId: noteId, patientUid,
      });
    });
  });

  describe('Step 5 — surgeon orders the workup (labs + imaging)', () => {
    it('places a STAT bloods investigation order (canonical order.created)', async () => {
      const res = await surgeon.post('/api/v1/emr/orders').set('Idempotency-Key', `acute-abdomen-order-bloods-${Date.now()}`).send({
        patient_uid: patientUid,
        er_visit_id: erVisitId,
        order_type: 'investigation',
        priority: 'stat',
        details: {
          test_name: 'CBC, CRP, lipase, lactate, U&E, group & save',
          reason: 'Acute abdomen workup',
        },
      });
      expect(res.statusCode).toBe(201);
      const orderId = (res.body.data?.order || res.body.data)?.id;
      expect(orderId).toBeTruthy();
      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.orderCreated, sourceId: orderId, patientUid,
      });
    });

    it('places a STAT imaging order (imaging → radiology; canonical order.created)', async () => {
      const res = await surgeon.post('/api/v1/emr/orders').set('Idempotency-Key', `acute-abdomen-order-ct-${Date.now()}`).send({
        patient_uid: patientUid,
        er_visit_id: erVisitId,
        order_type: 'imaging',
        priority: 'stat',
        details: {
          test_name: 'CT abdomen/pelvis with contrast',
          reason: 'Query perforation / free air — surgical planning',
        },
      });
      expect(res.statusCode).toBe(201);
      const orderId = (res.body.data?.order || res.body.data)?.id;
      expect(orderId).toBeTruthy();
      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.orderCreated, sourceId: orderId, patientUid,
      });
    });
  });

  describe('Step 6 — surgeon raises a surgical referral', () => {
    it('refuses a non-clinical role (lab staff) from raising a referral (RBAC)', async () => {
      const res = await labClient.post('/api/v1/referrals').send({
        patient_uid: patientUid,
        referred_to_department: 'General Surgery',
        reason: 'Should fail — lab staff cannot refer',
      });
      expect(res.statusCode).toBe(403);
      expect(String(res.body.message || '')).toMatch(/doctor|referral/i);
    });

    it('surgeon raises the surgical referral and writes the canonical referral triple', async () => {
      const res = await surgeon.post('/api/v1/referrals').send({
        patient_uid: patientUid,
        // Exercise the canonical column name; the route also accepts to_department.
        referred_to_department: 'General Surgery',
        referral_type: 'internal',
        urgency: 'emergency',
        reason: 'Acute surgical abdomen for emergency laparotomy assessment',
        clinical_summary: 'Peritonitic abdomen, raised lactate, CT shows free intraperitoneal air.',
      });
      expect(res.statusCode).toBe(201);
      const referralId = res.body.data?.id;
      expect(referralId).toBeTruthy();
      expect(res.body.data.referred_to_department).toBe('General Surgery');

      const row = await prisma.$queryRawUnsafe(
        `SELECT status, urgency, patient_uid FROM referrals WHERE id = $1::int`, referralId);
      expect(row[0].status).toBe('pending');
      expect(String(row[0].patient_uid)).toBe(String(patientUid));

      await assertCanonicalClinicalWrite({
        event: REFERRAL_REQUESTED, sourceId: referralId, patientUid,
      });
    });
  });

  describe('Step 7 — admissions desk admits the patient under the surgeon', () => {
    it('admits the consented patient to a ward bed and writes the canonical admission triple', async () => {
      const res = await admin.post('/api/v1/emr/admit').send({
        patient_uid: patientUid,
        admitting_doctor: SURGEON_UID,
        chief_complaint: 'Acute surgical abdomen — peritonitis',
        admitting_diagnosis: 'Perforated viscus, for emergency laparotomy',
        admission_type: 'emergency',
        priority: 'urgent',
        department: DEPARTMENT,
        bed_id: bedAId,
        code_status: 'full_code',
      });
      expect(res.statusCode).toBe(201);
      admissionId = res.body.data?.admission?.id;
      expect(admissionId).toBeDefined();

      const bed = await prisma.$queryRawUnsafe(`SELECT status FROM beds WHERE id = $1`, bedAId);
      expect(String(bed[0].status).toLowerCase()).toBe('occupied');

      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.admissionCreated, sourceId: admissionId, patientUid,
      });
    });

    it('dispositions the ED visit in_treatment → admitted', async () => {
      const res = await surgeon.patch(`/api/v1/ed/visits/${erVisitId}/transition`).send({
        next_status: 'admitted',
        disposition: 'admitted_ward',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('admitted');

      const ev = await prisma.$queryRawUnsafe(
        `SELECT status FROM emergency_visits WHERE id = $1`, erVisitId);
      expect(ev[0].status).toBe('admitted');
    });
  });

  describe('Step 8 — canonical patient timeline reflects the surgical pathway', () => {
    it('carries every clinical event written across the acute-abdomen journey', async () => {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT event_type FROM clinical_timeline_events WHERE patient_uid = $1::uuid`,
        patientUid);
      const types = rows.map((r) => r.event_type);
      expect(types).toEqual(expect.arrayContaining([
        'vitals.recorded',
        'note.created',
        'order.created',
        'referral.requested',
        'admission.created',
      ]));
    });
  });
});
