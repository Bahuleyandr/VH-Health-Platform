// Audit 2026-08-10 R8 — real-Postgres pins for FHIR observation import
// (src/services/import/patientDataImport.js):
//
//   * an import must NEVER overwrite a charted vitals row in place. The old
//     path ran a source-blind ±1-minute dedupe and UPDATEd the matched
//     (typically staff-charted) row — no timeline event, no audit row — and
//     its INSERT branch omitted source, so imports masqueraded as
//     staff-charted.
//   * imports now route through recordVitals: the new row carries
//     source 'fhir', and the canonical clinical timeline invariant holds
//     (detail row + one clinical_timeline_events row + one
//     clinical_audit_events row in the same transaction).
//   * dedupe is idempotency-only: a re-import of the same observation is
//     skipped against the prior 'fhir'-sourced row, never against charted
//     data.
//
// Self-skips without a DB.

import prisma from '../lib/prisma.js';
import { importFhirBundle } from '../services/import/patientDataImport.js';

const hasDb = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001'; // literal default tenant
const PATIENT = '00000000-0000-4000-8000-0000000f4151';
const IMPORTER = '00000000-0000-4000-8000-0000000f4152';

async function exec(sql, ...p) {
  return prisma.$executeRawUnsafe(sql, ...p);
}
async function query(sql, ...p) {
  const r = await prisma.$queryRawUnsafe(sql, ...p);
  return Array.isArray(r) ? r : [];
}

function heartRateBundle(effective, value) {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [{
      resource: {
        resourceType: 'Observation',
        id: 'obs-hr-1',
        status: 'final',
        category: [{ coding: [{ code: 'vital-signs' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] },
        subject: { reference: `Patient/${PATIENT}` },
        effectiveDateTime: effective,
        valueQuantity: { value, unit: 'beats/minute' },
      },
    }],
  };
}

async function cleanup() {
  await exec(`DELETE FROM tasks WHERE patient_uid = $1::uuid`, PATIENT).catch(() => {});
  await exec(`DELETE FROM workflow_sla_instances WHERE patient_uid = $1::uuid`, PATIENT).catch(() => {});
  await exec(`DELETE FROM news2_scores WHERE patient_uid = $1::uuid`, PATIENT).catch(() => {});
  // Append-only guarded tables — test-DB role is a superuser (accepted escape).
  await exec(`DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, PATIENT).catch(() => {});
  await exec(`DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`, PATIENT).catch(() => {});
  await exec(`DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`, PATIENT).catch(() => {});
  await exec(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT, IMPORTER).catch(() => {});
}

d('R8 — FHIR import never overwrites charted vitals (real Postgres)', () => {
  beforeAll(async () => {
    await cleanup();
    await exec(
      `INSERT INTO users (uid, phone, name, role, is_active, status, tenant_id, updated_at)
       VALUES ($1::uuid, '8990333444', 'Import Test Patient', 'PATIENT', true, 'active', $2::uuid, NOW())
       ON CONFLICT (uid) DO NOTHING`,
      PATIENT, TENANT,
    );
    await exec(
      `INSERT INTO users (uid, phone, name, role, is_active, status, tenant_id, updated_at)
       VALUES ($1::uuid, '8990333445', 'Import Test Clerk', 'STAFF', true, 'active', $2::uuid, NOW())
       ON CONFLICT (uid) DO NOTHING`,
      IMPORTER, TENANT,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('a near-duplicate import inserts a distinct fhir-sourced row; the staff row is untouched; timeline + audit exist; re-import dedupes', async () => {
    // A nurse charted HR 80 at time T.
    const chartedAt = new Date(Date.now() - 5 * 60 * 1000);
    await exec(
      `INSERT INTO vitals_chart (tenant_id, patient_uid, heart_rate, source, recorded_by, recorded_at)
       VALUES ($1::uuid, $2::uuid, 80, 'staff', $3::uuid, $4::timestamptz)`,
      TENANT, PATIENT, IMPORTER, chartedAt.toISOString(),
    );

    // An external FHIR bundle carries HR 90 for (nearly) the same instant —
    // inside the old ±1-minute overwrite window.
    const observedAt = new Date(chartedAt.getTime() + 20 * 1000).toISOString();
    const results = await importFhirBundle(heartRateBundle(observedAt, 90), IMPORTER, { tenantId: TENANT });
    expect(results.errors).toEqual([]);
    expect(results.imported).toBe(1);

    const rows = await query(
      `SELECT id, heart_rate, source, recorded_by
         FROM vitals_chart WHERE patient_uid = $1::uuid ORDER BY id`,
      PATIENT,
    );
    expect(rows).toHaveLength(2);
    // The staff-charted row is untouched.
    expect(Number(rows[0].heart_rate)).toBe(80);
    expect(rows[0].source).toBe('staff');
    // The import landed as its OWN row, labelled with its provenance.
    expect(Number(rows[1].heart_rate)).toBe(90);
    expect(rows[1].source).toBe('fhir');
    const importedRowId = rows[1].id;

    // Canonical clinical timeline invariant: the imported vital carries its
    // own timeline + audit pair.
    const timeline = await query(
      `SELECT id FROM clinical_timeline_events
        WHERE source_table = 'vitals_chart' AND source_id = $1::text
          AND event_type = 'vitals.recorded'`,
      String(importedRowId),
    );
    expect(timeline).toHaveLength(1);
    const audit = await query(
      `SELECT id FROM clinical_audit_events
        WHERE resource_table = 'vitals_chart' AND resource_id = $1::text`,
      String(importedRowId),
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);

    // Re-importing the same bundle is an idempotent skip — no third row, and
    // still no mutation of the charted row.
    const rerun = await importFhirBundle(heartRateBundle(observedAt, 90), IMPORTER, { tenantId: TENANT });
    expect(rerun.errors).toEqual([]);
    const after = await query(
      `SELECT id, heart_rate, source FROM vitals_chart WHERE patient_uid = $1::uuid ORDER BY id`,
      PATIENT,
    );
    expect(after).toHaveLength(2);
    expect(Number(after[0].heart_rate)).toBe(80);
  });

  it('an old observation timestamp is accepted (fhir ingest is backdate-exempt)', async () => {
    const observedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const results = await importFhirBundle(heartRateBundle(observedAt, 76), IMPORTER, { tenantId: TENANT });
    expect(results.errors).toEqual([]);
    expect(results.imported).toBe(1);

    const rows = await query(
      `SELECT source FROM vitals_chart
        WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz`,
      PATIENT, observedAt,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('fhir');
  });

  it('keeps distinct FHIR readings inside one minute while deduping an exact replay', async () => {
    const firstAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const secondAt = new Date(firstAt.getTime() + 20 * 1000);

    const first = await importFhirBundle(
      heartRateBundle(firstAt.toISOString(), 84),
      IMPORTER,
      { tenantId: TENANT },
    );
    const secondBundle = heartRateBundle(secondAt.toISOString(), 85);
    const second = await importFhirBundle(secondBundle, IMPORTER, { tenantId: TENANT });
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);

    const rows = await query(
      `SELECT heart_rate, source_device
         FROM vitals_chart
        WHERE patient_uid = $1::uuid
          AND recorded_at IN ($2::timestamptz, $3::timestamptz)
        ORDER BY recorded_at`,
      PATIENT,
      firstAt.toISOString(),
      secondAt.toISOString(),
    );
    expect(rows.map((row) => Number(row.heart_rate))).toEqual([84, 85]);
    expect(rows.every((row) => String(row.source_device).startsWith('fhir:'))).toBe(true);

    await importFhirBundle(secondBundle, IMPORTER, { tenantId: TENANT });
    const replayRows = await query(
      `SELECT id FROM vitals_chart
        WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz`,
      PATIENT,
      secondAt.toISOString(),
    );
    expect(replayRows).toHaveLength(1);
  });

  it('rejects an empty FHIR vital instead of coercing it to a critical zero', async () => {
    const bundle = heartRateBundle(new Date().toISOString(), 72);
    delete bundle.entry[0].resource.valueQuantity;
    bundle.entry[0].resource.valueString = '   ';

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });
    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/must not be empty/);

    const rows = await query(
      `SELECT id FROM vitals_chart
        WHERE patient_uid = $1::uuid AND heart_rate = 0`,
      PATIENT,
    );
    expect(rows).toHaveLength(0);
  });
});
