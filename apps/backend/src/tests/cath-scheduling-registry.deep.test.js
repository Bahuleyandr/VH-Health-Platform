// NL13-P1f deep integration: cath rooms on the Scheduling 2.0 rails,
// dose-audit rollups with owner thresholds, complication registry feeding the
// quality cockpit + BI catalog, and RLS in both directions.

import prisma from '../lib/prisma.js';
import {
  cancelCaseSchedule,
  getCaseSchedule,
  getDoseAlertSettings,
  getDoseRollup,
  getScheduleStrip,
  listRegistry,
  scheduleCase,
  setDoseAlertSettings,
  updateRegistryReview
} from '../services/clinical/cathSchedulingRegistryService.js';
import {
  addContrastRadiationRecord,
  recordProcedureLog
} from '../services/clinical/cathLabService.js';
import { createResource } from '../services/scheduling/schedulingOptimizationService.js';
import { computeIndicators } from '../services/quality/nabhIndicatorService.js';
import { listDatasetCatalog } from '../services/dashboards/analyticsCatalogService.js';

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const describeIfDb = hasDatabaseUrl ? describe : describe.skip;

// Keep rollup fixtures off the default tenant, whose comprehensive seed rows use NOW().
const TENANT_A = 'f1f00000-0000-4000-8000-00000000a000';
const TENANT_B = '00000000-0000-4000-8000-00000000f1fb';
const PATIENT_A = 'f1f00000-0000-4000-8000-00000000a001';
const PATIENT_A2 = 'f1f00000-0000-4000-8000-00000000a004';
const DOCTOR_A = 'f1f00000-0000-4000-8000-00000000a002';
const PATIENT_B = 'f1f00000-0000-4000-8000-00000000b001';
const RLS_ROLE = 'cath_sched_rls_app';
const ROOM_NAME = 'P1F Cath Room 1';

// 2026-08-03 in IST: bookings at 10:00–11:00 and 12:00–13:00 IST.
const STRIP_DATE = '2026-08-03';
const BOOK1_START = '2026-08-03T04:30:00.000Z';
const BOOK1_END = '2026-08-03T05:30:00.000Z';
const BOOK2_START = '2026-08-03T06:30:00.000Z';
const BOOK2_END = '2026-08-03T07:30:00.000Z';
const EMERGENCY_START = '2026-08-03T05:00:00.000Z';

const PERIOD_FROM = '2026-08-01';
const PERIOD_TO = '2026-08-31';
const DOSE_AT_1 = '2026-08-03T06:00:00.000Z';
const DOSE_AT_2 = '2026-08-10T06:00:00.000Z';

function actor(uid, role) {
  return {
    actorUid: uid,
    actorRole: role,
    requestId: 'cath-sched-deep',
    ipAddress: '127.0.0.1',
    userAgent: 'cath-scheduling-deep-test'
  };
}

async function maintenanceCleanup() {
  await prisma.$transaction(async (tx) => {
    // Teardown runs only on the disposable deep-test database. Disabling user
    // and constraint triggers for this one transaction is what keeps the whole
    // cleanup inside Prisma's 5 s interactive-transaction budget — see the same
    // note in cath-reporting.deep.test.js. Production paths are untouched.
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events WHERE patient_uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_A, PATIENT_A2, PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE patient_uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_A, PATIENT_A2, PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM cath_complication_registry WHERE patient_uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_A, PATIENT_A2, PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM cath_case_schedule_links WHERE case_id IN (
         SELECT id FROM cath_lab_cases WHERE patient_uid IN ($1::uuid, $2::uuid, $3::uuid)
       )`,
      PATIENT_A, PATIENT_A2, PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM resource_bookings WHERE resource_id IN (
         SELECT id FROM bookable_resources WHERE name = $1
       )`,
      ROOM_NAME,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM cath_contrast_radiation_records WHERE patient_uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_A, PATIENT_A2, PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM cath_procedure_logs WHERE patient_uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_A, PATIENT_A2, PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM cath_lab_readiness_checks WHERE case_id IN (
         SELECT id FROM cath_lab_cases WHERE patient_uid IN ($1::uuid, $2::uuid, $3::uuid)
       )`,
      PATIENT_A, PATIENT_A2, PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances WHERE patient_uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_A, PATIENT_A2, PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM cath_lab_cases WHERE patient_uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_A, PATIENT_A2, PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM bookable_resources WHERE name = $1`,
      ROOM_NAME,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM cath_dose_alert_settings WHERE tenant_id IN ($1::uuid, $2::uuid)`,
      TENANT_A, TENANT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      PATIENT_A, PATIENT_A2, DOCTOR_A, PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
      TENANT_A, TENANT_B,
    );
  });
}

async function asRlsRole(tenantId, sql, ...params) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${RLS_ROLE}`);
    await tx.$executeRawUnsafe(
      "SELECT set_config('app.current_tenant_id', $1, true)",
      tenantId,
    );
    return tx.$queryRawUnsafe(sql, ...params);
  });
}

async function insertCase({ patientUid, urgency, status, plannedStartAt = null, actualStartAt = null }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO cath_lab_cases
       (tenant_id, patient_uid, requested_procedure, urgency, status,
        planned_start_at, actual_start_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::timestamptz, $7::timestamptz)
     RETURNING id, patient_uid, urgency, status`,
    TENANT_A,
    patientUid,
    `P1F ${urgency} case`,
    urgency,
    status,
    plannedStartAt,
    actualStartAt,
  );
  return rows[0];
}

async function clearReadiness(caseId) {
  await prisma.$executeRawUnsafe(
    `UPDATE cath_lab_readiness_checks
        SET status = 'pass', completed_at = NOW()
      WHERE tenant_id = $1::uuid AND case_id = $2::bigint`,
    TENANT_A,
    caseId,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO cath_lab_readiness_checks (tenant_id, case_id, check_type, status, required, completed_at)
     SELECT $1::uuid, $2::bigint, t.check_type, 'pass', TRUE, NOW()
       FROM (VALUES ('consent'), ('labs'), ('allergy_renal_risk'), ('anticoagulation'),
                    ('blood_bank'), ('equipment'), ('implants_device_rep'), ('timeout')) AS t(check_type)
     ON CONFLICT (tenant_id, case_id, check_type)
       DO UPDATE SET status = 'pass', completed_at = NOW()`,
    TENANT_A,
    caseId,
  );
}

describeIfDb('NL-13 P1f cath scheduling + registries deep integration', () => {
  let roomId;
  let electiveCase;
  let elective2;
  let emergencyCase;
  let bookedLink;

  beforeAll(async () => {
    await maintenanceCleanup();
    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RLS_ROLE}') THEN
          CREATE ROLE ${RLS_ROLE} NOLOGIN;
        END IF;
      END $$
    `);
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${RLS_ROLE}`);
    await prisma.$executeRawUnsafe(
      `GRANT SELECT ON cath_lab_cases, cath_case_schedule_links, cath_complication_registry,
                       cath_dose_alert_settings, cath_contrast_radiation_records,
                       resource_bookings, bookable_resources TO ${RLS_ROLE}`,
    );
    await prisma.$executeRawUnsafe(
      `GRANT INSERT ON cath_complication_registry TO ${RLS_ROLE}`,
    );
    // Sequence usage too, so the cross-tenant write test exercises the RLS
    // WITH CHECK policy rather than a missing sequence grant.
    await prisma.$executeRawUnsafe(
      `GRANT USAGE ON SEQUENCE cath_complication_registry_id_seq TO ${RLS_ROLE}`,
    );

    await prisma.$queryRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status)
       VALUES ($1::uuid, 'p1f-tenant-a', 'P1F Tenant A', 'IN', 'DPDP', 'active')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_A,
    );
    await prisma.$queryRawUnsafe(
      `INSERT INTO users (tenant_id, uid, phone, name, role, is_active, updated_at)
       VALUES
         ($1::uuid, $2::uuid, '9012997001', 'P1F Patient A', 'PATIENT', TRUE, NOW()),
         ($1::uuid, $3::uuid, '9012997004', 'P1F Patient A2', 'PATIENT', TRUE, NOW()),
         ($1::uuid, $4::uuid, '9012997002', 'Dr P1F Operator', 'DOCTOR', TRUE, NOW())`,
      TENANT_A, PATIENT_A, PATIENT_A2, DOCTOR_A,
    );
    await prisma.$queryRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status)
       VALUES ($1::uuid, 'p1f-tenant-b', 'P1F Tenant B', 'IN', 'DPDP', 'active')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_B,
    );
    await prisma.$queryRawUnsafe(
      `INSERT INTO users (tenant_id, uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2::uuid, '9012997003', 'P1F Patient B', 'PATIENT', TRUE, NOW())`,
      TENANT_B, PATIENT_B,
    );

    const room = await createResource({
      kind: 'room',
      name: ROOM_NAME,
      location: 'Cath Lab Block',
      tenantId: TENANT_A,
    });
    roomId = room.id;

    electiveCase = await insertCase({
      patientUid: PATIENT_A,
      urgency: 'elective',
      status: 'scheduled',
    });
    elective2 = await insertCase({
      patientUid: PATIENT_A2,
      urgency: 'routine',
      status: 'scheduled',
    });
    emergencyCase = await insertCase({
      patientUid: PATIENT_A2,
      urgency: 'emergency',
      status: 'in_progress',
      actualStartAt: EMERGENCY_START,
    });
  }, 120000);

  afterAll(async () => {
    await maintenanceCleanup();
    await prisma.$disconnect();
  });

  describe('cath rooms on the Scheduling 2.0 rails', () => {
    it('books an elective case into a room slot and links it to the case', async () => {
      bookedLink = await scheduleCase(
        electiveCase.id,
        {
          tenantId: TENANT_A,
          resource_id: roomId,
          starts_at: BOOK1_START,
          ends_at: BOOK1_END,
        },
        actor(DOCTOR_A, 'DOCTOR'),
      );
      expect(Number(bookedLink.case_id)).toBe(Number(electiveCase.id));
      expect(bookedLink.status).toBe('active');
      expect(bookedLink.resource_name).toBe(ROOM_NAME);

      const bookingRows = await prisma.$queryRawUnsafe(
        `SELECT id, status, booked_for_type, booked_for_id, patient_uid
           FROM resource_bookings WHERE id = $1::int AND tenant_id = $2::uuid`,
        bookedLink.resource_booking_id, TENANT_A,
      );
      expect(bookingRows).toHaveLength(1);
      expect(bookingRows[0].status).toBe('booked');
      expect(bookingRows[0].booked_for_type).toBe('other');
      expect(bookingRows[0].booked_for_id).toBe(`cath_case:${electiveCase.id}`);
      expect(bookingRows[0].patient_uid).toBe(PATIENT_A);

      // Assert the stored INSTANT via SQL text — Prisma's raw reads render
      // timestamptz through the server timezone, so a JS-side toISOString()
      // comparison would false-fail on non-UTC dev clusters (IST).
      const caseRows = await prisma.$queryRawUnsafe(
        `SELECT (planned_start_at AT TIME ZONE 'UTC')::text AS planned_start_utc,
                (planned_end_at AT TIME ZONE 'UTC')::text AS planned_end_utc,
                lab_room
           FROM cath_lab_cases WHERE id = $1::bigint AND tenant_id = $2::uuid`,
        electiveCase.id, TENANT_A,
      );
      expect(caseRows[0].planned_start_utc).toBe('2026-08-03 04:30:00');
      expect(caseRows[0].planned_end_utc).toBe('2026-08-03 05:30:00');
      expect(caseRows[0].lab_room).toBe(ROOM_NAME);

      const schedule = await getCaseSchedule(electiveCase.id, { tenantId: TENANT_A });
      expect(schedule.booking).not.toBeNull();
      expect(Number(schedule.booking.resource_booking_id)).toBe(Number(bookedLink.resource_booking_id));
    });

    it('rejects an overlapping booking through the shared no-overlap rails', async () => {
      await expect(scheduleCase(
        elective2.id,
        {
          tenantId: TENANT_A,
          resource_id: roomId,
          starts_at: BOOK1_START,
          ends_at: BOOK1_END,
        },
        actor(DOCTOR_A, 'DOCTOR'),
      )).rejects.toMatchObject({ code: 'SCHED_RESOURCE_CLASH' });
    });

    it('rejects double-booking the same case', async () => {
      await expect(scheduleCase(
        electiveCase.id,
        {
          tenantId: TENANT_A,
          resource_id: roomId,
          starts_at: BOOK2_START,
          ends_at: BOOK2_END,
        },
        actor(DOCTOR_A, 'DOCTOR'),
      )).rejects.toMatchObject({ code: 'CATH_SCHED_ALREADY_BOOKED' });
    });

    it('emergency cases bypass booking entirely', async () => {
      await expect(scheduleCase(
        emergencyCase.id,
        {
          tenantId: TENANT_A,
          resource_id: roomId,
          starts_at: BOOK2_START,
          ends_at: BOOK2_END,
        },
        actor(DOCTOR_A, 'DOCTOR'),
      )).rejects.toMatchObject({ code: 'CATH_SCHED_EMERGENCY_BYPASS' });
    });

    it('flags the strip with a soft conflict while never touching the booking', async () => {
      const strip = await getScheduleStrip({ tenantId: TENANT_A, date: STRIP_DATE });
      expect(strip.date).toBe(STRIP_DATE);
      expect(strip.bookings).toHaveLength(1);
      const stripBooking = strip.bookings[0];
      expect(Number(stripBooking.case_id)).toBe(Number(electiveCase.id));
      expect(stripBooking.soft_conflict).toBe(true);
      expect(stripBooking.conflicting_emergency_case_ids.map(Number)).toContain(Number(emergencyCase.id));
      expect(strip.has_soft_conflict).toBe(true);
      expect(strip.emergencies.map((e) => Number(e.id))).toContain(Number(emergencyCase.id));

      // The overlapped booking is still booked — soft conflict only.
      const bookingRows = await prisma.$queryRawUnsafe(
        `SELECT status FROM resource_bookings WHERE id = $1::int`,
        stripBooking.resource_booking_id,
      );
      expect(bookingRows[0].status).toBe('booked');
    });

    it('cancels a booking and frees the slot for rebooking', async () => {
      const cancelled = await cancelCaseSchedule(
        electiveCase.id,
        { tenantId: TENANT_A, reason: 'patient rescheduled' },
        actor(DOCTOR_A, 'DOCTOR'),
      );
      expect(cancelled.status).toBe('cancelled');
      const bookingRows = await prisma.$queryRawUnsafe(
        `SELECT status FROM resource_bookings WHERE id = $1::int`,
        bookedLink.resource_booking_id,
      );
      expect(bookingRows[0].status).toBe('cancelled');

      // Slot is free again: the second case can now book the same window.
      const rebooked = await scheduleCase(
        elective2.id,
        {
          tenantId: TENANT_A,
          resource_id: roomId,
          starts_at: BOOK1_START,
          ends_at: BOOK1_END,
        },
        actor(DOCTOR_A, 'DOCTOR'),
      );
      expect(rebooked.status).toBe('active');
    });
  });

  describe('dose-audit rollups with owner thresholds', () => {
    beforeAll(async () => {
      await clearReadiness(emergencyCase.id);
      await addContrastRadiationRecord(
        emergencyCase.id,
        {
          tenantId: TENANT_A,
          contrast_volume_ml: 120,
          fluoroscopy_time_min: 14.5,
          dose_area_product_gy_cm2: 90,
          air_kerma_mgy: 700,
          recorded_at: DOSE_AT_1,
        },
        actor(DOCTOR_A, 'DOCTOR'),
      );
      await addContrastRadiationRecord(
        emergencyCase.id,
        {
          tenantId: TENANT_A,
          contrast_volume_ml: 260,
          fluoroscopy_time_min: 41,
          dose_area_product_gy_cm2: 310,
          air_kerma_mgy: 2400,
          recorded_at: DOSE_AT_2,
        },
        actor(DOCTOR_A, 'DOCTOR'),
      );
    });

    it('fails closed to thresholds_pending before the owner configures limits', async () => {
      const settings = await getDoseAlertSettings(TENANT_A);
      expect(settings.thresholds_status).toBe('thresholds_pending');
      expect(settings.configured).toBe(false);

      const rollup = await getDoseRollup({
        tenantId: TENANT_A,
        from: PERIOD_FROM,
        to: PERIOD_TO,
        groupBy: 'month',
      });
      expect(rollup.thresholds_status).toBe('thresholds_pending');
      expect(rollup.thresholds).toBeNull();
      expect(rollup.rows).toHaveLength(1);
      expect(rollup.rows[0].bucket).toBe('2026-08');
      expect(rollup.rows[0].record_count).toBe(2);
      expect(rollup.rows[0].case_count).toBe(1);
      expect(Number(rollup.rows[0].total_contrast_ml)).toBeCloseTo(380);
      expect(rollup.rows[0].breach_count).toBeNull();
    });

    it('counts breaches once the owner configures thresholds', async () => {
      await setDoseAlertSettings(
        TENANT_A,
        {
          fluoro_time_alert_min: 30,
          dap_alert_gy_cm2: 300,
          air_kerma_alert_mgy: 2000,
          contrast_volume_alert_ml: 200,
        },
        actor(DOCTOR_A, 'QUALITY_OFFICER'),
      );
      const rollup = await getDoseRollup({
        tenantId: TENANT_A,
        from: PERIOD_FROM,
        to: PERIOD_TO,
        groupBy: 'month',
      });
      expect(rollup.thresholds_status).toBe('configured');
      expect(rollup.rows[0].breach_count).toBe(1);

      const monthly = await getDoseRollup({
        tenantId: TENANT_A,
        from: '2026-08-01',
        to: '2026-08-05',
        groupBy: 'month',
      });
      expect(monthly.rows[0].record_count).toBe(1);
      expect(monthly.rows[0].breach_count).toBe(0);
    });

    it('rolls up per operator from the linked procedure log operators', async () => {
      const logged = await recordProcedureLog(
        emergencyCase.id,
        {
          tenantId: TENANT_A,
          procedure_type: 'Primary PCI',
          operators: [{ name: 'Dr P1F Operator', uid: DOCTOR_A }],
          complications: [],
          started_at: EMERGENCY_START,
        },
        actor(DOCTOR_A, 'DOCTOR'),
      );
      await addContrastRadiationRecord(
        emergencyCase.id,
        {
          tenantId: TENANT_A,
          procedure_log_id: logged.id,
          contrast_volume_ml: 90,
          fluoroscopy_time_min: 9,
          recorded_at: DOSE_AT_1,
        },
        actor(DOCTOR_A, 'DOCTOR'),
      );
      const rollup = await getDoseRollup({
        tenantId: TENANT_A,
        from: PERIOD_FROM,
        to: PERIOD_TO,
        groupBy: 'operator',
      });
      const buckets = Object.fromEntries(rollup.rows.map((r) => [r.bucket, r]));
      expect(buckets['Dr P1F Operator']).toBeDefined();
      expect(buckets['Dr P1F Operator'].record_count).toBe(1);
      expect(buckets.unattributed.record_count).toBe(2);
    });
  });

  describe('complication registry → cockpit + BI catalog', () => {
    let registryEntryId;

    it('derives registry rows from procedure-log complications atomically', async () => {
      const logged = await recordProcedureLog(
        emergencyCase.id,
        {
          tenantId: TENANT_A,
          procedure_type: 'Primary PCI — complication pass',
          operators: [{ name: 'Dr P1F Operator' }],
          complications: [
            { category: 'vascular_access', description: 'Access-site hematoma', severity: 'minor' },
            'No-reflow phenomenon',
          ],
          started_at: EMERGENCY_START,
          ended_at: '2026-08-03T06:15:00.000Z',
        },
        actor(DOCTOR_A, 'DOCTOR'),
      );
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id, complication_category, severity, review_status, source,
                procedure_log_id, timeline_event_id, audit_event_id
           FROM cath_complication_registry
          WHERE tenant_id = $1::uuid AND procedure_log_id = $2::bigint
          ORDER BY id`,
        TENANT_A, logged.id,
      );
      expect(rows).toHaveLength(2);
      expect(rows[0].complication_category).toBe('vascular_access');
      expect(rows[0].severity).toBe('minor');
      expect(rows[0].review_status).toBe('open');
      expect(rows[0].source).toBe('procedure_log');
      expect(rows[0].timeline_event_id).not.toBeNull();
      expect(rows[0].audit_event_id).not.toBeNull();
      expect(rows[1].complication_category).toBe('uncategorised');
      registryEntryId = rows[0].id;
    });

    it('lists the registry with case + patient context', async () => {
      const entries = await listRegistry({
        tenantId: TENANT_A,
        from: PERIOD_FROM,
        to: PERIOD_TO,
      });
      expect(entries.length).toBeGreaterThanOrEqual(2);
      const entry = entries.find((e) => Number(e.id) === Number(registryEntryId));
      expect(entry).toBeDefined();
      expect(entry.patient_name).toBe('P1F Patient A2');
      expect(entry.urgency).toBe('emergency');
    });

    it('walks the review lifecycle and audits each transition', async () => {
      const underReview = await updateRegistryReview(
        registryEntryId,
        { tenantId: TENANT_A, review_status: 'under_review', review_notes: 'M&M queued' },
        actor(DOCTOR_A, 'QUALITY_OFFICER'),
      );
      expect(underReview.review_status).toBe('under_review');
      const closed = await updateRegistryReview(
        registryEntryId,
        { tenantId: TENANT_A, review_status: 'closed', outcome: 'resolved' },
        actor(DOCTOR_A, 'QUALITY_OFFICER'),
      );
      expect(closed.review_status).toBe('closed');
      expect(closed.outcome).toBe('resolved');

      // closed is terminal except reopen to under_review.
      await expect(updateRegistryReview(
        registryEntryId,
        { tenantId: TENANT_A, review_status: 'reviewed' },
        actor(DOCTOR_A, 'QUALITY_OFFICER'),
      )).rejects.toMatchObject({ statusCode: 400 });

      const audits = await prisma.$queryRawUnsafe(
        `SELECT action_status FROM clinical_audit_events
          WHERE action = 'cath_lab.complication_review_updated'
            AND resource_id = $1
          ORDER BY occurred_at`,
        String(registryEntryId),
      );
      expect(audits.length).toBeGreaterThanOrEqual(2);
    });

    it('feeds the quality cockpit with cath indicators computed from real rows', async () => {
      // Complete the emergency case inside the period so volume/rate count it.
      await prisma.$executeRawUnsafe(
        `UPDATE cath_lab_cases
            SET status = 'completed', actual_end_at = $3::timestamptz, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::bigint`,
        TENANT_A, emergencyCase.id, '2026-08-03T06:30:00.000Z',
      );
      const pack = await computeIndicators({ from: PERIOD_FROM, to: PERIOD_TO, tenantId: TENANT_A });
      const byCode = Object.fromEntries(pack.indicators.map((i) => [i.code, i]));

      expect(byCode.cath_case_volume.available).toBe(true);
      expect(byCode.cath_case_volume.value).toBeGreaterThanOrEqual(1);
      expect(byCode.cath_case_volume.details.by_urgency.emergency).toBeGreaterThanOrEqual(1);

      expect(byCode.cath_complication_rate_pct.available).toBe(true);
      expect(byCode.cath_complication_rate_pct.numerator).toBeGreaterThanOrEqual(1);
      expect(byCode.cath_complication_rate_pct.denominator).toBeGreaterThanOrEqual(1);
      expect(byCode.cath_complication_rate_pct.value).toBeGreaterThan(0);

      expect(byCode.cath_dose_outlier_count.available).toBe(true);
      expect(byCode.cath_dose_outlier_count.details.thresholds_status).toBe('configured');
      expect(byCode.cath_dose_outlier_count.value).toBe(1);
    });

    it('reports thresholds_pending on the cockpit when the owner has not configured limits', async () => {
      await prisma.$executeRawUnsafe(
        `DELETE FROM cath_dose_alert_settings WHERE tenant_id = $1::uuid`,
        TENANT_A,
      );
      const pack = await computeIndicators({ from: PERIOD_FROM, to: PERIOD_TO, tenantId: TENANT_A });
      const outlier = pack.indicators.find((i) => i.code === 'cath_dose_outlier_count');
      expect(outlier.available).toBe(true);
      expect(outlier.value).toBeNull();
      expect(outlier.details.thresholds_status).toBe('thresholds_pending');
    });

    it('registers the registry as a read-only BI catalog dataset', async () => {
      const datasets = await listDatasetCatalog();
      const registry = datasets.find((d) => d.key === 'cath_complication_registry');
      expect(registry).toBeDefined();
      expect(registry.phiClass).toBe('restricted_phi');
      expect(registry.exportPolicy).toBe('governed_aggregate_only');
      expect(registry.certificationStatus).toBe('internal_only');
      const patientField = registry.fields.find((f) => f.fieldName === 'patient_uid');
      expect(patientField.hiddenByDefault).toBe(true);
      expect(patientField.backendDrilldownOnly).toBe(true);
    });
  });

  describe('RLS both directions', () => {
    it('tenant A sees its rows through the RLS role', async () => {
      const links = await asRlsRole(
        TENANT_A,
        `SELECT id FROM cath_case_schedule_links`,
      );
      expect(links.length).toBeGreaterThanOrEqual(1);
      const registry = await asRlsRole(
        TENANT_A,
        `SELECT id FROM cath_complication_registry`,
      );
      expect(registry.length).toBeGreaterThanOrEqual(2);
    });

    it('tenant B sees nothing', async () => {
      for (const table of ['cath_case_schedule_links', 'cath_complication_registry', 'cath_dose_alert_settings']) {
        const rows = await asRlsRole(TENANT_B, `SELECT * FROM ${table}`);
        expect(rows).toHaveLength(0);
      }
    });

    it('tenant B cannot write rows stamped for tenant A', async () => {
      const anyCase = await prisma.$queryRawUnsafe(
        `SELECT id FROM cath_lab_cases WHERE tenant_id = $1::uuid LIMIT 1`,
        TENANT_A,
      );
      await expect(asRlsRole(
        TENANT_B,
        `INSERT INTO cath_complication_registry
           (tenant_id, case_id, patient_uid, complication_category)
         VALUES ($1::uuid, $2::bigint, $3::uuid, 'cross_tenant_probe')
         RETURNING id`,
        TENANT_A, anyCase[0].id, PATIENT_A,
      )).rejects.toThrow();
    });
  });
});
