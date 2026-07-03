import request from 'supertest';

import app from '../app.js';
import prisma from '../lib/prisma.js';
import { deleteWithAuditBypass } from './helpers/auditBypass.js';
import { API_KEY, generateTestToken } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = 'c4d40000-0000-4000-8000-000000000400';
const PATIENT_UID = 'c4d40000-0000-4000-8000-000000000401';
const ACTOR_DOCTOR = 'c4d40000-0000-4000-8000-000000000402';
const ACTOR_NURSE = 'c4d40000-0000-4000-8000-000000000403';

function admin() {
  const token = generateTestToken('ADMIN', {
    tenant_id: TENANT_ID,
    tenantId: TENANT_ID,
    uid: 'c4d40000-0000-4000-8000-0000000004ad',
  });
  return {
    get: (path) => request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function cleanup() {
  await deleteWithAuditBypass(
    prisma,
    `DELETE FROM patient_access_audit_log
      WHERE patient_uid = $1::uuid OR actor_uid IN ($2::uuid, $3::uuid)`,
    PATIENT_UID,
    ACTOR_DOCTOR,
    ACTOR_NURSE,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id = $1::uuid`,
    TENANT_ID,
  ).catch(() => {});
}

async function insertAudit({
  actorUid = ACTOR_DOCTOR,
  actorRole = 'DOCTOR',
  decision = 'deny',
  shadowMode = true,
  recordType = 'PRESCRIPTION',
  resourceType = null,
  route = '/api/v1/prescriptions/patient',
  createdAt = '2026-07-01 09:15:00+05:30',
} = {}) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO patient_access_audit_log
       (tenant_id, patient_uid, actor_uid, actor_role, access_decision,
        access_source, reason, route, action, metadata, created_by, updated_by,
        created_at, updated_at)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'unknown',
        'No active care-team relationship', $6, 'VIEW',
        jsonb_strip_nulls(jsonb_build_object(
          'shadow_mode', $7::boolean,
          'record_type', $8::text,
          'resource_type', $9::text
        )),
        $3::uuid, $3::uuid, $10::timestamptz, $10::timestamptz)`,
    TENANT_ID,
    PATIENT_UID,
    actorUid,
    actorRole,
    decision,
    route,
    shadowMode,
    recordType,
    resourceType,
    createdAt,
  );
}

d('Batch 4 item 4 — care-team shadow-denials report', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, updated_at)
       VALUES ($1::uuid, 'shadow-denials-report', 'Shadow Denials Report Test', 'IN', 'DPDP', 'active', '{}'::jsonb, NOW())
       ON CONFLICT (id) DO NOTHING`,
      TENANT_ID,
    );
    await insertAudit();
    await insertAudit({ createdAt: '2026-07-01 10:05:00+05:30' });
    await insertAudit({
      actorUid: ACTOR_NURSE,
      actorRole: 'NURSE',
      recordType: null,
      resourceType: 'FHIR_RESOURCE',
      route: '/api/v1/fhir/Patient',
      createdAt: '2026-07-02 11:00:00+05:30',
    });
    await insertAudit({
      decision: 'allow',
      shadowMode: true,
      recordType: 'PRESCRIPTION',
      createdAt: '2026-07-01 12:00:00+05:30',
    });
    await insertAudit({
      shadowMode: false,
      recordType: 'PRESCRIPTION',
      createdAt: '2026-07-01 13:00:00+05:30',
    });
    await insertAudit({
      recordType: 'LAB_RESULT',
      createdAt: '2026-06-30 09:00:00+05:30',
    });
  }, 30000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('aggregates only shadow-mode deny rows by IST day, actor role, and resource family', async () => {
    const res = await admin()
      .get('/api/v1/admin/clinical-governance/patient-access/shadow-denials?date_from=2026-07-01&date_to=2026-07-02');

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      range: { date_from: '2026-07-01', date_to: '2026-07-02' },
      count: 2,
      total_denials: 3,
    });
    expect(res.body.data.shadow_denials).toEqual([
      expect.objectContaining({
        day: '2026-07-02',
        actor_role: 'NURSE',
        resource_family: 'FHIR_RESOURCE',
        denial_count: 1,
      }),
      expect.objectContaining({
        day: '2026-07-01',
        actor_role: 'DOCTOR',
        resource_family: 'PRESCRIPTION',
        denial_count: 2,
      }),
    ]);
  });

  it('exports the same aggregate as CSV', async () => {
    const res = await admin()
      .get('/api/v1/admin/clinical-governance/patient-access/shadow-denials?date_from=2026-07-01&date_to=2026-07-02&format=csv');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/shadow-denials-2026-07-01-to-2026-07-02\.csv/);
    expect(res.text).toContain('day,actor_role,resource_family,denial_count,first_seen_at,last_seen_at');
    expect(res.text).toContain('2026-07-01,DOCTOR,PRESCRIPTION,2,');
    expect(res.text).toContain('2026-07-02,NURSE,FHIR_RESOURCE,1,');
    expect(res.text).not.toContain('LAB_RESULT');
  });
});
