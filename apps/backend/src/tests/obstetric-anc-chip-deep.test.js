// Deep integration tests — Stage 5 fix chip 3, obstetric/ANC cluster.
//
// Covers:
//   F1  appointmentQueryService.getAppointmentById → pregnancy_context
//   F2  getAncTimelineForPregnancy → carried_forward_supplements
//   F3  getAncTimelineForPregnancy → booked_visits + schedule_milestones
//       + computeAncScheduleMilestones (pure)
//   F4  createInvestigationOrder → duplicate_warning (soft guard)
//   F5  getAncAdvice → trimester advice rows (migration 226)
//   F6  listMaternityPackages → obstetrics packages, null price + placeholder

import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';
import appointmentQueryService from '../services/appointment/appointmentQueryService.js';
import { createInvestigationOrder } from '../services/investigation/orderService.js';
import {
  computeAncScheduleMilestones,
  getAncAdvice,
  getAncTimelineForPregnancy,
  listMaternityPackages,
  listPriorOrdersForPregnancy,
  projectAncTimelineForPatient,
  recordAncVisit,
  recordSupplement,
} from '../services/maternity/maternityService.js';
import { getActiveReminders } from '../services/patient/medicationReminderService.js';
import { API_KEY, generateTestToken } from './testClient.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c301';
const DOCTOR_UID = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c302';

describe('Obstetric/ANC chip — deep integration', () => {
  let patientId;
  let pregnancyId;
  let appointmentId;
  let anomalyUsgId;

  beforeAll(async () => {
    // Clean any prior run.
    await prisma.$executeRawUnsafe(
      `DELETE FROM maternity_supplements WHERE pregnancy_id IN
         (SELECT id FROM maternity_pregnancies WHERE patient_uid=$1::uuid)`, PATIENT_UID);
    await prisma.$executeRawUnsafe(
      `DELETE FROM maternity_pregnancies WHERE patient_uid=$1::uuid`, PATIENT_UID);
    await prisma.$executeRawUnsafe(
      `DELETE FROM appointments WHERE patient_id IN
         (SELECT id FROM users WHERE uid=$1::uuid)`, PATIENT_UID);
    await prisma.$executeRawUnsafe(
      `DELETE FROM investigations WHERE patient_uid=$1::uuid`, PATIENT_UID);
    await prisma.$executeRawUnsafe(
      `DELETE FROM e_prescriptions WHERE patient_uid=$1::uuid`, PATIENT_UID);
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID);

    const u = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000090301', 'ANC Chip Patient', 'PATIENT', true, NOW())
       RETURNING id`, PATIENT_UID);
    patientId = u[0].id;

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000090302', 'ANC Chip Doctor', 'DOCTOR', true, NOW())`, DOCTOR_UID);

    // Ongoing pregnancy — LMP chosen so GA lands solidly in trimester 2.
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO maternity_pregnancies
         (patient_uid, lmp_date, edd_date, gravida, parity, status, tenant_id)
       VALUES ($1::uuid, CURRENT_DATE - INTERVAL '168 days',
               CURRENT_DATE + INTERVAL '112 days', 1, 0, 'ongoing', $2::uuid)
       RETURNING id`, PATIENT_UID, TENANT);
    pregnancyId = p[0].id;

    // Active e-prescription carrying an iron supplement (carry-forward source).
    await prisma.$executeRawUnsafe(
      `INSERT INTO e_prescriptions (patient_uid, doctor_uid, status, medications, updated_at)
       VALUES ($1::uuid, $2::uuid, 'active',
               '[{"name":"Ferrous Sulphate","dose":"200mg","frequency":"OD"}]'::jsonb,
               NOW())`, PATIENT_UID, DOCTOR_UID);

    // Booked ANC appointment in the pregnancy window.
    const a = await prisma.$queryRawUnsafe(
      `INSERT INTO appointments
         (patient_id, doctor_id, appointment_date, appointment_time, phone, reason,
          status, department, visit_no, updated_at)
       VALUES ($1, NULL, CURRENT_DATE, '10:30', '9000090301', '24-week ANC visit',
               'CONFIRMED', 'Obstetrics & Gynaecology', 'ANC-20260514-001', NOW())
       RETURNING id`, patientId);
    appointmentId = a[0].id;

    // Vitals recorded on the GENERIC vitals screen (vitals_chart) during the
    // pregnancy window — these must surface on the ANC timeline even though
    // they were not entered through the maternity composer.
    // Finding 2026-05-20-obstetric-anc-nurse-d4c9c118.
    await prisma.$executeRawUnsafe(
      `INSERT INTO vitals_chart
         (patient_uid, systolic_bp, diastolic_bp, heart_rate, weight_kg,
          recorded_at, tenant_id)
       VALUES ($1::uuid, 128, 82, 78, 64, NOW() - INTERVAL '10 days', $2::uuid)`,
      PATIENT_UID, TENANT);

    // Two prior recorded ANC visits (12w + 18w) — these must surface as
    // `visits` on the doctor's timeline, not come back empty.
    // Finding 2026-05-22-obstetric-anc-doctor-8d245f7c.
    await recordAncVisit({
      tenantId: TENANT, pregnancy_id: pregnancyId,
      visit_date: new Date(Date.now() - 84 * 86400000).toISOString().slice(0, 10),
      gestational_age_weeks: 12, weight_kg: 58, bp_systolic: 116, bp_diastolic: 74,
      hb_gm_dl: 11.2, recorded_by: DOCTOR_UID,
    });
    await recordAncVisit({
      tenantId: TENANT, pregnancy_id: pregnancyId,
      visit_date: new Date(Date.now() - 42 * 86400000).toISOString().slice(0, 10),
      gestational_age_weeks: 18, weight_kg: 61, bp_systolic: 118, bp_diastolic: 76,
      fundal_height_cm: 18, fetal_heart_rate_bpm: 148, recorded_by: DOCTOR_UID,
    });

    // A completed 18-week anomaly USG (RADIOLOGY) ordered during the
    // pregnancy — this must surface inline on the ANC timeline so the
    // doctor doesn't re-order it at the 24-week consult, and must also
    // appear in the prior-orders investigations list.
    const usg = await prisma.$queryRawUnsafe(
      `INSERT INTO investigations
         (phone, patient_id, patient_uid, test_name, test_type, status,
          priority, requested_by, requested_at, completed_at, result_summary,
          created_at, updated_at)
       VALUES ('9000090301', $1::int, $2::uuid,
               'Anomaly Scan (Level II Ultrasound)', 'RADIOLOGY', 'COMPLETED',
               'NORMAL', $3::uuid, NOW() - INTERVAL '42 days',
               NOW() - INTERVAL '42 days', 'No structural anomaly detected',
               NOW() - INTERVAL '42 days', NOW())
       RETURNING id`, patientId, PATIENT_UID, DOCTOR_UID);
    anomalyUsgId = usg[0].id;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM investigations WHERE patient_uid=$1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM e_prescriptions WHERE patient_uid=$1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM appointments WHERE patient_id=$1`, patientId).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM maternity_supplements WHERE pregnancy_id=$1`, pregnancyId).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM maternity_pregnancies WHERE id=$1`, pregnancyId).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM vitals_chart WHERE patient_uid=$1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  // ── F3 — pure schedule milestone math ──────────────────────────────
  describe('computeAncScheduleMilestones', () => {
    it('returns the standard schedule with past/current/upcoming status', () => {
      // LMP 168 days ago -> GA 24+0, with explicit 24w and 28w ANC visits.
      const lmp = new Date(Date.now() - 168 * 86400000).toISOString().slice(0, 10);
      const milestones = computeAncScheduleMilestones(lmp);
      expect(milestones.length).toBe(9);
      expect(milestones.every((m) => m.target_date && m.status)).toBe(true);
      expect(milestones.map((m) => m.ga_weeks)).toEqual(expect.arrayContaining([24, 28]));
      const booking = milestones.find((m) => m.ga_weeks === 12);
      const week24 = milestones.find((m) => m.ga_weeks === 24);
      const term = milestones.find((m) => m.ga_weeks === 39);
      expect(booking.status).toBe('past');
      expect(week24.visit_sequence_number).toBe(3);
      expect(week24.trimester_label).toBe('Second trimester');
      expect(term.status).toBe('upcoming');
    });

    it('returns [] when LMP is unknown', () => {
      expect(computeAncScheduleMilestones(null)).toEqual([]);
    });
  });

  // ── F2 + F3 — ANC timeline enrichment ──────────────────────────────
  describe('getAncTimelineForPregnancy', () => {
    it('carries forward active prescription supplements', async () => {
      const timeline = await getAncTimelineForPregnancy({
        tenantId: TENANT, pregnancy_id: pregnancyId,
      });
      expect(Array.isArray(timeline.carried_forward_supplements)).toBe(true);
      const iron = timeline.carried_forward_supplements.find((s) => s.supplement === 'iron');
      expect(iron).toBeTruthy();
      expect(iron.source).toBe('prescription');
      expect(iron.carried_forward).toBe(true);
      expect(iron.dose).toBe('200mg');
    });

    it('includes booked ANC appointments and the schedule milestones', async () => {
      const timeline = await getAncTimelineForPregnancy({
        tenantId: TENANT, pregnancy_id: pregnancyId,
      });
      expect(Array.isArray(timeline.booked_visits)).toBe(true);
      const booked = timeline.booked_visits.find((v) => v.id === appointmentId);
      expect(booked).toBeTruthy();
      expect(booked.milestone_label).toMatch(/24-week/i);
      expect(booked.visit_sequence_number).toBe(3);
      expect(timeline.schedule_milestones.length).toBe(9);
    });

    it('surfaces generic-path (vitals_chart) OB vitals on the timeline', async () => {
      const timeline = await getAncTimelineForPregnancy({
        tenantId: TENANT, pregnancy_id: pregnancyId,
      });
      expect(Array.isArray(timeline.general_vitals)).toBe(true);
      const reading = timeline.general_vitals.find(
        (v) => Number(v.systolic_bp) === 128 && Number(v.diastolic_bp) === 82,
      );
      expect(reading).toBeTruthy();
      expect(Number(reading.weight_kg)).toBe(64);
    });

    // ── F7 — H7 fix: prior visits + prior anomaly USG on the timeline ──
    // Finding 2026-05-22-obstetric-anc-doctor-8d245f7c: the 24-week
    // doctor view returned visits:[] and no anomaly-scan evidence, so a
    // duplicate USG could be re-ordered. Assert the recorded prior visits
    // come back AND the completed anomaly scan surfaces inline.
    it('returns recorded prior ANC visits and the completed anomaly USG', async () => {
      const timeline = await getAncTimelineForPregnancy({
        tenantId: TENANT, pregnancy_id: pregnancyId,
      });
      // Prior visits are not empty.
      expect(Array.isArray(timeline.visits)).toBe(true);
      expect(timeline.visits.length).toBeGreaterThanOrEqual(2);
      const gas = timeline.visits.map((v) => Number(v.gestational_age_weeks));
      expect(gas).toEqual(expect.arrayContaining([12, 18]));

      // Prior obstetric imaging surfaces with a completed flag.
      expect(Array.isArray(timeline.prior_imaging)).toBe(true);
      const scan = timeline.prior_imaging.find((i) => i.id === anomalyUsgId);
      expect(scan).toBeTruthy();
      expect(scan.test_type).toBe('RADIOLOGY');
      expect(scan.status).toBe('COMPLETED');
      expect(scan.completed).toBe(true);
      expect(/anomaly/i.test(String(scan.test_name))).toBe(true);
    });

    it('excludes non-obstetric imaging (a chest X-ray) from prior_imaging', async () => {
      const cxr = await prisma.$queryRawUnsafe(
        `INSERT INTO investigations
           (phone, patient_id, patient_uid, test_name, test_type, status,
            priority, requested_by, requested_at, created_at, updated_at)
         VALUES ('9000090301', $1::int, $2::uuid, 'Chest X-Ray PA View',
                 'RADIOLOGY', 'COMPLETED', 'NORMAL', $3::uuid,
                 NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days', NOW())
         RETURNING id`, patientId, PATIENT_UID, DOCTOR_UID);
      const cxrId = cxr[0].id;
      try {
        const timeline = await getAncTimelineForPregnancy({
          tenantId: TENANT, pregnancy_id: pregnancyId,
        });
        expect(timeline.prior_imaging.find((i) => i.id === cxrId)).toBeFalsy();
        // The anomaly scan is still there.
        expect(timeline.prior_imaging.find((i) => i.id === anomalyUsgId)).toBeTruthy();
      } finally {
        await prisma.$executeRawUnsafe(
          `DELETE FROM investigations WHERE id=$1`, cxrId).catch(() => {});
      }
    });

    it('prior-orders investigations include the completed anomaly USG', async () => {
      const prior = await listPriorOrdersForPregnancy({
        tenantId: TENANT, pregnancy_id: pregnancyId,
      });
      expect(Array.isArray(prior.investigations)).toBe(true);
      const scan = prior.investigations.find((i) => i.id === anomalyUsgId);
      expect(scan).toBeTruthy();
      expect(scan.status).toBe('COMPLETED');
    });

    it('continues an active supplement row instead of creating duplicate reminders', async () => {
      const first = await recordSupplement({
        tenantId: TENANT,
        pregnancy_id: pregnancyId,
        supplement: 'iron',
        dose: '60mg + FA 500mcg',
        frequency: 'once_daily',
        prescribed_by: DOCTOR_UID,
      });
      const second = await recordSupplement({
        tenantId: TENANT,
        pregnancy_id: pregnancyId,
        supplement: 'iron',
        dose: '60mg + FA 500mcg',
        frequency: 'once_daily',
        notes: 'Continue IFA',
        prescribed_by: DOCTOR_UID,
      });

      expect(first.continued).toBe(false);
      expect(second.continued).toBe(true);
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id FROM maternity_supplements
          WHERE pregnancy_id=$1::int
            AND supplement='iron'
            AND (end_date IS NULL OR end_date >= CURRENT_DATE)`,
        pregnancyId,
      );
      expect(rows.length).toBe(1);

      const reminders = await getActiveReminders(PATIENT_UID);
      const ancIron = reminders.filter((r) =>
        r.source === 'anc_supplement' && /iron/i.test(String(r.medication_name || '')));
      expect(ancIron.length).toBe(1);
    });
  });

  describe('patient ANC route access', () => {
    function patientGet(path, uid = PATIENT_UID, id = patientId) {
      const token = generateTestToken('PATIENT', { uid, id });
      return request(app)
        .get(path)
        .set('x-api-key', API_KEY)
        .set('Authorization', `Bearer ${token}`);
    }

    function doctorGet(path) {
      const token = generateTestToken('DOCTOR', { uid: DOCTOR_UID });
      return request(app)
        .get(path)
        .set('x-api-key', API_KEY)
        .set('Authorization', `Bearer ${token}`);
    }

    it('fails closed when imaging rows have no schema-backed patient release signal', () => {
      const source = {
        pregnancy: { id: pregnancyId },
        prior_imaging: [
          { status: 'REQUESTED', result_summary: 'draft narrative' },
          { status: 'PRELIMINARY', interpretation: 'preliminary interpretation' },
          {
            status: 'COMPLETED',
            verified_at: '2026-07-13T00:00:00.000Z',
            patient_notified_at: '2026-07-13T00:05:00.000Z',
            notes: 'staff note',
            result_summary: 'verified but unreleased narrative',
          },
          {
            status: 'COMPLETED',
            released_to_patient_at: '2026-07-13T00:10:00.000Z',
            internal_narrative: 'untrusted release-like field',
          },
        ],
      };

      const projected = projectAncTimelineForPatient(source);
      const serialized = JSON.stringify(projected);

      expect(projected).not.toHaveProperty('prior_imaging');
      expect(source.prior_imaging).toHaveLength(4);
      expect(serialized).not.toMatch(/draft narrative|preliminary interpretation|staff note|unreleased|internal_narrative/);
    });

    it('lets a patient read only their own ANC timeline and kick log', async () => {
      const active = await patientGet(`/api/v1/maternity/pregnancies/active/${PATIENT_UID}`);
      expect(active.statusCode).toBe(200);
      expect(active.body.data?.patient_uid).toBe(PATIENT_UID);

      const timeline = await patientGet(`/api/v1/maternity/timeline/patient/${PATIENT_UID}`);
      expect(timeline.statusCode).toBe(200);
      expect(timeline.body.data?.pregnancy?.patient_uid).toBe(PATIENT_UID);

      const pregnancyTimeline = await patientGet(`/api/v1/maternity/pregnancies/${pregnancyId}/timeline`);
      expect(pregnancyTimeline.statusCode).toBe(200);

      const kicks = await patientGet(`/api/v1/maternity/fetal-kicks/pregnancy/${pregnancyId}`);
      expect(kicks.statusCode).toBe(200);

      const forbidden = await patientGet(`/api/v1/maternity/timeline/patient/${DOCTOR_UID}`);
      expect(forbidden.statusCode).toBe(403);
    });

    it('omits prior imaging from every patient ANC timeline boundary', async () => {
      const responses = await Promise.all([
        patientGet('/api/v1/portal/maternity/timeline'),
        patientGet(`/api/v1/maternity/timeline/patient/${PATIENT_UID}`),
        patientGet(`/api/v1/maternity/pregnancies/${pregnancyId}/timeline`),
      ]);

      for (const response of responses) {
        expect(response.statusCode).toBe(200);
        expect(response.body.data).not.toHaveProperty('prior_imaging');
        expect(JSON.stringify(response.body.data)).not.toContain('No structural anomaly detected');
      }
    });

    it('preserves prior imaging and its narrative on the staff ANC timeline', async () => {
      const response = await doctorGet(`/api/v1/maternity/pregnancies/${pregnancyId}/timeline`);

      expect(response.statusCode).toBe(200);
      const scan = response.body.data?.prior_imaging?.find((row) => row.id === anomalyUsgId);
      expect(scan).toBeTruthy();
      expect(scan.result_summary).toBe('No structural anomaly detected');
    });
  });

  // ── F1 — appointment detail carries pregnancy context ──────────────
  describe('getAppointmentById', () => {
    it('attaches pregnancy_context with computed gestational age', async () => {
      const appt = await appointmentQueryService.getAppointmentById(appointmentId);
      expect(appt.pregnancy_context).toBeTruthy();
      expect(appt.pregnancy_context.pregnancy_id).toBe(pregnancyId);
      expect(appt.pregnancy_context.gestational_age).toBeTruthy();
      expect(appt.pregnancy_context.gestational_age.weeks).toBe(24);
    });
  });

  // ── F4 — soft duplicate-order guard ────────────────────────────────
  describe('createInvestigationOrder duplicate guard', () => {
    it('warns (does not block) on a repeat order within the window', async () => {
      // Distinct test_name from the 18-week anomaly scan seeded in
      // beforeAll, so the "first order has no prior warning" assertion
      // isn't tripped by the H7 prior-imaging fixture.
      const order = {
        patient_id: patientId,
        test_name: 'Growth Scan (Third Trimester Ultrasound)',
        type: 'RADIOLOGY',
        priority: 'NORMAL',
        orderedBy: DOCTOR_UID,
      };
      const first = await createInvestigationOrder(order);
      expect(first.investigation.id).toBeTruthy();
      expect(first.duplicate_warning).toBeNull();

      const second = await createInvestigationOrder(order);
      expect(second.investigation.id).toBeTruthy(); // still created — soft guard
      expect(second.duplicate_warning).toBeTruthy();
      expect(second.duplicate_warning.recent_order_id).toBe(first.investigation.id);
    });
  });

  // ── F5 — ANC trimester advice (migration 226) ──────────────────────
  describe('getAncAdvice', () => {
    it('returns seeded trimester advice rows', async () => {
      const all = await getAncAdvice({ tenantId: TENANT });
      expect(all.length).toBeGreaterThanOrEqual(12);
      const t2 = await getAncAdvice({ tenantId: TENANT, trimester: 2 });
      expect(t2.length).toBe(4);
      expect(t2.every((r) => r.trimester === 2)).toBe(true);
      expect(t2.map((r) => r.category).sort()).toEqual(
        ['danger_signs', 'fetal_movement', 'foods_to_avoid', 'when_to_contact']);
    });

    it('redacts clinical-review placeholders for patient-facing reads', async () => {
      const rows = await getAncAdvice({ tenantId: TENANT, trimester: 2, includePlaceholders: false });
      expect(rows.length).toBe(4);
      expect(rows.every((r) => r.content_status === 'pending_clinical_review')).toBe(true);
      expect(rows.every((r) => r.content === null)).toBe(true);
      expect(rows.some((r) => /PLACEHOLDER/i.test(String(r.content)))).toBe(false);
    });

    it('rejects an out-of-range trimester', async () => {
      await expect(getAncAdvice({ tenantId: TENANT, trimester: 9 })).rejects.toThrow();
    });
  });

  // ── F6 — maternity packages (migration 226) ────────────────────────
  describe('listMaternityPackages', () => {
    it('returns obstetrics packages with placeholder pricing (no invented prices)', async () => {
      const packages = await listMaternityPackages({ tenantId: TENANT });
      expect(packages.length).toBeGreaterThanOrEqual(3);
      const codes = packages.map((p) => p.package_code);
      expect(codes).toContain('MAT-NORMAL-DELIVERY');
      expect(codes).toContain('MAT-C-SECTION');
      for (const pkg of packages) {
        expect(pkg.base_specialty).toBe('obstetrics');
        expect(pkg.fixed_price_minor).toBeNull();
        expect(String(pkg.price_status)).toContain('PLACEHOLDER');
      }
    });
  });
});
