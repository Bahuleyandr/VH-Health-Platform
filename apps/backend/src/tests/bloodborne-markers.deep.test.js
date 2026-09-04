// apps/backend/src/tests/bloodborne-markers.deep.test.js
import prisma, { ensureTenantRlsRuntimeRoleGrants, setTenantTx } from '../lib/prisma.js';
import {
  __clearExposureHandlersForTests,
  clinicalDate,
  listMarkersForPatient,
  recordMarkers,
  recordMarkersFromSignedResults,
  registerExposureHandler,
  resolveReuseStatus,
  voidMarker,
} from '../services/clinical/bloodborneMarkerService.js';
import { signOffResults } from '../services/lab/labResultsService.js';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-0000000bb001';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000bb002';
const PATIENT = '00000000-0000-4000-8000-0000000bb011';
const OTHER_PATIENT = '00000000-0000-4000-8000-0000000bb012';
// Second patient inside TENANT: proves voidMarker's patient scoping is not
// satisfied by tenant membership alone.
const SECOND_PATIENT = '00000000-0000-4000-8000-0000000bb013';
const ACTOR = '00000000-0000-4000-8000-0000000bb0aa';
const OTHER_ACTOR = '00000000-0000-4000-8000-0000000bb0ab';
// signOffResults gates on canSignOffLabResults, which ACTOR's DOCTOR role
// does not satisfy; the end-to-end sign-off test below signs as this user.
const PATHOLOGIST = '00000000-0000-4000-8000-0000000bb0ac';
const RUNTIME_ROLES = ['vhhealth_app', 'vhhealth_runtime'];
const RLS_ROLE = 'vhhealth_runtime';
let previousRuntimeRole;
// beforeAll provisions the runtime roles through the same boot-time bootstrap
// production uses and keeps each call's own return value here. That return
// value — not a probe of the database — decides whether the RLS test may skip:
// `skipped: true` is the bootstrap declining to run at all (no role
// configured, unsafe role name), which is the only rig this file cannot make
// assertions on. Anything else means provisioning ran, so a missing role or a
// missing grant is a defect and must fail rather than skip.
const runtimeRoleProvisioning = new Map();

// Every fixture date is relative to the run. A hard-coded date reads as
// "recent" while the calendar is near it and as "older than the 90-day
// validity window" afterwards, which silently flips reuse status from clear to
// unknown and would fail this file on a future date rather than on a defect.
const daysAgo = (n) => clinicalDate(new Date(Date.now() - n * 86400000));

const resultIds = [];
const investigationIds = [];

// Handlers fire AFTER the writing transaction commits, so a *separate*
// connection must already see the row. The bare `prisma` client used here is
// not the one inside setTenantTx, so a handler still running inside that
// transaction would read 0 rows.
async function rowVisibleToAnotherConnection(event) {
  const seen = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM patient_bloodborne_markers WHERE tenant_id = $1::uuid AND id = $2::bigint`,
    event.tenantId, Number(event.markerRowId),
  );
  return seen[0].n === 1;
}

// expectForeignKeyFailure in billing-refund-payout-closure.deep.test.js reads
// message + meta, which is the shape of a statement-time violation
// (PrismaClientKnownRequestError P2010, SQLSTATE and constraint name inside
// the message). This FK is DEFERRABLE INITIALLY DEFERRED, so it fires at
// COMMIT and arrives instead as a bare DriverAdapterError whose message is
// only 'ForeignKeyConstraintViolation' — the SQLSTATE and the constraint name
// live on err.cause. Both shapes are folded into one text so the assertion
// pins the SQLSTATE and the constraint rather than a stringified class name.
async function expectForeignKeyFailure(operation, pattern) {
  let failure;
  try {
    await operation;
  } catch (err) {
    failure = err;
  }
  expect(failure).toBeTruthy();
  const text = [
    String(failure?.message || failure || ''),
    JSON.stringify(failure?.meta ?? ''),
    JSON.stringify(failure?.cause ?? ''),
    failure?.meta?.code || failure?.code || '',
  ].join(' ');
  expect(text).toMatch(/23503/);
  expect(text).toMatch(pattern);
}

async function asRlsRole(tenantId, sql, ...params) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${RLS_ROLE}`);
    await tx.$executeRawUnsafe("SELECT set_config('app.current_tenant_id', $1, true)", tenantId);
    return tx.$queryRawUnsafe(sql, ...params);
  });
}

async function seedSignedResult({ testCode, valueText, patientUid = PATIENT, daysBack = 3 }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_results
       (tenant_id, patient_uid, test_code, test_name, value_text, status,
        signed_off_at, signed_off_by, performed_at, received_at)
     VALUES ($1::uuid, $2::uuid, $3, $3, $4, 'final',
             NOW(), $5::uuid, NOW() - ($6::int * INTERVAL '1 day'), NOW() - ($6::int * INTERVAL '1 day'))
     RETURNING id`,
    TENANT, patientUid, testCode, valueText, ACTOR, daysBack,
  );
  const id = Number(rows[0].id);
  resultIds.push(id);
  return id;
}

// A result the real sign-off path can act on. seedSignedResult above writes
// the post-sign-off state directly; signOffResults instead needs the state
// *before* sign-off — a preliminary row linked to an investigation order,
// because deriveSignoffEpisode rejects a result with no order episode.
async function seedPreliminaryResult({ testCode, valueText, patientUid = PATIENT }) {
  const patientRows = await prisma.$queryRawUnsafe(
    `SELECT id, phone FROM users WHERE uid = $1::uuid`,
    patientUid,
  );
  const orders = await prisma.$queryRawUnsafe(
    `INSERT INTO investigations
       (tenant_id, phone, patient_id, patient_uid, test_name, test_type,
        status, priority, requested_by, requested_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4::uuid, $5, 'blood', 'IN_PROGRESS', 'NORMAL',
             $6::uuid, NOW(), NOW())
     RETURNING id`,
    TENANT, patientRows[0].phone, patientRows[0].id, patientUid, testCode, ACTOR,
  );
  const investigationId = Number(orders[0].id);
  investigationIds.push(investigationId);
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_results
       (tenant_id, patient_uid, investigation_id, test_code, test_name,
        value_text, status, performed_at, received_at)
     VALUES ($1::uuid, $2::uuid, $3::int, $4, $4, $5, 'preliminary', NOW(), NOW())
     RETURNING id`,
    TENANT, patientUid, investigationId, testCode, valueText,
  );
  const resultId = Number(rows[0].id);
  resultIds.push(resultId);
  return { investigationId, resultId };
}

// FK order: markers -> lab_results -> users -> tenants. Written as explicit
// IN-lists rather than `= ANY($n::uuid[])` because the repo lint rule reads an
// array literal in a $queryRawUnsafe argument list as a missed spread.
async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_bloodborne_markers WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT, OTHER_TENANT,
  ).catch(() => {});
  // A real sign-off writes canonical, diagnostic and worklist receipts that FK
  // this file's investigations and users, and several of them are append-only.
  // One replica-role transaction, scoped to the two tenants this file owns,
  // clears them; every table listed exists in the migrated schema, so a
  // statement failure here means a genuine teardown gap, not a missing table.
  // The tenant-wide (not id-scoped) deletes below are safe because TENANT
  // (...bb001) and OTHER_TENANT (...bb002) are unique to this file, and
  // because setTenantTx(TENANT, ...) still applies RLS inside the
  // replica-role transaction, so the block only ever reaches TENANT rows —
  // OTHER_TENANT never receives sign-off residue and is a no-op here.
  await setTenantTx(TENANT, async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    for (const table of [
      'lab_critical_alert_acknowledgement_receipts',
      'lab_critical_alert_reconciliation_receipts',
      'lab_critical_alerts',
      'lab_threshold_unmatched_exceptions',
      'diagnostic_result_generation_items',
      'diagnostic_result_generations',
      'lab_pathologist_signoffs',
      'clinical_timeline_events',
      'clinical_audit_events',
      'tasks',
      'event_outbox',
    ]) {
      await tx.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE tenant_id IN ($1::uuid, $2::uuid)`,
        TENANT, OTHER_TENANT,
      );
    }
  }).catch((err) => {
    console.warn(`bloodborne-markers teardown: sign-off residue delete failed: ${err?.message}`);
  });
  if (resultIds.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM lab_results WHERE tenant_id = $1::uuid AND id = ANY($2::int[])`,
      TENANT, resultIds,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM lab_results
      WHERE tenant_id IN ($1::uuid, $2::uuid)
        AND patient_uid IN ($3::uuid, $4::uuid, $5::uuid)`,
    TENANT, OTHER_TENANT, PATIENT, OTHER_PATIENT, SECOND_PATIENT,
  ).catch(() => {});
  if (investigationIds.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM investigations WHERE tenant_id = $1::uuid AND id = ANY($2::int[])`,
      TENANT, investigationIds,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM users
      WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid)`,
    PATIENT, OTHER_PATIENT, SECOND_PATIENT, ACTOR, OTHER_ACTOR, PATHOLOGIST,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
    TENANT, OTHER_TENANT,
  ).catch(() => {});
}

d('blood-borne markers (deep)', () => {
  beforeAll(async () => {
    // Provision the sealed runtime roles the way the boot path does, so the
    // RLS assertions below actually execute instead of skipping on a rig whose
    // ci-setup-db never created vhhealth_runtime.
    previousRuntimeRole = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    try {
      for (const role of RUNTIME_ROLES) {
        process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = role;
        runtimeRoleProvisioning.set(role, await ensureTenantRlsRuntimeRoleGrants());
      }
    } finally {
      // The env restore must happen even if provisioning throws, or every
      // later test in this worker inherits the overridden role name.
      if (previousRuntimeRole === undefined) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
      else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = previousRuntimeRole;
    }

    await cleanup();
    for (const [id, slug] of [[TENANT, 'bbm-test'], [OTHER_TENANT, 'bbm-other']]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, $2) ON CONFLICT (id) DO NOTHING`,
        id, slug,
      );
    }
    // ON CONFLICT (uid) — users_uid_key is the unique constraint on uid. A row
    // left behind by a failed prior cleanup then shows up as a failed
    // assertion in a test rather than as a 23505 that aborts the whole file.
    for (const [uid, tenant, role, phone] of [
      [PATIENT, TENANT, 'PATIENT', '+919000011011'],
      [OTHER_PATIENT, OTHER_TENANT, 'PATIENT', '+919000011012'],
      [SECOND_PATIENT, TENANT, 'PATIENT', '+919000011013'],
      [ACTOR, TENANT, 'DOCTOR', '+919000011099'],
      [OTHER_ACTOR, OTHER_TENANT, 'DOCTOR', '+919000011098'],
      [PATHOLOGIST, TENANT, 'PATHOLOGIST', '+919000011097'],
    ]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'BBM Test', $4, true, 'active', NOW())
         ON CONFLICT (uid) DO NOTHING`,
        uid, tenant, phone, role,
      );
    }
  }, 60000);

  afterAll(async () => {
    __clearExposureHandlersForTests();
    await cleanup();
  }, 30000);

  afterEach(() => __clearExposureHandlersForTests());

  test('recordMarkers writes rows, ignores a label on a named marker, and the resolver reads them back', async () => {
    const recorded = await recordMarkers({
      tenantId: TENANT,
      patientUid: PATIENT,
      actorUid: ACTOR,
      entries: [
        // marker_label identifies the marker only for 'other'; on hiv it is
        // ignored outright rather than validated or stored.
        { marker: 'hiv', marker_label: 'ignored', result: 'non_reactive', testedOn: daysAgo(15), source: 'clinical_declaration', evidence: { note: 'outside report sighted' } },
        { marker: 'hbsag', result: 'non_reactive', testedOn: daysAgo(15), source: 'clinical_declaration' },
        { marker: 'hcv', result: 'non_reactive', testedOn: daysAgo(15), source: 'clinical_declaration' },
      ],
    });
    expect(recorded.recorded).toHaveLength(3);
    expect(recorded.skipped).toEqual([]);
    expect(recorded.recorded.find((row) => row.marker === 'hiv').marker_label).toBeNull();
    const status = await resolveReuseStatus({ tenantId: TENANT, patientUid: PATIENT });
    expect(status.status).toBe('clear');
    const listed = await listMarkersForPatient({ tenantId: TENANT, patientUid: PATIENT });
    expect(listed.markers).toHaveLength(3);
    expect(listed.reuse_status.status).toBe('clear');
  }, 30000);

  test('recordMarkers rejects an invalid marker, a missing or over-long label for other, a future date, a mismatched source/link, and an out-of-range lab result id', async () => {
    const base = { tenantId: TENANT, patientUid: PATIENT, actorUid: ACTOR };
    await expect(recordMarkers({ ...base, entries: [{ marker: 'malaria', result: 'reactive', testedOn: daysAgo(1), source: 'clinical_declaration' }] }))
      .rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_INVALID' });
    await expect(recordMarkers({ ...base, entries: [{ marker: 'other', result: 'reactive', testedOn: daysAgo(1), source: 'clinical_declaration' }] }))
      .rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_INVALID' });
    await expect(recordMarkers({ ...base, entries: [{ marker: 'hiv', result: 'reactive', testedOn: '2999-01-01', source: 'clinical_declaration' }] }))
      .rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_INVALID' });
    await expect(recordMarkers({ ...base, entries: [{ marker: 'hiv', result: 'reactive', testedOn: daysAgo(1), source: 'external_report' }] }))
      .rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_INVALID' });
    await expect(recordMarkers({ ...base, entries: [{ marker: 'hiv', result: 'reactive', testedOn: daysAgo(1), source: 'clinical_declaration', lab_result_id: 1 }] }))
      .rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_INVALID' });
    // An over-long label is rejected, not silently truncated to 120.
    await expect(recordMarkers({
      ...base,
      entries: [{ marker: 'other', marker_label: 'L'.repeat(121), result: 'reactive', testedOn: daysAgo(1), source: 'clinical_declaration' }],
    })).rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_INVALID' });
    await expect(recordMarkers({
      ...base,
      entries: [{ marker: 'hiv', result: 'reactive', testedOn: daysAgo(1), source: 'external_report', lab_result_id: 'abc' }],
    })).rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_INVALID' });
    // lab_result_id is an int4 column: an id past int4 must fail validation,
    // not reach the $8::int cast as a 22003.
    await expect(recordMarkers({
      ...base,
      entries: [{ marker: 'hiv', result: 'reactive', testedOn: daysAgo(1), source: 'external_report', lab_result_id: 2_147_483_648 }],
    })).rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_INVALID' });
  });

  test('a reactive entry fires exposure handlers after commit with the row identity', async () => {
    const events = [];
    registerExposureHandler(async (event) => {
      events.push({ ...event, visibleToOtherConnection: await rowVisibleToAnotherConnection(event) });
    });
    const testedOn = daysAgo(3);
    await recordMarkers({
      tenantId: TENANT, patientUid: PATIENT, actorUid: ACTOR,
      entries: [{ marker: 'other', marker_label: 'HTLV-1', result: 'reactive', testedOn, source: 'clinical_declaration' }],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: TENANT, patientUid: PATIENT, marker: 'other', markerLabel: 'HTLV-1', testedOn, source: 'clinical_declaration',
    });
    expect(Number(events[0].markerRowId)).toBeGreaterThan(0);
    expect(events[0].visibleToOtherConnection).toBe(true);
    const status = await resolveReuseStatus({ tenantId: TENANT, patientUid: PATIENT });
    expect(status.status).toBe('restricted');
  });

  test('voidMarker is patient-scoped, hides the row from the resolver, and refuses a second void or a blank reason', async () => {
    // Owns its fixture rather than voiding a row an earlier test happened to
    // leave behind.
    const created = await recordMarkers({
      tenantId: TENANT, patientUid: PATIENT, actorUid: ACTOR,
      entries: [{ marker: 'other', marker_label: 'HTLV-void', result: 'reactive', testedOn: daysAgo(2), source: 'clinical_declaration' }],
    });
    const markerId = created.recorded[0].id;
    await expect(voidMarker({ tenantId: TENANT, patientUid: PATIENT, markerId, actorUid: ACTOR, reason: '  ' }))
      .rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_INVALID' });
    // The void reason is the retraction's whole audit record. void_reason is a
    // TEXT column, so the 500-char cap is the published contract
    // (BloodborneMarkerVoidRequest.maxLength), and the service enforces it by
    // refusing an over-length reason rather than truncating it into one that
    // reads as the caller's but is not.
    await expect(voidMarker({ tenantId: TENANT, patientUid: PATIENT, markerId, actorUid: ACTOR, reason: 'r'.repeat(501) }))
      .rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_INVALID' });
    // Right tenant, wrong patient: tenant membership alone must not reach it.
    await expect(voidMarker({ tenantId: TENANT, patientUid: SECOND_PATIENT, markerId, actorUid: ACTOR, reason: 'wrong patient' }))
      .rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_NOT_FOUND' });
    const voided = await voidMarker({ tenantId: TENANT, patientUid: PATIENT, markerId, actorUid: ACTOR, reason: 'entered in error' });
    expect(voided.void_reason).toBe('entered in error');
    await expect(voidMarker({ tenantId: TENANT, patientUid: PATIENT, markerId, actorUid: ACTOR, reason: 'again' }))
      .rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_ALREADY_VOIDED' });
    await expect(voidMarker({ tenantId: TENANT, patientUid: PATIENT, markerId: 999999999, actorUid: ACTOR, reason: 'x' }))
      .rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_NOT_FOUND' });
    const active = await listMarkersForPatient({ tenantId: TENANT, patientUid: PATIENT });
    expect(active.markers.some((m) => m.id === markerId)).toBe(false);
    expect(active.reuse_status.reasons.some((reason) => reason.includes('HTLV-void'))).toBe(false);
    const withVoided = await listMarkersForPatient({ tenantId: TENANT, patientUid: PATIENT, includeVoided: true });
    expect(withVoided.markers.some((m) => m.id === markerId && m.voided_at)).toBe(true);
  }, 30000);

  test('a signed HBSAG result creates one marker; an exact replay is reported as skipped; HGB is ignored', async () => {
    const hbsag = await seedSignedResult({ testCode: 'HBSAG', valueText: 'Reactive' });
    const hgb = await seedSignedResult({ testCode: 'HGB', valueText: '12.1' });
    const events = [];
    registerExposureHandler(async (event) => {
      events.push({ ...event, visibleToOtherConnection: await rowVisibleToAnotherConnection(event) });
    });

    const first = await recordMarkersFromSignedResults({ tenantId: TENANT, resultIds: [hbsag, hgb], decision: 'verified', actorUid: ACTOR });
    expect(first.recorded).toHaveLength(1);
    expect(first.recorded[0]).toMatchObject({ marker: 'hbsag', result: 'reactive', source: 'lab_result', lab_result_id: hbsag });
    expect(first.skipped).toEqual([]);
    expect(first.failed).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0].visibleToOtherConnection).toBe(true);

    // Same content on replay: nothing is written and no handler fires again.
    const replay = await recordMarkersFromSignedResults({ tenantId: TENANT, resultIds: [hbsag, hgb], decision: 'verified', actorUid: ACTOR });
    expect(replay.recorded).toHaveLength(0);
    expect(replay.skipped).toEqual([hbsag]);
    expect(replay.voided).toBe(0);
    expect(events).toHaveLength(1);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM patient_bloodborne_markers WHERE tenant_id = $1::uuid AND lab_result_id = $2::int`,
      TENANT, hbsag,
    );
    expect(rows[0].n).toBe(1);
  }, 30000);

  test('the real lab sign-off path records the marker: signOffResults on a reactive HBSAG result writes one active lab-sourced row and fires the exposure handler', async () => {
    const { resultId } = await seedPreliminaryResult({ testCode: 'HBSAG', valueText: 'Reactive' });
    const events = [];
    registerExposureHandler(async (event) => { events.push(event); });

    await signOffResults({
      tenantId: TENANT,
      signed_off_by: PATHOLOGIST,
      signed_off_by_role: 'PATHOLOGIST',
      result_ids: [resultId],
      decision: 'verified',
      patient_uid: PATIENT,
    });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT marker, result, source, patient_uid::text AS patient_uid
         FROM patient_bloodborne_markers
        WHERE tenant_id = $1::uuid AND lab_result_id = $2::int AND voided_at IS NULL`,
      TENANT, resultId,
    );
    expect(rows).toEqual([
      { marker: 'hbsag', result: 'reactive', source: 'lab_result', patient_uid: PATIENT },
    ]);
    // The hook runs post-commit, so the handler must have fired by the time
    // signOffResults resolves — not on some later tick.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: TENANT, patientUid: PATIENT, marker: 'hbsag', result: 'reactive', labResultId: resultId,
    });
  }, 60000);

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
    expect(corrected.recorded[0].evidence).toMatchObject({ decision: 'corrected' });
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

  test('the lab row content decides, not the decision word: a changed value replayed as verified still corrects', async () => {
    const hiv = await seedSignedResult({ testCode: 'HIV', valueText: 'Non-reactive' });
    const first = await recordMarkersFromSignedResults({ tenantId: TENANT, resultIds: [hiv], decision: 'verified', actorUid: ACTOR });
    expect(first.recorded).toHaveLength(1);
    expect(first.recorded[0].result).toBe('non_reactive');
    await prisma.$executeRawUnsafe(
      `UPDATE lab_results SET value_text = 'Reactive', status = 'corrected', updated_at = NOW() WHERE id = $1::int AND tenant_id = $2::uuid`,
      hiv, TENANT,
    );
    const replay = await recordMarkersFromSignedResults({ tenantId: TENANT, resultIds: [hiv], decision: 'verified', actorUid: ACTOR });
    expect(replay.voided).toBe(1);
    expect(replay.recorded).toHaveLength(1);
    expect(replay.recorded[0].result).toBe('reactive');
    expect(replay.skipped).toEqual([]);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT result, voided_at IS NOT NULL AS voided, void_reason
         FROM patient_bloodborne_markers WHERE tenant_id = $1::uuid AND lab_result_id = $2::int ORDER BY id`,
      TENANT, hiv,
    );
    expect(rows).toEqual([
      { result: 'non_reactive', voided: true, void_reason: 'lab_result_corrected' },
      { result: 'reactive', voided: false, void_reason: null },
    ]);
  }, 30000);

  test('a future-dated NON-reactive result is reported in failed and the rest of the batch is still recorded', async () => {
    // Non-reactive: dropping it is the safe direction, so the drop stands.
    // The reactive case below is clamped instead — see the test after this.
    const future = await seedSignedResult({ testCode: 'HCV', valueText: 'Non-reactive', daysBack: -5 });
    const usable = await seedSignedResult({ testCode: 'HBSAG', valueText: 'Non-reactive', daysBack: 1 });
    const outcome = await recordMarkersFromSignedResults({
      tenantId: TENANT, resultIds: [future, usable], decision: 'verified', actorUid: ACTOR,
    });
    expect(outcome.failed).toEqual([{ lab_result_id: future, reason: 'future_dated' }]);
    expect(outcome.recorded).toHaveLength(1);
    expect(outcome.recorded[0].lab_result_id).toBe(usable);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM patient_bloodborne_markers WHERE tenant_id = $1::uuid AND lab_result_id = $2::int`,
      TENANT, future,
    );
    expect(rows[0].n).toBe(0);
  }, 30000);

  test('a future-dated REACTIVE result is clamped to today rather than dropped, and still restricts', async () => {
    // Dropping this candidate would be the permissive failure: an analyzer
    // clock skewed a day forward would keep a reactive HIV result off the
    // record entirely, and the patient would read as unrestricted.
    const before = await resolveReuseStatus({ tenantId: TENANT, patientUid: SECOND_PATIENT });
    expect(before.status).not.toBe('restricted');

    const skewed = await seedSignedResult({
      testCode: 'HIV', valueText: 'Reactive', patientUid: SECOND_PATIENT, daysBack: -3,
    });
    const outcome = await recordMarkersFromSignedResults({
      tenantId: TENANT, resultIds: [skewed], decision: 'verified', actorUid: ACTOR,
    });
    expect(outcome.failed).toEqual([]);
    expect(outcome.recorded).toHaveLength(1);
    expect(outcome.recorded[0]).toMatchObject({
      marker: 'hiv', result: 'reactive', lab_result_id: skewed, tested_on: clinicalDate(new Date()),
    });
    expect(outcome.recorded[0].evidence).toMatchObject({
      tested_on_clamped: true, tested_on_problem: 'future_dated',
    });
    // The raw instant is kept so the clamp is auditable.
    expect(typeof outcome.recorded[0].evidence.tested_on_raw).toBe('string');

    const status = await resolveReuseStatus({ tenantId: TENANT, patientUid: SECOND_PATIENT });
    expect(status.status).toBe('restricted');

    // The clamped date is what the content compare reads, so a replay on the
    // same day skips instead of voiding and re-inserting on every sign-off.
    const replay = await recordMarkersFromSignedResults({
      tenantId: TENANT, resultIds: [skewed], decision: 'verified', actorUid: ACTOR,
    });
    expect(replay.recorded).toEqual([]);
    expect(replay.skipped).toEqual([skewed]);
    expect(replay.voided).toBe(0);
  }, 30000);

  test('an external_report entry for a lab result the hook already recorded is reported in skipped, not written', async () => {
    const hbsag = await seedSignedResult({ testCode: 'HBSAG', valueText: 'Non-reactive' });
    const hook = await recordMarkersFromSignedResults({
      tenantId: TENANT, resultIds: [hbsag], decision: 'verified', actorUid: ACTOR,
    });
    expect(hook.recorded).toHaveLength(1);
    // The lab-linked slot is now held by an active row, so the checklist's
    // external_report path writes nothing. It has to say so in `skipped`: a
    // short `recorded` array alone cannot tell "already on record" from
    // "silently lost", and this is the only path that fills recordMarkers'
    // `skipped` at all.
    const outcome = await recordMarkers({
      tenantId: TENANT,
      patientUid: PATIENT,
      actorUid: ACTOR,
      entries: [{
        marker: 'hbsag', result: 'reactive', testedOn: daysAgo(1), source: 'external_report', lab_result_id: hbsag,
      }],
    });
    expect(outcome.recorded).toEqual([]);
    expect(outcome.skipped).toEqual([hbsag]);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM patient_bloodborne_markers WHERE tenant_id = $1::uuid AND lab_result_id = $2::int`,
      TENANT, hbsag,
    );
    expect(rows[0].n).toBe(1);
  }, 30000);

  test('two concurrent sign-offs of the same result leave exactly one active row and neither rejects', async () => {
    const hcv = await seedSignedResult({ testCode: 'HCV', valueText: 'Reactive' });
    const call = () => recordMarkersFromSignedResults({
      tenantId: TENANT, resultIds: [hcv], decision: 'verified', actorUid: ACTOR,
    });
    const [first, second] = await Promise.all([call(), call()]);
    // The per-(tenant, lab result) advisory lock serialises the pair: one
    // transaction inserts, the other waits, reads the committed row and skips.
    // This does not prove the race is closed — it proves the lock neither
    // deadlocks nor throws, and that the pair still lands one active row.
    expect(first.recorded.length + first.skipped.length
      + second.recorded.length + second.skipped.length).toBe(2);
    expect(first.failed).toEqual([]);
    expect(second.failed).toEqual([]);
    const active = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM patient_bloodborne_markers
        WHERE tenant_id = $1::uuid AND lab_result_id = $2::int AND voided_at IS NULL`,
      TENANT, hcv,
    );
    expect(active[0].n).toBe(1);
  }, 30000);

  test('a marker cannot bind another patient\'s lab result (composite FK)', async () => {
    const otherPatientResult = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_results (tenant_id, patient_uid, test_code, test_name, value_text, status, signed_off_at, signed_off_by, performed_at, received_at)
       VALUES ($1::uuid, $2::uuid, 'HIV', 'HIV', 'Non-reactive', 'final', NOW(), $3::uuid, NOW(), NOW()) RETURNING id`,
      OTHER_TENANT, OTHER_PATIENT, OTHER_ACTOR,
    );
    const foreignId = Number(otherPatientResult[0].id);
    await expectForeignKeyFailure(
      recordMarkers({
        tenantId: TENANT, patientUid: PATIENT, actorUid: ACTOR,
        entries: [{ marker: 'hiv', result: 'non_reactive', testedOn: daysAgo(1), source: 'external_report', lab_result_id: foreignId }],
      }),
      /fk_patient_bloodborne_markers_lab_result/,
    );
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM patient_bloodborne_markers WHERE lab_result_id = $1::int`, foreignId,
    );
    expect(rows[0].n).toBe(0);
    await prisma.$executeRawUnsafe(`DELETE FROM lab_results WHERE id = $1::int`, foreignId);
  }, 30000);

  test('RLS: another tenant cannot read this tenant\'s marker rows, and the runtime role is mutable but cannot delete', async () => {
    const provisioned = runtimeRoleProvisioning.get(RLS_ROLE);
    if (provisioned?.skipped === true) {
      // The only skip this file allows: the bootstrap declined to run (no
      // runtime role configured, or an unsafe role name), so there is nothing
      // to assert against. A provisioning pass that ran must have produced a
      // usable role, and the assertions below fail if it did not.
      console.warn(`Skipping RLS probe: ${RLS_ROLE} provisioning skipped (${provisioned.reason})`);
      return;
    }
    const probe = await prisma.$queryRawUnsafe(
      `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1::name) AS role_exists,
              COALESCE((SELECT has_table_privilege($1::name, 'public.patient_bloodborne_markers', 'SELECT')
                          FROM pg_roles WHERE rolname = $1::name), false) AS can_select,
              COALESCE((SELECT has_table_privilege($1::name, 'public.patient_bloodborne_markers', 'UPDATE')
                          FROM pg_roles WHERE rolname = $1::name), false) AS can_update,
              COALESCE((SELECT has_table_privilege($1::name, 'public.patient_bloodborne_markers', 'DELETE')
                          FROM pg_roles WHERE rolname = $1::name), false) AS can_delete`,
      RLS_ROLE,
    );
    expect(probe[0].role_exists).toBe(true);
    expect(probe[0].can_select).toBe(true);
    // The void transition is an UPDATE, so UPDATE is part of the contract;
    // the record is append-only by convention, so DELETE must stay revoked.
    expect(probe[0].can_update).toBe(true);
    expect(probe[0].can_delete).toBe(false);

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
    // The sign-off hook locks the active row with SELECT … FOR UPDATE, and a
    // row lock needs UPDATE privilege: without it this raises 42501 under the
    // runtime role while passing as the owner in every other test here.
    const locked = await asRlsRole(
      TENANT,
      `SELECT id FROM patient_bloodborne_markers WHERE patient_uid = $1::uuid FOR UPDATE`,
      PATIENT,
    );
    expect(Array.isArray(locked)).toBe(true);
  });
});
