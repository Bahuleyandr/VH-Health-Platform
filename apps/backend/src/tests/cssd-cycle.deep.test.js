import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const RUN = `CSSDTEST${Date.now()}`;
const OT_DATE = '2030-07-07';

let patientUid;
let surgeonUid;
let scheduleId;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM set_issue_log
      WHERE tenant_id = $1::uuid
        AND issue_code LIKE 'CSSDTEST%'`,
    TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM set_issue_log
      WHERE tenant_id = $1::uuid
        AND instrument_set_id IN (
          SELECT id FROM instrument_sets WHERE tenant_id = $1::uuid AND set_code LIKE 'CSSDTEST%'
        )`,
    TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM sterilization_loads
      WHERE tenant_id = $1::uuid
        AND load_code LIKE 'CSSDTEST%'`,
    TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM instrument_sets
      WHERE tenant_id = $1::uuid
        AND set_code LIKE 'CSSDTEST%'`,
    TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM ot_schedules
      WHERE tenant_id = $1::uuid
        AND procedure_name LIKE 'CSSDTEST%'`,
    TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users
      WHERE tenant_id = $1::uuid
        AND name LIKE 'CSSDTEST%'`,
    TENANT_ID,
  ).catch(() => {});
}

d('CSSD instrument set loop', () => {
  const admin = authClient('ADMIN', { tenant_id: TENANT_ID });

  beforeAll(async () => {
    await cleanup();
    const suffix = String(Date.now()).slice(-8);
    const patientRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, $3, 'PATIENT', true, NOW())
       RETURNING uid`,
      TENANT_ID,
      `+91987${suffix.slice(0, 5)}`,
      `${RUN} Patient`,
    );
    patientUid = patientRows[0].uid;

    const surgeonRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, $3, 'DOCTOR', true, NOW())
       RETURNING uid`,
      TENANT_ID,
      `+91988${suffix.slice(0, 5)}`,
      `${RUN} Surgeon`,
    );
    surgeonUid = surgeonRows[0].uid;

    const scheduleRows = await prisma.$queryRawUnsafe(
      `INSERT INTO ot_schedules
         (tenant_id, patient_uid, surgeon, procedure_name, procedure_code, ot_room,
          scheduled_date, scheduled_time, equipment_needed, consent_obtained, status, created_at, updated_at)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, $4, 'CSSD', 'OT-CSSD', $5::date, '10:00'::time,
          '{}'::text[], true, 'scheduled', NOW(), NOW())
       RETURNING id`,
      TENANT_ID,
      patientUid,
      surgeonUid,
      `${RUN} laparotomy`,
      OT_DATE,
    );
    scheduleId = scheduleRows[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('load to issue to theatre-use to return to decontaminate to re-sterilize', async () => {
    const set = await admin.post('/api/v1/cssd/sets').send({
      set_code: `${RUN}A`,
      display_name: 'Major laparotomy set',
      contents: [
        { name: 'Artery forceps', quantity: 4 },
        { name: 'Needle holder', quantity: 2 },
      ],
    });
    expect(set.status).toBe(201);
    const setId = set.body.data.id;

    const label = await admin.get(`/api/v1/cssd/sets/${setId}/label`);
    expect(label.status).toBe(200);
    expect(label.body.data.barcode_symbology).toBe('code39');
    expect(label.body.data.svg).toContain('<svg');

    const issue = await admin.post('/api/v1/cssd/issues').send({
      issue_code: `${RUN}ISSUEA`,
      instrument_set_id: setId,
      ot_schedule_id: scheduleId,
      return_due_at: `${OT_DATE}T16:00:00.000Z`,
    });
    expect(issue.status).toBe(201);
    expect(issue.body.data.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'CSSD_SET_NOT_FROM_PASSED_LOAD',
          warn_only: true,
          enforcement_enabled: false,
        }),
      ]),
    );
    const issueId = issue.body.data.id;

    const theatre = await admin.get(`/api/v1/theatre/today?date=${OT_DATE}`);
    expect(theatre.status).toBe(200);
    const schedule = theatre.body.data.find((row) => Number(row.id) === Number(scheduleId));
    expect(schedule.cssd_warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'CSSD_SET_NOT_FROM_PASSED_LOAD' }),
      ]),
    );

    const theatreUse = await admin.post(`/api/v1/cssd/issues/${issueId}/theatre-use`).send({});
    expect(theatreUse.status).toBe(200);
    expect(theatreUse.body.data.status).toBe('in_theatre');

    const returned = await admin.post(`/api/v1/cssd/issues/${issueId}/return`).send({
      return_condition: 'intact',
    });
    expect(returned.status).toBe(200);
    expect(returned.body.data.status).toBe('returned');

    const decontaminated = await admin.post(`/api/v1/cssd/issues/${issueId}/decontaminate`).send({});
    expect(decontaminated.status).toBe(200);
    expect(decontaminated.body.data.status).toBe('awaiting_sterilization');

    const load = await admin.post('/api/v1/cssd/loads').send({
      load_code: `${RUN}LOADA`,
      set_ids: [setId],
      cycle_type: 'steam',
      started_at: `${OT_DATE}T17:00:00.000Z`,
      completed_at: `${OT_DATE}T18:00:00.000Z`,
      biological_indicator_result: 'passed',
      chemical_indicator_result: 'passed',
      mechanical_indicator_result: 'passed',
      temperature_c: 134,
      exposure_minutes: 18,
    });
    expect(load.status).toBe(201);
    expect(load.body.data.status).toBe('passed');

    const sets = await admin.get(`/api/v1/cssd/sets?status=sterilized&q=${RUN}A`);
    expect(sets.status).toBe(200);
    expect(sets.body.data[0]).toEqual(expect.objectContaining({
      status: 'sterilized',
      usable: true,
      requires_reprocessing: false,
    }));

    const board = await admin.get('/api/v1/cssd/board');
    expect(board.status).toBe(200);
    expect(board.body.data.summary.total_sets).toBeGreaterThanOrEqual(1);
    expect(board.body.data.recent_loads.map((row) => row.load_code)).toContain(`${RUN}LOADA`);
  });

  test('failed indicators flag every set in the load unusable until reprocessed', async () => {
    const set = await admin.post('/api/v1/cssd/sets').send({
      set_code: `${RUN}B`,
      display_name: 'Minor set',
      contents: [{ name: 'Mosquito forceps', quantity: 2 }],
    });
    expect(set.status).toBe(201);
    const setId = set.body.data.id;

    const failedLoad = await admin.post('/api/v1/cssd/loads').send({
      load_code: `${RUN}LOADB`,
      set_ids: [setId],
      cycle_type: 'steam',
      completed_at: `${OT_DATE}T19:00:00.000Z`,
      biological_indicator_result: 'failed',
      chemical_indicator_result: 'passed',
      mechanical_indicator_result: 'passed',
      failure_reason: 'Biological indicator failed',
    });
    expect(failedLoad.status).toBe(201);
    expect(failedLoad.body.data.status).toBe('failed');

    const sets = await admin.get(`/api/v1/cssd/sets?status=unusable&q=${RUN}B`);
    expect(sets.status).toBe(200);
    expect(sets.body.data[0]).toEqual(expect.objectContaining({
      status: 'unusable',
      usable: false,
      requires_reprocessing: true,
    }));

    const deniedIssue = await admin.post('/api/v1/cssd/issues').send({
      issue_code: `${RUN}ISSUEB`,
      instrument_set_id: setId,
      ot_schedule_id: scheduleId,
    });
    expect(deniedIssue.status).toBe(409);
    expect(deniedIssue.body.code || deniedIssue.body.error?.code).toBe('CSSD_SET_UNUSABLE');
  });
});
