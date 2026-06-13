// Journey: obstetric-anc (swarm journey #7) — deterministic in-CI replacement.
//
// A pregnant patient comes in for a routine antenatal-care (ANC) visit. Flow
// through the REAL API surface across roles:
//   1. Receptionist registers the ANC patient as a walk-in into the obstetric
//      department (auto-assigned OB doctor).
//   2. OB doctor opens the ANC encounter: SCHEDULED/CONFIRMED → IN_PROGRESS.
//   3. OB doctor registers the pregnancy episode on the maternity surface
//      (POST /maternity/pregnancies — LMP/EDD, gravida/parity).
//   4. OB doctor records ANC vitals + BP (canonical: vitals.recorded).
//   5. OB doctor writes the obstetric exam note bound to the visit
//      (op_consultation, auto-creates the canonical encounter; canonical:
//      note.created) and signs it (canonical: note.signed).
//   6. OB doctor records the structured ANC visit on the maternity surface
//      (POST /maternity/anc-visits — fundal height, FHR, presentation, urine
//      dipstick) against the pregnancy.
//   7. OB doctor places an obstetric investigation order (anomaly scan)
//      (canonical: order.created).
//   8. OB doctor sets the ANC care plan (POST /maternity/supplements — IFA),
//      then completes the consult: IN_PROGRESS → COMPLETED.
//   9. The patient's canonical timeline reflects the visit's clinical events,
//      and the ANC timeline read endpoint surfaces the pregnancy + visit.
//
// Assertions: walk-in registration + appointment state-machine transitions,
// RBAC (a non-front-desk role cannot register; a stranger doctor cannot drive
// the visit), the canonical clinical-timeline invariant on every /emr clinical
// write (vitals/note/order), and the maternity ANC surfaces (pregnancy episode,
// structured ANC visit, supplement care plan).
//
// The maternity (/api/v1/maternity/*) endpoints are feature-specific and do NOT
// emit the canonical timeline/audit triple (they write only to the
// maternity_* tables); the canonical invariant is asserted only on the /emr
// vitals/notes/orders writes, exactly as the sibling journeys do. The /emr
// writes are what populate clinical_timeline_events for this visit.
//
// Deterministic: every fixture id namespaced per-run; "today" derived from the
// Postgres hospital clock (so the OP-note same-day session gate + the ANC visit
// date agree with the server date across the UTC midnight boundary); the OB
// doctor authorised via an explicit care-team grant AND the assigned-appointment
// relationship. Patients land in DEFAULT_TENANT (the users.tenant_id default),
// which is the tenant the maternity service falls back to, so the pregnancy
// lookups resolve. maternity_* children FK to maternity_pregnancies with ON
// DELETE CASCADE, so cleanup of the patient (which deletes the pregnancy) sweeps
// the ANC visit + supplement rows automatically.

import {
  describeJourney,
  roleClient,
  runSuffix,
  hospitalToday,
  seedDoctor,
  grantCareTeam,
  assertCanonicalClinicalWrite,
  fetchPatientTimeline,
  cleanupJourney,
  uidForUserId,
  CANONICAL_EVENTS,
  DEFAULT_TENANT,
  prisma,
} from './_journeyHarness.js';

const RUN = runSuffix();
const DOCTOR_UID = `b5000001-0000-4000-8000-${RUN.padStart(12, '0')}`;
const STRANGER_DOCTOR_UID = `b5000002-0000-4000-8000-${RUN.padStart(12, '0')}`;
const RECEPTIONIST_UID = `b5000003-0000-4000-8000-${RUN.padStart(12, '0')}`;
const DEPARTMENT = `JObstetricANC-${RUN}`; // substring "obstet" → ANC timeline picks up booked visits
const PATIENT_PHONE = `96701${RUN}`;
const DOCTOR_PHONE = `+9196702${RUN}`;
const STRANGER_PHONE = `+9196703${RUN}`;
const RECEPTIONIST_PHONE = `96704${RUN}`;

describeJourney('Journey: obstetric-anc', () => {
  let receptionist;
  let doctor;
  let strangerDoctor;
  let doctorUserId;
  let receptionistId;

  let appointmentId;
  let patientId;
  let patientUid;
  let pregnancyId;
  let today;

  beforeAll(async () => {
    await cleanupJourney({
      patientUids: [],
      staffUids: [DOCTOR_UID, STRANGER_DOCTOR_UID, RECEPTIONIST_UID],
      phones: [PATIENT_PHONE, RECEPTIONIST_PHONE],
      departments: [DEPARTMENT, `${DEPARTMENT}-other`],
    });

    today = await hospitalToday();

    const doc = await seedDoctor({
      uid: DOCTOR_UID, phone: DOCTOR_PHONE, name: `Dr OB ${RUN}`, department: DEPARTMENT,
      specialty: 'Obstetrics & Gynaecology',
    });
    doctorUserId = doc.userId;

    await seedDoctor({
      uid: STRANGER_DOCTOR_UID, phone: STRANGER_PHONE,
      name: `Dr Stranger OB ${RUN}`, department: `${DEPARTMENT}-other`,
      specialty: 'Obstetrics & Gynaecology',
    });

    const recep = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, $3, 'RECEPTIONIST', true, NOW()) RETURNING id`,
      RECEPTIONIST_UID, `+91${RECEPTIONIST_PHONE}`, `Reception ${RUN}`,
    );
    receptionistId = recep[0].id;

    receptionist = roleClient('RECEPTIONIST', { uid: RECEPTIONIST_UID, id: receptionistId });
    doctor = roleClient('DOCTOR', { uid: DOCTOR_UID, id: doctorUserId, phone: DOCTOR_PHONE });
    strangerDoctor = roleClient('DOCTOR', { uid: STRANGER_DOCTOR_UID, id: 0, phone: STRANGER_PHONE });
  });

  afterAll(async () => {
    await cleanupJourney({
      patientUids: [patientUid].filter(Boolean),
      staffUids: [DOCTOR_UID, STRANGER_DOCTOR_UID, RECEPTIONIST_UID],
      phones: [PATIENT_PHONE, RECEPTIONIST_PHONE],
      departments: [DEPARTMENT, `${DEPARTMENT}-other`],
    });
    await prisma.$disconnect().catch(() => {});
  });

  describe('Step 1 — receptionist registers the ANC walk-in', () => {
    it('rejects a non-front-desk role (lab staff) from registering a walk-in', async () => {
      const lab = roleClient('LAB_STAFF', { uid: STRANGER_DOCTOR_UID, id: 0 });
      const res = await lab.post('/api/v1/appointments/walk-in').send({
        patient_name: 'Should Fail',
        patient_phone: PATIENT_PHONE,
        department: DEPARTMENT,
        reason: 'ANC visit',
      });
      expect(res.statusCode).toBe(403);
      expect(String(res.body.message || '')).toMatch(/front-desk/i);
    });

    it('registers the pregnant patient + creates the OB appointment, auto-assigning the OB doctor', async () => {
      const res = await receptionist.post('/api/v1/appointments/walk-in').send({
        patient_name: `ANC Patient ${RUN}`,
        patient_phone: PATIENT_PHONE,
        patient_gender: 'F',
        department: DEPARTMENT,
        reason: 'Routine antenatal check-up',
        visit_type: 'NEW',
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeDefined();
      // auto-assignment picks the only doctor in this department
      expect(res.body.data.doctor_id).toBe(doctorUserId);

      appointmentId = res.body.data.id;
      patientId = res.body.data.patient_id;
      patientUid = await uidForUserId(patientId);
      expect(patientUid).toBeTruthy();

      // Persisted appointment row is in a live pre-consult state.
      const row = await prisma.$queryRawUnsafe(
        `SELECT status, doctor_id, department FROM appointments WHERE id = $1`, appointmentId);
      expect(row[0].doctor_id).toBe(doctorUserId);
      expect(row[0].department).toBe(DEPARTMENT);
      expect(['SCHEDULED', 'CONFIRMED', 'CHECKED_IN', 'WAITING']).toContain(row[0].status);

      // Now that we know the patient, grant the assigned OB doctor an explicit
      // care-team relationship (belt-and-braces with the appointment
      // relationship) so the clinical-write guard resolves deterministically.
      await grantCareTeam({
        patientUid, staffUid: DOCTOR_UID, memberName: `ANC Patient ${RUN}`,
      });
    });
  });

  describe('Step 2 — OB doctor opens the ANC encounter', () => {
    it('blocks a stranger doctor from advancing the appointment (RBAC/IDOR)', async () => {
      const res = await strangerDoctor.put(`/api/v1/appointments/${appointmentId}/status`).send({
        status: 'IN_PROGRESS',
      });
      expect(res.statusCode).toBe(403);
    });

    it('assigned OB doctor advances SCHEDULED/CONFIRMED → IN_PROGRESS', async () => {
      const res = await doctor.put(`/api/v1/appointments/${appointmentId}/status`).send({
        status: 'IN_PROGRESS',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.appointment.status).toBe('IN_PROGRESS');
    });
  });

  describe('Step 3 — OB doctor registers the pregnancy episode', () => {
    it('creates the pregnancy record on the maternity surface (LMP/EDD, gravida/parity)', async () => {
      // LMP ~20 weeks before the hospital "today" so the GA + ANC schedule math
      // lands in the second trimester (deterministic relative to server date).
      const lmp = await prisma.$queryRawUnsafe(
        `SELECT (current_date - INTERVAL '140 days')::date::text AS d`);
      const lmpDate = lmp[0].d;

      const res = await doctor.post('/api/v1/maternity/pregnancies').send({
        patient_uid: patientUid,
        lmp_date: lmpDate,
        gravida: 2,
        parity: 1,
        living_children: 1,
        booking_status: 'booked',
        booking_visit_date: today,
      });
      // Maternity routes use success(res, data) → default 200 (not 201).
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      pregnancyId = res.body.data?.id;
      expect(pregnancyId).toBeTruthy();
      expect(String(res.body.data.patient_uid)).toBe(String(patientUid));
      expect(res.body.data.status).toBe('ongoing');

      // Persisted pregnancy row is tenant-scoped to the default floor.
      const row = await prisma.$queryRawUnsafe(
        `SELECT patient_uid, status, gravida, parity, tenant_id
           FROM maternity_pregnancies WHERE id = $1::int`, pregnancyId);
      expect(String(row[0].patient_uid)).toBe(String(patientUid));
      expect(Number(row[0].gravida)).toBe(2);
      expect(String(row[0].tenant_id)).toBe(DEFAULT_TENANT);
    });
  });

  describe('Step 4 — OB doctor records ANC vitals + BP', () => {
    it('records vitals and writes the canonical vitals timeline + audit triple', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: patientUid,
        heart_rate: 84,
        systolic_bp: 118,
        diastolic_bp: 74,
        temperature: 36.8,
        spo2: 99,
        respiratory_rate: 18,
        weight_kg: 64.5,
      });
      expect(res.statusCode).toBe(201);
      const vitalsId = res.body.data?.vitals?.id;
      expect(vitalsId).toBeTruthy();

      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.vitalsRecorded,
        sourceId: vitalsId,
        patientUid,
      });
    });
  });

  describe('Step 5 — OB doctor writes + signs the obstetric exam note', () => {
    let noteId;

    it('creates an op_consultation obstetric exam note bound to the visit (auto-creates the encounter)', async () => {
      const res = await doctor.post('/api/v1/emr/notes').send({
        patient_uid: patientUid,
        appointment_id: appointmentId,
        note_type: 'op_consultation',
        content: {
          chief_complaint: 'Routine antenatal visit, ~20 weeks',
          history: 'G2P1, single intrauterine pregnancy. No bleeding, no leaking, good fetal movements.',
          examination: 'Fundal height ~20cm, FHR 148 bpm, cephalic, no pedal edema, no pallor.',
          diagnosis: '20-week intrauterine pregnancy, progressing normally',
          plan: 'Anomaly scan, continue iron-folic acid, review in 4 weeks.',
        },
      });
      expect(res.statusCode).toBe(201);
      noteId = res.body.data.id;
      expect(noteId).toBeTruthy();

      // The OP note auto-creates the canonical encounter (migration 240 +
      // ensureEncounterForAppointment) — the UUID encounter_id is stamped.
      const row = await prisma.$queryRawUnsafe(
        `SELECT appointment_id, encounter_id, note_type FROM clinical_notes WHERE id = $1::int`,
        noteId);
      expect(Number(row[0].appointment_id)).toBe(appointmentId);
      expect(row[0].encounter_id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(row[0].note_type).toBe('op_consultation');

      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.noteCreated,
        sourceId: noteId,
        patientUid,
      });
    });

    it('signs the obstetric exam note (canonical note.signed event)', async () => {
      const res = await doctor.post(`/api/v1/emr/notes/${noteId}/sign`).send({});
      expect(res.statusCode).toBe(200);
      expect(res.body.data.is_signed).toBe(true);

      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.noteSigned,
        sourceId: noteId,
        patientUid,
      });
    });
  });

  describe('Step 6 — OB doctor records the structured ANC visit', () => {
    it('records the ANC visit (fundal height, FHR, presentation, urine dipstick) against the pregnancy', async () => {
      const res = await doctor.post('/api/v1/maternity/anc-visits').send({
        pregnancy_id: pregnancyId,
        visit_date: today,
        gestational_age_weeks: 20,
        weight_kg: 64.5,
        bp_systolic: 118,
        bp_diastolic: 74,
        pulse_bpm: 84,
        fundal_height_cm: 20,
        fetal_heart_rate_bpm: 148,
        fetal_movements_felt: true,
        presentation: 'cephalic',
        edema: 'none',
        pallor: 'none',
        hb_gm_dl: 11.4,
        urine_albumin: 'nil',
        urine_sugar: 'nil',
        iron_folic_acid_given: true,
        next_visit_date: await (async () => {
          const r = await prisma.$queryRawUnsafe(
            `SELECT (current_date + INTERVAL '28 days')::date::text AS d`);
          return r[0].d;
        })(),
        notes: 'Second-trimester ANC visit, progressing normally.',
      });
      // Maternity routes use success(res, data) → default 200.
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      const visit = res.body.data;
      expect(visit?.id).toBeTruthy();
      expect(Number(visit.pregnancy_id)).toBe(Number(pregnancyId));
      // First visit on this pregnancy → auto-assigned visit_number 1.
      expect(Number(visit.visit_number)).toBe(1);

      // Persisted against the pregnancy with the recorded obstetric findings.
      const row = await prisma.$queryRawUnsafe(
        `SELECT pregnancy_id, fundal_height_cm, fetal_heart_rate_bpm, presentation
           FROM maternity_anc_visits WHERE id = $1::int`, visit.id);
      expect(Number(row[0].pregnancy_id)).toBe(Number(pregnancyId));
      expect(Number(row[0].fetal_heart_rate_bpm)).toBe(148);
      expect(row[0].presentation).toBe('cephalic');
    });
  });

  describe('Step 7 — OB doctor places an obstetric investigation order', () => {
    it('creates an investigation order (anomaly scan) and writes the canonical order timeline + audit triple', async () => {
      const res = await doctor.post('/api/v1/emr/orders').send({
        patient_uid: patientUid,
        order_type: 'investigation',
        priority: 'routine',
        details: {
          test_name: 'Anomaly scan (anatomy ultrasound)',
          test_type: 'RADIOLOGY',
          reason: 'Routine 20-week fetal anomaly screening',
        },
      });
      expect(res.statusCode).toBe(201);
      const order = res.body.data?.order || res.body.data;
      const orderId = order?.id;
      expect(orderId).toBeTruthy();

      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.orderCreated,
        sourceId: orderId,
        patientUid,
      });
    });
  });

  describe('Step 8 — OB doctor sets the ANC care plan + completes the visit', () => {
    it('prescribes an iron-folic-acid supplement on the maternity care-plan surface', async () => {
      const res = await doctor.post('/api/v1/maternity/supplements').send({
        pregnancy_id: pregnancyId,
        supplement: 'iron',
        dose: 'Iron 60mg + FA 500mcg',
        frequency: 'once_daily',
        route: 'oral',
        start_date: today,
        reminder_enabled: true,
        notes: 'Continue through second + third trimester.',
      });
      // Maternity routes use success(res, data) → default 200.
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data?.id).toBeTruthy();
      expect(res.body.data.supplement).toBe('iron');
      expect(Number(res.body.data.pregnancy_id)).toBe(Number(pregnancyId));
    });

    it('advances IN_PROGRESS → COMPLETED', async () => {
      const res = await doctor.put(`/api/v1/appointments/${appointmentId}/status`).send({
        status: 'COMPLETED',
        notes: 'ANC visit complete; anomaly scan ordered, IFA continued.',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.appointment.status).toBe('COMPLETED');

      const row = await prisma.$queryRawUnsafe(
        `SELECT status FROM appointments WHERE id = $1`, appointmentId);
      expect(row[0].status).toBe('COMPLETED');
    });
  });

  describe('Step 9 — canonical + ANC timelines reflect the visit', () => {
    it("exposes the visit's clinical events on the patient's canonical timeline", async () => {
      const res = await fetchPatientTimeline(doctor, patientUid);
      expect(res.statusCode).toBe(200);

      // The canonical timeline rows we wrote this visit must be queryable.
      const rows = await prisma.$queryRawUnsafe(
        `SELECT event_type FROM clinical_timeline_events WHERE patient_uid = $1::uuid`,
        patientUid);
      const types = rows.map((r) => r.event_type);
      expect(types).toEqual(expect.arrayContaining([
        'vitals.recorded',
        'note.created',
        'note.signed',
        'order.created',
      ]));
    });

    it('surfaces the pregnancy + ANC visit on the maternity ANC timeline', async () => {
      const res = await doctor.get(`/api/v1/maternity/pregnancies/${pregnancyId}/timeline`);
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Number(res.body.data?.pregnancy?.id)).toBe(Number(pregnancyId));
      // The structured ANC visit recorded in Step 6 is on the timeline.
      const visits = res.body.data?.visits || [];
      expect(visits.length).toBeGreaterThanOrEqual(1);
      expect(visits.some((v) => Number(v.fetal_heart_rate_bpm) === 148)).toBe(true);
    });
  });
});
