import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import prisma, { setTenantTx, ensureTenantRlsRuntimeRoleGrants } from '../lib/prisma.js';
import router from '../routes/admin/cathMigrationApprovalRoutes.js';
import integrityRouter from '../routes/clinical/integrityRoutes.js';
import jwtAuth from '../middleware/jwtMiddleware.js';
import { verifyCathMigrationApprovalTx } from '../services/clinical/cathMigrationApprovalService.js';
import { signDocument, signDocumentTx, verifyDocumentSignatureTx } from '../services/clinical/documentIntegrityService.js';
import { errorHandlerMiddleware } from '../middleware/errorHandlerMiddleware.js';

const TENANT = randomUUID();
const OTHER = randomUUID();
const ACTOR = randomUUID();
const PATIENT = randomUUID();
const TOKEN = randomUUID();
const app = express();
app.use(express.json());
app.use('/maintenance/cath', router);
app.use('/integrity', jwtAuth, integrityRouter);
app.use(errorHandlerMiddleware);
const owner = new pg.Client({ connectionString: process.env.DATABASE_URL });
let caseId;
let otherCaseId;
let previousRole;
const TABLES = ['cath_lab_attempt_readiness_records', 'cath_lab_consent_policy_versions'];

function token(claims = {}) {
  return jwt.sign({ uid: ACTOR, role: 'SUPER_ADMIN', mfa: true, tenant_id: TENANT,
    token_epoch: 0, jti: randomUUID(), ...claims }, process.env.JWT_SECRET, { expiresIn: '5m' });
}
function material() {
  return { schema: 'cath-nnn-dispositions/v2', rows: [{
    tenant_id: TENANT, case_id: caseId, issue_class: 'LEGACY_CONSENT_WITHOUT_STRUCTURE',
    disposition: 'PRESERVE_UNKNOWN', source_sha256: '0'.repeat(64),
    decision_material: { consent: null }, evidence_reference: 'fixture:review-1',
  }] };
}
const approve = (body = material(), claims = {}) => request(app).post('/maintenance/cath/dispositions/approve')
  .set('Authorization', `Bearer ${token(claims)}`).send(body);

beforeAll(async () => {
  await owner.connect();
  previousRole = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
  process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = 'vhhealth_app';
  await ensureTenantRlsRuntimeRoleGrants();
  await owner.query(`INSERT INTO tenants(id,slug,name) VALUES ($1::uuid,$1::text,'Cath PR1 test'),($2::uuid,$2::text,'Cath PR1 other')`, [TENANT, OTHER]);
  await owner.query(`INSERT INTO admins(uid,username,password_hash,role,tenant_id,totp_enabled)
    VALUES ($1::uuid,$1::text,'fixture-not-a-password','SUPER_ADMIN',NULL,TRUE)`, [ACTOR]);
  await owner.query(`INSERT INTO tenant_entitlements(tenant_id,package_key,status,assigned_by)
    VALUES ($1,'enterprise','active',$2)`, [TENANT, ACTOR]);
  await owner.query(`INSERT INTO users(uid,tenant_id,phone,name,role,updated_at)
    VALUES ($1::uuid,$2::uuid,left($1::text,15),'Cath PR1 patient','PATIENT',NOW())`, [PATIENT, TENANT]);
  const facility = (await owner.query(`INSERT INTO facilities(tenant_id,facility_code,display_name)
    VALUES ($1,'CATH-PR1','Cath PR1') RETURNING id`, [TENANT])).rows[0].id;
  const otherFacility = (await owner.query(`INSERT INTO facilities(tenant_id,facility_code,display_name)
    VALUES ($1,'CATH-PR1','Cath PR1 other') RETURNING id`, [OTHER])).rows[0].id;
  caseId = (await owner.query(`INSERT INTO cath_lab_cases(tenant_id,patient_uid,facility_id,requested_procedure,status,actual_end_at)
    VALUES ($1,$2,$3,'Fixture procedure','cancelled',NOW()) RETURNING id::text`, [TENANT, PATIENT, facility])).rows[0].id;
  const otherPatient = randomUUID();
  await owner.query(`INSERT INTO users(uid,tenant_id,phone,name,role,updated_at)
    VALUES ($1::uuid,$2::uuid,left($1::text,15),'Cath PR1 other patient','PATIENT',NOW())`, [otherPatient, OTHER]);
  otherCaseId = (await owner.query(`INSERT INTO cath_lab_cases(tenant_id,patient_uid,facility_id,requested_procedure)
    VALUES ($1,$2,$3,'Fixture procedure') RETURNING id::text`, [OTHER, otherPatient, otherFacility])).rows[0].id;
  for (const [tenant, id] of [[TENANT, caseId], [OTHER, otherCaseId]]) {
    await owner.query(`INSERT INTO cath_lab_attempt_readiness_records
      (tenant_id,case_id,procedure_attempt,check_type,lifecycle_token,server_provenance)
      VALUES ($1,$2,1,'consent',$3,'fixture')`, [tenant, id, TOKEN]);
    await owner.query(`INSERT INTO cath_lab_consent_policy_versions
      (tenant_id,version,authority_codes,scopes,modes_by_authority,ordinary_evidence_types,
       emergency_evidence_types,representative_evidence_types,evidence_owner_roles)
      VALUES ($1,'test-v1',ARRAY['patient'],ARRAY['procedure'],'{"patient":["written"]}',
        ARRAY['consent_document'],ARRAY['emergency_document'],ARRAY['representative_document'],ARRAY['DOCTOR'])`, [tenant]);
  }
}, 30000);

afterAll(async () => {
  if (previousRole === undefined) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
  else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = previousRole;
  await owner.query('BEGIN');
  try {
    await owner.query("SET LOCAL session_replication_role = 'replica'");
    for (const table of ['clinical_document_signatures', 'clinical_audit_events', 'audit_logs',
      'entitlement_audit_events', 'tenant_entitlements',
      ...TABLES, 'cath_procedure_logs', 'cath_lab_cases', 'facilities', 'users']) {
      await owner.query(`DELETE FROM ${table} WHERE tenant_id IN ($1,$2)`, [TENANT, OTHER]);
    }
    await owner.query('DELETE FROM admins WHERE uid = $1', [ACTOR]);
    await owner.query('DELETE FROM tenants WHERE id IN ($1,$2)', [TENANT, OTHER]);
    await owner.query('COMMIT');
  } catch (err) {
    await owner.query('ROLLBACK');
    throw err;
  } finally {
    await owner.end();
    await prisma.$disconnect();
  }
});

test('R5-8 attempt table is fail-closed under vhhealth_app', async () => {
  const migration = readFileSync(new URL('../migrations/790_cath_lab_case_attempts.sql', import.meta.url), 'utf8');
  const created = [...migration.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1]).sort();
  expect(created).toEqual([...TABLES].sort());
  for (const table of TABLES) {
    const policies = (await owner.query(`SELECT p.polname,p.polpermissive,p.polcmd,
      pg_get_expr(p.polqual,p.polrelid) AS qual, pg_get_expr(p.polwithcheck,p.polrelid) AS check_qual,
      c.relrowsecurity,c.relforcerowsecurity FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
      WHERE c.relname=$1 ORDER BY polname`, [table])).rows;
    expect(policies).toHaveLength(2);
    expect(policies[0]).toMatchObject({ polname: 'tenant_context_required', polpermissive: false,
      polcmd: '*', qual: '(app_current_tenant_id_uuid() IS NOT NULL)', check_qual: null,
      relrowsecurity: true, relforcerowsecurity: true });
    expect(policies[1].polname).toBe('tenant_isolation');
    expect(policies[1].polpermissive).toBe(true);
    for (const context of [TENANT, undefined, '', 'bypass', OTHER, 'malformed']) {
      // A new connection makes unset genuinely unset, not a pooled empty GUC.
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE vhhealth_app');
        const role = (await client.query('SELECT current_user AS role')).rows[0].role;
        expect(role).toBe('vhhealth_app');
        if (context !== undefined) await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [context]);
        if (context === 'malformed') {
          await expect(client.query(`SELECT tenant_id FROM ${table} WHERE tenant_id=$1`, [TENANT])).rejects.toMatchObject({ code: '22P02' });
        } else {
          const visible = (await client.query(`SELECT tenant_id FROM ${table} WHERE tenant_id=$1`, [TENANT])).rows;
          expect(visible).toEqual(context === TENANT ? [{ tenant_id: TENANT }] : []);
        }
        await client.query('ROLLBACK');
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE vhhealth_app');
        if (context !== undefined) await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [context]);
        const insert = table === TABLES[0]
          ? client.query(`INSERT INTO cath_lab_attempt_readiness_records
             (tenant_id,case_id,procedure_attempt,check_type,lifecycle_token,server_provenance)
             VALUES ($1,$2,1,'timeout',$3,'fixture')`, [TENANT, caseId, TOKEN])
          : client.query(`INSERT INTO cath_lab_consent_policy_versions
             (tenant_id,version,authority_codes,scopes,modes_by_authority,ordinary_evidence_types,
              emergency_evidence_types,representative_evidence_types,evidence_owner_roles)
             VALUES ($1,'insert-control','{}','{}','{}','{}','{}','{}','{}')`, [TENANT]);
        if (context === TENANT) expect((await insert).rowCount).toBe(1);
        else await expect(insert).rejects.toMatchObject({ code: context === 'malformed' ? '22P02' : '42501' });
      } finally {
        await client.query('ROLLBACK');
        await client.end();
      }
    }
  }
}, 30000);

test('R9-1 approval persists and verifies through the real signer', async () => {
  const response = await approve();
  expect(response.status).toBe(201);
  const envelope = response.body.data;
  const receipt = await setTenantTx(TENANT, (tx) => verifyCathMigrationApprovalTx(tx, envelope, TENANT));
  const verdict = await setTenantTx(TENANT, (tx) => verifyDocumentSignatureTx(receipt.signature_id, { tx }));
  expect(verdict.intact).toBe(true);
  expect(verdict.signed_hash).toBe(envelope.content_sha256);
  const stored = (await owner.query(`SELECT s.id,s.audit_event_id,s.content_hash,a.actor_uid,a.after_state,a.chain_hash
    FROM clinical_document_signatures s JOIN clinical_audit_events a ON a.id=s.audit_event_id
    WHERE s.id=$1`, [receipt.signature_id])).rows[0];
  expect(stored).toMatchObject({ audit_event_id: envelope.approval_event_id, content_hash: envelope.content_sha256,
    actor_uid: ACTOR, after_state: material() });
  expect(stored.chain_hash).toMatch(/^[0-9a-f]{64}$/);
  await expect(signDocument({ documentType: 'cath_migration_approval', documentId: envelope.approval_event_id },
    { actorUid: ACTOR, actorRole: 'SUPER_ADMIN' })).rejects.toMatchObject({ code: 'SIGN_APPROVAL_PATH_REQUIRED' });
  const generic = await request(app).post('/integrity/sign').set('Authorization', `Bearer ${token()}`)
    .send({ document_type: 'cath_migration_approval', document_id: envelope.approval_event_id });
  expect(generic.status).toBe(403);
  expect((await owner.query('SELECT count(*)::int AS n FROM clinical_document_signatures WHERE audit_event_id=$1',
    [envelope.approval_event_id])).rows[0].n).toBe(1);
  await expect(setTenantTx(TENANT, (tx) => signDocumentTx({ documentType: 'cath_migration_approval',
    documentId: envelope.approval_event_id, canonicalAuditEventId: envelope.approval_event_id },
  { actorUid: ACTOR, actorRole: 'SUPER_ADMIN' }, { tx }))).rejects.toMatchObject({ code: 'SIGN_PREALLOCATED_EVIDENCE_INCOMPLETE' });
});

test('R7-5 migration approval rejects null and stale decision material', async () => {
  expect((await request(app).post('/maintenance/cath/dispositions/approve').send(material())).status).toBe(401);
  expect((await approve(material(), { mfa: false })).status).toBe(403);
  expect((await approve(material(), { role: 'ADMIN' })).status).toBe(403);
  await owner.query('UPDATE admins SET tenant_id=$2 WHERE uid=$1', [ACTOR, TENANT]);
  expect((await approve()).status).toBe(403);
  await owner.query('UPDATE admins SET tenant_id=NULL WHERE uid=$1', [ACTOR]);
  const multiTenant = material();
  multiTenant.rows.push({ ...multiTenant.rows[0], tenant_id: OTHER, case_id: otherCaseId });
  expect((await approve(multiTenant)).status).toBe(201);
  const before = (await owner.query('SELECT count(*)::int AS n FROM clinical_audit_events WHERE tenant_id=$1', [TENANT])).rows[0].n;
  expect((await approve({ schema: 'cath-nnn-dispositions/v2', rows: [null] })).status).toBe(400);
  const unresolved = material();
  unresolved.rows[0].issue_class = 'PRESTART_WITH_FIRST_START';
  unresolved.rows[0].disposition = null;
  expect((await approve(unresolved)).status).toBe(400);
  expect((await owner.query('SELECT count(*)::int AS n FROM clinical_audit_events WHERE tenant_id=$1', [TENANT])).rows[0].n).toBe(before);
  const result = await approve();
  expect(result.status).toBe(201);
  const changed = structuredClone(result.body.data);
  changed.rows[0].decision_material.consent = { status: 'pass' };
  await expect(setTenantTx(TENANT, (tx) => verifyCathMigrationApprovalTx(tx, changed, TENANT))).rejects.toMatchObject({ code: 'CATH_MIGRATION_MATERIAL_INVALID' });
  await expect(setTenantTx(OTHER, (tx) => verifyCathMigrationApprovalTx(tx, result.body.data, OTHER))).rejects.toMatchObject({ code: 'CATH_MIGRATION_APPROVAL_REQUIRED' });
});

test('R8-5 approval and policy identity are enforceable', async () => {
  await setTenantTx(TENANT, (tx) => tx.$executeRawUnsafe(`UPDATE cath_lab_consent_policy_versions
    SET state='approved',approved_by=$2::uuid,approved_at=NOW() WHERE tenant_id=$1::uuid AND version='test-v1'`, TENANT, ACTOR));
  await expect(setTenantTx(TENANT, (tx) => tx.$executeRawUnsafe(`UPDATE cath_lab_consent_policy_versions
    SET authority_codes=ARRAY['emergency_basis'] WHERE tenant_id=$1::uuid AND version='test-v1'`, TENANT))).rejects.toThrow(/Approved consent policy rules and identity are immutable/);
  // Owner connection has DELETE privilege: the identity trigger must deny it too.
  await expect(owner.query(`DELETE FROM cath_lab_consent_policy_versions WHERE tenant_id=$1 AND version='test-v1'`, [TENANT])).rejects.toMatchObject({ code: '23514' });
  await setTenantTx(TENANT, (tx) => tx.$executeRawUnsafe(`UPDATE cath_lab_consent_policy_versions
    SET state='revoked',revoked_by=$2::uuid,revoked_at=NOW() WHERE tenant_id=$1::uuid AND version='test-v1'`, TENANT, ACTOR));
  await expect(setTenantTx(TENANT, (tx) => tx.$executeRawUnsafe(`UPDATE cath_lab_attempt_readiness_records
    SET policy_version='missing-version' WHERE tenant_id=$1::uuid AND case_id=$2::bigint`, TENANT, caseId))).rejects.toThrow(/cath_attempt_policy_fk/);
});

test('PR1 expansion preserves legacy cancellation and nullable clocks', async () => {
  const row = (await owner.query(`SELECT status, actual_start_at,actual_end_at,attempt_started_at,
    attempt_start_recorded_at FROM cath_lab_cases WHERE id=$1`, [caseId])).rows[0];
  expect(row.status).toBe('cancelled');
  expect(row.actual_start_at).toBeNull();
  expect(row.actual_end_at).not.toBeNull();
  expect(row.attempt_started_at).toBeNull();
  expect(row.attempt_start_recorded_at).toBeNull();
  const columns = (await owner.query(`SELECT column_name,datetime_precision,is_nullable FROM information_schema.columns
    WHERE table_name='cath_lab_attempt_readiness_records' AND column_name IN ('attempt_started_at','attempt_start_recorded_at')
    ORDER BY column_name`)).rows;
  expect(columns).toEqual([
    { column_name: 'attempt_start_recorded_at', datetime_precision: 6, is_nullable: 'YES' },
    { column_name: 'attempt_started_at', datetime_precision: 6, is_nullable: 'YES' },
  ]);
});

test('PR1 attempt snapshots and log revision scope are structural invariants', async () => {
  await owner.query(`UPDATE cath_lab_attempt_readiness_records SET at_start_status='pending',
    at_start_recorded_at=NOW(),attempt_start_recorded_at=NOW(),at_start_metadata='{}',at_start_evidence_refs='[]'
    WHERE tenant_id=$1 AND case_id=$2`, [TENANT, caseId]);
  await expect(owner.query(`UPDATE cath_lab_attempt_readiness_records SET at_start_metadata='{"changed":true}'
    WHERE tenant_id=$1 AND case_id=$2`, [TENANT, caseId])).rejects.toMatchObject({ code: '23514' });
  const insertLog = (attempt, parent = null) => owner.query(`INSERT INTO cath_procedure_logs
    (tenant_id,case_id,patient_uid,procedure_type,procedure_attempt,lifecycle_token,supersedes_log_id)
    VALUES ($1,$2,$3,'fixture',$4,$5,$6) RETURNING id::text`, [TENANT, caseId, PATIENT, attempt, TOKEN, parent]);
  const parent = (await insertLog(1)).rows[0].id;
  await expect(insertLog(2, parent)).rejects.toMatchObject({ code: '23503' });
  expect((await insertLog(1, parent)).rowCount).toBe(1);
  await expect(insertLog(1, parent)).rejects.toMatchObject({ code: '23505' });
});

test('R9-9 each implementation PR leaves main coherent alone', async () => {
  const { default: productionApp } = await import('../app.js');
  const denied = await request(productionApp).post('/api/v1/admin/cath-migration/dispositions/approve')
    .set('X-API-Key', process.env.API_KEY).set('Authorization', `Bearer ${token()}`).send(material());
  expect(denied.status).toBe(404);
  const legacy = await request(productionApp).get('/api/v1/cath-lab/cases')
    .set('X-API-Key', process.env.API_KEY).set('Authorization', `Bearer ${token()}`);
  expect(legacy.status).toBe(200);
}, 60000);
