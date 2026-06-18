// cdsAndDocumentCareTeamGuard.deep.test.js
//
// Audit finding #5 (companion to #4 / fhirCareTeamGuard.deep.test.js): two more
// PHI mounts were tenant-filtered but not under the per-tenant care-team ABAC
// rollout the way nursing-assessments / encounters / FHIR are:
//
//   * /api/v1/cds-services — CDS Hooks; the patient lives in the POST body hook
//     `context` (context.patientId / context.patient). A cdsPatientContext
//     bridge lifts it onto req.phiContext so the governed mount guard can
//     resolve it.
//   * /api/v1/documents     — clinical document export; the patient is a
//     :patientUid route param the generic resolver already reads. Its per-route
//     export guards are now care-team-governed (shadow by default).
//
// This proves the guard actually RESOLVES the patient and runs the access
// decision in SHADOW mode — today it audits without blocking, and the GO_LIVE
// per-tenant enforce flip then covers these mounts too. The airtight
// non-cosmetic proof is the patient_access_audit_log row with
// metadata.shadow_mode = true: it is only written once a patient is RESOLVED (a
// cosmetic no_patient_context guard writes nothing). DB-backed — self-skips when
// no test DB is configured.

import prisma from '../lib/prisma.js';

import { authClient } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const PHONE = `+9199915${String(Date.now() % 10000).padStart(4, '0')}`;
const PATIENT_NAME = 'SHADOWGUARD Patient';
let patientUid;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_access_audit_log
      WHERE patient_uid IN (SELECT uid FROM users WHERE name = $1)`,
    PATIENT_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = $1`, PATIENT_NAME).catch(() => {});
}

async function latestAuditRow() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT access_decision, action, metadata
       FROM patient_access_audit_log
      WHERE patient_uid = $1::uuid
      ORDER BY created_at DESC LIMIT 1`,
    patientUid,
  );
  return rows[0] || null;
}

function metaOf(row) {
  const m = row?.metadata;
  return typeof m === 'string' ? JSON.parse(m) : (m || {});
}

d('CDS Hooks + clinical-document care-team guard parity (#5)', () => {
  beforeAll(async () => {
    await cleanup();
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, '${PATIENT_NAME}', 'PATIENT', true, NOW()) RETURNING uid`,
      PHONE,
    );
    patientUid = p[0].uid;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  // Clear between tests so latestAuditRow() unambiguously reflects the row the
  // mount under test wrote (CDS and documents both target the same patient).
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM patient_access_audit_log WHERE patient_uid = $1::uuid`,
      patientUid,
    ).catch(() => {});
  });

  test('a CDS Hooks invoke (patient in body context) runs the ABAC in SHADOW and does not block', async () => {
    const res = await authClient('DOCTOR')
      .post('/api/v1/cds-services/vh-patient-view')
      .send({ hook: 'patient-view', context: { patientId: patientUid } });

    // Shadow mode never blocks — CDS Hooks behaviour is unchanged today.
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.cards)).toBe(true);

    // The guard RESOLVED the body-context patient (via the cdsPatientContext
    // bridge) and ran the access decision — proof it is not a cosmetic
    // no_patient_context pass-through.
    const row = await latestAuditRow();
    expect(row).not.toBeNull();
    expect(metaOf(row).shadow_mode).toBe(true);
  });

  test('the CDS Hooks discovery endpoint carries no patient context and is not gated', async () => {
    const res = await authClient('DOCTOR').get('/api/v1/cds-services');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.services)).toBe(true);
    // No patient resolvable → no patient_access_audit_log row written.
    expect(await latestAuditRow()).toBeNull();
  });

  test('a clinical-document export (/fhir-bundle/:patientUid) is audited in SHADOW and does not block', async () => {
    const res = await authClient('DOCTOR').get(`/api/v1/documents/fhir-bundle/${patientUid}`);

    // Shadow mode never blocks: the request reaches the export handler instead
    // of being turned away with a 403 by the care-team guard. The handler's own
    // 2xx depends on downstream document-generation queries that are out of
    // scope for this guard test (on a partial QA schema generatePatientBundle
    // may 500) — a non-403 still proves the guard passed the request THROUGH
    // rather than denying it. The shadow audit row below is the resolution proof.
    expect(res.status).not.toBe(403);

    const row = await latestAuditRow();
    expect(row).not.toBeNull();
    expect(row.action).toBe('VIEW');
    expect(metaOf(row).shadow_mode).toBe(true);
  });
});
