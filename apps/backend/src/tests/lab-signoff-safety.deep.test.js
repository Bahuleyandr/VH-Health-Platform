import prisma from '../lib/prisma.js';
import { signOffResults } from '../services/lab/labResultsService.js';
import { authClient, ensureTestIdentity } from './testClient.js';
import { purgeDiagnosticEvidence } from './helpers/diagnosticEvidenceCleanup.js';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'a2a00000-0000-4000-8000-000000000001';
const PATHOLOGIST_UID = 'a2a00000-0000-4000-8000-000000000002';
const INACTIVE_UID = 'a2a00000-0000-4000-8000-000000000003';
const RUN = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const KEY_PREFIX = `s2a-signoff-${RUN}`;

const investigationIds = [];
const resultIds = [];

async function seedEpisode({ patientUid = PATIENT_UID, analytes = [{}] } = {}) {
  const investigation = await prisma.$queryRawUnsafe(
    `INSERT INTO investigations
       (tenant_id, patient_uid, phone, test_name, test_type, status, priority,
        requested_at, updated_at)
     VALUES ($1::uuid, $2::uuid, '9822000001', 'S2a sign-off panel', 'LAB',
             'IN_PROGRESS', 'NORMAL', NOW(), NOW())
     RETURNING id`,
    TENANT,
    patientUid,
  );
  const investigationId = Number(investigation[0].id);
  investigationIds.push(investigationId);

  const created = [];
  for (const [index, analyte] of analytes.entries()) {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_results
         (tenant_id, patient_uid, investigation_id, test_code, test_name,
          value_text, value_numeric, unit, abnormal_flag, is_critical, status)
       VALUES ($1::uuid, $2::uuid, $3::int, $4, $5, $6, $7, $8, $9, $10, 'preliminary')
       RETURNING id`,
      TENANT,
      patientUid,
      investigationId,
      analyte.testCode || `S2A-${index + 1}`,
      analyte.testName || `S2a analyte ${index + 1}`,
      analyte.valueText || '4.2',
      analyte.valueNumeric ?? 4.2,
      analyte.unit || 'mmol/L',
      analyte.abnormalFlag ?? 'N',
      analyte.isCritical ?? false,
    );
    const id = Number(rows[0].id);
    resultIds.push(id);
    created.push(id);
  }
  return { investigationId, resultIds: created };
}

async function cleanup() {
  // A verified sign-off writes append-only diagnostic evidence (migration 589)
  // that FK-pins the sign-off, its investigation and the fixture users. Until
  // it is gone the deletes below are all rejected — and because they swallow
  // their errors the teardown failed in silence. Deliberately NOT swallowed:
  // a purge that stops working should be loud, not quietly reintroduce the leak.
  await purgeDiagnosticEvidence(prisma, TENANT, [PATIENT_UID, PATHOLOGIST_UID, INACTIVE_UID]);
  await prisma.$executeRawUnsafe(
    `DELETE FROM staff_credentials
      WHERE tenant_id = $1::uuid
        AND staff_uid = $2::uuid
        AND name = 'S2a test registration'`,
    TENANT,
    PATHOLOGIST_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM idempotency_keys
      WHERE user_uid IN ($1::uuid, $2::uuid)
        AND request_key LIKE $3`,
    PATHOLOGIST_UID,
    INACTIVE_UID,
    `${KEY_PREFIX}%`,
  ).catch(() => {});
  if (resultIds.length > 0) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM lab_pathologist_signoffs
        WHERE tenant_id = $1::uuid AND result_ids && $2::int[]`,
      TENANT,
      resultIds,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM lab_results
        WHERE tenant_id = $1::uuid AND id = ANY($2::int[])`,
      TENANT,
      resultIds,
    ).catch(() => {});
  }
  if (investigationIds.length > 0) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM investigations
        WHERE tenant_id = $1::uuid AND id = ANY($2::int[])`,
      TENANT,
      investigationIds,
    ).catch(() => {});
  }
}

d('Lab pathologist sign-off safety contract', () => {
  // Authentication fails closed when a token's subject has no live identity
  // row, so an invented uid 401s before this suite's authz gate is reached.
  beforeAll(async () => {
    await ensureTestIdentity(PATHOLOGIST_UID);
    await ensureTestIdentity(INACTIVE_UID);
  });
  const pathologist = authClient('PATHOLOGIST', { uid: PATHOLOGIST_UID });
  const inactive = authClient('PATHOLOGIST', { uid: INACTIVE_UID });

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, status, is_active, is_deleted, updated_at)
       VALUES
         ($1::uuid, $3::uuid, '9822000001', 'S2a Sign-off Patient', 'PATIENT', 'active', true, false, NOW()),
         ($2::uuid, $3::uuid, '9822000002', 'S2a Pathologist', 'PATHOLOGIST', 'active', true, false, NOW())
       ON CONFLICT (uid) DO UPDATE
         SET tenant_id = EXCLUDED.tenant_id,
             name = EXCLUDED.name,
             role = EXCLUDED.role,
             status = EXCLUDED.status,
             is_active = EXCLUDED.is_active,
             is_deleted = false,
             deleted_at = NULL`,
      PATIENT_UID,
      PATHOLOGIST_UID,
      TENANT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff_credentials
         (tenant_id, staff_uid, credential_type, name, registration_number,
          status, verified_by, verified_at, created_by)
       VALUES ($1::uuid, $2::uuid, 'registration', 'S2a test registration',
               'S2A-REG-2042', 'active', $2::uuid, NOW(), $2::uuid)`,
      TENANT,
      PATHOLOGIST_UID,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID,
      PATHOLOGIST_UID,
      INACTIVE_UID,
    ).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('requires an idempotency key before sign-off', async () => {
    const episode = await seedEpisode();
    const response = await pathologist.post('/api/v1/lab/pathologist/signoff').send({
      result_ids: episode.resultIds,
      decision: 'verified',
    });
    expect(response.statusCode).toBe(400);
    expect(response.body.message).toMatch(/Idempotency-Key/i);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM lab_pathologist_signoffs WHERE $1::int = ANY(result_ids)`,
      episode.resultIds[0],
    );
    expect(rows).toHaveLength(0);
  });

  it('rejects caller-supplied signer identity before authorization or PHI access', async () => {
    const episode = await seedEpisode();
    const key = `${KEY_PREFIX}-signer-spoof`;
    const response = await pathologist.post('/api/v1/lab/pathologist/signoff')
      .set('Idempotency-Key', key)
      .send({
        result_ids: episode.resultIds,
        decision: 'verified',
        signed_off_by_name: 'Another clinician',
      });
    expect(response.statusCode).toBe(400);

    const claims = await prisma.$queryRawUnsafe(
      `SELECT id FROM idempotency_keys
        WHERE user_uid = $1::uuid AND request_key = $2`,
      PATHOLOGIST_UID,
      key,
    );
    expect(claims).toHaveLength(0);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT signed_off_at FROM lab_results WHERE id = $1::int`,
      episode.resultIds[0],
    );
    expect(rows[0].signed_off_at).toBeNull();
  });

  it('replays the exact sign-off response and rejects a changed payload under the same key', async () => {
    const episode = await seedEpisode();
    const key = `${KEY_PREFIX}-replay`;
    const body = { result_ids: episode.resultIds, decision: 'verified' };
    const first = await pathologist.post('/api/v1/lab/pathologist/signoff')
      .set('Idempotency-Key', key)
      .send(body);
    expect(first.statusCode).toBe(200);
    expect(first.body.data).toMatchObject({
      episode_key: `investigation:${episode.investigationId}`,
      classification: 'normal',
    });
    expect(String(first.body.data.result_snapshot_sha256)).toHaveLength(64);

    const replay = await pathologist.post('/api/v1/lab/pathologist/signoff')
      .set('Idempotency-Key', key)
      .send(body);
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toEqual(first.body);

    const mismatch = await pathologist.post('/api/v1/lab/pathologist/signoff')
      .set('Idempotency-Key', key)
      .send({ ...body, comments: 'changed payload' });
    expect(mismatch.statusCode).toBe(422);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, signed_off_by_name, signed_off_by_reg
         FROM lab_pathologist_signoffs
        WHERE $1::int = ANY(result_ids)`,
      episode.resultIds[0],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      signed_off_by_name: 'S2a Pathologist',
      signed_off_by_reg: 'S2A-REG-2042',
    });
  });

  it('collapses a concurrent same-key submit to one sign-off and one stamp', async () => {
    const episode = await seedEpisode();
    const key = `${KEY_PREFIX}-concurrent`;
    const body = { result_ids: episode.resultIds, decision: 'verified' };
    const [left, right] = await Promise.all([
      pathologist.post('/api/v1/lab/pathologist/signoff').set('Idempotency-Key', key).send(body),
      pathologist.post('/api/v1/lab/pathologist/signoff').set('Idempotency-Key', key).send(body),
    ]);
    const statuses = [left.statusCode, right.statusCode].sort((a, b) => a - b);
    expect(statuses[0]).toBe(200);
    expect([200, 409]).toContain(statuses[1]);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM lab_pathologist_signoffs
        WHERE $1::int = ANY(result_ids)`,
      episode.resultIds[0],
    );
    expect(rows[0].count).toBe(1);
    const result = await prisma.$queryRawUnsafe(
      `SELECT status, signed_off_by, signed_off_at FROM lab_results WHERE id = $1::int`,
      episode.resultIds[0],
    );
    expect(result[0]).toMatchObject({ status: 'final', signed_off_by: PATHOLOGIST_UID });
    expect(result[0].signed_off_at).toBeTruthy();
  });

  it('rejects a second initial sign-off under a different key', async () => {
    const episode = await seedEpisode();
    const body = { result_ids: episode.resultIds, decision: 'verified' };
    const first = await pathologist.post('/api/v1/lab/pathologist/signoff')
      .set('Idempotency-Key', `${KEY_PREFIX}-initial-a`)
      .send(body);
    expect(first.statusCode).toBe(200);

    const second = await pathologist.post('/api/v1/lab/pathologist/signoff')
      .set('Idempotency-Key', `${KEY_PREFIX}-initial-b`)
      .send(body);
    expect(second.statusCode).toBe(409);
    expect(second.body.details?.code || second.body.code).toBe('LAB_SIGNOFF_ILLEGAL_INITIAL_STATE');
  });

  it('rejects a cross-episode batch before creating a sign-off', async () => {
    const first = await seedEpisode();
    const second = await seedEpisode();
    await expect(signOffResults({
      tenantId: TENANT,
      signed_off_by: PATHOLOGIST_UID,
      signed_off_by_role: 'PATHOLOGIST',
      actorRoles: ['PATHOLOGIST'],
      actorRawRole: 'PATHOLOGIST',
      result_ids: [first.resultIds[0], second.resultIds[0]],
      decision: 'verified',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_SIGNOFF_MULTI_EPISODE_BATCH',
    });
  });

  it('checks current database authorization before claiming idempotency or reading results', async () => {
    const episode = await seedEpisode();
    const key = `${KEY_PREFIX}-inactive`;
    const response = await inactive.post('/api/v1/lab/pathologist/signoff')
      .set('Idempotency-Key', key)
      .send({ result_ids: episode.resultIds, decision: 'verified' });
    expect(response.statusCode).toBe(403);

    const claims = await prisma.$queryRawUnsafe(
      `SELECT id FROM idempotency_keys
        WHERE user_uid = $1::uuid AND request_key = $2`,
      INACTIVE_UID,
      key,
    );
    expect(claims).toHaveLength(0);
    const result = await prisma.$queryRawUnsafe(
      `SELECT signed_off_at FROM lab_results WHERE id = $1::int`,
      episode.resultIds[0],
    );
    expect(result[0].signed_off_at).toBeNull();
  });
});
