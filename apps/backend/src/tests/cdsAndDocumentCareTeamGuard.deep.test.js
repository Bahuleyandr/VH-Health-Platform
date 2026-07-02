// cdsAndDocumentCareTeamGuard.deep.test.js
//
// Hard-enforce lock-in (#5). The #5 audit pass set out to add a care-team guard
// to two PHI mounts that looked unguarded — but they were already ENFORCING
// patient care-team ABAC (not merely tenant-filtered), so the decision was to
// KEEP them hard-enforcing rather than fold them into the shadow rollout:
//
//   * /api/v1/cds-services — CDS Hooks; cdsHooksRoutes' in-route
//     authorizePatientAccessRequest (enforce + requireResolvedPatient) gates
//     every invoke that carries a patient in the body hook context.
//   * /api/v1/documents     — clinical document export; per-route enforce guards
//     (guardPatientDocumentExport / guardDischargeSummaryExport /
//     guardLabReportExport) gate each export by :patientUid or resource id.
//
// A staff actor (DOCTOR) with NO care-team / referral / appointment / admission
// / break-glass relationship to the patient must be BLOCKED with a real 403 —
// and the block must be a genuine, patient-RESOLVED access decision, proven by a
// patient_access_audit_log row with access_decision='deny' and
// metadata.shadow_mode NOT true. This guards against a future refactor silently
// downgrading either mount to shadow / pass-through (the enforce check is the
// guarantee here, not just the tenant filter). DB-backed — self-skips when no
// test DB is configured.

import prisma from '../lib/prisma.js';

import { authClient } from './testClient.js';
import { withAuditBypass } from './helpers/auditBypass.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const PHONE = `+9199915${String(Date.now() % 10000).padStart(4, '0')}`;
const PATIENT_NAME = 'SHADOWGUARD Patient';
let patientUid;

async function cleanup() {
  await withAuditBypass(prisma, (tx) => tx.$executeRawUnsafe(
    `DELETE FROM patient_access_audit_log
      WHERE patient_uid IN (SELECT uid FROM users WHERE name = $1)`,
    PATIENT_NAME,
  )).catch(() => {});
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

d('CDS Hooks + clinical-document care-team guard (hard-enforce lock-in #5)', () => {
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
    await withAuditBypass(prisma, (tx) => tx.$executeRawUnsafe(
      `DELETE FROM patient_access_audit_log WHERE patient_uid = $1::uuid`,
      patientUid,
    )).catch(() => {});
  });

  test('a CDS Hooks invoke for an unrelated patient is BLOCKED (403) by the enforce guard', async () => {
    const res = await authClient('DOCTOR')
      .post('/api/v1/cds-services/vh-patient-view')
      .send({ hook: 'patient-view', context: { patientId: patientUid } });

    // Hard enforce: a doctor with no relationship to this patient is denied.
    expect(res.status).toBe(403);

    // The block RESOLVED the body-context patient and recorded a real deny
    // decision — proof it is genuine care-team ABAC enforcement, not a cosmetic
    // pass-through (a no_patient_context guard would write nothing) and not
    // shadow (which would have allowed + flagged shadow_mode).
    const row = await latestAuditRow();
    expect(row).not.toBeNull();
    expect(row.access_decision).toBe('deny');
    expect(metaOf(row).shadow_mode).not.toBe(true);
  });

  test('the CDS Hooks discovery endpoint carries no patient context and is not gated', async () => {
    const res = await authClient('DOCTOR').get('/api/v1/cds-services');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.services)).toBe(true);
    // No patient resolvable → no patient_access_audit_log row written.
    expect(await latestAuditRow()).toBeNull();
  });

  test('a clinical-document export for an unrelated patient is BLOCKED (403) by the enforce guard', async () => {
    const res = await authClient('DOCTOR').get(`/api/v1/documents/fhir-bundle/${patientUid}`);

    // Hard enforce: blocked before the document is ever generated.
    expect(res.status).toBe(403);

    const row = await latestAuditRow();
    expect(row).not.toBeNull();
    expect(row.access_decision).toBe('deny');
    expect(metaOf(row).shadow_mode).not.toBe(true);
  });
});
