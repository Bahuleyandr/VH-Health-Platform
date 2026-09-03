import { createHash } from 'node:crypto';
import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { deleteWithAuditBypass } from './helpers/auditBypass.js';
import { API_KEY, generateTestToken, ensureTestIdentity } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '57400000-0000-4000-8000-000000000010';
const ACTOR_UID = '57400000-0000-4000-8000-000000000001';
const PATIENT_UID = '57400000-0000-4000-8000-000000000002';
const CLINICAL_ID = '57400000-0000-4000-8000-000000000003';
const ENCOUNTER_ID = '57400000-0000-4000-8000-000000000004';
const MARKER = 'AA574';

function get(path, tenantId = TENANT_A) {
  const token = generateTestToken('ADMIN', {
    uid: ACTOR_UID,
    id: 57401,
    tenant_id: tenantId,
  });
  return request(app)
    .get(path)
    .set('x-api-key', API_KEY)
    .set('Authorization', `Bearer ${token}`);
}

async function clean() {
  await deleteWithAuditBypass(prisma, `DELETE FROM audit_log WHERE action LIKE $1`, `${MARKER}%`).catch(() => {});
  await deleteWithAuditBypass(prisma, `DELETE FROM audit_logs WHERE action LIKE $1`, `${MARKER}%`).catch(() => {});
  await deleteWithAuditBypass(prisma, `DELETE FROM audit_logs WHERE resource = 'audit_console' AND uid = $1::uuid`, ACTOR_UID).catch(() => {});
  await deleteWithAuditBypass(prisma, `DELETE FROM hipaa_access_log WHERE action LIKE $1`, `${MARKER}%`).catch(() => {});
  await deleteWithAuditBypass(prisma, `DELETE FROM patient_access_audit_log WHERE action LIKE $1`, `${MARKER}%`).catch(() => {});
  await deleteWithAuditBypass(prisma, `DELETE FROM clinical_audit_events WHERE id = $1::uuid`, CLINICAL_ID).catch(() => {});
}

async function seed() {
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, 'aa574-tenant-b', 'AA574 Tenant B')
     ON CONFLICT (id) DO NOTHING`, TENANT_B);
  // Admin surface is entitlement-gated barrel-wide (once-over 2026-08-23):
  // give every test tenant a package, mirroring production provisioning.
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenant_entitlements (tenant_id, package_key, status, starts_at, source)
     SELECT id, 'enterprise', 'active', NOW(), 'test_seed' FROM tenants
     ON CONFLICT (tenant_id, package_key) DO NOTHING`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO audit_log
       (tenant_id, actor_uid, uid, user_id, user_name, user_role, method, path,
        module, action, resource, resource_id, metadata, status_code, success, created_at)
     VALUES
       ($1::uuid, $2::uuid, $2::uuid, 57401, 'Dr Accountability', 'DOCTOR', 'POST',
        '/api/v1/emr/notes', 'clinical_notes', $3, 'clinical_note', 'N-574',
        jsonb_build_object('patient_uid', $4::text, 'request_id', 'req-aa574'), 201, true, NOW())`,
    TENANT_A, ACTOR_UID, `${MARKER}_REQUEST`, PATIENT_UID);
  await prisma.$executeRawUnsafe(
    `INSERT INTO audit_logs
       (tenant_id, uid, actor_uid, role, action, resource, resource_id, metadata, created_at)
     VALUES ($1::uuid, $2::uuid, $2::uuid, 'DOCTOR', $3, 'investigation', 'INV-574',
             jsonb_build_object('patient_uid', $4::text, 'request_id', 'req-aa574-op'), NOW())`,
    TENANT_A, ACTOR_UID, `${MARKER}_OPERATIONAL`, PATIENT_UID);
  await prisma.$executeRawUnsafe(
    `INSERT INTO clinical_audit_events
       (id, tenant_id, patient_uid, encounter_id, action, action_status, actor_uid, actor_role,
        resource_type, resource_table, resource_id, request_id, before_state, after_state, metadata, occurred_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $6::uuid, $4, 'success', $5::uuid, 'DOCTOR',
             'clinical_note', 'clinical_notes', 'N-574', 'req-aa574',
             '{"note":"secret-before"}'::jsonb, '{"note":"secret-after"}'::jsonb,
             '{"summary":"AA574 note created","department_id":"CARDIOLOGY","admission_id":"574"}'::jsonb, NOW())`,
    CLINICAL_ID, TENANT_A, PATIENT_UID, `${MARKER}_CLINICAL`, ACTOR_UID, ENCOUNTER_ID);
  await prisma.$executeRawUnsafe(
    `INSERT INTO hipaa_access_log
       (tenant_id, accessed_by, actor_uid, accessed_by_role, patient_id, record_type, action, request_id, accessed_at)
     VALUES ($1::uuid, $2::uuid, $2::uuid, 'DOCTOR', $3, 'clinical_note', $4, 'req-aa574-phi', NOW())`,
    TENANT_A, ACTOR_UID, PATIENT_UID, `${MARKER}_PHI`);
  await prisma.$executeRawUnsafe(
    `INSERT INTO patient_access_audit_log
       (tenant_id, patient_uid, actor_uid, actor_role, access_decision, access_source, action, request_id, metadata)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, 'DOCTOR', 'allow', 'care_team', $4, 'req-aa574-access', '{}'::jsonb),
       ($1::uuid, $2::uuid, $3::uuid, 'DOCTOR', 'deny', 'unknown', $5, 'req-aa574-deny', '{}'::jsonb),
       ($1::uuid, $2::uuid, $3::uuid, 'DOCTOR', 'allow', 'break_glass', $6, 'req-aa574-break', '{}'::jsonb)`,
    TENANT_A, PATIENT_UID, ACTOR_UID,
    `${MARKER}_ACCESS`, `${MARKER}_DENY`, `${MARKER}_BREAK_GLASS`);
  await prisma.$executeRawUnsafe(
    `INSERT INTO audit_log
       (tenant_id, actor_uid, uid, user_role, method, path, action, success, created_at)
     VALUES ($1::uuid, $2::uuid, $2::uuid, 'DOCTOR', 'POST', '/api/v1/emr/notes', $3, true, NOW())`,
    TENANT_B, ACTOR_UID, `${MARKER}_OTHER_TENANT`);
}

d('Unified audit accountability API', () => {
  // Authentication fails closed when a token's subject has no live identity
  // row, so an invented uid 401s before this suite's authz gate is reached.
  beforeAll(async () => {
    await ensureTestIdentity(ACTOR_UID);
  });
  beforeAll(async () => {
    await clean();
    await seed();
  }, 30000);

  afterAll(async () => {
    await clean();
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('filters per staff, patient, role, date, resource, and outcome with a cursor', async () => {
    const from = encodeURIComponent(new Date(Date.now() - 60_000).toISOString());
    const path = `/api/v1/admin/audit/events?actor_uid=${ACTOR_UID}&patient_uid=${PATIENT_UID}&role=DOCTOR&outcome=success&from=${from}&search=${MARKER}&limit=2`;
    const first = await get(path);
    expect(first.statusCode).toBe(200);
    expect(first.body.data.logs).toHaveLength(2);
    expect(first.body.data.has_more).toBe(true);
    expect(first.body.data.next_cursor).toBeTruthy();
    expect(first.body.data.logs.every((row) => row.actor_uid === ACTOR_UID)).toBe(true);
    expect(first.body.data.logs.every((row) => row.patient_uid === PATIENT_UID)).toBe(true);

    const second = await get(`${path}&cursor=${encodeURIComponent(first.body.data.next_cursor)}`);
    expect(second.statusCode).toBe(200);
    const firstIds = new Set(first.body.data.logs.map((row) => `${row.source}:${row.id}`));
    expect(second.body.data.logs.some((row) => firstIds.has(`${row.source}:${row.id}`))).toBe(false);
  });

  it('keeps other-tenant events out of the normalized feed', async () => {
    const res = await get(`/api/v1/admin/audit/events?search=${MARKER}&limit=100`, TENANT_A);
    expect(res.statusCode).toBe(200);
    const actions = res.body.data.logs.map((row) => row.action);
    expect(actions).not.toContain(`${MARKER}_OTHER_TENANT`);
  });

  it('uses source-table RLS and deterministic UTC for legacy operational timestamps', async () => {
    const [row] = await prisma.$queryRawUnsafe(`
      SELECT c.reloptions, pg_get_viewdef(c.oid, true) AS definition
        FROM pg_class c
       WHERE c.oid = 'unified_audit_events_v'::regclass`);
    expect(row.reloptions).toContain('security_invoker=true');
    expect(row.definition).toContain("al.created_at AT TIME ZONE 'UTC'::text");
    expect(row.definition).not.toContain('current_setting');
  });

  it('filters clinical accountability by department, encounter, and admission', async () => {
    const res = await get(`/api/v1/admin/audit/events?department_id=CARDIOLOGY&encounter_id=${ENCOUNTER_ID}&admission_id=574`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.logs).toHaveLength(1);
    expect(res.body.data.logs[0]).toMatchObject({
      source: 'clinical',
      id: CLINICAL_ID,
      department_id: 'CARDIOLOGY',
      encounter_id: ENCOUNTER_ID,
      admission_id: '574',
    });
  });

  it('surfaces break-glass access as a distinct audit outcome', async () => {
    const res = await get('/api/v1/admin/audit/events?outcome=break_glass&source=patient_access');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: `${MARKER}_BREAK_GLASS`, outcome: 'break_glass' }),
    ]));
  });

  it('returns a useful detail record without raw request or clinical state', async () => {
    const res = await get(`/api/v1/admin/audit/events/clinical/${CLINICAL_ID}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.event.action).toBe(`${MARKER}_CLINICAL`);
    expect(JSON.stringify(res.body.data)).not.toContain('secret-before');
    expect(JSON.stringify(res.body.data)).not.toContain('secret-after');
    expect(res.body.data.redactions).toContain('before_state');
  });

  it('exports filtered events as no-store CSV', async () => {
    const from = encodeURIComponent(new Date(Date.now() - 60_000).toISOString());
    const to = encodeURIComponent(new Date(Date.now() + 60_000).toISOString());
    const res = await get(`/api/v1/admin/audit/export?action=${MARKER}_CLINICAL&from=${from}&to=${to}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain(`${MARKER}_CLINICAL`);
    expect(res.text).not.toContain('secret-before');
    expect(res.headers.digest).toBe(`sha-256=${createHash('sha256').update(Buffer.from(res.text, 'utf8')).digest('base64')}`);
    expect(res.headers['x-audit-export-generated-at']).toBeTruthy();
    expect(Number.isNaN(new Date(res.headers['x-audit-export-generated-at']).getTime())).toBe(false);
    expect(res.headers['x-audit-export-actor-uid']).toBe(ACTOR_UID);
    const [exportAudit] = await prisma.$queryRawUnsafe(`
      SELECT metadata
        FROM audit_logs
       WHERE tenant_id = $1::uuid AND uid = $2::uuid AND action = 'AUDIT_EVENTS_EXPORT'
       ORDER BY created_at DESC LIMIT 1`, TENANT_A, ACTOR_UID);
    expect(exportAudit.metadata).toMatchObject({
      generated_at: res.headers['x-audit-export-generated-at'],
      actor_uid: ACTOR_UID,
      sha256_digest: res.headers.digest.replace('sha-256=', ''),
    });
  });

  it('reports source and correlation completeness for the selected window', async () => {
    const res = await get('/api/v1/admin/audit/health?hours=24&patient_threshold=1');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.generated_at).toBeTruthy();
    expect(res.body.data.total_events).toBeGreaterThanOrEqual(7);
    expect(res.body.data.sources.map((row) => row.source)).toEqual(expect.arrayContaining([
      'request', 'operational', 'clinical', 'phi_access', 'patient_access',
    ]));
    expect(res.body.data.completeness.total_events).toBe(res.body.data.total_events);
    expect(res.body.data.canonical_write_coverage).toHaveProperty('coverage_percent');
    expect(res.body.data.integrity).toEqual(expect.objectContaining({
      missing_hash_count: expect.any(Number),
      hash_mismatch_count: expect.any(Number),
      continuity_break_count: expect.any(Number),
      intact: expect.any(Boolean),
    }));
    expect(res.body.data.resource_completeness.map((row) => row.resource_table)).toEqual([
      'clinical_notes', 'clinical_orders', 'e_prescriptions', 'investigations',
    ]);
    const notes = res.body.data.resource_completeness.find((row) => row.resource_table === 'clinical_notes');
    expect(notes).toEqual(expect.objectContaining({
      resource_rows: expect.any(Number),
      audited_resource_rows: expect.any(Number),
      orphan_resource_rows: expect.any(Number),
      dangling_audit_events: expect.any(Number),
    }));
    expect(notes.dangling_audit_events).toBeGreaterThanOrEqual(1);
    expect(res.body.data.anomalies).toEqual(expect.objectContaining({
      denied_attempts: expect.any(Number),
      break_glass_accesses: expect.any(Number),
      after_hours_accesses: expect.any(Number),
      audit_exports: expect.any(Number),
      high_patient_access_actors: expect.any(Number),
      high_patient_access_threshold: 1,
    }));
    expect(res.body.data.anomalies.denied_attempts).toBeGreaterThanOrEqual(1);
    expect(res.body.data.anomalies.break_glass_accesses).toBeGreaterThanOrEqual(1);
    expect(res.body.data.anomalies.audit_exports).toBeGreaterThanOrEqual(1);
    expect(res.body.data.anomalies.high_patient_access_actors).toBeGreaterThanOrEqual(1);
  });
});
