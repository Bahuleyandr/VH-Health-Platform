// Batch 4 item 3 — tenant console phase 2.
//
// Proves the super-admin tenant control plane exposes interop-secret management
// without rendering secret values, and queues a step-up-gated tenant KEK re-wrap
// job with status readback.
import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';
import { getKeyId } from '../utils/fieldEncryption.js';
import { provisionTenantKek, tenantKeyId, resetTenantKekCacheForTesting } from '../services/security/tenantKekProvider.js';
import { resetTenantKekRewrapJobsForTesting } from '../services/security/tenantKekRewrapService.js';

const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;

const TENANT_ID = '35353535-3535-4353-8535-353535353503';
const SUPER_UID = '35353535-3535-4353-8535-35353535d5a1';
const SFX = String(Date.now() % 100000);
const SENDER = `BATCH4-HIP-${SFX}`;
const SECRET_VALUE = `batch4-secret-${SFX}`;

function superClient(mfa) {
  const token = generateTestToken('SUPER_ADMIN', {
    uid: SUPER_UID,
    tenant_id: TENANT_ID,
    mfa,
  });
  return {
    get: (path) => request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (path) => request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function ensureTenant() {
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name, status = 'active', updated_at = NOW()`,
    TENANT_ID,
    `batch4-secrets-${SFX}`,
    `Batch 4 Secrets ${SFX}`,
  );
}

async function waitForJob(jobId) {
  for (let i = 0; i < 30; i += 1) {
    const res = await superClient(true)
      .get(`/api/v1/admin/tenants/${TENANT_ID}/kek-rotation-jobs/${jobId}`);
    expect(res.status).toBe(200);
    const job = res.body.data;
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for tenant KEK re-wrap job');
}

d('Batch 4 tenant console secrets + KEK re-wrap control plane', () => {
  beforeAll(async () => {
    resetTenantKekCacheForTesting();
    resetTenantKekRewrapJobsForTesting();
    await prisma.$executeRawUnsafe(`DELETE FROM tenant_interop_secrets WHERE tenant_id = $1::uuid OR sender_identifier = $2`, TENANT_ID, SENDER).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM encryption_keys WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
    await ensureTenant();
  }, 30000);

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM tenant_interop_secrets WHERE tenant_id = $1::uuid OR sender_identifier = $2`, TENANT_ID, SENDER).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM encryption_keys WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_ID).catch(() => {});
    resetTenantKekCacheForTesting();
    resetTenantKekRewrapJobsForTesting();
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('requires super-admin step-up for interop secret management', async () => {
    const res = await superClient(false)
      .get(`/api/v1/admin/tenants/${TENANT_ID}/interop-secrets`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUPER_ADMIN_MFA_REQUIRED');
  });

  it('stores an interop secret, returns only masked metadata, and writes audit', async () => {
    const created = await superClient(true)
      .post(`/api/v1/admin/tenants/${TENANT_ID}/interop-secrets`)
      .send({
        kind: 'abdm_callback',
        senderIdentifier: SENDER,
        secret: SECRET_VALUE,
      });
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body)).not.toContain(SECRET_VALUE);
    expect(created.body.data).toMatchObject({
      tenant_id: TENANT_ID,
      kind: 'abdm_callback',
      sender_identifier: SENDER,
      has_secret: true,
      secret_masked: '********',
    });

    const listed = await superClient(true)
      .get(`/api/v1/admin/tenants/${TENANT_ID}/interop-secrets`);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(SECRET_VALUE);
    expect(listed.body.data.secrets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sender_identifier: SENDER,
        secret_masked: '********',
      }),
    ]));

    const audit = await prisma.$queryRawUnsafe(
      `SELECT action, metadata
         FROM audit_logs
        WHERE resource = 'tenant'
          AND resource_id = $1
          AND action = 'TENANT_INTEROP_SECRET_UPSERTED'
        ORDER BY created_at DESC
        LIMIT 1`,
      TENANT_ID,
    );
    expect(audit[0]?.metadata?.after).toMatchObject({
      kind: 'abdm_callback',
      sender_identifier: SENDER,
      has_secret: true,
    });
    expect(JSON.stringify(audit[0]?.metadata)).not.toContain(SECRET_VALUE);
  });

  it('queues a step-up-gated tenant KEK re-wrap job with status readback and audit', async () => {
    const blocked = await superClient(false)
      .post(`/api/v1/admin/tenants/${TENANT_ID}/kek-rotation-jobs`)
      .send({});
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('SUPER_ADMIN_MFA_REQUIRED');

    await provisionTenantKek(TENANT_ID);

    const before = await prisma.$queryRawUnsafe(
      `SELECT secret_ciphertext
         FROM tenant_interop_secrets
        WHERE tenant_id = $1::uuid
          AND kind = 'abdm_callback'
          AND sender_identifier = $2
        LIMIT 1`,
      TENANT_ID,
      SENDER,
    );
    expect(getKeyId(before[0]?.secret_ciphertext)).not.toBe(tenantKeyId(TENANT_ID));

    const queued = await superClient(true)
      .post(`/api/v1/admin/tenants/${TENANT_ID}/kek-rotation-jobs`)
      .send({});
    expect(queued.status).toBe(202);
    expect(queued.body.data).toMatchObject({
      tenant_id: TENANT_ID,
      status: 'queued',
    });
    const jobId = queued.body.data.job_id;

    const job = await waitForJob(jobId);
    expect(job.status).toBe('succeeded');
    expect(job.summary.rewrapped).toBeGreaterThanOrEqual(1);

    const after = await prisma.$queryRawUnsafe(
      `SELECT secret_ciphertext
         FROM tenant_interop_secrets
        WHERE tenant_id = $1::uuid
          AND kind = 'abdm_callback'
          AND sender_identifier = $2
        LIMIT 1`,
      TENANT_ID,
      SENDER,
    );
    expect(getKeyId(after[0]?.secret_ciphertext)).toBe(tenantKeyId(TENANT_ID));

    const audit = await prisma.$queryRawUnsafe(
      `SELECT action, metadata
         FROM audit_logs
        WHERE resource = 'tenant'
          AND resource_id = $1
          AND action = 'TENANT_KEK_REWRAP_JOB_STARTED'
        ORDER BY created_at DESC
        LIMIT 1`,
      TENANT_ID,
    );
    expect(audit[0]?.metadata?.after).toMatchObject({
      job_id: jobId,
      status: 'queued',
    });
  });
});
