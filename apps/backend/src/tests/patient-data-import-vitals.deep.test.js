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

import { jest } from '@jest/globals';

import prisma from '../lib/prisma.js';
import { importFhirBundle } from '../services/import/patientDataImport.js';

const hasDb = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = hasDb ? describe : describe.skip;
jest.setTimeout(30_000);

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

function observationId(prefix, effective) {
  return `${prefix}-${new Date(effective).getTime()}`;
}

function heartRateBundle(effective, value, { id = observationId('obs-hr', effective) } = {}) {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [{
      resource: {
        resourceType: 'Observation',
        id,
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

function heightBundle(effective, value, {
  id = observationId('obs-height', effective),
  code = 'cm',
  unit = 'centimetres',
} = {}) {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [{
      resource: {
        resourceType: 'Observation',
        id,
        status: 'final',
        category: [{ coding: [{ code: 'vital-signs' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '8302-2' }] },
        subject: { reference: `Patient/${PATIENT}` },
        effectiveDateTime: effective,
        valueQuantity: { value, code, unit },
      },
    }],
  };
}

function compositeNews2Bundle(effective, { idSuffix = '' } = {}) {
  const timestampSuffix = new Date(effective).getTime();
  const observations = [
    { id: 'obs-rr-crit', code: '9279-1', value: 26, unit: 'breaths/minute' },
    { id: 'obs-spo2-crit', code: '2708-6', value: 88, unit: '%' },
    { id: 'obs-sbp-crit', code: '8480-6', value: 88, unit: 'mmHg' },
    { id: 'obs-hr-crit', code: '8867-4', value: 132, unit: 'beats/minute' },
    { id: 'obs-temp-normal', code: '8310-5', value: 37, unit: 'Cel' },
  ];
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: observations.map(({ id, code, value, unit }) => ({
      resource: {
        resourceType: 'Observation',
        id: `${id}-${timestampSuffix}${idSuffix}`,
        status: 'final',
        category: [{ coding: [{ code: 'vital-signs' }] }],
        code: { coding: [{ system: 'http://loinc.org', code }] },
        subject: { reference: `Patient/${PATIENT}` },
        effectiveDateTime: effective,
        valueQuantity: { value, unit },
      },
    })),
  };
}

function componentAndFahrenheitBundle(effective) {
  const timestampSuffix = new Date(effective).getTime();
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      {
        resource: {
          resourceType: 'Observation',
          id: `obs-bp-panel-${timestampSuffix}`,
          status: 'final',
          category: [{ coding: [{ code: 'vital-signs' }] }],
          code: { coding: [{ system: 'http://loinc.org', code: '85354-9' }] },
          subject: { reference: `Patient/${PATIENT}` },
          effectiveDateTime: effective,
          component: [
            { code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] }, valueQuantity: { value: 118, unit: 'mmHg' } },
            { code: { coding: [{ system: 'http://loinc.org', code: '8462-4' }] }, valueQuantity: { value: 72, unit: 'mmHg' } },
          ],
        },
      },
      {
        resource: {
          resourceType: 'Observation',
          id: `obs-temp-fahrenheit-${timestampSuffix}`,
          status: 'final',
          category: [{ coding: [{ code: 'vital-signs' }] }],
          code: { coding: [{ system: 'http://loinc.org', code: '8310-5' }] },
          subject: { reference: `Patient/${PATIENT}` },
          effectiveDateTime: effective,
          valueQuantity: { value: 98.6, unit: 'degF' },
        },
      },
    ],
  };
}

async function cleanup() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    await tx.$executeRawUnsafe(`DELETE FROM tasks WHERE patient_uid = $1::uuid`, PATIENT);
    await tx.$executeRawUnsafe(`DELETE FROM workflow_sla_instances WHERE patient_uid = $1::uuid`, PATIENT);
  }).catch(() => {});
  await exec(`DELETE FROM news2_scores WHERE patient_uid = $1::uuid`, PATIENT).catch(() => {});
  await exec(`DELETE FROM clinical_alerts WHERE patient_id = (SELECT id FROM users WHERE uid = $1::uuid)`, PATIENT).catch(() => {});
  // Append-only guarded tables — test-DB role is a superuser (accepted escape).
  await exec(`DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, PATIENT).catch(() => {});
  await exec(`DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`, PATIENT).catch(() => {});
  await exec(`DELETE FROM fhir_vital_observation_set_resources WHERE tenant_id = $1::uuid`, TENANT).catch(() => {});
  await exec(`DELETE FROM fhir_vital_observation_sets WHERE patient_uid = $1::uuid`, PATIENT).catch(() => {});
  await exec(`DELETE FROM fhir_vital_observation_receipts WHERE patient_uid = $1::uuid`, PATIENT).catch(() => {});
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
      TENANT, PATIENT, IMPORTER, chartedAt,
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
    expect(rerun.imported).toBe(0);
    expect(rerun.deduplicated).toBe(1);
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
      PATIENT, new Date(observedAt),
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
      firstAt,
      secondAt,
    );
    expect(rows.map((row) => Number(row.heart_rate))).toEqual([84, 85]);
    expect(rows.every((row) => String(row.source_device).startsWith('fhir-set:'))).toBe(true);

    await importFhirBundle(secondBundle, IMPORTER, { tenantId: TENANT });
    const replayRows = await query(
      `SELECT id FROM vitals_chart
        WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz`,
      PATIENT,
      secondAt,
    );
    expect(replayRows).toHaveLength(1);
  });

  it('deduplicates timezone-equivalent representations of the same FHIR resource', async () => {
    const utcInstant = '2026-08-09T10:00:00.123Z';
    const offsetInstant = '2026-08-09T15:30:00.123+05:30';

    const first = await importFhirBundle(heartRateBundle(utcInstant, 82), IMPORTER, { tenantId: TENANT });
    const replay = await importFhirBundle(heartRateBundle(offsetInstant, 82), IMPORTER, { tenantId: TENANT });

    expect(first).toEqual(expect.objectContaining({ imported: 1, deduplicated: 0, errors: [] }));
    expect(replay).toEqual(expect.objectContaining({ imported: 0, deduplicated: 1, errors: [] }));
    const rows = await query(
      `SELECT id FROM vitals_chart
        WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz`,
      PATIENT, new Date(utcInstant),
    );
    expect(rows).toHaveLength(1);
  });

  it('deduplicates unit-equivalent values but preserves a distinct FHIR resource id', async () => {
    const observedAt = '2026-08-09T11:00:00.456Z';
    const metres = await importFhirBundle(
      heightBundle(observedAt, 1.82, { code: 'm', unit: 'metres' }),
      IMPORTER,
      { tenantId: TENANT },
    );
    const centimetreReplay = await importFhirBundle(
      heightBundle(observedAt, 182, { code: 'cm', unit: 'centimetres' }),
      IMPORTER,
      { tenantId: TENANT },
    );
    const distinctId = await importFhirBundle(
      heightBundle(observedAt, 182, {
        id: 'obs-height-distinct',
        code: 'cm',
        unit: 'centimetres',
      }),
      IMPORTER,
      { tenantId: TENANT },
    );

    expect(metres).toEqual(expect.objectContaining({ imported: 1, deduplicated: 0, errors: [] }));
    expect(centimetreReplay).toEqual(expect.objectContaining({ imported: 0, deduplicated: 1, errors: [] }));
    expect(distinctId).toEqual(expect.objectContaining({ imported: 1, deduplicated: 0, errors: [] }));
    const rows = await query(
      `SELECT height_cm, source_device FROM vitals_chart
        WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz
        ORDER BY id`,
      PATIENT, new Date(observedAt),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map(({ height_cm: heightCm }) => Number(heightCm))).toEqual([182, 182]);
    expect(new Set(rows.map(({ source_device: sourceDevice }) => sourceDevice)).size).toBe(2);
  });

  it('atomically conflicts concurrent changed content under one logical Observation.id', async () => {
    const observedAt = '2026-08-09T11:30:00.456Z';
    const logicalResourceId = 'obs-hr-shared-logical';
    const sourceA = heartRateBundle(observedAt, 80, { id: logicalResourceId });
    sourceA.entry[0].fullUrl = `https://source-a.example/fhir/Observation/${logicalResourceId}`;
    sourceA.entry[0].resource.meta = { versionId: '1' };
    const changedContent = heartRateBundle(observedAt, 81, { id: logicalResourceId });
    changedContent.entry[0].fullUrl = `https://source-b.example/fhir/Observation/${logicalResourceId}`;
    changedContent.entry[0].resource.meta = { versionId: '2' };

    const concurrent = await Promise.all([
      importFhirBundle(sourceA, IMPORTER, { tenantId: TENANT }),
      importFhirBundle(changedContent, IMPORTER, { tenantId: TENANT }),
    ]);
    const winnerIndex = concurrent.findIndex(({ imported }) => imported === 1);
    const loserIndex = concurrent.findIndex(({ errors }) => errors.length === 1);

    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    expect(loserIndex).toBeGreaterThanOrEqual(0);
    expect(winnerIndex).not.toBe(loserIndex);
    expect(concurrent.reduce((sum, result) => sum + result.imported, 0)).toBe(1);
    expect(concurrent.reduce((sum, result) => sum + result.deduplicated, 0)).toBe(0);
    expect(concurrent.reduce((sum, result) => sum + result.errors.length, 0)).toBe(1);
    expect(concurrent[loserIndex]).toEqual(expect.objectContaining({
      imported: 0,
      skipped: 0,
      deduplicated: 0,
      errors: [expect.objectContaining({
        id: logicalResourceId,
        code: 'FHIR_OBSERVATION_RESOURCE_ID_CONFLICT',
        error: expect.stringMatching(/already imported with different canonical content/),
      })],
      observationPartitions: [expect.objectContaining({
        status: 'error',
        resourceCount: 1,
        errorCode: 'FHIR_OBSERVATION_RESOURCE_ID_CONFLICT',
      })],
    }));

    const committed = await query(
      `SELECT v.id, v.heart_rate, v.source_device,
              COUNT(n.id)::integer AS news2_count
         FROM vitals_chart v
         LEFT JOIN news2_scores n ON n.vitals_chart_id = v.id
        WHERE v.patient_uid = $1::uuid
          AND v.recorded_at = $2::timestamptz
        GROUP BY v.id, v.heart_rate, v.source_device`,
      PATIENT, new Date(observedAt),
    );
    expect(committed).toHaveLength(1);
    expect(Number(committed[0].heart_rate)).toBe(winnerIndex === 0 ? 80 : 81);
    expect(committed[0].news2_count).toBe(1);

    const receipts = await query(
      `SELECT
         (SELECT COUNT(*)::integer FROM fhir_vital_observation_receipts
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND resource_id = $4) AS receipts,
         (SELECT COUNT(*)::integer FROM fhir_vital_observation_sets
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND observed_at = $3::timestamptz) AS sets,
         (SELECT COUNT(*)::integer
            FROM fhir_vital_observation_set_resources links
            JOIN fhir_vital_observation_sets sets
              ON sets.tenant_id = links.tenant_id
             AND sets.set_fingerprint = links.set_fingerprint
           WHERE sets.tenant_id = $1::uuid
             AND sets.patient_uid = $2::uuid
             AND sets.observed_at = $3::timestamptz) AS links`,
      TENANT, PATIENT, new Date(observedAt), logicalResourceId,
    );
    expect(receipts[0]).toEqual({ receipts: 1, sets: 1, links: 1 });

    const winningReplay = structuredClone(winnerIndex === 0 ? sourceA : changedContent);
    winningReplay.entry[0].fullUrl = `https://untrusted-replay.example/fhir/Observation/${logicalResourceId}`;
    winningReplay.entry[0].resource.meta.versionId = '999';
    const replay = await importFhirBundle(winningReplay, IMPORTER, { tenantId: TENANT });
    expect(replay).toEqual(expect.objectContaining({ imported: 0, deduplicated: 1, errors: [] }));

    const distinctId = structuredClone(winningReplay);
    distinctId.entry[0].resource.id = 'obs-hr-distinct';
    const distinct = await importFhirBundle(distinctId, IMPORTER, { tenantId: TENANT });
    expect(distinct).toEqual(expect.objectContaining({ imported: 1, deduplicated: 0, errors: [] }));
    const finalRows = await query(
      `SELECT COUNT(*)::integer AS vitals_count,
              COUNT(n.id)::integer AS news2_count
         FROM vitals_chart v
         LEFT JOIN news2_scores n ON n.vitals_chart_id = v.id
        WHERE v.patient_uid = $1::uuid
          AND v.recorded_at = $2::timestamptz`,
      PATIENT, new Date(observedAt),
    );
    expect(finalRows[0]).toEqual({ vitals_count: 2, news2_count: 2 });
  });

  it('rejects an empty FHIR vital instead of coercing it to a critical zero', async () => {
    const bundle = heartRateBundle(new Date().toISOString(), 72);
    delete bundle.entry[0].resource.valueQuantity;
    bundle.entry[0].resource.valueString = '   ';

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });
    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/finite numeric Quantity value/);

    const rows = await query(
      `SELECT id FROM vitals_chart
        WHERE patient_uid = $1::uuid AND heart_rate = 0`,
      PATIENT,
    );
    expect(rows).toHaveLength(0);
  });

  it('imports one same-instant FHIR vitals set as one composite NEWS2 12 high-risk assessment', async () => {
    const observedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const result = await importFhirBundle(compositeNews2Bundle(observedAt), IMPORTER, { tenantId: TENANT });
    expect(result.errors).toEqual([]);
    expect(result.imported).toBe(5);

    const rows = await query(
      `SELECT v.id, v.respiratory_rate, v.spo2, v.systolic_bp, v.heart_rate, v.temperature,
              n.total_score, n.clinical_risk, n.escalation_action
         FROM vitals_chart v
         JOIN news2_scores n ON n.vitals_chart_id = v.id
        WHERE v.patient_uid = $1::uuid
          AND v.recorded_at = $2::timestamptz
          AND n.superseded_at IS NULL
        ORDER BY n.id DESC`,
      PATIENT, new Date(observedAt),
    );

    expect(rows).toHaveLength(1);
    expect([
      rows[0].respiratory_rate,
      rows[0].spo2,
      rows[0].systolic_bp,
      rows[0].heart_rate,
      rows[0].temperature,
    ].map(Number)).toEqual([26, 88, 88, 132, 37]);
    expect(Number(rows[0].total_score)).toBe(12);
    expect(rows[0].clinical_risk).toBe('high');
    expect(rows[0].escalation_action).toMatch(/Emergency response/i);

    const replay = await importFhirBundle(compositeNews2Bundle(observedAt), IMPORTER, { tenantId: TENANT });
    expect(replay.errors).toEqual([]);
    expect(replay.imported).toBe(0);
    expect(replay.deduplicated).toBe(5);
    expect(replay.observationPartitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'deduplicated', resourceCount: 5 }),
    ]));
    const afterReplay = await query(
      `SELECT v.id, v.source_device, n.id AS news2_id
         FROM vitals_chart v
         JOIN news2_scores n ON n.vitals_chart_id = v.id
        WHERE v.patient_uid = $1::uuid
          AND v.recorded_at = $2::timestamptz`,
      PATIENT, new Date(observedAt),
    );
    expect(afterReplay).toHaveLength(1);
    expect(afterReplay[0].source_device).toMatch(/^fhir-set:[0-9a-f]{64}$/);

    const distinct = await importFhirBundle(
      compositeNews2Bundle(observedAt, { idSuffix: '-distinct' }),
      IMPORTER,
      { tenantId: TENANT },
    );
    expect(distinct.errors).toEqual([]);
    expect(distinct.imported).toBe(5);
    const distinctRows = await query(
      `SELECT v.source_device, n.total_score, n.clinical_risk
         FROM vitals_chart v
         JOIN news2_scores n ON n.vitals_chart_id = v.id
        WHERE v.patient_uid = $1::uuid
          AND v.recorded_at = $2::timestamptz
        ORDER BY v.id`,
      PATIENT, new Date(observedAt),
    );
    expect(distinctRows).toHaveLength(2);
    expect(new Set(distinctRows.map((row) => row.source_device)).size).toBe(2);
    expect(distinctRows.map((row) => Number(row.total_score))).toEqual([12, 12]);
    expect(distinctRows.map((row) => row.clinical_risk)).toEqual(['high', 'high']);
  });

  it('keeps component observations and source units inside the grouped bundle path', async () => {
    const observedAt = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const result = await importFhirBundle(componentAndFahrenheitBundle(observedAt), IMPORTER, { tenantId: TENANT });
    expect(result.errors).toEqual([]);
    expect(result.imported).toBe(2);

    const rows = await query(
      `SELECT systolic_bp, diastolic_bp, temperature
         FROM vitals_chart
        WHERE patient_uid = $1::uuid
          AND recorded_at = $2::timestamptz`,
      PATIENT, new Date(observedAt),
    );
    expect(rows).toHaveLength(1);
    expect([rows[0].systolic_bp, rows[0].diastolic_bp, rows[0].temperature].map(Number))
      .toEqual([118, 72, 37]);
  });

  it('canonicalizes coding, component, and bundle ordering for replay identity', async () => {
    const observedAt = '2026-08-09T12:00:00.789Z';
    const bundle = componentAndFahrenheitBundle(observedAt);
    for (const { resource } of bundle.entry) {
      resource.code.coding.push({ system: 'http://snomed.info/sct', code: '75367002' });
      for (const component of resource.component || []) {
        component.code.coding.push({ system: 'http://snomed.info/sct', code: '75367002' });
      }
    }
    const replayBundle = structuredClone(bundle);
    replayBundle.entry.reverse();
    for (const { resource } of replayBundle.entry) {
      resource.code.coding.reverse();
      resource.component?.reverse();
      for (const component of resource.component || []) component.code.coding.reverse();
    }

    const first = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });
    const replay = await importFhirBundle(replayBundle, IMPORTER, { tenantId: TENANT });

    expect(first).toEqual(expect.objectContaining({ imported: 2, deduplicated: 0, errors: [] }));
    expect(replay).toEqual(expect.objectContaining({ imported: 0, deduplicated: 2, errors: [] }));
    const rows = await query(
      `SELECT id FROM vitals_chart
        WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz`,
      PATIENT, new Date(observedAt),
    );
    expect(rows).toHaveLength(1);
  });

  it('atomically claims concurrent replays and rejects a mixed superset without duplicating the clinical row', async () => {
    const observedAt = new Date(Date.now() - 4 * 60 * 1000).toISOString();
    const bundle = compositeNews2Bundle(observedAt, { idSuffix: '-receipt' });

    const [left, right] = await Promise.all([
      importFhirBundle(bundle, IMPORTER, { tenantId: TENANT }),
      importFhirBundle(bundle, IMPORTER, { tenantId: TENANT }),
    ]);
    expect(left.errors).toEqual([]);
    expect(right.errors).toEqual([]);
    expect(left.imported + right.imported).toBe(5);
    expect(left.deduplicated + right.deduplicated).toBe(5);

    const subset = structuredClone(bundle);
    subset.entry = subset.entry.slice(0, 2);
    const subsetResult = await importFhirBundle(subset, IMPORTER, { tenantId: TENANT });
    expect(subsetResult).toEqual(expect.objectContaining({ imported: 0, deduplicated: 2, errors: [] }));

    const superset = structuredClone(bundle);
    superset.entry.push({
      resource: {
        resourceType: 'Observation',
        id: 'obs-dbp-receipt',
        status: 'final',
        category: [{ coding: [{ code: 'vital-signs' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '8462-4' }] },
        subject: { reference: `Patient/${PATIENT}` },
        effectiveDateTime: observedAt,
        valueQuantity: { value: 70, code: 'mm[Hg]' },
      },
    });
    const supersetResult = await importFhirBundle(superset, IMPORTER, { tenantId: TENANT });
    expect(supersetResult).toEqual(expect.objectContaining({ imported: 0, deduplicated: 0 }));
    expect(supersetResult.errors).toHaveLength(6);
    expect(supersetResult.errors[0].error).toMatch(/cannot be partially augmented/i);
    expect(supersetResult.observationPartitions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'error',
        resourceCount: 6,
      }),
    ]));

    const rows = await query(
      `SELECT v.id, v.diastolic_bp, n.total_score, n.clinical_risk
         FROM vitals_chart v
         JOIN news2_scores n ON n.vitals_chart_id = v.id
        WHERE v.patient_uid = $1::uuid AND v.recorded_at = $2::timestamptz
        ORDER BY v.id`,
      PATIENT, new Date(observedAt),
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].total_score)).toBe(12);
    expect(rows[0].clinical_risk).toBe('high');
    expect(rows[0].diastolic_bp).toBeNull();

    const receipts = await query(
      `SELECT COUNT(*)::integer AS count
         FROM fhir_vital_observation_receipts
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND observed_at = $3::timestamptz`,
      TENANT, PATIENT, new Date(observedAt),
    );
    const sets = await query(
      `SELECT COUNT(*)::integer AS count
         FROM fhir_vital_observation_sets
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND observed_at = $3::timestamptz`,
      TENANT, PATIENT, new Date(observedAt),
    );
    const links = await query(
      `SELECT COUNT(*)::integer AS count
         FROM fhir_vital_observation_set_resources links
         JOIN fhir_vital_observation_sets sets
           ON sets.tenant_id = links.tenant_id
          AND sets.set_fingerprint = links.set_fingerprint
        WHERE sets.tenant_id = $1::uuid
          AND sets.patient_uid = $2::uuid
          AND sets.observed_at = $3::timestamptz`,
      TENANT, PATIENT, new Date(observedAt),
    );
    expect(receipts[0].count).toBe(5);
    expect(sets[0].count).toBe(1);
    expect(links[0].count).toBe(5);
  });

  it('rejects a malformed known same-time component before writing any part of the set', async () => {
    const observedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const bundle = compositeNews2Bundle(observedAt);
    bundle.entry[1].resource.valueQuantity.value = '88junk';

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });
    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(5);
    expect(result.errors.some(({ error }) => /finite numeric Quantity value/i.test(error))).toBe(true);
    expect(result.observationPartitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'error', resourceCount: 5 }),
    ]));

    const rows = await query(
      `SELECT id FROM vitals_chart
        WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz`,
      PATIENT, new Date(observedAt),
    );
    expect(rows).toHaveLength(0);
  });

  it('rejects ambiguous overlapping same-time sets before any partition can commit', async () => {
    const observedAt = new Date(Date.now() - 7 * 60 * 1000).toISOString();
    const bundle = heartRateBundle(observedAt, 80);
    const second = structuredClone(bundle.entry[0]);
    second.resource.id = 'obs-hr-overlap';
    second.resource.valueQuantity.value = 92;
    bundle.entry.push(second);

    const result = await importFhirBundle(bundle, IMPORTER, { tenantId: TENANT });
    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].error).toMatch(/same canonical vital field/i);

    const rows = await query(
      `SELECT id FROM vitals_chart
        WHERE patient_uid = $1::uuid AND recorded_at = $2::timestamptz`,
      PATIENT, new Date(observedAt),
    );
    expect(rows).toHaveLength(0);
  });
});
