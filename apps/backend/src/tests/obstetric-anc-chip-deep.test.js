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
import appointmentQueryService from '../services/appointment/appointmentQueryService.js';
import { createInvestigationOrder } from '../services/investigation/orderService.js';
import {
  computeAncScheduleMilestones,
  getAncAdvice,
  getAncTimelineForPregnancy,
  listMaternityPackages,
} from '../services/maternity/maternityService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c301';
const DOCTOR_UID = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c302';

describe('Obstetric/ANC chip — deep integration', () => {
  let patientId;
  let pregnancyId;
  let appointmentId;

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
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  // ── F3 — pure schedule milestone math ──────────────────────────────
  describe('computeAncScheduleMilestones', () => {
    it('returns the standard schedule with past/current/upcoming status', () => {
      // LMP 168 days ago → GA 24+0 → milestones up to 20w past, 26w current.
      const lmp = new Date(Date.now() - 168 * 86400000).toISOString().slice(0, 10);
      const milestones = computeAncScheduleMilestones(lmp);
      expect(milestones.length).toBe(7);
      expect(milestones.every((m) => m.target_date && m.status)).toBe(true);
      const booking = milestones.find((m) => m.ga_weeks === 12);
      const term = milestones.find((m) => m.ga_weeks === 39);
      expect(booking.status).toBe('past');
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
      expect(timeline.booked_visits.some((v) => v.id === appointmentId)).toBe(true);
      expect(timeline.schedule_milestones.length).toBe(7);
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
      const order = {
        patient_id: patientId,
        test_name: 'Anomaly Scan (Level II Ultrasound)',
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
