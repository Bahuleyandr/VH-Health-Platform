// apps/backend/src/tests/bloodborne-marker-reconciliation.deep.test.js
//
// The reconciliation sweep (spec 2026-09-04 §18) against a real database.
//
// The unit suite pins the candidate query's SHAPE; only Postgres can say
// whether the anti-join actually answers the question. Two of these cases —
// "an active marker excludes the result" and "a voided one does not" — differ
// by a single `voided_at IS NULL` predicate, which a stubbed client would
// report as passing either way. They are the calibration for the mutation
// check recorded with this change.
//
// This file owns its own tenants (…bc001 / …bc002) and never touches the
// blood-borne marker suite's (…bb001 / …bb002), so the two can run in the same
// shard without sharing rows.

import prisma, {
  ensureTenantRlsRuntimeRoleGrants,
  setTenantTx,
} from '../lib/prisma.js';
import {
  clinicalDate,
  isoDate,
  recordMarkersFromSignedResults,
  voidMarker,
} from '../services/clinical/bloodborneMarkerService.js';
import {
  findUnreconciledSerologyResults,
  reconcileTenant,
} from '../services/clinical/bloodborneMarkerReconciliationService.js';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-0000000bc001';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000bc002';
const PATIENT = '00000000-0000-4000-8000-0000000bc011';
const OTHER_PATIENT = '00000000-0000-4000-8000-0000000bc012';
const SIGNER = '00000000-0000-4000-8000-0000000bc0aa';
const OTHER_SIGNER = '00000000-0000-4000-8000-0000000bc0ab';

const RUNTIME_ROLES = ['vhhealth_app', 'vhhealth_runtime'];
const RLS_ROLE = 'vhhealth_runtime';
let previousRuntimeRole;
// The bootstrap's own return value decides whether the RLS case may skip:
// `skipped: true` means it declined to run at all, the one rig this file
// cannot assert on. Anything else means provisioning ran, so a missing grant
// is a defect and must fail rather than skip.
const runtimeRoleProvisioning = new Map();

const resultIds = [];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A lab result in the state the sign-off hook leaves behind — signed, with the
// marker write missing. `daysBack` is negative for a future-dated instant,
// which is what an analyzer with a skewed clock produces.
async function seedSignedResult({
  testCode = 'HBSAG',
  valueText = 'Reactive',
  status = 'final',
  tenantId = TENANT,
  patientUid = PATIENT,
  signedBy = SIGNER,
  daysBack = 3,
  signedDaysBack = 0,
} = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_results
       (tenant_id, patient_uid, test_code, test_name, value_text, status,
        signed_off_at, signed_off_by, performed_at, received_at)
     VALUES ($1::uuid, $2::uuid, $3, $3, $4, $5,
             NOW() - ($8::int * INTERVAL '1 day'), $6::uuid,
             NOW() - ($7::int * INTERVAL '1 day'),
             NOW() - ($7::int * INTERVAL '1 day'))
     RETURNING id`,
    tenantId, patientUid, testCode, valueText, status, signedBy, daysBack, signedDaysBack,
  );
  const id = Number(rows[0].id);
  resultIds.push(id);
  return id;
}

async function seedUnsignedResult({ testCode = 'HIV', valueText = 'Reactive' } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_results
       (tenant_id, patient_uid, test_code, test_name, value_text, status,
        performed_at, received_at)
     VALUES ($1::uuid, $2::uuid, $3, $3, $4, 'preliminary', NOW(), NOW())
     RETURNING id`,
    TENANT, PATIENT, testCode, valueText,
  );
  const id = Number(rows[0].id);
  resultIds.push(id);
  return id;
}

async function markerRowsFor(labResultId, tenantId = TENANT) {
  return prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, marker, result, tested_on, source, lab_result_id,
            evidence, recorded_by, voided_at, void_reason
       FROM patient_bloodborne_markers
      WHERE tenant_id = $1::uuid AND lab_result_id = $2::int
      ORDER BY id`,
    tenantId, labResultId,
  );
}

async function activeMarkerFor(labResultId, tenantId = TENANT) {
  const rows = await markerRowsFor(labResultId, tenantId);
  return rows.filter((row) => row.voided_at === null);
}

async function candidateIds(tenantId = TENANT, args = {}) {
  const rows = await findUnreconciledSerologyResults({ tenantId, ...args });
  return rows.map((row) => row.lab_result_id);
}

// FK order: markers -> lab_results -> users -> tenants. Explicit IN-lists
// rather than `= ANY($n::uuid[])`, matching the sibling suite: the repo lint
// reads an array literal in a $queryRawUnsafe argument list as a missed spread.
async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_bloodborne_markers WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT, OTHER_TENANT,
  ).catch(() => {});
  // A lab_results write fans out beyond lab_results itself: migration 753's
  // BEFORE-trigger bumps pharmacy_patient_safety_versions on every insert, and
  // the pathway projector inbox takes clinical events. Neither is FK-bound to
  // the rows below, so they would survive this file and drift the next run's
  // fixtures; both are cleared here even when this file leaves them empty.
  await setTenantTx(TENANT, async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    for (const table of [
      'pharmacy_patient_safety_versions',
      'pathway_projector_inbox',
      'clinical_timeline_events',
      'clinical_audit_events',
      'event_outbox',
    ]) {
      await tx.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE tenant_id IN ($1::uuid, $2::uuid)`,
        TENANT, OTHER_TENANT,
      );
    }
  }).catch((err) => {
    console.warn(`bloodborne-marker-reconciliation teardown: residue delete failed: ${err?.message}`);
  });
  if (resultIds.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM lab_results WHERE tenant_id IN ($1::uuid, $2::uuid) AND id = ANY($3::int[])`,
      TENANT, OTHER_TENANT, resultIds,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM lab_results
      WHERE tenant_id IN ($1::uuid, $2::uuid)
        AND patient_uid IN ($3::uuid, $4::uuid)`,
    TENANT, OTHER_TENANT, PATIENT, OTHER_PATIENT,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
    PATIENT, OTHER_PATIENT, SIGNER, OTHER_SIGNER,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
    TENANT, OTHER_TENANT,
  ).catch(() => {});
}

d('blood-borne marker reconciliation sweep (deep)', () => {
  beforeAll(async () => {
    previousRuntimeRole = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    try {
      for (const role of RUNTIME_ROLES) {
        process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = role;
        runtimeRoleProvisioning.set(role, await ensureTenantRlsRuntimeRoleGrants());
      }
    } finally {
      if (previousRuntimeRole === undefined) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
      else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = previousRuntimeRole;
    }

    await cleanup();
    for (const [id, slug] of [[TENANT, 'bbm-sweep'], [OTHER_TENANT, 'bbm-sweep-other']]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, $2) ON CONFLICT (id) DO NOTHING`,
        id, slug,
      );
    }
    for (const [uid, tenant, role, phone] of [
      [PATIENT, TENANT, 'PATIENT', '+919000012011'],
      [OTHER_PATIENT, OTHER_TENANT, 'PATIENT', '+919000012012'],
      [SIGNER, TENANT, 'PATHOLOGIST', '+919000012099'],
      [OTHER_SIGNER, OTHER_TENANT, 'PATHOLOGIST', '+919000012098'],
    ]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'BBM Sweep Test', $4, true, 'active', NOW())
         ON CONFLICT (uid) DO NOTHING`,
        uid, tenant, phone, role,
      );
    }
  }, 60000);

  afterAll(async () => {
    await cleanup();
  }, 60000);

  // -------------------------------------------------------------------------

  test('a signed reactive result with no marker is repaired into one linked row', async () => {
    const resultId = await seedSignedResult({ testCode: 'HBSAG', valueText: 'Reactive' });

    await expect(candidateIds()).resolves.toContain(resultId);

    const summary = await reconcileTenant({ tenantId: TENANT });
    expect(summary).toMatchObject({ recorded: 1, voided: 0, failed: 0 });
    expect(summary.examples).toContain(resultId);

    const rows = await markerRowsFor(resultId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      patient_uid: PATIENT,
      marker: 'hbsag',
      result: 'reactive',
      // The value the sign-off hook writes — the sweep re-drives that writer
      // rather than inventing a provenance of its own.
      source: 'lab_result',
      lab_result_id: resultId,
      recorded_by: SIGNER,
      voided_at: null,
    });
    // evidence.decision carries the result's own status, not a flat 'verified'.
    expect(rows[0].evidence).toMatchObject({ decision: 'verified', test_code: 'HBSAG' });
  }, 60000);

  test('a second sweep is a no-op: the repaired result is no longer a candidate', async () => {
    const resultId = await seedSignedResult({ testCode: 'HIV', valueText: 'Non-reactive' });

    const first = await reconcileTenant({ tenantId: TENANT });
    expect(first.recorded).toBeGreaterThanOrEqual(1);
    await expect(activeMarkerFor(resultId)).resolves.toHaveLength(1);

    const second = await reconcileTenant({ tenantId: TENANT });
    expect(second).toMatchObject({ candidates: 0, recorded: 0, voided: 0, failed: 0 });
    await expect(candidateIds()).resolves.not.toContain(resultId);
    // Still exactly one row: the sweep did not void-and-reinsert an identical
    // finding on its second pass.
    await expect(markerRowsFor(resultId)).resolves.toHaveLength(1);
  }, 60000);

  test('the writer itself reports skipped if it is re-driven over a repaired result', async () => {
    // The sweep's own idempotence is the anti-join; this is the second layer,
    // which is what protects two sweeps that read their candidate lists before
    // either committed. Same call shape the sweep uses.
    const resultId = await seedSignedResult({ testCode: 'HCV', valueText: 'Non reactive' });
    await reconcileTenant({ tenantId: TENANT });
    const [active] = await activeMarkerFor(resultId);

    const replay = await recordMarkersFromSignedResults({
      tenantId: TENANT,
      resultIds: [resultId],
      decision: 'verified',
      actorUid: SIGNER,
    });
    expect(replay.recorded).toHaveLength(0);
    expect(replay.skipped).toEqual([resultId]);
    expect(replay.voided).toBe(0);
    const rows = await markerRowsFor(resultId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].id)).toBe(Number(active.id));
  }, 60000);

  test('a result whose only marker row is VOIDED becomes a candidate again', async () => {
    const resultId = await seedSignedResult({ testCode: 'HBSAG', valueText: 'Reactive' });
    await reconcileTenant({ tenantId: TENANT });
    const [recorded] = await activeMarkerFor(resultId);
    expect(recorded).toBeTruthy();

    // With an ACTIVE row it is excluded...
    await expect(candidateIds()).resolves.not.toContain(resultId);

    await voidMarker({
      tenantId: TENANT,
      patientUid: PATIENT,
      markerId: Number(recorded.id),
      actorUid: SIGNER,
      reason: 'voided by the reconciliation deep suite',
    });

    // ...and once voided the lab result is unrepresented again, so the sweep
    // must offer it. This is the assertion the `voided_at IS NULL` predicate
    // in the anti-join exists for.
    await expect(candidateIds()).resolves.toContain(resultId);

    const summary = await reconcileTenant({ tenantId: TENANT });
    expect(summary.recorded).toBeGreaterThanOrEqual(1);

    const rows = await markerRowsFor(resultId);
    expect(rows).toHaveLength(2);
    expect(rows[0].voided_at).not.toBeNull();
    expect(rows[1].voided_at).toBeNull();
    // A fresh row, not a resurrection of the voided one.
    expect(Number(rows[1].id)).toBeGreaterThan(Number(recorded.id));
    expect(rows[1]).toMatchObject({ result: 'reactive', source: 'lab_result', lab_result_id: resultId });
  }, 60000);

  test('unsigned and non-serology results are never candidates', async () => {
    const unsigned = await seedUnsignedResult({ testCode: 'HIV' });
    const quantitative = await seedSignedResult({ testCode: 'HGB', valueText: '12.4' });
    const ids = await candidateIds();
    expect(ids).not.toContain(unsigned);
    expect(ids).not.toContain(quantitative);

    await reconcileTenant({ tenantId: TENANT });
    await expect(markerRowsFor(unsigned)).resolves.toHaveLength(0);
    await expect(markerRowsFor(quantitative)).resolves.toHaveLength(0);
  }, 60000);

  test('an aliased, unnormalised analyte code still reaches the sweep', async () => {
    // 'Anti-HCV' only matches the map after normalizeCode; the SQL pre-filter
    // has to normalise the column the same way or this result is invisible.
    const resultId = await seedSignedResult({ testCode: 'Anti-HCV', valueText: 'Reactive' });
    await expect(candidateIds()).resolves.toContain(resultId);
    await reconcileTenant({ tenantId: TENANT });
    await expect(activeMarkerFor(resultId)).resolves.toMatchObject([{ marker: 'hcv', result: 'reactive' }]);
  }, 60000);

  test('a dry run reports the candidates and writes nothing', async () => {
    const resultId = await seedSignedResult({ testCode: 'HBSAG', valueText: 'Reactive' });
    const summary = await reconcileTenant({ tenantId: TENANT, dryRun: true });
    expect(summary.candidates).toBeGreaterThanOrEqual(1);
    expect(summary).toMatchObject({ recorded: 0, voided: 0, skipped: 0, failed: 0 });
    expect(summary.examples).toContain(resultId);
    await expect(markerRowsFor(resultId)).resolves.toHaveLength(0);
    // Still there to be repaired afterwards.
    await expect(candidateIds()).resolves.toContain(resultId);
  }, 60000);

  test('the since window bounds which signed results the sweep offers', async () => {
    const old = await seedSignedResult({ testCode: 'HIV', valueText: 'Reactive', signedDaysBack: 30 });
    const recent = await seedSignedResult({ testCode: 'HCV', valueText: 'Reactive', signedDaysBack: 1 });
    const since = new Date(Date.now() - 7 * 86400000);
    const windowed = await candidateIds(TENANT, { since });
    expect(windowed).toContain(recent);
    expect(windowed).not.toContain(old);
    // Without a window both are offered.
    const all = await candidateIds();
    expect(all).toEqual(expect.arrayContaining([old, recent]));
  }, 60000);

  // -------------------------------------------------------------------------
  // Spec §7.1: the sweep must apply the same clamp-don't-drop rule.
  // -------------------------------------------------------------------------

  test('a future-dated REACTIVE result is clamped and recorded, never dropped', async () => {
    const resultId = await seedSignedResult({
      testCode: 'HBSAG', valueText: 'Reactive', daysBack: -5,
    });
    const summary = await reconcileTenant({ tenantId: TENANT });
    expect(summary.recorded).toBeGreaterThanOrEqual(1);

    const [row] = await activeMarkerFor(resultId);
    expect(row).toMatchObject({ marker: 'hbsag', result: 'reactive' });
    // Clamped to today's clinical date, with the skew kept as evidence — the
    // sweep inherits this by re-driving the writer rather than inserting.
    // isoDate, not String(...).slice: the driver materialises a DATE column as
    // a JS Date, whose default stringification is 'Sat Sep 05 2026' and would
    // make this assertion compare two things that are never equal.
    expect(isoDate(row.tested_on)).toBe(clinicalDate(new Date()));
    expect(row.evidence).toMatchObject({
      tested_on_clamped: true,
      tested_on_problem: 'future_dated',
    });
  }, 60000);

  test('a future-dated NON-reactive result is still dropped, and counted as failed', async () => {
    const resultId = await seedSignedResult({
      testCode: 'HIV', valueText: 'Non-reactive', daysBack: -5,
    });
    const summary = await reconcileTenant({ tenantId: TENANT });
    expect(summary.failed).toBeGreaterThanOrEqual(1);
    await expect(markerRowsFor(resultId)).resolves.toHaveLength(0);
    // It stays a candidate — an unusable date is a real gap, and the sweep
    // reports it every run rather than pretending it was repaired.
    await expect(candidateIds()).resolves.toContain(resultId);
  }, 60000);

  // -------------------------------------------------------------------------
  // Isolation
  // -------------------------------------------------------------------------

  test('sweeping one tenant leaves another tenant\'s gap untouched', async () => {
    const mine = await seedSignedResult({ testCode: 'HBSAG', valueText: 'Reactive' });
    const theirs = await seedSignedResult({
      testCode: 'HBSAG',
      valueText: 'Reactive',
      tenantId: OTHER_TENANT,
      patientUid: OTHER_PATIENT,
      signedBy: OTHER_SIGNER,
    });

    const summary = await reconcileTenant({ tenantId: TENANT });
    expect(summary.examples).not.toContain(theirs);
    await expect(activeMarkerFor(mine)).resolves.toHaveLength(1);
    // The other tenant's result is untouched...
    await expect(markerRowsFor(theirs, OTHER_TENANT)).resolves.toHaveLength(0);
    // ...and still its own tenant's candidate, so it is repairable there.
    await expect(candidateIds(OTHER_TENANT)).resolves.toContain(theirs);
    await expect(candidateIds(TENANT)).resolves.not.toContain(theirs);

    const theirSummary = await reconcileTenant({ tenantId: OTHER_TENANT });
    expect(theirSummary.recorded).toBe(1);
    await expect(activeMarkerFor(theirs, OTHER_TENANT)).resolves.toHaveLength(1);
  }, 60000);

  test('the candidate query works under the runtime RLS role, not just as owner', async () => {
    if (runtimeRoleProvisioning.get(RLS_ROLE)?.skipped === true) return;

    const probe = await prisma.$queryRawUnsafe(
      `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1::name) AS role_exists,
              COALESCE((SELECT has_table_privilege($1::name, 'public.lab_results', 'SELECT')
                          FROM pg_roles WHERE rolname = $1::name), false) AS can_read_results,
              COALESCE((SELECT has_table_privilege($1::name, 'public.patient_bloodborne_markers', 'SELECT')
                          FROM pg_roles WHERE rolname = $1::name), false) AS can_read_markers`,
      RLS_ROLE,
    );
    expect(probe[0].role_exists).toBe(true);
    expect(probe[0].can_read_results).toBe(true);
    expect(probe[0].can_read_markers).toBe(true);

    const resultId = await seedSignedResult({ testCode: 'HCV', valueText: 'Reactive' });

    // Drive the PRODUCTION query under the production role rather than
    // re-typing its SQL here: setTenant reads AUTH_TENANT_RLS_RUNTIME_ROLE at
    // call time and issues SET LOCAL ROLE, so this is the same statement the
    // sweep runs in a deployment where RLS is actually enforced.
    const before = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    let underRole;
    let crossTenant;
    try {
      process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = RLS_ROLE;
      underRole = await candidateIds(TENANT);
      crossTenant = await candidateIds(OTHER_TENANT);
    } finally {
      if (before === undefined) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
      else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = before;
    }
    expect(underRole).toContain(resultId);
    // RLS is doing the scoping, not just the WHERE clause: the same query run
    // in the other tenant's context cannot see this tenant's result.
    expect(crossTenant).not.toContain(resultId);
  }, 60000);
});
