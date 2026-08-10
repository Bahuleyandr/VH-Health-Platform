import prisma from '../lib/prisma.js';
import request from 'supertest';

import app from '../app.js';
import { API_KEY, generateTestToken } from './testClient.js';

const hasDb = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '00000000-0000-4000-8000-0000000c4e61';
const NURSE_UID = '00000000-0000-4000-8000-0000000c4e62';
const OUTSIDER_UID = '00000000-0000-4000-8000-0000000c4e63';
const KEY_PREFIX = `audit3-p3-staff-vitals-${process.pid}`;
const RECORD_KEY = `${KEY_PREFIX}-record`;
const CORRECTION_KEY = `${KEY_PREFIX}-correction`;

async function query(sql, ...params) {
  const rows = await prisma.$queryRawUnsafe(sql, ...params);
  return Array.isArray(rows) ? rows : [];
}

async function exec(sql, ...params) {
  return prisma.$executeRawUnsafe(sql, ...params);
}

async function purgeAppendOnlyAuditRows() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
    await tx.$executeRawUnsafe(
      `DELETE FROM audit_logs
        WHERE uid IN ($1::uuid, $2::uuid)
          AND action = 'CORRECT_VITALS'`,
      NURSE_UID,
      OUTSIDER_UID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM patient_access_audit_log
        WHERE patient_uid = $1::uuid
           OR actor_uid IN ($2::uuid, $3::uuid)`,
      PATIENT_UID,
      NURSE_UID,
      OUTSIDER_UID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM hipaa_access_log
        WHERE patient_id = $1
           OR accessed_by IN ($2::uuid, $3::uuid)`,
      PATIENT_UID,
      NURSE_UID,
      OUTSIDER_UID,
    );
    await tx.$executeRawUnsafe(
      'DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid',
      PATIENT_UID,
    );
    await tx.$executeRawUnsafe(
      'DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid',
      PATIENT_UID,
    );
  });
}

async function cleanup() {
  const patientRows = await query('SELECT id FROM users WHERE uid = $1::uuid', PATIENT_UID);
  const patientId = patientRows[0]?.id ?? null;

  await exec(
    `DELETE FROM idempotency_keys
      WHERE user_uid IN ($1::uuid, $2::uuid)
        AND request_key LIKE $3`,
    NURSE_UID,
    OUTSIDER_UID,
    `${KEY_PREFIX}%`,
  ).catch(() => {});
  await purgeAppendOnlyAuditRows().catch(() => {});
  await exec('DELETE FROM tasks WHERE patient_uid = $1::uuid', PATIENT_UID).catch(() => {});
  await exec('DELETE FROM workflow_sla_instances WHERE patient_uid = $1::uuid', PATIENT_UID).catch(() => {});
  await exec('DELETE FROM cds_alerts WHERE patient_uid = $1::uuid', PATIENT_UID).catch(() => {});
  if (patientId != null) {
    await exec('DELETE FROM clinical_alerts WHERE patient_id = $1::int', patientId).catch(() => {});
  }
  await exec('DELETE FROM news2_scores WHERE patient_uid = $1::uuid', PATIENT_UID).catch(() => {});
  await exec('DELETE FROM vitals_chart WHERE patient_uid = $1::uuid', PATIENT_UID).catch(() => {});
  await exec('DELETE FROM patient_vitals WHERE patient_uid = $1::uuid', PATIENT_UID).catch(() => {});
  await exec('DELETE FROM care_team_members WHERE patient_uid = $1::uuid', PATIENT_UID).catch(() => {});
  await exec('DELETE FROM care_teams WHERE patient_uid = $1::uuid', PATIENT_UID).catch(() => {});
  await exec(
    'DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)',
    PATIENT_UID,
    NURSE_UID,
    OUTSIDER_UID,
  ).catch(() => {});
}

function authToken(role, uid, deviceType, id) {
  return generateTestToken(role, {
    uid,
    tenant_id: TENANT,
    deviceType,
    ...(id == null ? {} : { id }),
  });
}

function apiRequest(method, path, { role, uid, deviceType = 'desktop', id, key, body } = {}) {
  let pending = request(app)
    [method](path)
    .set('x-api-key', API_KEY)
    .set('Authorization', `Bearer ${authToken(role, uid, deviceType, id)}`);
  if (key) pending = pending.set('Idempotency-Key', key);
  return pending.send(body ?? {});
}

async function waitForReceipt({ key, method, path }) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const rows = await query(
      `SELECT status FROM idempotency_keys
        WHERE user_uid = $1::uuid
          AND request_key = $2
          AND request_method = $3
          AND request_path = $4`,
      NURSE_UID,
      key,
      method,
      path,
    );
    if (rows[0]?.status === 'complete') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`idempotency receipt did not complete for ${method} ${path}`);
}

async function waitForHipaaCount(expected) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const rows = await query(
      `SELECT COUNT(*)::int AS count
         FROM hipaa_access_log
        WHERE accessed_by = $1::uuid
          AND patient_id = $2
          AND record_type = 'STAFF_RECORDED_VITALS'`,
      NURSE_UID,
      PATIENT_UID,
    );
    if (rows[0]?.count === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`HIPAA audit row count did not reach ${expected}`);
}

async function grantNurseCareTeam() {
  const teams = await query(
    `INSERT INTO care_teams
       (tenant_id, patient_uid, team_kind, display_name, status, created_by, updated_at)
     VALUES ($1::uuid, $2::uuid, 'longitudinal', 'Canonical vitals test team',
             'active', $3::uuid, NOW())
     RETURNING id`,
    TENANT,
    PATIENT_UID,
    NURSE_UID,
  );
  await exec(
    `INSERT INTO care_team_members
       (tenant_id, care_team_id, patient_uid, staff_uid, staff_role, member_name,
        relationship_kind, break_glass_allowed, created_by, updated_at)
     VALUES ($1::uuid, $2::int, $3::uuid, $4::uuid, 'NURSING_STAFF',
             'Canonical Route Nurse', 'care_team', false, $4::uuid, NOW())`,
    TENANT,
    teams[0].id,
    PATIENT_UID,
    NURSE_UID,
  );
}

d('staff quick-vitals canonical route', () => {
  let patientId;
  let nurseId;
  let vitalsId;
  let recordResponse;

  const recordBody = () => ({
    patient_id: patientId,
    record_type: 'VITALS',
    vital_signs: {
      blood_pressure: { systolic: 120, diastolic: 80 },
      pulse: 72,
      temperature: 98.6,
      spo2: 98,
    },
    measurements: { weight: 70 },
    notes: 'canonical route proof',
  });

  beforeAll(async () => {
    await cleanup();
    const rows = await query(
      `INSERT INTO users (uid, phone, name, role, is_active, status, tenant_id, updated_at)
       VALUES
         ($1::uuid, '8990222361', 'Canonical Route Patient', 'PATIENT', true, 'active', $4::uuid, NOW()),
         ($2::uuid, '8990222362', 'Canonical Route Nurse', 'NURSING_STAFF', true, 'active', $4::uuid, NOW()),
         ($3::uuid, '8990222363', 'Canonical Route Outsider', 'NURSING_STAFF', true, 'active', $4::uuid, NOW())
       RETURNING id, uid`,
      PATIENT_UID,
      NURSE_UID,
      OUTSIDER_UID,
      TENANT,
    );
    patientId = rows.find((row) => String(row.uid) === PATIENT_UID)?.id;
    nurseId = rows.find((row) => String(row.uid) === NURSE_UID)?.id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 30_000);

  it.each(['post', 'put', 'patch'])('denies PATIENT callers on the %s compatibility alias', async (method) => {
    const path = method === 'post' ? '/api/v1/health/records' : '/api/v1/health/records/1';
    const response = await apiRequest(method, path, {
      role: 'PATIENT',
      uid: PATIENT_UID,
      deviceType: 'mobile',
      id: patientId,
      body: method === 'post' ? recordBody() : { vital_signs: { pulse: 74 } },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({ success: false, error: 'Forbidden' });
  });

  it.each(['post', 'put', 'patch'])('runs the Staff mobile-write guard on the %s alias', async (method) => {
    const path = method === 'post' ? '/api/v1/health/records' : '/api/v1/health/records/1';
    const response = await apiRequest(method, path, {
      role: 'NURSING_STAFF',
      uid: NURSE_UID,
      deviceType: 'mobile',
      id: nurseId,
      body: method === 'post' ? recordBody() : { vital_signs: { pulse: 74 } },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({
      success: false,
      code: 'CLINICAL_WRITE_DESKTOP_ONLY',
    });
  });

  it('denies a desktop Staff write without a patient relationship', async () => {
    const response = await apiRequest('post', '/api/v1/health/records', {
      role: 'NURSING_STAFF',
      uid: NURSE_UID,
      id: nurseId,
      body: recordBody(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({
      success: false,
      code: 'PATIENT_ACCESS_DENIED',
    });
  });

  it('requires the compatibility target to be a patient', async () => {
    const response = await apiRequest('post', '/api/v1/health/records', {
      role: 'NURSING_STAFF',
      uid: NURSE_UID,
      id: nurseId,
      key: `${KEY_PREFIX}-non-patient-target`,
      body: {
        patient_id: nurseId,
        vital_signs: { pulse: 72 },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.message).toMatch(/patient_id must identify a patient/);
  });

  it('writes canonical vitals + NEWS2 once and replays the same record receipt', async () => {
    await grantNurseCareTeam();
    const first = await apiRequest('post', '/api/v1/health/records', {
      role: 'NURSING_STAFF',
      uid: NURSE_UID,
      id: nurseId,
      key: RECORD_KEY,
      body: recordBody(),
    });
    expect(first.statusCode).toBe(200);
    expect(first.body.data).toMatchObject({
      patientId,
      patientUid: PATIENT_UID,
      source: 'staff',
    });
    expect(first.body.data.news2?.id).toBeTruthy();

    vitalsId = first.body.data.id;
    recordResponse = first.body;
    await waitForReceipt({
      key: RECORD_KEY,
      method: 'POST',
      path: '/api/v1/health/records',
    });
    const replay = await apiRequest('post', '/api/v1/health/records', {
      role: 'NURSING_STAFF',
      uid: NURSE_UID,
      id: nurseId,
      key: RECORD_KEY,
      body: recordBody(),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toEqual(recordResponse);

    const counts = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM vitals_chart WHERE patient_uid = $1::uuid) AS canonical,
         (SELECT COUNT(*)::int FROM patient_vitals WHERE patient_uid = $1::uuid) AS legacy,
         (SELECT COUNT(*)::int FROM news2_scores WHERE vitals_chart_id = $2::int) AS news2,
         (SELECT COUNT(*)::int FROM clinical_timeline_events
           WHERE patient_uid = $1::uuid AND source_table = 'vitals_chart' AND source_id = $2::text) AS timeline,
         (SELECT COUNT(*)::int FROM clinical_audit_events
           WHERE patient_uid = $1::uuid AND resource_table = 'vitals_chart' AND resource_id = $2::text) AS audit`,
      PATIENT_UID,
      vitalsId,
    );
    expect(counts[0]).toEqual({
      canonical: 1,
      legacy: 0,
      news2: 1,
      timeline: 1,
      audit: 1,
    });
  });

  it.each(['put', 'patch'])('runs the resource relationship guard on the %s alias', async (method) => {
    const response = await apiRequest(method, `/api/v1/health/records/${vitalsId}`, {
      role: 'NURSING_STAFF',
      uid: OUTSIDER_UID,
      body: { vital_signs: { pulse: 74 } },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({
      success: false,
      code: 'PATIENT_ACCESS_DENIED',
    });
  });

  it.each(['put', 'patch'])('requires a correction-scoped receipt on the %s alias', async (method) => {
    const response = await apiRequest(method, `/api/v1/health/records/${vitalsId}`, {
      role: 'NURSING_STAFF',
      uid: NURSE_UID,
      id: nurseId,
      body: { vital_signs: { pulse: 74 } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.message).toMatch(/Idempotency-Key header is required/);
    expect(response.body.details).toMatchObject({ scope: 'staff_vitals_correction' });
  });

  it('replays a lost correction response twice without duplicating any clinical side effect', async () => {
    const path = `/api/v1/health/records/${vitalsId}`;
    const body = { vital_signs: { pulse: 76 } };
    const first = await apiRequest('patch', path, {
      role: 'NURSING_STAFF',
      uid: NURSE_UID,
      id: nurseId,
      key: CORRECTION_KEY,
      body,
    });
    expect(first.statusCode).toBe(200);
    expect(first.body.data).toMatchObject({ id: vitalsId, heart_rate: 76 });

    await waitForReceipt({ key: CORRECTION_KEY, method: 'PATCH', path });
    const replayOne = await apiRequest('patch', path, {
      role: 'NURSING_STAFF',
      uid: NURSE_UID,
      id: nurseId,
      key: CORRECTION_KEY,
      body,
    });
    const replayTwo = await apiRequest('patch', path, {
      role: 'NURSING_STAFF',
      uid: NURSE_UID,
      id: nurseId,
      key: CORRECTION_KEY,
      body,
    });
    expect(replayOne.statusCode).toBe(200);
    expect(replayTwo.statusCode).toBe(200);
    expect(replayOne.body).toEqual(first.body);
    expect(replayTwo.body).toEqual(first.body);

    await waitForHipaaCount(2);
    const counts = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM vitals_chart
           WHERE patient_uid = $1::uuid AND id = $2::int AND heart_rate = 76) AS corrected_rows,
         (SELECT COUNT(*)::int FROM audit_logs
           WHERE uid = $3::uuid AND action = 'CORRECT_VITALS'
             AND resource = 'vitals_chart' AND resource_id = $2::text) AS corrections,
         (SELECT COUNT(*)::int FROM news2_scores WHERE vitals_chart_id = $2::int) AS news2,
         (SELECT COUNT(*)::int FROM news2_scores
           WHERE vitals_chart_id = $2::int AND superseded_at IS NULL) AS live_news2,
         (SELECT COUNT(*)::int FROM clinical_timeline_events
           WHERE patient_uid = $1::uuid AND source_table = 'vitals_chart'
             AND source_id = $2::text) AS timeline_total,
         (SELECT COUNT(*)::int FROM clinical_timeline_events
           WHERE patient_uid = $1::uuid AND source_table = 'vitals_chart'
             AND source_id = $2::text AND event_type = 'vitals.corrected') AS correction_timeline,
         (SELECT COUNT(*)::int FROM clinical_audit_events
           WHERE patient_uid = $1::uuid AND resource_table = 'vitals_chart'
             AND resource_id = $2::text) AS audit_total,
         (SELECT COUNT(*)::int FROM clinical_audit_events
           WHERE patient_uid = $1::uuid AND resource_table = 'vitals_chart'
             AND resource_id = $2::text AND action = 'vitals.corrected') AS correction_audit,
         (SELECT COUNT(*)::int FROM clinical_alerts WHERE patient_id = $4::int) AS alerts,
         (SELECT COUNT(*)::int FROM cds_alerts WHERE patient_uid = $1::uuid) AS cds_alerts,
         (SELECT COUNT(*)::int FROM tasks WHERE patient_uid = $1::uuid) AS tasks,
         (SELECT COUNT(*)::int FROM workflow_sla_instances WHERE patient_uid = $1::uuid) AS sla_instances,
         (SELECT COUNT(*)::int FROM hipaa_access_log
           WHERE accessed_by = $3::uuid AND patient_id = $1::text
             AND record_type = 'STAFF_RECORDED_VITALS' AND action = 'CREATE') AS hipaa_creates,
         (SELECT COUNT(*)::int FROM hipaa_access_log
           WHERE accessed_by = $3::uuid AND patient_id = $1::text
             AND record_type = 'STAFF_RECORDED_VITALS' AND action = 'UPDATE') AS hipaa_updates,
         (SELECT COUNT(*)::int FROM idempotency_keys
           WHERE user_uid = $3::uuid AND request_key = $5
             AND request_method = 'PATCH' AND request_path = $6) AS correction_receipts`,
      PATIENT_UID,
      vitalsId,
      NURSE_UID,
      patientId,
      CORRECTION_KEY,
      path,
    );
    expect(counts[0]).toEqual({
      corrected_rows: 1,
      corrections: 1,
      news2: 2,
      live_news2: 1,
      timeline_total: 2,
      correction_timeline: 1,
      audit_total: 2,
      correction_audit: 1,
      alerts: 0,
      cds_alerts: 0,
      tasks: 0,
      sla_instances: 0,
      hipaa_creates: 1,
      hipaa_updates: 1,
      correction_receipts: 1,
    });
  });
});
