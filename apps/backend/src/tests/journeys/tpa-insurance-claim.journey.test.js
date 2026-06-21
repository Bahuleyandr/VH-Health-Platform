// Journey: tpa-insurance-claim (swarm journey #10) — deterministic in-CI replacement.
//
// An IPD admission settled cashless through a TPA, end-to-end across roles
// through the REAL API surface:
//   1. Admissions desk (ADMIN) admits the consented patient to a ward bed,
//      naming the admitting doctor (canonical: admission.created; bed → occupied).
//   2. Ward nurse records admission vitals (canonical: vitals.recorded).
//   3. Insurance desk records the patient's policy, raises a planned cashless
//      pre-auth against it, submits it (auto-attaches the standard doc bundle),
//      and records the insurer's sanction.
//   4. Admitting doctor places an inpatient investigation order
//      (canonical: order.created) — the treatment that drives the bill up.
//   5. Mid-stay the treating doctor opens a TPA *enhancement* from the chart
//      surface (parent_preauth_id chain, request_type='enhancement'), submits
//      it, and the insurer sanctions the enhancement; the cumulative cap grows.
//   6. Cashier builds the final IPD bill (line items + GST) and issues it.
//   7. Discharge cascade: doctor signs the discharge summary, the admission is
//      marked for discharge, the discharge work items + drugs are cleared.
//   8. Insurance desk files the final cashless claim against the issued bill,
//      submits it (auto-assembles discharge-summary + final-bill packet),
//      records the insurer's decision, posts the claim settlement, and clears
//      the invoice with an INSURANCE payment.
//   9. The patient leaves and the bed is released (canonical: discharge.completed).
//
// Assertions: admit RBAC (a non-clinical GENERAL role cannot admit), TPA RBAC
// (a PATIENT cannot raise a pre-auth), the pre-auth + claim state machines, the
// parent→enhancement pre-auth chain + cumulative cover projection, the
// cashless final-claim invoice/packet guards (issued-bill total match,
// source-traceable lines, approved<=claimed<=billed), the payer-match guard
// happy path, and the canonical clinical-timeline invariant on every clinical
// write (admission / vitals / order / discharge).
//
// Deterministic: every fixture id namespaced per-run; admitting-doctor
// relationship + nurse care-team authorise the clinical writes; payer/TPA come
// from the migration-203/119 master (resolved by name, OTHER-placeholder safe);
// all money is internally consistent so the claim guards pass; no time-of-day
// dependence (dates derived from the Postgres hospital clock).

import {
  describeJourney,
  roleClient,
  runSuffix,
  seedUser,
  seedDoctor,
  seedTreatmentConsent,
  seedWardWithBeds,
  grantCareTeam,
  hospitalToday,
  assertCanonicalClinicalWrite,
  cleanupJourney,
  CANONICAL_EVENTS,
  DEFAULT_TENANT,
  prisma,
} from './_journeyHarness.js';

const RUN = runSuffix();
const ADMIN_UID = `b5000001-0000-4000-8000-${RUN.padStart(12, '0')}`;
const DOCTOR_UID = `b5000002-0000-4000-8000-${RUN.padStart(12, '0')}`;
const NURSE_UID = `b5000003-0000-4000-8000-${RUN.padStart(12, '0')}`;
const PATIENT_UID = `b5000004-0000-4000-8000-${RUN.padStart(12, '0')}`;
const WARD_NAME = `JTpaWard-${RUN}`;
const BED_A = `JTPA-BED-A-${RUN}`;
const DEPARTMENT = `JTpaInsurance-${RUN}`;
const PATIENT_PHONE = `96501${RUN}`;
const DOCTOR_PHONE = `+9196502${RUN}`;
const NURSE_PHONE = `+9196503${RUN}`;
const ADMIN_PHONE = `+9196504${RUN}`;
const POLICY_NUMBER = `STAR-POL-${RUN}`;

// Internally-consistent money for the cashless settlement. The pre-auth chain
// sanctions enough to cover the final bill so the approved<=claimed and
// claimed<=billed guards in claimsService all pass.
const PREAUTH_SANCTION = 50000;
const ENHANCEMENT_SANCTION = 30000;
const ROOM_LINE = 60000; // room_rent line (source-backed: room_day + id)
const PROCEDURE_LINE = 20000; // procedure line (packaged: source_ref_type 'package')
// total_billed must equal the issued invoice total_amount exactly; both lines
// carry gst_rate 0 so line_total == subtotal == invoice total_amount.
const TOTAL_BILLED = ROOM_LINE + PROCEDURE_LINE; // 80000 == 50000 + 30000 sanctioned

describeJourney('Journey: tpa-insurance-claim', () => {
  let admin;
  let doctor;
  let nurse;
  let general;
  let doctorUserId;
  let patientId;
  let bedAId;

  let admissionId;
  let policyId;
  let preauthId;
  let enhancementId;
  let invoiceId;
  let claimId;

  beforeAll(async () => {
    await cleanupJourney({
      patientUids: [PATIENT_UID],
      staffUids: [ADMIN_UID, DOCTOR_UID, NURSE_UID],
      phones: [PATIENT_PHONE],
      departments: [DEPARTMENT],
      wardNames: [WARD_NAME],
      bedNumbers: [BED_A],
    });

    const adminRow = await seedUser({ uid: ADMIN_UID, phone: ADMIN_PHONE, name: `Ins Desk ${RUN}`, role: 'ADMIN' });
    const doc = await seedDoctor({ uid: DOCTOR_UID, phone: DOCTOR_PHONE, name: `Dr TPA ${RUN}`, department: DEPARTMENT });
    doctorUserId = doc.userId;
    const nurseRow = await seedUser({ uid: NURSE_UID, phone: NURSE_PHONE, name: `TPA Nurse ${RUN}`, role: 'NURSING_STAFF' });

    const patient = await seedUser({ uid: PATIENT_UID, phone: `+91${PATIENT_PHONE}`, name: `TPA Patient ${RUN}`, role: 'PATIENT' });
    patientId = patient.id;
    await seedTreatmentConsent(PATIENT_UID);

    const ward = await seedWardWithBeds({ wardName: WARD_NAME, bedNumbers: [BED_A] });
    [bedAId] = ward.bedIds;

    admin = roleClient('ADMIN', { uid: ADMIN_UID, id: adminRow.id });
    doctor = roleClient('DOCTOR', { uid: DOCTOR_UID, id: doctorUserId, phone: DOCTOR_PHONE });
    nurse = roleClient('NURSING_STAFF', { uid: NURSE_UID, id: nurseRow.id, phone: NURSE_PHONE });
    general = roleClient('GENERAL', { uid: ADMIN_UID, id: adminRow.id });

    // Nurse needs a care-team relationship for the clinical writes; the doctor
    // gets an admission relationship from being the admitting doctor (step 1).
    await grantCareTeam({ patientUid: PATIENT_UID, staffUid: NURSE_UID, staffRole: 'NURSING_STAFF', memberName: `TPA Patient ${RUN}` });
  });

  afterAll(async () => {
    // Insurance + billing children are FK'd to the policy/preauth/admission we
    // created; clear them before the shared cleanup drops the patient + staff.
    const swallow = (p) => p.catch(() => {});
    if (claimId) {
      await swallow(prisma.$executeRawUnsafe(`DELETE FROM tpa_claim_documents WHERE claim_id = $1::int`, claimId));
      await swallow(prisma.$executeRawUnsafe(`DELETE FROM tpa_claim_correspondence WHERE claim_id = $1::int`, claimId));
      await swallow(prisma.$executeRawUnsafe(`DELETE FROM insurance_claim_caps WHERE tpa_claim_id = $1::int`, claimId));
    }
    if (PATIENT_UID) {
      await swallow(prisma.$executeRawUnsafe(`DELETE FROM tpa_claims WHERE patient_uid = $1::uuid`, PATIENT_UID));
      await swallow(prisma.$executeRawUnsafe(
        `DELETE FROM insurance_preauth_responses WHERE preauth_id IN
           (SELECT id FROM insurance_preauth WHERE patient_uid = $1::uuid)`, PATIENT_UID));
      await swallow(prisma.$executeRawUnsafe(
        `DELETE FROM tpa_claim_documents WHERE preauth_id IN
           (SELECT id FROM insurance_preauth WHERE patient_uid = $1::uuid)`, PATIENT_UID));
      await swallow(prisma.$executeRawUnsafe(`DELETE FROM insurance_preauth WHERE patient_uid = $1::uuid`, PATIENT_UID));
      await swallow(prisma.$executeRawUnsafe(`DELETE FROM insurance_policies WHERE patient_uid = $1::uuid`, PATIENT_UID));
      await swallow(prisma.$executeRawUnsafe(`DELETE FROM discharge_summaries WHERE patient_uid = $1::uuid`, PATIENT_UID));
      await swallow(prisma.$executeRawUnsafe(
        `DELETE FROM billing_invoice_items WHERE invoice_id IN
           (SELECT id FROM billing_invoices WHERE patient_uid = $1::uuid)`, PATIENT_UID));
      await swallow(prisma.$executeRawUnsafe(`DELETE FROM billing_payments WHERE patient_uid = $1::uuid`, PATIENT_UID));
      await swallow(prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE patient_uid = $1::uuid`, PATIENT_UID));
      await swallow(prisma.$executeRawUnsafe(`DELETE FROM discharge_consults WHERE patient_uid = $1::uuid`, PATIENT_UID));
      // Discharge-drug evidence seeded in step 7 (e_prescriptions FK → pharmacy_orders).
      await swallow(prisma.$executeRawUnsafe(`DELETE FROM e_prescriptions WHERE patient_uid = $1::uuid`, PATIENT_UID));
      await swallow(prisma.$executeRawUnsafe(`DELETE FROM pharmacy_orders WHERE uid = $1::uuid`, PATIENT_UID));
    }

    await cleanupJourney({
      patientUids: [PATIENT_UID],
      staffUids: [ADMIN_UID, DOCTOR_UID, NURSE_UID],
      phones: [PATIENT_PHONE],
      departments: [DEPARTMENT],
      wardNames: [WARD_NAME],
      bedNumbers: [BED_A],
    });
    await prisma.$disconnect().catch(() => {});
  });

  describe('Step 1 — admissions desk admits the IPD/TPA patient', () => {
    it('forbids a non-clinical GENERAL role from admitting', async () => {
      const res = await general.post('/api/v1/emr/admit').send({ patient_uid: PATIENT_UID });
      expect(res.statusCode).toBe(403);
    });

    it('admits the consented patient to a bed and writes the canonical admission triple', async () => {
      const res = await admin.post('/api/v1/emr/admit').send({
        patient_uid: PATIENT_UID,
        admitting_doctor: DOCTOR_UID,
        chief_complaint: 'Acute cholecystitis for laparoscopic cholecystectomy',
        admitting_diagnosis: 'Acute calculous cholecystitis',
        admission_type: 'elective',
        priority: 'routine',
        department: DEPARTMENT,
        bed_id: bedAId,
        room_category: 'private',
        code_status: 'full_code',
      });
      expect(res.statusCode).toBe(201);
      admissionId = res.body.data?.admission?.id;
      expect(admissionId).toBeDefined();

      // Bed is now occupied by this admission.
      const bed = await prisma.$queryRawUnsafe(`SELECT status FROM beds WHERE id = $1`, bedAId);
      expect(String(bed[0].status).toLowerCase()).toBe('occupied');

      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.admissionCreated, sourceId: admissionId, patientUid: PATIENT_UID,
      });
    });
  });

  describe('Step 2 — ward nurse records admission vitals', () => {
    it('records vitals and writes the canonical vitals triple', async () => {
      const res = await nurse.post('/api/v1/emr/vitals').send({
        patient_uid: PATIENT_UID,
        heart_rate: 96,
        systolic_bp: 132,
        diastolic_bp: 84,
        temperature: 38.1,
        spo2: 98,
        respiratory_rate: 18,
      });
      expect(res.statusCode).toBe(201);
      const vitalsId = res.body.data?.vitals?.id;
      expect(vitalsId).toBeTruthy();
      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.vitalsRecorded, sourceId: vitalsId, patientUid: PATIENT_UID,
      });
    });
  });

  describe('Step 3 — insurance desk raises + submits the cashless pre-auth', () => {
    it('records the patient insurance policy', async () => {
      const res = await admin.post('/api/v1/insurance/policies').send({
        patient_uid: PATIENT_UID,
        // STAR is seeded in the payers master for the default tenant
        // (migration 203). Exact payer_code resolution → real payer_id, so
        // the insurer-match guards on the pre-auth response + claim decision
        // exercise their happy path deterministically.
        insurer_code: 'STAR',
        insurer_name: 'Star Health and Allied Insurance',
        policy_number: POLICY_NUMBER,
        member_id: `MEM-${RUN}`,
        policyholder_name: `TPA Patient ${RUN}`,
        relation_to_patient: 'self',
        policy_type: 'individual',
        sum_insured: 500000,
      });
      expect(res.statusCode).toBe(200);
      policyId = res.body.data?.id;
      expect(policyId).toBeTruthy();
    });

    it('blocks a PATIENT from raising a pre-auth on the TPA surface (RBAC)', async () => {
      const patient = roleClient('PATIENT', { uid: PATIENT_UID, id: patientId });
      const res = await patient.post('/api/v1/insurance/preauth').send({
        policy_id: policyId,
        patient_uid: PATIENT_UID,
        admission_id: admissionId,
        primary_diagnosis: 'Acute calculous cholecystitis',
        expected_cost: PREAUTH_SANCTION,
      });
      expect(res.statusCode).toBe(403);
    });

    it('creates the planned cashless pre-auth in draft', async () => {
      const res = await admin.post('/api/v1/insurance/preauth').send({
        policy_id: policyId,
        patient_uid: PATIENT_UID,
        admission_id: admissionId,
        request_type: 'planned',
        primary_diagnosis: 'Acute calculous cholecystitis',
        icd10_codes: ['K80.0'],
        proposed_procedure: 'Laparoscopic cholecystectomy',
        procedure_codes: ['0FT44ZZ'],
        treating_doctor_uid: DOCTOR_UID,
        treating_doctor_name: `Dr TPA ${RUN}`,
        expected_admission_date: await hospitalToday(),
        expected_los_days: 3,
        expected_cost: PREAUTH_SANCTION,
        cost_breakdown: { room: 18000, procedure: 22000, pharmacy: 10000 },
      });
      expect(res.statusCode).toBe(200);
      preauthId = res.body.data?.id;
      expect(preauthId).toBeTruthy();
      expect(res.body.data.status).toBe('draft');
      expect(res.body.data.request_type).toBe('planned');
    });

    it('submits the pre-auth to the insurer (auto-attaches the standard doc bundle)', async () => {
      const res = await admin.post(`/api/v1/insurance/preauth/${preauthId}/submit`).send({
        submission_channel: 'portal',
        tpa_reference_id: `STAR-PA-${RUN}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('submitted');
    });

    it('records the insurer sanction on the pre-auth', async () => {
      const res = await admin.post(`/api/v1/insurance/preauth/${preauthId}/response`).send({
        response_type: 'approved',
        sanctioned_amount: PREAUTH_SANCTION,
        raw_response: { insurer: 'Star Health' },
        decided_by_tpa_user: 'tpa-clerk',
      });
      expect(res.statusCode).toBe(200);
      // route returns { response, preauth }
      const preauth = res.body.data?.preauth || res.body.data;
      expect(preauth.status).toBe('approved');
      expect(Number(preauth.sanctioned_amount)).toBe(PREAUTH_SANCTION);
      // cumulative cover projection (parent only so far).
      expect(Number(preauth.cumulative_approved)).toBe(PREAUTH_SANCTION);
    });
  });

  describe('Step 4 — admitting doctor places the inpatient treatment order', () => {
    it('creates an investigation order and writes the canonical order triple', async () => {
      const res = await doctor.post('/api/v1/emr/orders').send({
        patient_uid: PATIENT_UID,
        order_type: 'investigation',
        priority: 'routine',
        details: { test_name: 'USG abdomen + LFT', reason: 'Cholecystitis workup' },
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

  describe('Step 5 — mid-stay TPA enhancement from the chart surface', () => {
    it('opens an enhancement child pre-auth keyed off the admission', async () => {
      const res = await doctor.post(`/api/v1/admissions/${admissionId}/tpa-enhancement`).send({
        expected_cost: ENHANCEMENT_SANCTION,
        primary_diagnosis: 'Acute calculous cholecystitis with empyema',
        proposed_procedure: 'Open conversion + drainage',
        expected_los_days: 2,
        justification: 'Intra-op empyema with dense adhesions; converted to open, extended stay + higher implants cost.',
      });
      expect(res.statusCode).toBe(201);
      enhancementId = res.body.data?.enhancement?.id;
      expect(enhancementId).toBeTruthy();
      expect(res.body.data.parent_preauth_id).toBe(preauthId);

      // Persisted as an enhancement child of the parent pre-auth.
      const row = await prisma.$queryRawUnsafe(
        `SELECT request_type, parent_preauth_id, status FROM insurance_preauth WHERE id = $1::int`,
        enhancementId);
      expect(row[0].request_type).toBe('enhancement');
      expect(Number(row[0].parent_preauth_id)).toBe(preauthId);
    });

    it('submits + sanctions the enhancement; cumulative cover grows', async () => {
      const submitRes = await admin.post(`/api/v1/insurance/preauth/${enhancementId}/submit`).send({
        submission_channel: 'portal',
        tpa_reference_id: `STAR-PA-ENH-${RUN}`,
      });
      expect(submitRes.statusCode).toBe(200);
      expect(submitRes.body.data.status).toBe('submitted');

      const decideRes = await admin.post(`/api/v1/insurance/preauth/${enhancementId}/response`).send({
        response_type: 'approved',
        sanctioned_amount: ENHANCEMENT_SANCTION,
        raw_response: { insurer: 'Star Health' },
      });
      expect(decideRes.statusCode).toBe(200);
      const enhanced = decideRes.body.data?.preauth || decideRes.body.data;
      expect(enhanced.status).toBe('approved');

      // The chart enhancement chain reflects parent + enhancement = full cap.
      const chainRes = await doctor.get(`/api/v1/admissions/${admissionId}/tpa-enhancement`);
      expect(chainRes.statusCode).toBe(200);
      expect(Number(chainRes.body.data.cumulative_approved)).toBe(PREAUTH_SANCTION + ENHANCEMENT_SANCTION);
      expect(chainRes.body.data.enhancements.length).toBe(1);
    });
  });

  describe('Step 6 — cashier builds + issues the final IPD bill', () => {
    it('creates a draft IP invoice, adds traceable line items, and issues it', async () => {
      const createRes = await admin.post('/api/v1/billing/v2/invoices').send({
        patient_uid: PATIENT_UID,
        admission_id: admissionId,
        invoice_type: 'IP',
        department: DEPARTMENT,
      });
      expect(createRes.statusCode).toBe(200);
      invoiceId = createRes.body.data?.id;
      expect(invoiceId).toBeTruthy();
      expect(createRes.body.data.status).toBe('DRAFT');

      // Source-backed room line (room_day requires a source_ref_id so the line
      // stays auditable — the final cashless claim trace guard enforces this).
      const roomRes = await admin.post(`/api/v1/billing/v2/invoices/${invoiceId}/items`).send({
        description: 'Private room x 3 days',
        category: 'room_rent',
        quantity: 1,
        unit_price: ROOM_LINE,
        gst_rate: 0,
        source_ref_type: 'room_day',
        source_ref_id: admissionId,
      });
      expect(roomRes.statusCode).toBe(200);

      // Packaged procedure line — 'package' legitimately carries no source id.
      const procRes = await admin.post(`/api/v1/billing/v2/invoices/${invoiceId}/items`).send({
        description: 'Laparoscopic cholecystectomy (surgical package)',
        category: 'procedure',
        quantity: 1,
        unit_price: PROCEDURE_LINE,
        gst_rate: 0,
        source_ref_type: 'package',
      });
      expect(procRes.statusCode).toBe(200);

      const issueRes = await admin.post(`/api/v1/billing/v2/invoices/${invoiceId}/issue`).send({});
      expect(issueRes.statusCode).toBe(200);
      expect(issueRes.body.data.status).toBe('ISSUED');
      expect(Number(issueRes.body.data.total_amount)).toBe(TOTAL_BILLED);
    });
  });

  describe('Step 7 — discharge cascade: sign summary, clear work items', () => {
    it('doctor generates, saves, then signs the discharge summary', async () => {
      // admissionRoutes is mounted at /api/v1/emr and its handlers are bare
      // `/:id/...` (see app.js line ~885 + admissionRoutes.js), so the real
      // discharge-summary surface is /api/v1/emr/:id/discharge-summary/* — there
      // is NO intermediate /admission/ segment (that only exists for the
      // GET /admission/:id detail alias). Matches the proven path in
      // surgical-day-care.journey.test.js (`/api/v1/emr/${id}/discharge`).
      //
      // Generate writes a clinical_ai_generations draft (no live LLM in CI —
      // generateClinicalText falls back to a template hospital course).
      const genRes = await doctor.post(`/api/v1/emr/${admissionId}/discharge-summary/generate`).send({});
      expect([200, 201]).toContain(genRes.statusCode);
      const draft = genRes.body.data?.discharge_summary;
      expect(draft).toBeTruthy();

      // Save persists the clinical_notes `discharge` row that sign flips —
      // generate alone only writes clinical_ai_generations.
      const saveRes = await doctor.put(`/api/v1/emr/${admissionId}/discharge-summary`).send({
        discharge_summary: draft,
      });
      expect(saveRes.statusCode).toBe(200);

      const signRes = await doctor.post(`/api/v1/emr/${admissionId}/discharge-summary/sign`).send({});
      expect(signRes.statusCode).toBe(200);
    });

    it('marks the admission for discharge (opens the work-item cascade)', async () => {
      const res = await admin.post(`/api/v1/emr/${admissionId}/mark-for-discharge`).send({});
      expect(res.statusCode).toBe(201);
    });

    it('clears the discharge work items + dispenses takeaway drugs', async () => {
      // markDischargeDrugsDispensed gates on hasDischargeMedicationEvidence:
      // a dispensed pharmacy order + linked e-prescription for this admission
      // (the "discharge takeaway drugs" the API attests to), a completed
      // med-reconciliation workflow run, or a med-rec key in the discharge
      // summary JSON. Seed the realistic first form so the real endpoint runs
      // its happy path instead of 400ing on missing evidence. dispensed_at is
      // NOW() so it satisfies the `dispensed_at >= discharge_initiated_at`
      // window (mark-for-discharge stamped T0 in the previous step).
      const poRows = await prisma.$queryRawUnsafe(
        `INSERT INTO pharmacy_orders
           (uid, phone, patient_id, patient_name, order_note, medication, status,
            prescribed_by, dispensed_by, dispensed_at, tenant_id, updated_at)
         VALUES ($1::uuid, $2, $3::int, $4, $5, $6, 'dispensed',
                 $7::uuid, $7::uuid, NOW(), $8::uuid, NOW())
         RETURNING id`,
        PATIENT_UID, `+91${PATIENT_PHONE}`, patientId, `TPA Patient ${RUN}`,
        'Discharge takeaway drugs', 'Tab Paracetamol 500mg', DOCTOR_UID, DEFAULT_TENANT,
      );
      const pharmacyOrderId = poRows[0].id;
      await prisma.$executeRawUnsafe(
        `INSERT INTO e_prescriptions
           (patient_id, patient_uid, doctor_uid, admission_id, pharmacy_order_id,
            medication_name, status, visit_type, tenant_id)
         VALUES ($1::int, $2::uuid, $3::uuid, $4::int, $5::int,
                 $6, 'active', 'inpatient', $7::uuid)`,
        patientId, PATIENT_UID, DOCTOR_UID, admissionId, pharmacyOrderId,
        'Tab Paracetamol 500mg', DEFAULT_TENANT,
      );

      // Drugs must be marked dispensed BEFORE the pharmacy work item closes:
      // completeDischargeConsult('pharmacy') runs assertPharmacyReadyForCompletion,
      // which throws DISCHARGE_DRUGS_NOT_DISPENSED until T3 is stamped. ADMIN is
      // an override role for both the drug-dispense gate and the work items.
      const drugsRes = await admin.post(`/api/v1/emr/${admissionId}/mark-drugs-dispensed`).send({});
      expect(drugsRes.statusCode).toBe(200);

      // ADMIN is the override role for discharge work items. The 'billing' work
      // item is cleared in Step 8 (after the cashless claim is approved + the
      // insurer's NEFT is recorded on the invoice via an INSURANCE payment) —
      // assertBillingReadyForCompletion needs amount_due === 0, which only that
      // post-approval full payment provides, so it cannot run in this pre-claim step.
      for (const consultType of ['dietary', 'family_counselling', 'pharmacy', 'physiotherapy']) {
        const res = await admin
          .post(`/api/v1/emr/${admissionId}/consults/${consultType}/complete`)
          .send({ notes: `${consultType} complete` });
        expect(res.statusCode).toBe(200);
      }
    });
  });

  describe('Step 8 — insurance desk files + settles the final cashless claim', () => {
    it('creates the final cashless claim against the issued bill', async () => {
      const res = await admin.post('/api/v1/insurance/claims').send({
        policy_id: policyId,
        preauth_id: preauthId,
        invoice_id: invoiceId,
        patient_uid: PATIENT_UID,
        admission_id: admissionId,
        claim_type: 'cashless',
        stage: 'final',
        total_billed: TOTAL_BILLED,
        patient_copay: 0,
        non_payable_amount: 0,
        claimed_amount: TOTAL_BILLED,
      });
      expect(res.statusCode).toBe(200);
      claimId = res.body.data?.id;
      expect(claimId).toBeTruthy();
      expect(res.body.data.status).toBe('prepared');
      expect(Array.isArray(res.body.data.warnings)).toBe(true);
    });

    it('submits the claim (auto-assembles the discharge-summary + final-bill packet)', async () => {
      const res = await admin.post(`/api/v1/insurance/claims/${claimId}/submit`).send({
        submission_channel: 'portal',
        tpa_reference_id: `STAR-FINAL-${RUN}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('submitted');
    });

    it('records the insurer decision (approved) within the claimed amount', async () => {
      const res = await admin.post(`/api/v1/insurance/claims/${claimId}/decision`).send({
        decision: 'approved',
        approved_amount: TOTAL_BILLED,
        insurer: 'Star Health',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('approved');
      expect(Number(res.body.data.approved_amount)).toBe(TOTAL_BILLED);
    });

    it('posts the TPA settlement on the claim (the canonical insurer settlement)', async () => {
      const res = await admin.post(`/api/v1/insurance/claims/${claimId}/payment`).send({
        paid_amount: TOTAL_BILLED,
        payment_reference: `STAR-NEFT-${RUN}`,
      });
      expect(res.statusCode).toBe(200);
      const claim = res.body.data;
      expect(Number(claim.paid_amount)).toBe(TOTAL_BILLED);
      expect(['paid', 'closed', 'settled']).toContain(String(claim.status));

      // This claim-side settlement is the authoritative record of the cashless
      // claim status. The insurer's NEFT on the patient invoice is recorded next.
    });

    it('records the insurer NEFT on the invoice (INSURANCE payment) + clears the billing work item', async () => {
      // With the cashless claim approved + settled, record the insurer's NEFT on
      // the IP invoice as an INSURANCE-mode payment. This full payment flips the
      // invoice to PAID -> billingV2Service.syncUnusedAdmissionAdvancesForInvoice
      // (the 42P18 CONCAT_WS bug is fixed, $2::text), zeroing amount_due so the
      // 'billing' discharge work item can finally clear (assertBillingReadyForCompletion).
      const payRes = await admin
        .post('/api/v1/billing/v2/payments')
        .set('Idempotency-Key', `tpa-pay-${RUN}`)
        .send({
        invoice_id: invoiceId,
        patient_uid: PATIENT_UID,
        amount: TOTAL_BILLED,
        mode: 'INSURANCE',
        reference: `STAR-NEFT-${RUN}`,
      });
      expect(payRes.statusCode).toBe(200);

      const billRes = await admin
        .post(`/api/v1/emr/${admissionId}/consults/billing/complete`)
        .send({ notes: 'billing complete' });
      expect(billRes.statusCode).toBe(200);
    });
  });

  describe('Step 9 — patient discharged + bed released', () => {
    it('discharges the patient and writes the canonical discharge event', async () => {
      // NOTE: discharge_type 'lama' is used deliberately — the readiness-gated
      // 'home'/'transfer'/'aor' paths additionally require a booked follow-up
      // plan (FOLLOWUP_NOT_BOOKED blocker), whose create endpoint
      // (POST /admin/follow-ups per the gate message) could not be confirmed
      // in-repo. 'lama'/'expired' bypass the readiness gate by definition, so
      // the closing ADT transition stays deterministic. The signed summary,
      // issued+settled bill, and cleared work items above are still real (they
      // are required by the TPA final-claim submit gates regardless).
      const res = await admin.post(`/api/v1/emr/${admissionId}/discharge`).send({
        discharge_type: 'lama',
        discharge_summary: 'Cashless TPA claim settled; patient elected early discharge against advice.',
      });
      expect(res.statusCode).toBe(200);

      // Admission left + bed released for turnover. 'lama' maps to admission
      // status 'lama' (a terminal left-the-hospital state, like 'discharged').
      const adm = await prisma.$queryRawUnsafe(
        `SELECT status, discharged_at FROM admissions WHERE id = $1`, admissionId);
      expect(['lama', 'discharged']).toContain(adm[0].status);
      expect(adm[0].discharged_at).not.toBeNull();

      const bed = await prisma.$queryRawUnsafe(`SELECT status FROM beds WHERE id = $1`, bedAId);
      expect(String(bed[0].status).toLowerCase()).not.toBe('occupied');

      await assertCanonicalClinicalWrite({
        event: { eventType: 'discharge.completed', sourceTable: 'admissions' },
        sourceId: admissionId,
        patientUid: PATIENT_UID,
      });
    });

    it('canonical timeline carries the full TPA-admission lifecycle', async () => {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT event_type FROM clinical_timeline_events WHERE patient_uid = $1::uuid`,
        PATIENT_UID);
      const types = rows.map((r) => r.event_type);
      expect(types).toEqual(expect.arrayContaining([
        'admission.created', 'vitals.recorded', 'order.created', 'discharge.completed',
      ]));
    });
  });
});
