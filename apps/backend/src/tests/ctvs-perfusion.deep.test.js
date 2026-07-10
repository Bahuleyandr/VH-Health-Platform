import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';
import {
  createPerfusionDeviceLink,
  createPerfusionRecord,
  finalizePerfusionSignoff,
  upsertCtvsCaseOverlay,
  upsertPerfusionSignoff,
} from '../services/theatre/ctvsPerfusionService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const RUN = `CTVSP5${Date.now()}`;
const OT_DATE = '2031-03-18';

let patientUid;
let surgeonUid;
let anesthetistUid;
let perfusionistUid;
let scheduleId;
let activeAssociationId;
let inactiveAssociationId;
let recordId;
let signoffId;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events
      WHERE source_table IN ('perfusion_records', 'perfusion_signoffs')
        AND patient_uid IN (SELECT uid FROM users WHERE name LIKE $1)`,
    `${RUN}%`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM perfusion_device_links
      WHERE tenant_id = $1::uuid
        AND patient_uid IN (SELECT uid FROM users WHERE name LIKE $2)`,
    TENANT_ID,
    `${RUN}%`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM perfusion_signoffs
      WHERE tenant_id = $1::uuid
        AND patient_uid IN (SELECT uid FROM users WHERE name LIKE $2)`,
    TENANT_ID,
    `${RUN}%`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM perfusion_records
      WHERE tenant_id = $1::uuid
        AND patient_uid IN (SELECT uid FROM users WHERE name LIKE $2)`,
    TENANT_ID,
    `${RUN}%`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM ctvs_case_overlays
      WHERE tenant_id = $1::uuid
        AND patient_uid IN (SELECT uid FROM users WHERE name LIKE $2)`,
    TENANT_ID,
    `${RUN}%`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM device_patient_associations
      WHERE tenant_id = $1::uuid
        AND patient_uid IN (SELECT uid FROM users WHERE name LIKE $2)`,
    TENANT_ID,
    `${RUN}%`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM device_registry
      WHERE tenant_id = $1::uuid
        AND device_code LIKE $2`,
    TENANT_ID,
    `${RUN}%`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM anesthesia_records
      WHERE tenant_id = $1::uuid
        AND patient_uid IN (SELECT uid FROM users WHERE name LIKE $2)`,
    TENANT_ID,
    `${RUN}%`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM ot_schedules
      WHERE tenant_id = $1::uuid
        AND procedure_name LIKE $2`,
    TENANT_ID,
    `${RUN}%`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users
      WHERE tenant_id = $1::uuid
        AND name LIKE $2`,
    TENANT_ID,
    `${RUN}%`,
  ).catch(() => {});
}

async function seedUser(role, label, phone) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (tenant_id, phone, name, role, is_active, updated_at)
     VALUES ($1::uuid, $2, $3, $4, true, NOW())
     RETURNING uid`,
    TENANT_ID,
    phone,
    `${RUN} ${label}`,
    role,
  );
  return rows[0].uid;
}

d('NL-13 P5 CTVS/perfusion seam', () => {
  beforeAll(async () => {
    await cleanup();
    const suffix = String(Date.now()).slice(-8);
    patientUid = await seedUser('PATIENT', 'Patient', `+91910${suffix.slice(0, 5)}`);
    surgeonUid = await seedUser('DOCTOR', 'Surgeon', `+91911${suffix.slice(0, 5)}`);
    anesthetistUid = await seedUser('DOCTOR', 'Anesthetist', `+91912${suffix.slice(0, 5)}`);
    perfusionistUid = await seedUser('DOCTOR', 'Perfusionist', `+91913${suffix.slice(0, 5)}`);

    const scheduleRows = await prisma.$queryRawUnsafe(
      `INSERT INTO ot_schedules
         (tenant_id, patient_uid, surgeon, anesthetist, procedure_name, procedure_code,
          ot_room, scheduled_date, scheduled_time, equipment_needed, consent_obtained,
          status, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'CTVS', 'OT-CTVS',
               $6::date, '08:30'::time, '{}'::text[], true, 'scheduled', NOW(), NOW())
       RETURNING id`,
      TENANT_ID,
      patientUid,
      surgeonUid,
      anesthetistUid,
      `${RUN} CABG`,
      OT_DATE,
    );
    scheduleId = scheduleRows[0].id;

    await prisma.$queryRawUnsafe(
      `INSERT INTO anesthesia_records
         (tenant_id, ot_schedule_id, patient_uid, anesthetist, technique, status, created_at, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, 'general', 'draft', NOW(), NOW())`,
      TENANT_ID,
      scheduleId,
      patientUid,
      anesthetistUid,
    );

    const deviceRows = await prisma.$queryRawUnsafe(
      `INSERT INTO device_registry
         (tenant_id, device_code, display_name, kind, protocol, status, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, 'monitor_gateway', 'http-json', 'active', NOW(), NOW())
       RETURNING id`,
      TENANT_ID,
      `${RUN}-PUMP-GW`,
      `${RUN} owner-side perfusion gateway`,
    );

    const inactive = await prisma.$queryRawUnsafe(
      `INSERT INTO device_patient_associations
         (tenant_id, device_registry_id, channel, patient_uid, started_by, start_method, ended_at, end_reason, metadata)
       VALUES ($1::uuid, $2, 'perfusion-inactive', $3::uuid, $4::uuid, 'manual', NOW(), 'manual', '{}'::jsonb)
       RETURNING id`,
      TENANT_ID,
      deviceRows[0].id,
      patientUid,
      perfusionistUid,
    );
    inactiveAssociationId = inactive[0].id;

    const active = await prisma.$queryRawUnsafe(
      `INSERT INTO device_patient_associations
         (tenant_id, device_registry_id, channel, patient_uid, started_by, start_method, metadata)
       VALUES ($1::uuid, $2, 'perfusion-active', $3::uuid, $4::uuid, 'manual', '{}'::jsonb)
       RETURNING id`,
      TENANT_ID,
      deviceRows[0].id,
      patientUid,
      perfusionistUid,
    );
    activeAssociationId = active[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('links a minimal CTVS overlay to the existing theatre and anesthesia case', async () => {
    const overlay = await upsertCtvsCaseOverlay({
      tenantId: TENANT_ID,
      otScheduleId: scheduleId,
      procedureCategory: 'CABG',
      bypassExpected: true,
      bloodProductReadiness: { crossmatch_units: 4, owner_supplied: true },
      implantDeviceReadiness: { valve_implants_available: false, device_rep_required: false },
      policySourceLabel: 'owner-pending-ctvs-policy',
      policySourceVersion: 'pending',
      actorUid: surgeonUid,
    });
    expect(overlay.ot_schedule_id).toBe(scheduleId);
    expect(overlay.patient_uid).toBe(patientUid);
    expect(overlay.anesthesia_record_id).toBeTruthy();

    const doctor = authClient('DOCTOR', { uid: surgeonUid, tenant_id: TENANT_ID });
    const res = await doctor.get(`/api/v1/ctvs/overlays?ot_schedule_id=${scheduleId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.overlays).toHaveLength(1);
  });

  test('validates bypass and cross-clamp timing before writing', async () => {
    await expect(createPerfusionRecord({
      tenantId: TENANT_ID,
      otScheduleId: scheduleId,
      perfusionistUid,
      bypassStartedAt: '2031-03-18T09:30:00.000Z',
      bypassEndedAt: '2031-03-18T09:00:00.000Z',
    })).rejects.toThrow(/bypass_ended_at/);
  });

  test('records perfusion summary with canonical timeline and audit evidence', async () => {
    const record = await createPerfusionRecord({
      tenantId: TENANT_ID,
      otScheduleId: scheduleId,
      perfusionistUid,
      bypassStartedAt: '2031-03-18T04:00:00.000Z',
      bypassEndedAt: '2031-03-18T05:25:00.000Z',
      crossClampStartedAt: '2031-03-18T04:20:00.000Z',
      crossClampEndedAt: '2031-03-18T05:05:00.000Z',
      actBaselineSeconds: 132,
      actPeakSeconds: 512,
      actLastSeconds: 180,
      temperatureMinC: 32.4,
      temperatureMaxC: 36.6,
      fluidsProductsSummary: { packed_cells_units: 2, cell_saver_ml: 350 },
      complications: 'No bypass complications recorded.',
      recordPolicySourceLabel: 'owner-pending-perfusion-record-policy',
      recordPolicySourceVersion: 'pending',
      actorUid: perfusionistUid,
      actorRole: 'DOCTOR',
    });
    recordId = record.id;
    expect(record.bypass_time_minutes).toBe(85);
    expect(record.cross_clamp_time_minutes).toBe(45);
    expect(record.act_peak_seconds).toBe(512);

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type, source_table, source_id, payload
         FROM clinical_timeline_events
        WHERE patient_uid = $1::uuid
          AND source_table = 'perfusion_records'
          AND source_id = $2`,
      patientUid,
      String(recordId),
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0].event_type).toBe('perfusion.recorded');
    expect(Number(timeline[0].payload.bypass_time_minutes)).toBe(85);

    const audit = await prisma.$queryRawUnsafe(
      `SELECT action, resource_table, resource_id
         FROM clinical_audit_events
        WHERE patient_uid = $1::uuid
          AND resource_table = 'perfusion_records'
          AND resource_id = $2`,
      patientUid,
      String(recordId),
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  test('requires all reviews before finalizing perfusion sign-off', async () => {
    const partial = await upsertPerfusionSignoff({
      tenantId: TENANT_ID,
      perfusionRecordId: recordId,
      perfusionistSignedBy: perfusionistUid,
      signoffPolicySourceLabel: 'owner-pending-perfusion-signoff-policy',
      signoffPolicySourceVersion: 'pending',
    });
    signoffId = partial.id;
    await expect(finalizePerfusionSignoff({
      tenantId: TENANT_ID,
      id: signoffId,
      finalizedBy: surgeonUid,
      actorRole: 'DOCTOR',
    })).rejects.toThrow(/surgeon review, and anesthesia review/);

    const ready = await upsertPerfusionSignoff({
      tenantId: TENANT_ID,
      perfusionRecordId: recordId,
      surgeonReviewedBy: surgeonUid,
      anesthesiaReviewedBy: anesthetistUid,
    });
    expect(ready.status).toBe('ready_for_finalize');

    const finalized = await finalizePerfusionSignoff({
      tenantId: TENANT_ID,
      id: signoffId,
      finalizedBy: surgeonUid,
      actorRole: 'DOCTOR',
    });
    expect(finalized.status).toBe('finalized');

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type
         FROM clinical_timeline_events
        WHERE patient_uid = $1::uuid
          AND source_table = 'perfusion_signoffs'
          AND source_id = $2`,
      patientUid,
      String(signoffId),
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0].event_type).toBe('perfusion.signoff_finalized');
  });

  test('contracts device links to active NL-7 device-patient associations', async () => {
    await expect(createPerfusionDeviceLink({
      tenantId: TENANT_ID,
      perfusionRecordId: recordId,
      devicePatientAssociationId: inactiveAssociationId,
      vendorDocumentRef: `${RUN}-inactive.pdf`,
      actorUid: perfusionistUid,
    })).rejects.toThrow(/active NL-7 device-patient association/);

    const link = await createPerfusionDeviceLink({
      tenantId: TENANT_ID,
      perfusionRecordId: recordId,
      devicePatientAssociationId: activeAssociationId,
      vendorDocumentRef: `${RUN}-pump-summary.pdf`,
      vendorSourceLabel: 'owner-supplied perfusion pump summary',
      vendorSourceVersion: 'pending',
      summaryImportStatus: 'owner_supplied',
      importedSummary: { imported: false, owner_supplied_summary_only: true },
      actorUid: perfusionistUid,
    });
    expect(link.device_patient_association_id).toBe(activeAssociationId);
    expect(link.summary_import_status).toBe('owner_supplied');
  });
});
