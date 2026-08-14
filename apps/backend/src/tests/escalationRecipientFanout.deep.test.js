// Escalation recipient fan-out — silent-eviction regression (real service + QA DB).
//
// THE DEFECT THIS PINS. Both arms of escalationEngineService.resolveRecipientsForRole
// used to end in a bare `LIMIT 50` with `ORDER BY id`:
//
//     SELECT id, uid, phone, role FROM users
//      WHERE tenant_id = $1 AND role = $2 AND is_active ORDER BY id LIMIT 50
//
// A tenant with more than fifty active clinicians in a role therefore had
// recipient 51+ dropped from a critical-result escalation with no warning, no
// metric, and no clinically meaningful reason for WHICH fifty survived — the
// surviving page was simply whoever held the lowest user ids, i.e. the
// longest-standing accounts. In a hospital escalation path, silently not paging
// staff about an unacknowledged critical result is clinical-safety-adjacent.
//
// This suite proves the three properties the fix has to hold:
//   1. VOLUME    — a role with >50 active users resolves ALL of them (the exact
//                  arm AND the role-family fallback arm). This is the assertion
//                  that fails on the pre-change service, which returns 50.
//   2. HONESTY   — when the configured cap DOES trim, the drop is announced: an
//                  exact dropped count in a Winston warning plus a Prometheus
//                  counter, never inference from silence.
//   3. ORDERING  — the cap sheds the least-reachable clinicians first. There is
//                  no on-duty roster to join, so the order is the documented
//                  availability proxy `last_sign_in_at DESC NULLS LAST, id ASC`:
//                  never-signed-in accounts sort last and are dropped first, and
//                  the total order makes the page deterministic across sweeps.
//
// It also drives the REAL sweep end to end, because "resolveRecipientsForRole
// returned 55 rows" is not the clinical claim — "55 clinicians actually got an
// outbox row" is.
//
// ---------------------------------------------------------------------------
// TENANT OWNERSHIP (the #675/#678/#680 pattern — see resultsInboxC3Escalation).
// The queries under test are tenant-scoped, so this suite MUST own its tenant or
// it would be measuring the default tenant's shared seed population. It creates
// TENANT (+ TENANT_DECOY) in beforeAll and drops both in afterAll; every fixture
// row sets tenant_id EXPLICITLY, because raw inserts run with
// app.current_tenant_id unset and an omitted tenant_id silently falls to the
// column DEFAULT (the default tenant). The mig-312 tier rules are CLONED from the
// default tenant rather than restated, both so the fixture cannot drift from the
// migration and so runEscalationSweep's tenant discovery (SELECT DISTINCT
// tenant_id FROM escalation_rules WHERE is_active AND scope='task') reaches this
// tenant at all. TENANT_DECOY carries its own users in the same roles so the
// scoping assertions are proofs rather than statements about an empty database.
//
// Roles are kept DISJOINT across tests (DUTY_DOCTOR / CONSULTANT / CNO) so the
// large trim fixture cannot perturb the volume fixture.
//
// A note on the "55 active DOCTOR rows" figure quoted in
// resultsInboxC3Escalation.deep.test.js: 55 is an ALL-TENANTS count. The
// resolver is tenant-scoped, and the largest single tenant in the QA database
// holds 32 active doctor-tier users — under the old 50 limit. The defect is real
// (any real hospital clears 50 doctors trivially) but it was not firing in the QA
// database today, so this suite manufactures the condition explicitly instead of
// relying on ambient seed data.

import { jest } from '@jest/globals';
import { Client } from 'pg';

const prisma = (await import('../lib/prisma.js')).default;
const { setTenantTx } = await import('../lib/prisma.js');
const { DEFAULT_TENANT_ID } = await import('../services/tenant/tenantService.js');
const { runEscalationSweep, __testing__ } = await import('../services/workflow/escalationEngineService.js');
const {
  getEscalationRecipientRankings,
  replaceEscalationRecipientRankings,
} = await import('../services/workflow/escalationRecipientRankingService.js');
const { enqueueCriticalResultTask } = await import('../services/results/resultsInboxService.js');
const { serializeEscalationMetrics } = await import('../observability/escalationMetrics.js');
const logger = (await import('../logging/logger.js')).default;

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const DB_CONFIGURED = !!databaseUrl;
const d = DB_CONFIGURED ? describe : describe.skip;

// Distinct from every other suite's tenants. The UUID must satisfy
// tenantContextMiddleware's UUID_RE: version nibble [1-5], variant [89ab].
const TENANT = 'd6600000-0000-4000-8000-00000000fa01';
const TENANT_DECOY = 'd6600000-0000-4000-8000-00000000fa02';
const TENANT_RANKED = 'd6600000-0000-4000-8000-00000000fa03';

// tenants(id) is referenced by ~685 foreign keys, so each tenant DELETE pays a
// check per constraint. Both hooks therefore carry an explicit timeout: jest's 5s
// default is not enough, and a standalone run must not silently depend on the CI
// runner's --testTimeout=60000.
const HOOK_TIMEOUT_MS = 180000;

function ownerDatabaseUrl(value) {
  if (!value) return value;
  const url = new URL(value);
  if (url.hostname === '127.0.0.1' && url.port === '55432') {
    url.username = 'postgres';
    url.password = '';
  }
  return url.toString();
}

const CAP = __testing__.RECIPIENT_FANOUT_CAP;
// Enough over the cap to make the dropped count a specific number rather than
// "some". These are the rows deliberately left with a NULL last_sign_in_at.
const OVER_CAP = 5;

// >50 but well under the cap: the population that the OLD `LIMIT 50` would have
// truncated and the fixed resolver must return whole.
const OVER_LEGACY_LIMIT = 55;

// users.uid and users.phone are globally unique, so every seeded row embeds a
// per-run suffix. 5 suffix chars + 7 counter chars fills the 12-char UUID tail
// exactly, and '+9' + 5 + 7 = 14 chars fits users.phone varchar(15).
const SUFFIX = String(Date.now() % 100000).padStart(5, '0');
const uidFor = (n) => `c4f00000-0000-4000-8000-${SUFFIX}${String(n).padStart(7, '0')}`;
const rankedUidFor = (n) => `c5f00000-0000-4000-8000-${SUFFIX}${String(n).padStart(7, '0')}`;

const PATIENT_UID = uidFor(9000001);
const DOCTOR_UID = uidFor(9000002);
const DECOY_PATIENT_UID = uidFor(9000003);
const DECOY_DOCTOR_UID = uidFor(9000004);

// Disjoint id bands per role so the fixtures cannot alias one another.
const BAND = {
  duty: 100000, // DUTY_DOCTOR   — volume + end-to-end fan-out (OVER_LEGACY_LIMIT)
  consultant: 200000, // CONSULTANT — cap trim + ordering (CAP + OVER_CAP)
  cno: 300000, // CNO           — family-fallback volume (OVER_LEGACY_LIMIT)
  decoy: 400000, // decoy tenant mirrors
};

const RESOURCE_ID = `97${SUFFIX}`;
// The engine measures every tier window forward from the breach, so this is a
// window boundary anchored to run time, not a calendar literal (PR #676).
const BREACH_ISO = new Date(Date.now() - 80 * 24 * 60 * 60_000).toISOString();

// ---- helpers ---------------------------------------------------------------

// Read one labelled counter out of the real Prometheus exposition text. Counters
// are process-global, so every assertion is a before/after DELTA.
function counterValue(name, labels) {
  const labelPart = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',');
  const prefix = `${name}{${labelPart}} `;
  const line = serializeEscalationMetrics().split('\n').find((l) => l.startsWith(prefix));
  return line ? Number(line.slice(prefix.length)) : 0;
}

// Seed `count` active users in one role. `signedInThrough` rows get a descending
// last_sign_in_at (row 1 most recent); everything past it is left NULL, which is
// what the resolver's NULLS LAST ordering must shed first.
async function seedRoleCohort({
  tenantId, role, band, count, signedInThrough = count,
}) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at, last_sign_in_at)
     SELECT ('c4f00000-0000-4000-8000-' || $1::text || lpad((n + $2::int)::text, 7, '0'))::uuid,
            '+9' || $1::text || lpad((n + $2::int)::text, 7, '0'),
            $3::text || ' ' || n::text || ' [test]',
            $3::text,
            TRUE,
            $4::uuid,
            NOW(),
            CASE WHEN n <= $5::int THEN NOW() - make_interval(mins => n) ELSE NULL END
       FROM generate_series(1, $6::int) AS n`,
    SUFFIX, band, role, tenantId, signedInThrough, count,
  );
  // Non-vacuity: a phone/uid collision with a previous crashed run would silently
  // shrink the cohort and make every count assertion below meaningless.
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM users
      WHERE tenant_id = $1::uuid AND role = $2::text AND is_active = TRUE`,
    tenantId, role,
  );
  if (rows[0].n !== count) {
    throw new Error(`cohort seed for ${role} produced ${rows[0].n} rows, expected ${count}`);
  }
}

async function resolveInTenant(tenantId, role, clock = undefined) {
  return setTenantTx(tenantId, async (tx) => (
    __testing__.resolveRecipientsForRole(tx, tenantId, role, clock)
  ));
}

// Copy the mig-312 critical_result_ack tier rules (T1 @0 / T2 @10 / T3 @30) into a
// suite-owned tenant. Cloned rather than restated so the fixture cannot drift from
// the migration.
async function cloneCriticalResultEscalationRules(tenantId) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO escalation_rules
       (tenant_id, display_name, description, scope, match_filter, trigger_condition,
        trigger_window_minutes, action_kind, action_payload, is_active)
     SELECT $2::uuid, display_name, description, scope, match_filter, trigger_condition,
            trigger_window_minutes, action_kind, action_payload, is_active
       FROM escalation_rules
      WHERE tenant_id = $1::uuid
        AND scope = 'task'
        AND is_active = TRUE
        AND (match_filter->>'sla_key') = 'critical_result_ack'`,
    DEFAULT_TENANT_ID, tenantId,
  );
  const cloned = await prisma.$queryRawUnsafe(
    `SELECT trigger_window_minutes AS win FROM escalation_rules
      WHERE tenant_id = $1::uuid AND scope = 'task' AND is_active = TRUE
      ORDER BY trigger_window_minutes`,
    tenantId,
  );
  return cloned.map((r) => Number(r.win));
}

async function setSlaBreachedAt(slaInstanceId, whenIso, tenantId) {
  await setTenantTx(tenantId, async (tx) => {
    await tx.$executeRawUnsafe(
      `UPDATE tasks SET due_at = $2::timestamptz, updated_at = NOW()
        WHERE workflow_sla_instance_id = $1::uuid AND tenant_id = $3::uuid`,
      slaInstanceId, whenIso, tenantId,
    );
    await tx.$executeRawUnsafe(
      `UPDATE workflow_sla_instances
          SET status = 'breached', breached_at = $2::timestamptz,
              due_at = $2::timestamptz, updated_at = NOW()
        WHERE id = $1::uuid AND tenant_id = $3::uuid`,
      slaInstanceId, whenIso, tenantId,
    );
  });
  const rows = await prisma.$queryRawUnsafe(
    `SELECT breached_at FROM workflow_sla_instances
      WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    slaInstanceId, tenantId,
  );
  return new Date(rows[0].breached_at);
}

// The post-commit queue keeps the originating tenant context, so read the
// outbox under that same tenant rather than relying on an owner-exempt query.
async function readEscalationOutboxForTask(taskId, tenantId = TENANT) {
  return setTenantTx(tenantId, (tx) => tx.$queryRawUnsafe(
    `SELECT id, recipient_id, payload
       FROM notification_outbox
      WHERE tenant_id = $1::uuid
        AND (payload->>'task_id') = $2::text
        AND (payload->>'kind') = 'results_inbox_escalation'
      ORDER BY id ASC`,
    tenantId,
    String(taskId),
  ), { readOnly: true });
}

async function cleanup() {
  const owner = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
  await owner.connect();
  await owner.query('BEGIN');
  try {
    await owner.query("SET LOCAL session_replication_role = 'replica'");
    // The tier-2/tier-3 notify rows carry patient_uid, but the tier-1 assignee
    // re-notify payload carries assigned_to_uid instead and no patient_uid.
    await owner.query(
      `DELETE FROM notification_outbox
        WHERE (payload->>'kind') = 'results_inbox_escalation'
          AND (
            (payload->>'patient_uid') IN ($1::text, $2::text)
            OR (payload->>'assigned_to_uid') IN ($3::text, $4::text)
          )`,
      [PATIENT_UID, DECOY_PATIENT_UID, DOCTOR_UID, DECOY_DOCTOR_UID],
    );

    for (const tenantId of [TENANT, TENANT_DECOY, TENANT_RANKED]) {
      // Children before parents, every statement scoped to this suite's tenant.
      await owner.query('DELETE FROM task_comments WHERE tenant_id = $1::uuid', [tenantId]);
      await owner.query('DELETE FROM tasks WHERE tenant_id = $1::uuid', [tenantId]);
      await owner.query('DELETE FROM workflow_sla_instances WHERE tenant_id = $1::uuid', [tenantId]);
      await owner.query('DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid', [tenantId]);
      await owner.query('DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid', [tenantId]);
      await owner.query('DELETE FROM event_outbox WHERE tenant_id = $1::uuid', [tenantId]);
      await owner.query('DELETE FROM escalation_rules WHERE tenant_id = $1::uuid', [tenantId]);
      await owner.query(
        'DELETE FROM escalation_recipient_rank_mappings WHERE tenant_id = $1::uuid',
        [tenantId],
      );
      await owner.query('DELETE FROM audit_logs WHERE tenant_id = $1::uuid', [tenantId]);
      await owner.query('DELETE FROM staff WHERE tenant_id = $1::uuid', [tenantId]);
      await owner.query('DELETE FROM users WHERE tenant_id = $1::uuid', [tenantId]);
    }
    // Parent last, and deliberately NOT swallowed. A tenant this suite cannot
    // drop would keep active escalation rules in every later sweep.
    await owner.query(
      `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid, $3::uuid)`,
      [TENANT, TENANT_DECOY, TENANT_RANKED],
    );
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await owner.end();
  }
}

d('Escalation recipient fan-out (deep, real service + DB)', () => {
  beforeAll(async () => {
    // Every cohort below is sized against the REAL cap. A leaked
    // ESCALATION_RECIPIENT_FANOUT_CAP from another suite in the same jest process
    // would silently invalidate all of it (the volume tests would measure the cap
    // instead of the vanished 50-row page), so assert the premise rather than
    // discovering it as a confusing count mismatch.
    expect(CAP).toBeGreaterThan(OVER_LEGACY_LIMIT);

    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status)
       VALUES ($1::uuid, 'fanout-escalation', 'Fan-out Escalation Tenant', 'IN', 'DPDP', 'active'),
              ($2::uuid, 'fanout-escalation-decoy', 'Fan-out Escalation Decoy', 'IN', 'DPDP', 'active')
       ON CONFLICT (id) DO NOTHING`,
      TENANT, TENANT_DECOY,
    );

    // Patient + ordering clinician for the end-to-end sweep. tenant_id explicit.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Fanout Patient [test]', 'PATIENT', true, $3::uuid, NOW()),
              ($4::uuid, $5, 'Fanout Doctor [test]', 'DOCTOR', true, $3::uuid, NOW())`,
      PATIENT_UID, `+9${SUFFIX}9000001`, TENANT,
      DOCTOR_UID, `+9${SUFFIX}9000002`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Fanout Decoy Patient [test]', 'PATIENT', true, $3::uuid, NOW()),
              ($4::uuid, $5, 'Fanout Decoy Doctor [test]', 'DOCTOR', true, $3::uuid, NOW())`,
      DECOY_PATIENT_UID, `+9${SUFFIX}9000003`, TENANT_DECOY,
      DECOY_DOCTOR_UID, `+9${SUFFIX}9000004`,
    );

    // Three disjoint cohorts, each sized to a specific claim.
    await seedRoleCohort({
      tenantId: TENANT, role: 'DUTY_DOCTOR', band: BAND.duty, count: OVER_LEGACY_LIMIT,
    });
    await seedRoleCohort({
      tenantId: TENANT,
      role: 'CONSULTANT',
      band: BAND.consultant,
      count: CAP + OVER_CAP,
      // The last OVER_CAP rows keep a NULL last_sign_in_at — the cohort the
      // ordering must shed when the cap bites.
      signedInThrough: CAP,
    });
    await seedRoleCohort({
      tenantId: TENANT, role: 'CNO', band: BAND.cno, count: OVER_LEGACY_LIMIT,
    });
    // Decoy mirrors: same roles, different tenant. These are what make the
    // tenant-scoping assertions probative rather than merely true.
    await seedRoleCohort({
      tenantId: TENANT_DECOY, role: 'DUTY_DOCTOR', band: BAND.decoy, count: 3,
    });

    const windows = await cloneCriticalResultEscalationRules(TENANT);
    // Non-vacuity guard on the clone: if mig-312's tiers ever change, this is
    // where you find out, rather than inside a confusing tier assertion.
    expect(windows).toEqual([0, 10, 30]);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, HOOK_TIMEOUT_MS);

  // ---- 1. VOLUME -----------------------------------------------------------

  it('resolves EVERY active clinician in the role — the old 50-row page is gone', async () => {
    const rows = await resolveInTenant(TENANT, 'DUTY_DOCTOR');

    // THE regression assertion. The pre-change resolver returns exactly 50 here.
    expect(rows).toHaveLength(OVER_LEGACY_LIMIT);
    expect(rows.every((r) => Number.isInteger(r.id) && r.id > 0)).toBe(true);
    expect(new Set(rows.map((r) => r.uid)).size).toBe(OVER_LEGACY_LIMIT);
    expect(rows.every((r) => r.role === 'DUTY_DOCTOR')).toBe(true);

    // Pre-assertion: the decoy tenant really does hold active DUTY_DOCTORs, so
    // the count above is a tenant-scoped result and not an empty-database one.
    const decoy = await resolveInTenant(TENANT_DECOY, 'DUTY_DOCTOR');
    expect(decoy).toHaveLength(3);
    const decoyUids = new Set(decoy.map((r) => r.uid));
    expect(rows.some((r) => decoyUids.has(r.uid))).toBe(false);
  });

  it('resolves every clinician through the role-FAMILY fallback arm too', async () => {
    // No user holds CMO in this tenant, so resolveRecipientsForRole widens to
    // LEADERSHIP_ROLES — where the 55 seeded CNOs live. The pre-change fallback
    // arm carried its own independent `LIMIT 50` and would return 50.
    const rows = await resolveInTenant(TENANT, 'CMO');

    expect(rows).toHaveLength(OVER_LEGACY_LIMIT);
    expect(rows.every((r) => r.role === 'CNO')).toBe(true);
  });

  // ---- 2. HONESTY + 3. ORDERING -------------------------------------------

  it('over the cap: pages exactly CAP, sheds the least-reachable first, and says so', async () => {
    const before = counterValue('vhhealth_escalation_recipients_trimmed_total', {
      role: 'CONSULTANT', arm: 'exact',
    });
    const warnSpy = jest.spyOn(logger, 'warn');

    let rows;
    try {
      rows = await resolveInTenant(TENANT, 'CONSULTANT');

      // Bounded at the configured cap, not at 50 and not unbounded.
      expect(rows).toHaveLength(CAP);

      // ORDERING: the OVER_CAP never-signed-in accounts are exactly the ones cut.
      // This is the property that makes the trim defensible rather than arbitrary
      // — `ORDER BY id` would instead have dropped the newest-provisioned staff.
      const resolved = new Set(rows.map((r) => r.uid));
      const nullSignIn = await prisma.$queryRawUnsafe(
        `SELECT uid FROM users
          WHERE tenant_id = $1::uuid AND role = 'CONSULTANT'
            AND is_active = TRUE AND last_sign_in_at IS NULL`,
        TENANT,
      );
      // Pre-assertion: the fixture really does contain the dropped cohort.
      expect(nullSignIn).toHaveLength(OVER_CAP);
      expect(nullSignIn.some((r) => resolved.has(r.uid))).toBe(false);

      // HONESTY: an exact dropped count in the log...
      expect(warnSpy).toHaveBeenCalledWith(
        'escalation notify: recipient fan-out exceeded cap — tail of the role was NOT notified',
        expect.objectContaining({
          tenantId: TENANT,
          role: 'CONSULTANT',
          arm: 'exact',
          matched: CAP + OVER_CAP,
          notified: CAP,
          dropped: OVER_CAP,
          cap: CAP,
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }

    // ...and the same number on the scrape endpoint's counter.
    expect(counterValue('vhhealth_escalation_recipients_trimmed_total', {
      role: 'CONSULTANT', arm: 'exact',
    })).toBe(before + OVER_CAP);

    // DETERMINISM: the page is stable across sweeps, so a trimmed tier does not
    // silently rotate which clinicians it reaches.
    const again = await resolveInTenant(TENANT, 'CONSULTANT');
    expect(again.map((r) => r.uid)).toEqual(rows.map((r) => r.uid));
  }, 60000);

  // ---- end-to-end: recipients actually become notifications -----------------

  it('a real sweep enqueues one outbox row per resolved clinician, not fifty', async () => {
    const res = await enqueueCriticalResultTask({
      tenantId: TENANT,
      patientUid: PATIENT_UID,
      source: 'lab_result',
      resourceType: 'lab_result',
      resourceId: RESOURCE_ID,
      severity: 'critical',
      title: 'Critical lab: Potassium',
      summary: 'Potassium critically high.',
      orderingClinicianUid: DOCTOR_UID,
    });
    expect(res.created).toBe(true);

    const taskRow = await prisma.$queryRawUnsafe(
      `SELECT workflow_sla_instance_id FROM tasks
        WHERE id = $1::int AND tenant_id = $2::uuid LIMIT 1`,
      res.taskId, TENANT,
    );
    const breachSeen = await setSlaBreachedAt(
      taskRow[0].workflow_sla_instance_id, BREACH_ISO, TENANT,
    );

    // Drive T1 (0m) / T2 (10m, DUTY→DUTY_DOCTOR) / T3 (30m, LEADERSHIP→CMO,
    // which falls back to the CNO cohort), padding one minute past each window.
    await runEscalationSweep({ now: new Date(breachSeen.getTime() + 1 * 60_000) });
    await runEscalationSweep({ now: new Date(breachSeen.getTime() + 11 * 60_000) });
    await runEscalationSweep({ now: new Date(breachSeen.getTime() + 31 * 60_000) });

    const outbox = await readEscalationOutboxForTask(res.taskId);
    const dutyRows = outbox.filter((o) => o.payload?.notify_role === 'DUTY_DOCTOR');
    const leadershipRows = outbox.filter((o) => o.payload?.notify_role === 'CMO');

    // The clinical claim: every one of the 55 duty doctors got a row. The
    // pre-change engine caps each of these at 50.
    expect(dutyRows).toHaveLength(OVER_LEGACY_LIMIT);
    expect(leadershipRows).toHaveLength(OVER_LEGACY_LIMIT);
    // Every row reaches a real human — no null-recipient no-ops (audit C-3).
    expect(outbox.every((o) => o.recipient_id != null)).toBe(true);
    expect(new Set(dutyRows.map((o) => Number(o.recipient_id))).size)
      .toBe(OVER_LEGACY_LIMIT);
  }, 120000);
});

// Keep eslint happy about the imported jest namespace in this ESM test.
void jest;

const RANK_CLOCK = new Date('2026-08-04T10:00:00.000Z');
const RANKED_COHORT_SIZE = 600;
const RANKED_PRESENT_COUNT = 500;

async function seedRankedDoctorCohort() {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users
       (uid, phone, name, role, is_active, tenant_id, updated_at, last_sign_in_at)
     SELECT
       ('c5f00000-0000-4000-8000-' || $1::text || lpad((5000000 + n)::text, 7, '0'))::uuid,
       '+8' || $1::text || lpad((5000000 + n)::text, 7, '0'),
       CASE
         WHEN n <= 100 THEN 'rank-recent-one-' || lpad(n::text, 3, '0')
         WHEN n <= 280 THEN 'rank-recent-two-' || lpad(n::text, 3, '0')
         WHEN n <= 500 THEN 'rank-recent-three-' || lpad(n::text, 3, '0')
         WHEN n <= 520 THEN 'rank-never-one-' || lpad(n::text, 3, '0')
         WHEN n <= 560 THEN 'rank-leave-unranked-' || lpad(n::text, 3, '0')
         ELSE 'rank-never-unranked-' || lpad(n::text, 3, '0')
       END,
       'DOCTOR', TRUE, $2::uuid, $3::timestamptz,
       CASE
         WHEN n = 1 THEN $3::timestamptz - INTERVAL '6 hours'
         WHEN n = 2 THEN $3::timestamptz - INTERVAL '6 hours 1 second'
         WHEN n <= 500 THEN $3::timestamptz - make_interval(secs => n)
         WHEN n <= 520 THEN NULL
         WHEN n <= 560 THEN $3::timestamptz - make_interval(secs => n)
         ELSE NULL
       END
       FROM generate_series(1, $4::integer) AS n`,
    SUFFIX,
    TENANT_RANKED,
    RANK_CLOCK.toISOString(),
    RANKED_COHORT_SIZE,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO staff
       (tenant_id, user_id, employee_id, name, designation, position,
        is_active, on_leave, archived, updated_at)
     SELECT
       $1::uuid,
       ('c5f00000-0000-4000-8000-' || $2::text || lpad((5000000 + n)::text, 7, '0'))::uuid,
       'RANK-' || $2::text || '-' || lpad(n::text, 3, '0'),
       'Ranked doctor ' || n::text,
       CASE
         WHEN n = 1 THEN 'Doctor'
         WHEN n = 2 THEN 'Consultant'
         ELSE 'Unmapped designation'
       END,
       CASE
         WHEN n = 1 THEN 'Consultant'
         WHEN n = 2 THEN 'Unmapped position'
         WHEN n <= 100 THEN 'Consultant'
         WHEN n <= 280 THEN 'Doctor'
         WHEN n <= 500 THEN 'Junior Resident'
         WHEN n <= 520 THEN 'Consultant'
         ELSE 'Unmapped position'
       END,
       TRUE,
       n BETWEEN 521 AND 560,
       FALSE,
       $3::timestamptz
       FROM generate_series(1, 560) AS n`,
    TENANT_RANKED,
    SUFFIX,
    RANK_CLOCK.toISOString(),
  );
}

async function seedRankVisibilityRoles() {
  const rows = [
    [7000001, 'RADIOLOGIST', 'rank-zero-1', true],
    [7000002, 'RADIOLOGIST', 'rank-zero-2', true],
    [7000003, 'RADIOLOGIST', 'rank-zero-3', true],
    [7000011, 'DUTY_DOCTOR', 'rank-no-active-staff-recent', false],
    [7000012, 'DUTY_DOCTOR', 'rank-no-active-staff-null', false],
  ];
  for (const [number, role, name, withStaff] of rows) {
    const uid = rankedUidFor(number);
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, phone, name, role, is_active, tenant_id, updated_at, last_sign_in_at)
       VALUES
         ($1::uuid, $2::text, $3::text, $4::text, TRUE, $5::uuid,
          $6::timestamptz, $7::timestamptz)`,
      uid,
      `+8${SUFFIX}${String(number).padStart(7, '0')}`,
      name,
      role,
      TENANT_RANKED,
      RANK_CLOCK.toISOString(),
      number === 7000012 ? null : RANK_CLOCK.toISOString(),
    );
    if (withStaff) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO staff
           (tenant_id, user_id, employee_id, name, designation, position,
            is_active, on_leave, archived, updated_at)
         VALUES
           ($1::uuid, $2::uuid, $3::text, $4::text, 'Unmapped radiology',
            'Unmapped radiology', TRUE, FALSE, FALSE, $5::timestamptz)`,
        TENANT_RANKED,
        uid,
        `RANK-${SUFFIX}-${number}`,
        name,
        RANK_CLOCK.toISOString(),
      );
    }
  }
}

async function seedOrderingUser({
  number,
  role,
  lastSignInAt,
  staffRows = [],
}) {
  const uid = rankedUidFor(number);
  await prisma.$executeRawUnsafe(
    `INSERT INTO users
       (uid, phone, name, role, is_active, tenant_id, updated_at, last_sign_in_at)
     VALUES
       ($1::uuid, $2::text, $3::text, $4::text, TRUE, $5::uuid,
        $6::timestamptz, $7::timestamptz)`,
    uid,
    `+8${SUFFIX}${String(number).padStart(7, '0')}`,
    `rank-order-${number}`,
    role,
    TENANT_RANKED,
    RANK_CLOCK.toISOString(),
    lastSignInAt?.toISOString() || null,
  );
  for (const [index, staffRow] of staffRows.entries()) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff
         (tenant_id, user_id, employee_id, name, designation, position,
          is_active, on_leave, archived, updated_at)
       VALUES
         ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text,
          TRUE, $7::boolean, FALSE, $8::timestamptz)`,
      TENANT_RANKED,
      uid,
      `RANK-${SUFFIX}-${number}-${index}`,
      `Rank ordering ${number}`,
      staffRow.designation ?? null,
      staffRow.position ?? null,
      staffRow.onLeave === true,
      RANK_CLOCK.toISOString(),
    );
  }
}

async function seedOrderingProofs() {
  const minutesAgo = (minutes, extraMs = 0) => (
    new Date(RANK_CLOCK.getTime() - minutes * 60_000 - extraMs)
  );
  const rows = [
    {
      number: 8000001,
      role: 'ANESTHETIST',
      lastSignInAt: minutesAgo(60),
      staffRows: [{ position: 'Junior Resident', designation: 'Unmapped designation' }],
    },
    {
      number: 8000002,
      role: 'ANESTHETIST',
      lastSignInAt: minutesAgo(60, 1),
      staffRows: [{ position: 'Consultant', designation: 'Unmapped designation' }],
    },
    {
      number: 8000003,
      role: 'ANESTHETIST',
      lastSignInAt: minutesAgo(4),
      staffRows: [{ position: 'Consultant', designation: 'Unmapped designation', onLeave: true }],
    },
    {
      number: 8000004,
      role: 'ANESTHETIST',
      lastSignInAt: null,
      staffRows: [{ position: 'Consultant', designation: 'Unmapped designation' }],
    },
    {
      number: 8000005,
      role: 'ANESTHETIST',
      lastSignInAt: minutesAgo(1),
      staffRows: [{ position: null, designation: null }],
    },
    {
      number: 8000006,
      role: 'ANESTHETIST',
      lastSignInAt: minutesAgo(2),
      staffRows: [{ position: '   ', designation: '   ' }],
    },
    {
      number: 8000007,
      role: 'ANESTHETIST',
      lastSignInAt: minutesAgo(3),
      staffRows: [{ position: 'Unknown grade', designation: 'Unknown title' }],
    },
    {
      // The duplicate-source candidate. This used to be TWO staff rows for one
      // user, which migration 669 made unrepresentable: it adds
      // `ux_staff_tenant_user_identity` UNIQUE (tenant_id, user_id) so payroll
      // cannot pick salary metadata from an ambiguous staff identity on a money
      // path, and it hard-fails the migration if such rows already exist.
      //
      // The invariant this test defends is unchanged and still exercised. The
      // resolver collapses a candidate through a LEFT JOIN LATERAL aggregate
      // (COALESCE(MIN(...) FILTER position, MIN(...) FILTER designation)), and
      // the multiplicity that aggregate has to survive is now mapping matches
      // rather than staff rows: one staff row whose position AND designation
      // both resolve to a configured rank. effective_rank is identical either
      // way — position is authoritative, so this candidate is still rank 1 and
      // still sorts first — and it must still appear exactly once.
      number: 8000008,
      role: 'ANESTHETIST',
      lastSignInAt: minutesAgo(0, 30_000),
      staffRows: [
        { position: 'Consultant', designation: 'Doctor' },
      ],
    },
    {
      number: 8000009,
      role: 'ANESTHETIST',
      lastSignInAt: minutesAgo(1, 30_000),
      staffRows: [{ position: 'Cross Tenant Chief', designation: 'Unmapped designation' }],
    },
    {
      number: 8000012,
      role: 'ANESTHETIST',
      lastSignInAt: minutesAgo(2, 30_000),
      staffRows: [{ position: 'Unranked tie', designation: 'Unranked tie' }],
    },
    {
      number: 8000013,
      role: 'ANESTHETIST',
      lastSignInAt: minutesAgo(2, 30_000),
      staffRows: [{ position: 'Unranked tie', designation: 'Unranked tie' }],
    },
    {
      number: 8000010,
      role: 'CNO',
      lastSignInAt: minutesAgo(4),
      staffRows: [{ position: 'Junior Resident', designation: 'Unmapped designation' }],
    },
    {
      number: 8000011,
      role: 'CNO',
      lastSignInAt: null,
      staffRows: [{ position: 'Consultant', designation: 'Unmapped designation' }],
    },
  ];
  for (const row of rows) await seedOrderingUser(row);
}

d('Escalation recipient tenant ranking (deep, 600-doctor cohort)', () => {
  beforeAll(async () => {
    expect(CAP).toBe(500);
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status)
       VALUES ($1::uuid, $2::text, 'Ranked recipient proof', 'IN', 'DPDP', 'active'),
              ($3::uuid, $4::text, 'Ranked recipient cross-tenant decoy', 'IN', 'DPDP', 'active')`,
      TENANT_RANKED,
      `ranked-recipient-${SUFFIX}`,
      TENANT_DECOY,
      `ranked-recipient-decoy-${SUFFIX}`,
    );
    await seedRankedDoctorCohort();
    await seedRankVisibilityRoles();
    await seedOrderingProofs();
    const owner = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
    await owner.connect();
    try {
      await owner.query(
        `INSERT INTO escalation_recipient_rank_mappings
           (tenant_id, source_kind, source_value, normalized_source_value, priority_rank)
         VALUES ($1::uuid, 'position', 'Cross Tenant Chief', 'cross tenant chief', 1)`,
        [TENANT_DECOY],
      );
    } finally {
      await owner.end();
    }
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, HOOK_TIMEOUT_MS);

  test('never-configured and explicitly empty controls use byte-identical legacy paging', async () => {
    const neverConfigured = await getEscalationRecipientRankings(TENANT_RANKED);
    expect(neverConfigured).toMatchObject({
      configured: false,
      explicitEmpty: false,
      expectedMappingCount: 0,
      mappings: [],
    });
    const before = await resolveInTenant(TENANT_RANKED, 'DOCTOR', RANK_CLOCK);
    expect(before).toHaveLength(CAP);

    const empty = await replaceEscalationRecipientRankings({
      tenantId: TENANT_RANKED,
      mappings: [],
      presenceWindowMinutes: 720,
      actorUid: rankedUidFor(5000001),
      actorRole: 'SUPER_ADMIN',
      ipAddress: '127.0.0.1',
      userAgent: 'escalation-ranking-deep-test',
    });
    expect(empty).toMatchObject({
      configured: true,
      explicitEmpty: true,
      expectedMappingCount: 0,
      mappings: [],
    });
    const after = await resolveInTenant(TENANT_RANKED, 'DOCTOR', RANK_CLOCK);
    expect(after.map((row) => row.uid)).toEqual(before.map((row) => row.uid));
  }, 60000);

  test('the ranked 600-doctor cap drops exactly the least-reachable configured cohorts', async () => {
    await replaceEscalationRecipientRankings({
      tenantId: TENANT_RANKED,
      mappings: [
        { sourceKind: 'position', sourceValue: 'Consultant', priorityRank: 1 },
        { sourceKind: 'position', sourceValue: 'Doctor', priorityRank: 2 },
        { sourceKind: 'position', sourceValue: 'Junior Resident', priorityRank: 3 },
        { sourceKind: 'designation', sourceValue: 'Consultant', priorityRank: 1 },
        { sourceKind: 'designation', sourceValue: 'Doctor', priorityRank: 2 },
      ],
      presenceWindowMinutes: 720,
      actorUid: rankedUidFor(5000001),
      actorRole: 'SUPER_ADMIN',
      ipAddress: '127.0.0.1',
      userAgent: 'escalation-ranking-deep-test',
    });

    const rankOneBefore = counterValue('vhhealth_escalation_recipients_trimmed_by_rank_total', {
      role: 'DOCTOR', arm: 'exact', rank: '1',
    });
    const unrankedBefore = counterValue('vhhealth_escalation_recipients_trimmed_by_rank_total', {
      role: 'DOCTOR', arm: 'exact', rank: 'unranked',
    });
    const warnSpy = jest.spyOn(logger, 'warn');
    let resolved;
    try {
      resolved = await resolveInTenant(TENANT_RANKED, 'DOCTOR', RANK_CLOCK);
      expect(resolved).toHaveLength(CAP);
      expect(warnSpy).toHaveBeenCalledWith(
        'escalation notify: recipient fan-out exceeded cap — tail of the role was NOT notified',
        expect.objectContaining({
          tenantId: TENANT_RANKED,
          role: 'DOCTOR',
          arm: 'exact',
          matched: 600,
          notified: 500,
          dropped: 100,
          droppedByRank: { 1: 20, unranked: 80 },
          droppedByPresence: { plausibly_present: 0, less_reachable: 100 },
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }

    const resolvedUids = new Set(resolved.map((row) => row.uid));
    for (let n = 1; n <= RANKED_PRESENT_COUNT; n += 1) {
      expect(resolvedUids.has(rankedUidFor(5000000 + n))).toBe(true);
    }
    for (let n = 501; n <= RANKED_COHORT_SIZE; n += 1) {
      expect(resolvedUids.has(rankedUidFor(5000000 + n))).toBe(false);
    }

    expect(counterValue('vhhealth_escalation_recipients_trimmed_by_rank_total', {
      role: 'DOCTOR', arm: 'exact', rank: '1',
    })).toBe(rankOneBefore + 20);
    expect(counterValue('vhhealth_escalation_recipients_trimmed_by_rank_total', {
      role: 'DOCTOR', arm: 'exact', rank: 'unranked',
    })).toBe(unrankedBefore + 80);

    const positionAuthoritative = resolved.findIndex((row) => row.uid === rankedUidFor(5000001));
    const designationFallback = resolved.findIndex((row) => row.uid === rankedUidFor(5000002));
    const recentRankTwo = resolved.findIndex((row) => row.uid === rankedUidFor(5000101));
    expect(positionAuthoritative).toBeLessThan(recentRankTwo);
    expect(designationFallback).toBeLessThan(recentRankTwo);
  }, 120000);

  test('presence override, exact boundary, labels, and duplicate staff preserve every candidate', async () => {
    await replaceEscalationRecipientRankings({
      tenantId: TENANT_RANKED,
      mappings: [
        { sourceKind: 'position', sourceValue: 'Consultant', priorityRank: 1 },
        { sourceKind: 'position', sourceValue: 'Doctor', priorityRank: 2 },
        { sourceKind: 'position', sourceValue: 'Junior Resident', priorityRank: 3 },
        { sourceKind: 'designation', sourceValue: 'Consultant', priorityRank: 1 },
        { sourceKind: 'designation', sourceValue: 'Doctor', priorityRank: 2 },
      ],
      presenceWindowMinutes: 60,
      actorUid: rankedUidFor(5000001),
      actorRole: 'SUPER_ADMIN',
      ipAddress: '127.0.0.1',
      userAgent: 'escalation-ranking-boundary-test',
    });

    const rows = await resolveInTenant(TENANT_RANKED, 'ANESTHETIST', RANK_CLOCK);
    expect(rows).toHaveLength(11);
    expect(new Set(rows.map((row) => row.uid)).size).toBe(11);
    expect(rows.map((row) => row.uid)).toEqual([
      rankedUidFor(8000008),
      rankedUidFor(8000001),
      rankedUidFor(8000005),
      rankedUidFor(8000009),
      rankedUidFor(8000006),
      rankedUidFor(8000012),
      rankedUidFor(8000013),
      rankedUidFor(8000007),
      rankedUidFor(8000003),
      rankedUidFor(8000002),
      rankedUidFor(8000004),
    ]);

    const recentJunior = rows.findIndex((row) => row.uid === rankedUidFor(8000001));
    const onLeaveConsultant = rows.findIndex((row) => row.uid === rankedUidFor(8000003));
    const neverConsultant = rows.findIndex((row) => row.uid === rankedUidFor(8000004));
    const justOutsideConsultant = rows.findIndex((row) => row.uid === rankedUidFor(8000002));
    expect(recentJunior).toBeLessThan(onLeaveConsultant);
    expect(recentJunior).toBeLessThan(neverConsultant);
    expect(recentJunior).toBeLessThan(justOutsideConsultant);
    expect(rows.findIndex((row) => row.uid === rankedUidFor(8000001)))
      .toBeLessThan(rows.findIndex((row) => row.uid === rankedUidFor(8000009)));
  }, 60000);

  test('the family fallback arm uses the same presence-before-rank ordering', async () => {
    const rows = await resolveInTenant(TENANT_RANKED, 'CMO', RANK_CLOCK);
    expect(rows.map((row) => row.uid)).toEqual([
      rankedUidFor(8000010),
      rankedUidFor(8000011),
    ]);
    expect(rows.every((row) => row.role === 'CNO')).toBe(true);
  });

  test('configured but zero ranks resolved is visible without dropping candidates', async () => {
    const before = counterValue('vhhealth_escalation_recipient_ranking_failures_total', {
      role: 'RADIOLOGIST', arm: 'exact', reason: 'zero_ranked_candidates',
    });
    const warnSpy = jest.spyOn(logger, 'warn');
    try {
      const rows = await resolveInTenant(TENANT_RANKED, 'RADIOLOGIST', RANK_CLOCK);
      expect(rows).toHaveLength(3);
      expect(warnSpy).toHaveBeenCalledWith(
        'escalation notify: configured recipient ranking failed visibility check',
        expect.objectContaining({
          tenantId: TENANT_RANKED,
          role: 'RADIOLOGIST',
          arm: 'exact',
          reason: 'zero_ranked_candidates',
          expectedMappingCount: 5,
          observedMappingCount: 5,
          rankedCandidates: 0,
          matched: 3,
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
    expect(counterValue('vhhealth_escalation_recipient_ranking_failures_total', {
      role: 'RADIOLOGIST', arm: 'exact', reason: 'zero_ranked_candidates',
    })).toBe(before + 1);
  });

  test('users with no active staff row remain deterministic candidates', async () => {
    const rows = await resolveInTenant(TENANT_RANKED, 'DUTY_DOCTOR', RANK_CLOCK);
    expect(rows.map((row) => row.uid)).toEqual([
      rankedUidFor(7000011),
      rankedUidFor(7000012),
    ]);
  });

  test('wiped visible mappings emit mapping-count mismatch and zero-ranked signals', async () => {
    const mismatchBefore = counterValue('vhhealth_escalation_recipient_ranking_failures_total', {
      role: 'RADIOLOGIST', arm: 'exact', reason: 'mapping_count_mismatch',
    });
    const zeroBefore = counterValue('vhhealth_escalation_recipient_ranking_failures_total', {
      role: 'RADIOLOGIST', arm: 'exact', reason: 'zero_ranked_candidates',
    });
    const owner = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
    await owner.connect();
    try {
      await owner.query(
        'DELETE FROM escalation_recipient_rank_mappings WHERE tenant_id = $1::uuid',
        [TENANT_RANKED],
      );
    } finally {
      await owner.end();
    }

    const warnSpy = jest.spyOn(logger, 'warn');
    try {
      const rows = await resolveInTenant(TENANT_RANKED, 'RADIOLOGIST', RANK_CLOCK);
      expect(rows).toHaveLength(3);
      for (const reason of ['mapping_count_mismatch', 'zero_ranked_candidates']) {
        expect(warnSpy).toHaveBeenCalledWith(
          'escalation notify: configured recipient ranking failed visibility check',
          expect.objectContaining({
            tenantId: TENANT_RANKED,
            role: 'RADIOLOGIST',
            arm: 'exact',
            reason,
            expectedMappingCount: 5,
            observedMappingCount: 0,
            rankedCandidates: 0,
            matched: 3,
          }),
        );
      }
    } finally {
      warnSpy.mockRestore();
    }
    expect(counterValue('vhhealth_escalation_recipient_ranking_failures_total', {
      role: 'RADIOLOGIST', arm: 'exact', reason: 'mapping_count_mismatch',
    })).toBe(mismatchBefore + 1);
    expect(counterValue('vhhealth_escalation_recipient_ranking_failures_total', {
      role: 'RADIOLOGIST', arm: 'exact', reason: 'zero_ranked_candidates',
    })).toBe(zeroBefore + 1);
  });
});
