// apps/backend/src/tests/bloodborne-markers.deep.test.js
import prisma from '../lib/prisma.js';
import {
  __clearExposureHandlersForTests,
  listMarkersForPatient,
  recordMarkers,
  recordMarkersFromSignedResults,
  registerExposureHandler,
  resolveReuseStatus,
  voidMarker,
} from '../services/clinical/bloodborneMarkerService.js';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-0000000bb001';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000bb002';
const PATIENT = '00000000-0000-4000-8000-0000000bb011';
const OTHER_PATIENT = '00000000-0000-4000-8000-0000000bb012';
const ACTOR = '00000000-0000-4000-8000-0000000bb0aa';
const OTHER_ACTOR = '00000000-0000-4000-8000-0000000bb0ab';
const RLS_ROLE = 'vhhealth_runtime';

const resultIds = [];

async function asRlsRole(tenantId, sql, ...params) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${RLS_ROLE}`);
    await tx.$executeRawUnsafe("SELECT set_config('app.current_tenant_id', $1, true)", tenantId);
    return tx.$queryRawUnsafe(sql, ...params);
  });
}

async function seedSignedResult({ testCode, valueText, patientUid = PATIENT, daysAgo = 3 }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_results
       (tenant_id, patient_uid, test_code, test_name, value_text, status,
        signed_off_at, signed_off_by, performed_at, received_at)
     VALUES ($1::uuid, $2::uuid, $3, $3, $4, 'final',
             NOW(), $5::uuid, NOW() - ($6::int * INTERVAL '1 day'), NOW() - ($6::int * INTERVAL '1 day'))
     RETURNING id`,
    TENANT, patientUid, testCode, valueText, ACTOR, daysAgo,
  );
  const id = Number(rows[0].id);
  resultIds.push(id);
  return id;
}

// FK order: markers -> lab_results -> users -> tenants. Written as explicit
// IN-lists rather than `= ANY($n::uuid[])` because the repo lint rule reads an
// array literal in a $queryRawUnsafe argument list as a missed spread.
async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_bloodborne_markers WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT, OTHER_TENANT,
  ).catch(() => {});
  if (resultIds.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM lab_results WHERE tenant_id = $1::uuid AND id = ANY($2::int[])`,
      TENANT, resultIds,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM lab_results
      WHERE tenant_id IN ($1::uuid, $2::uuid) AND patient_uid IN ($3::uuid, $4::uuid)`,
    TENANT, OTHER_TENANT, PATIENT, OTHER_PATIENT,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
    PATIENT, OTHER_PATIENT, ACTOR, OTHER_ACTOR,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
    TENANT, OTHER_TENANT,
  ).catch(() => {});
}

d('blood-borne markers (deep)', () => {
  beforeAll(async () => {
    await cleanup();
    for (const [id, slug] of [[TENANT, 'bbm-test'], [OTHER_TENANT, 'bbm-other']]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, $2) ON CONFLICT (id) DO NOTHING`,
        id, slug,
      );
    }
    for (const [uid, tenant, role, phone] of [
      [PATIENT, TENANT, 'PATIENT', '+919000011011'],
      [OTHER_PATIENT, OTHER_TENANT, 'PATIENT', '+919000011012'],
      [ACTOR, TENANT, 'DOCTOR', '+919000011099'],
      [OTHER_ACTOR, OTHER_TENANT, 'DOCTOR', '+919000011098'],
    ]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'BBM Test', $4, true, 'active', NOW())`,
        uid, tenant, phone, role,
      );
    }
  }, 30000);

  afterAll(async () => {
    __clearExposureHandlersForTests();
    await cleanup();
  }, 30000);

  afterEach(() => __clearExposureHandlersForTests());

  test('recordMarkers writes rows and the resolver reads them back', async () => {
    const recorded = await recordMarkers({
      tenantId: TENANT,
      patientUid: PATIENT,
      actorUid: ACTOR,
      entries: [
        { marker: 'hiv', result: 'non_reactive', testedOn: '2026-08-20', source: 'clinical_declaration', evidence: { note: 'outside report sighted' } },
        { marker: 'hbsag', result: 'non_reactive', testedOn: '2026-08-20', source: 'clinical_declaration' },
        { marker: 'hcv', result: 'non_reactive', testedOn: '2026-08-20', source: 'clinical_declaration' },
      ],
    });
    expect(recorded.recorded).toHaveLength(3);
    const status = await resolveReuseStatus({ tenantId: TENANT, patientUid: PATIENT, asOf: new Date('2026-09-04T00:00:00Z') });
    expect(status.status).toBe('clear');
    const listed = await listMarkersForPatient({ tenantId: TENANT, patientUid: PATIENT });
    expect(listed.markers).toHaveLength(3);
    expect(listed.reuse_status.status).toBe('clear');
  }, 30000);

  test('recordMarkers rejects an invalid marker, a missing label for other, a future date, and a mismatched source/link', async () => {
    const base = { tenantId: TENANT, patientUid: PATIENT, actorUid: ACTOR };
    await expect(recordMarkers({ ...base, entries: [{ marker: 'malaria', result: 'reactive', testedOn: '2026-09-01', source: 'clinical_declaration' }] }))
      .rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_INVALID' });
    await expect(recordMarkers({ ...base, entries: [{ marker: 'other', result: 'reactive', testedOn: '2026-09-01', source: 'clinical_declaration' }] }))
      .rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_INVALID' });
    await expect(recordMarkers({ ...base, entries: [{ marker: 'hiv', result: 'reactive', testedOn: '2999-01-01', source: 'clinical_declaration' }] }))
      .rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_INVALID' });
    await expect(recordMarkers({ ...base, entries: [{ marker: 'hiv', result: 'reactive', testedOn: '2026-09-01', source: 'external_report' }] }))
      .rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_INVALID' });
    await expect(recordMarkers({ ...base, entries: [{ marker: 'hiv', result: 'reactive', testedOn: '2026-09-01', source: 'clinical_declaration', lab_result_id: 1 }] }))
      .rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_INVALID' });
  });

  test('a reactive entry fires exposure handlers after commit with the row identity', async () => {
    const events = [];
    registerExposureHandler(async (event) => { events.push(event); });
    await recordMarkers({
      tenantId: TENANT, patientUid: PATIENT, actorUid: ACTOR,
      entries: [{ marker: 'other', marker_label: 'HTLV-1', result: 'reactive', testedOn: '2026-09-01', source: 'clinical_declaration' }],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: TENANT, patientUid: PATIENT, marker: 'other', markerLabel: 'HTLV-1', testedOn: '2026-09-01', source: 'clinical_declaration',
    });
    expect(Number(events[0].markerRowId)).toBeGreaterThan(0);
    const status = await resolveReuseStatus({ tenantId: TENANT, patientUid: PATIENT });
    expect(status.status).toBe('restricted');
  });

  test('voidMarker hides a row from the resolver and refuses a second void or a blank reason', async () => {
    const listed = await listMarkersForPatient({ tenantId: TENANT, patientUid: PATIENT });
    const htlv = listed.markers.find((m) => m.marker === 'other');
    await expect(voidMarker({ tenantId: TENANT, patientUid: PATIENT, markerId: htlv.id, actorUid: ACTOR, reason: '  ' }))
      .rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_INVALID' });
    const voided = await voidMarker({ tenantId: TENANT, patientUid: PATIENT, markerId: htlv.id, actorUid: ACTOR, reason: 'entered in error' });
    expect(voided.void_reason).toBe('entered in error');
    const after = await resolveReuseStatus({ tenantId: TENANT, patientUid: PATIENT, asOf: new Date('2026-09-04T00:00:00Z') });
    expect(after.status).toBe('clear');
    await expect(voidMarker({ tenantId: TENANT, patientUid: PATIENT, markerId: htlv.id, actorUid: ACTOR, reason: 'again' }))
      .rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_ALREADY_VOIDED' });
    await expect(voidMarker({ tenantId: TENANT, patientUid: PATIENT, markerId: 999999999, actorUid: ACTOR, reason: 'x' }))
      .rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_NOT_FOUND' });
    const withVoided = await listMarkersForPatient({ tenantId: TENANT, patientUid: PATIENT, includeVoided: true });
    expect(withVoided.markers.some((m) => m.id === htlv.id && m.voided_at)).toBe(true);
  });

  test('signed HBSAG/HIV/HCV results create markers once; replay is a no-op; non-serology is ignored', async () => {
    const hbsag = await seedSignedResult({ testCode: 'HBSAG', valueText: 'Reactive' });
    const hgb = await seedSignedResult({ testCode: 'HGB', valueText: '12.1' });
    const events = [];
    registerExposureHandler(async (event) => { events.push(event); });

    const first = await recordMarkersFromSignedResults({ tenantId: TENANT, resultIds: [hbsag, hgb], decision: 'verified', actorUid: ACTOR });
    expect(first.recorded).toHaveLength(1);
    expect(first.recorded[0]).toMatchObject({ marker: 'hbsag', result: 'reactive', source: 'lab_result', lab_result_id: hbsag });
    expect(events).toHaveLength(1);

    const replay = await recordMarkersFromSignedResults({ tenantId: TENANT, resultIds: [hbsag, hgb], decision: 'verified', actorUid: ACTOR });
    expect(replay.recorded).toHaveLength(0);
    expect(events).toHaveLength(1);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM patient_bloodborne_markers WHERE tenant_id = $1::uuid AND lab_result_id = $2::int`,
      TENANT, hbsag,
    );
    expect(rows[0].n).toBe(1);
  }, 30000);

  test('a corrective sign-off voids the earlier marker row and inserts the corrected one', async () => {
    const hcv = await seedSignedResult({ testCode: 'HCV', valueText: 'Reactive' });
    await recordMarkersFromSignedResults({ tenantId: TENANT, resultIds: [hcv], decision: 'verified', actorUid: ACTOR });
    await prisma.$executeRawUnsafe(
      `UPDATE lab_results SET value_text = 'Non-reactive', status = 'corrected', updated_at = NOW() WHERE id = $1::int AND tenant_id = $2::uuid`,
      hcv, TENANT,
    );
    const corrected = await recordMarkersFromSignedResults({ tenantId: TENANT, resultIds: [hcv], decision: 'corrected', actorUid: ACTOR });
    expect(corrected.voided).toBe(1);
    expect(corrected.recorded).toHaveLength(1);
    expect(corrected.recorded[0].result).toBe('non_reactive');
    const rows = await prisma.$queryRawUnsafe(
      `SELECT result, voided_at IS NOT NULL AS voided, void_reason
         FROM patient_bloodborne_markers WHERE tenant_id = $1::uuid AND lab_result_id = $2::int ORDER BY id`,
      TENANT, hcv,
    );
    expect(rows).toEqual([
      { result: 'reactive', voided: true, void_reason: 'lab_result_corrected' },
      { result: 'non_reactive', voided: false, void_reason: null },
    ]);
  }, 30000);

  test('a marker cannot bind another patient\'s lab result (composite FK)', async () => {
    const otherPatientResult = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_results (tenant_id, patient_uid, test_code, test_name, value_text, status, signed_off_at, signed_off_by, performed_at, received_at)
       VALUES ($1::uuid, $2::uuid, 'HIV', 'HIV', 'Non-reactive', 'final', NOW(), $3::uuid, NOW(), NOW()) RETURNING id`,
      OTHER_TENANT, OTHER_PATIENT, OTHER_ACTOR,
    );
    const foreignId = Number(otherPatientResult[0].id);
    await expect(recordMarkers({
      tenantId: TENANT, patientUid: PATIENT, actorUid: ACTOR,
      entries: [{ marker: 'hiv', result: 'non_reactive', testedOn: '2026-09-01', source: 'external_report', lab_result_id: foreignId }],
    })).rejects.toBeTruthy();
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM patient_bloodborne_markers WHERE lab_result_id = $1::int`, foreignId,
    );
    expect(rows[0].n).toBe(0);
    await prisma.$executeRawUnsafe(`DELETE FROM lab_results WHERE id = $1::int`, foreignId);
  }, 30000);

  test('RLS: another tenant cannot read this tenant\'s marker rows', async () => {
    const visible = await asRlsRole(
      OTHER_TENANT,
      `SELECT COUNT(*)::int AS n FROM patient_bloodborne_markers WHERE patient_uid = $1::uuid`,
      PATIENT,
    );
    expect(visible[0].n).toBe(0);
    const own = await asRlsRole(
      TENANT,
      `SELECT COUNT(*)::int AS n FROM patient_bloodborne_markers WHERE patient_uid = $1::uuid`,
      PATIENT,
    );
    expect(own[0].n).toBeGreaterThan(0);
  });
});
