// Roadmap D4 — NABH indicator pack deep round-trip + CSV shape.

import prisma from '../lib/prisma.js';
import { waitForAuditLogDrain } from '../middleware/auditLog.js';
import { authClient } from './testClient.js';
import { deleteWithAuditBypass } from './helpers/auditBypass.js';
import { packToCsv, packToPdfBuffer, INDICATOR_CODES } from '../services/quality/nabhIndicatorService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

// Every indicator here is a tenant-wide rollup over a fixed window, so the
// suite owns the tenant it measures (post-#675 pattern — see
// cath-scheduling-registry.deep.test.js). On the default tenant the exact
// numerator/denominator assertions below are hostage to the comprehensive
// seeder and to any cohabiting suite that writes a March-2026 discharge,
// feedback row, or quality incident. Both tenants are created in beforeAll and
// dropped in afterAll; nothing is read or written outside them.
//
// TENANT_DECOY carries in-window rows of every measured shape. It is what
// keeps the isolation guarantee honest: if tenant scoping ever regressed, the
// exact counts would move rather than staying at 1/2.
const TENANT = 'd4d40000-0000-4000-8000-0000000000d4';
const TENANT_DECOY = 'd4d40000-0000-4000-8000-0000000000de';
const PHONE = '+919992000401';
const DECOY_PHONE = '+919992000402';
const REPORTER_UID = '550e8400-e29b-41d4-a716-446655440000';
const FROM = '2026-03-01';
const TO = '2026-03-31';
let patientUid;

// tenantContextMiddleware resolves the JWT tenant_id claim first, so stamping
// it on the token is what puts every request below inside TENANT.
const asTenant = (role) => authClient(role, { tenant_id: TENANT });

// Creating and dropping a tenant is not fast: 685 foreign keys reference
// tenants(id), so each DELETE pays a check per constraint (~2s here). Both
// hooks below carry an explicit timeout for that reason — jest's 5s default is
// not enough, and a standalone run must not depend on the CI runner's
// --testTimeout=60000.
const HOOK_TIMEOUT_MS = 120000;

async function cleanup() {
  // Children first: admissions/incidents/feedback/snapshots all carry an FK to
  // tenants, and admissions/incidents reference the patient row.
  const bothTenants = [TENANT, TENANT_DECOY];
  await waitForAuditLogDrain();
  await deleteWithAuditBypass(
    prisma,
    'DELETE FROM audit_log WHERE tenant_id IN ($1::uuid, $2::uuid)',
    ...bothTenants,
  ).catch(() => {});
  for (const sql of [
    'DELETE FROM nabh_indicator_snapshots WHERE tenant_id IN ($1::uuid, $2::uuid)',
    'DELETE FROM quality_incidents WHERE tenant_id IN ($1::uuid, $2::uuid)',
    'DELETE FROM feedback WHERE tenant_id IN ($1::uuid, $2::uuid)',
    'DELETE FROM admissions WHERE tenant_id IN ($1::uuid, $2::uuid)',
    'DELETE FROM users WHERE tenant_id IN ($1::uuid, $2::uuid)',
  ]) {
    await prisma.$executeRawUnsafe(sql, ...bothTenants).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    'DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)',
    ...bothTenants,
  );
}

d('NABH indicators — deep round-trip (roadmap D4)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status)
       VALUES ($1::uuid, 'd4test-nabh', 'D4TEST NABH Tenant', 'IN', 'DPDP', 'active'),
              ($2::uuid, 'd4test-nabh-decoy', 'D4TEST NABH Decoy Tenant', 'IN', 'DPDP', 'active')
       ON CONFLICT (id) DO NOTHING`,
      TENANT, TENANT_DECOY,
    );
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'D4TEST Patient', 'PATIENT', true, NOW()) RETURNING uid`,
      TENANT, PHONE,
    );
    patientUid = p[0].uid;
    // One routine discharge + one LAMA inside the period → 50% AMA/LAMA.
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions (tenant_id, patient_uid, allergies, status, ward, bed_number, admitted_at, discharged_at, discharge_type, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, '{}', 'discharged', 'D4TEST Ward', 'D4-01', '2026-03-02', '2026-03-05', 'routine', NOW(), NOW()),
              ($1::uuid, $2::uuid, '{}', 'discharged', 'D4TEST Ward', 'D4-02', '2026-03-10', '2026-03-12', 'LAMA', NOW(), NOW())`,
      TENANT, patientUid,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO feedback (tenant_id, phone, rating, comment, category, created_at, updated_at)
       VALUES ($1::uuid, $2, 5, 'D4TEST great', 'GENERAL', '2026-03-06', NOW()),
              ($1::uuid, $2, 3, 'D4TEST ok', 'GENERAL', '2026-03-07', NOW())`,
      TENANT, PHONE,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO quality_incidents
         (tenant_id, incident_number, reported_by, patient_uid, incident_type, severity, description,
          date_occurred, status, root_cause, corrective_action, preventive_action, resolved_at)
       VALUES
         ($1::uuid, 'D4TEST-RCA-1', $3::uuid, $2::uuid, 'fall',
          'sentinel', 'D4TEST sentinel incident', '2026-03-08', 'closed',
          'Process gap', 'Checklist updated', 'Monthly audit', '2026-03-10'),
         ($1::uuid, 'D4TEST-RCA-2', $3::uuid, $2::uuid, 'near_miss',
          'major', 'D4TEST major incident', '2026-03-09', 'investigating',
          NULL, NULL, NULL, NULL)`,
      TENANT, patientUid, REPORTER_UID,
    );

    // Decoy tenant: same window, same shapes, values chosen so any bleed would
    // break the exact 1/2 assertions (an extra AMA discharge, an extra positive
    // rating, an extra unresolved major incident).
    const decoyPatient = await prisma.$queryRawUnsafe(
      `INSERT INTO users (tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'D4TEST Decoy Patient', 'PATIENT', true, NOW()) RETURNING uid`,
      TENANT_DECOY, DECOY_PHONE,
    );
    const decoyPatientUid = decoyPatient[0].uid;
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions (tenant_id, patient_uid, allergies, status, ward, bed_number, admitted_at, discharged_at, discharge_type, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, '{}', 'discharged', 'D4TEST Decoy Ward', 'D4D-01', '2026-03-03', '2026-03-06', 'AMA', NOW(), NOW())`,
      TENANT_DECOY, decoyPatientUid,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO feedback (tenant_id, phone, rating, comment, category, created_at, updated_at)
       VALUES ($1::uuid, $2, 5, 'D4TEST decoy great', 'GENERAL', '2026-03-06', NOW())`,
      TENANT_DECOY, DECOY_PHONE,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO quality_incidents
         (tenant_id, incident_number, reported_by, patient_uid, incident_type, severity, description,
          date_occurred, status, root_cause, corrective_action, preventive_action, resolved_at)
       VALUES
         ($1::uuid, 'D4TEST-DECOY-RCA-1', $3::uuid, $2::uuid, 'fall',
          'major', 'D4TEST decoy major incident', '2026-03-11', 'investigating',
          NULL, NULL, NULL, NULL)`,
      TENANT_DECOY, decoyPatientUid, REPORTER_UID,
    );
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  }, HOOK_TIMEOUT_MS);

  test('computes the pack with isolated, schema-tolerant indicators', async () => {
    const res = await asTenant('QUALITY_OFFICER')
      .get('/api/v1/quality/nabh/indicators')
      .query({ from: FROM, to: TO });
    expect(res.status).toBe(200);
    const pack = res.body.data;
    expect(pack.indicators.map((i) => i.code).sort()).toEqual([...INDICATOR_CODES].sort());

    const ama = pack.indicators.find((i) => i.code === 'ama_lama_discharge_pct');
    expect(ama.available).toBe(true);
    expect(ama.numerator).toBe(1);
    expect(ama.denominator).toBe(2);
    expect(ama.value).toBe(50);

    const hai = pack.indicators.find((i) => i.code === 'hai_rate_per_1000_patient_days');
    expect(hai.available).toBe(true);
    expect(Number(hai.denominator)).toBeGreaterThan(0); // patient-days from the two stays

    const satisfaction = pack.indicators.find((i) => i.code === 'patient_satisfaction_positive_pct');
    expect(satisfaction.available).toBe(true);
    expect(satisfaction.numerator).toBe(1);
    expect(satisfaction.denominator).toBe(2);
    expect(satisfaction.value).toBe(50);

    const rca = pack.indicators.find((i) => i.code === 'rca_completion_pct');
    expect(rca.available).toBe(true);
    expect(rca.numerator).toBe(1);
    expect(rca.denominator).toBe(2);
    expect(rca.value).toBe(50);
    expect(rca.details.rca_required_scope).toContain('major, sentinel');
  });

  test('rows from a second tenant in the same window never enter the rollup', async () => {
    // Prove the decoy really is in-window first — otherwise this guard could
    // silently go vacuous and stop protecting the counts above.
    const decoy = await prisma.$queryRawUnsafe(
      `SELECT (SELECT COUNT(*)::int FROM admissions
                WHERE tenant_id = $1::uuid
                  AND discharged_at >= $2::date AND discharged_at < ($3::date + 1)) AS discharges,
              (SELECT COUNT(*)::int FROM feedback
                WHERE tenant_id = $1::uuid
                  AND created_at >= $2::date AND created_at < ($3::date + 1)
                  AND rating BETWEEN 1 AND 5) AS ratings,
              (SELECT COUNT(*)::int FROM quality_incidents
                WHERE tenant_id = $1::uuid
                  AND severity IN ('major', 'sentinel')
                  AND date_occurred >= $2::date AND date_occurred < ($3::date + 1)) AS rca_required`,
      TENANT_DECOY, FROM, TO,
    );
    expect(Number(decoy[0].discharges)).toBe(1);
    expect(Number(decoy[0].ratings)).toBe(1);
    expect(Number(decoy[0].rca_required)).toBe(1);

    const res = await asTenant('QUALITY_OFFICER')
      .get('/api/v1/quality/nabh/indicators')
      .query({ from: FROM, to: TO });
    expect(res.status).toBe(200);
    const byCode = Object.fromEntries(res.body.data.indicators.map((i) => [i.code, i]));
    expect(byCode.ama_lama_discharge_pct.numerator).toBe(1);
    expect(byCode.ama_lama_discharge_pct.denominator).toBe(2);
    expect(byCode.patient_satisfaction_positive_pct.numerator).toBe(1);
    expect(byCode.patient_satisfaction_positive_pct.denominator).toBe(2);
    expect(byCode.rca_completion_pct.numerator).toBe(1);
    expect(byCode.rca_completion_pct.denominator).toBe(2);
  });

  test('CSV export is assessor-shaped', async () => {
    const res = await asTenant('ADMIN')
      .get('/api/v1/quality/nabh/indicators')
      .query({ from: FROM, to: TO, format: 'csv' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.split('\n');
    expect(lines[0]).toBe('indicator_code,label,value,unit,numerator,denominator,period_start,period_end,available,definition_status,evidence_control,source_tables,assessor_note');
    expect(lines.length).toBe(INDICATOR_CODES.length + 1);
    expect(res.text).toContain('pending_assessor_format');
  });

  test('snapshots persist and list; nurses blocked', async () => {
    const snap = await asTenant('CMO')
      .post('/api/v1/quality/nabh/snapshots')
      .send({ from: FROM, to: TO });
    expect(snap.status).toBe(201);
    expect(snap.body.data.snapshot_saved).toBeGreaterThanOrEqual(4);

    const list = await asTenant('QUALITY_OFFICER')
      .get('/api/v1/quality/nabh/snapshots')
      .query({ from: FROM, to: TO });
    expect(list.status).toBe(200);
    expect(list.body.data.count).toBeGreaterThanOrEqual(4);

    const nurse = await asTenant('NURSING_STAFF')
      .get('/api/v1/quality/nabh/indicators')
      .query({ from: FROM, to: TO });
    expect(nurse.status).toBe(403);
  });

  test('freezes a period pack and exports assessor-ready JSON, CSV, and PDF', async () => {
    const freeze = await asTenant('CMO')
      .post('/api/v1/quality/nabh/period-pack')
      .send({ from: FROM, to: TO });
    expect(freeze.status).toBe(201);
    expect(freeze.body.data.pack_type).toBe('NABH_PERIOD_PACK');
    expect(freeze.body.data.export_contract.canonical_format_status).toBe('pending_assessor_format');
    expect(freeze.body.data.evidence_attachment.control_code).toBe('NABH_AUDIT_EXPORT');
    expect(freeze.body.data.snapshot_saved).toBe(INDICATOR_CODES.length);
    expect(freeze.body.data.missing_indicator_codes).toEqual([]);

    const json = await asTenant('QUALITY_OFFICER')
      .get('/api/v1/quality/nabh/period-pack')
      .query({ from: FROM, to: TO });
    expect(json.status).toBe(200);
    expect(json.body.data.status).toBe('frozen');
    expect(json.body.data.indicator_count).toBe(INDICATOR_CODES.length);

    const csv = await asTenant('QUALITY_OFFICER')
      .get('/api/v1/quality/nabh/period-pack')
      .query({ from: FROM, to: TO, format: 'csv' });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-disposition']).toContain('nabh-period-pack');
    expect(csv.text).toContain('NABH_AUDIT_EXPORT');

    const pdfBuffer = await packToPdfBuffer(json.body.data);
    expect(pdfBuffer.subarray(0, 4).toString('utf8')).toBe('%PDF');
  });

  test('packToCsv escapes embedded commas/quotes (pure)', () => {
    const csv = packToCsv({
      period: { from: FROM, to: TO },
      export_contract: { canonical_format_status: 'pending_assessor_format' },
      indicators: [{ code: 'x', label: 'Label, with "quotes"', value: 1, unit: '%', numerator: 1, denominator: 2, available: true, definition: { source_tables: ['a'], assessor_note: 'note' }, details: {} }],
    });
    expect(csv.split('\n')[1]).toContain('"Label, with ""quotes"""');
  });

  test('inverted period is a clean 400', async () => {
    const res = await asTenant('ADMIN')
      .get('/api/v1/quality/nabh/indicators')
      .query({ from: TO, to: FROM });
    expect(res.status).toBe(400);
  });
});
