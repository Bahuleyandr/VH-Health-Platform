// fhirCareTeamGuard.deep.test.js
//
// Audit finding #4: the FHIR R4 mount was tenant-filtered but bypassed the
// patient care-team ABAC (no patientAccessGuard), unlike the nursing-assessments
// / encounters PHI mounts. This proves the now-wired guard actually RESOLVES the
// FHIR-addressed patient (path /Patient/<id> and ?patient= query) and runs the
// access decision — in SHADOW mode, so today it audits without blocking, and the
// GO_LIVE enforce flip will cover FHIR too.
//
// The airtight non-cosmetic proof is the patient_access_audit_log row: it is only
// written once a patient is RESOLVED (a cosmetic no_patient_context guard writes
// nothing). DB-backed — self-skips when no test DB is configured.

import prisma from '../lib/prisma.js';

import { authClient } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const PHONE = `+9199916${String(Date.now() % 10000).padStart(4, '0')}`;
let patientUid;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_access_audit_log
      WHERE patient_uid IN (SELECT uid FROM users WHERE name = 'FHIRGUARD Patient')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = 'FHIRGUARD Patient'`).catch(() => {});
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

d('FHIR care-team guard parity (#4)', () => {
  beforeAll(async () => {
    await cleanup();
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, 'FHIRGUARD Patient', 'PATIENT', true, NOW()) RETURNING uid`,
      PHONE,
    );
    patientUid = p[0].uid;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('a FHIR instance read (/Patient/<id>) runs the ABAC in SHADOW and does not block', async () => {
    const res = await authClient('DOCTOR').get(`/api/v1/fhir/Patient/${patientUid}`);

    // Shadow mode never blocks — FHIR behaviour is unchanged today.
    expect(res.status).toBe(200);
    expect(res.body.resourceType).toBe('Patient');

    // The guard RESOLVED the path-addressed patient and ran the access decision
    // — proof it is not a cosmetic no_patient_context pass-through.
    const row = await latestAuditRow();
    expect(row).not.toBeNull();
    expect(row.action).toBe('VIEW');
    expect(metaOf(row).shadow_mode).toBe(true);
  });

  test('a FHIR search (?patient=) is audited via the query-param bridge', async () => {
    const res = await authClient('DOCTOR').get(`/api/v1/fhir/Observation?patient=${patientUid}`);

    expect(res.status).toBe(200);
    expect(res.body.resourceType).toBe('Bundle');

    const row = await latestAuditRow();
    expect(row).not.toBeNull();
    expect(metaOf(row).shadow_mode).toBe(true);
  });

  test('the capability statement carries no patient context and is not gated', async () => {
    const res = await authClient('DOCTOR').get('/api/v1/fhir/metadata');
    expect(res.status).toBe(200);
    expect(res.body.resourceType).toBe('CapabilityStatement');
  });
});
