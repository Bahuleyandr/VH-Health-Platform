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

const prisma = (await import('../lib/prisma.js')).default;
const { setTenantTx } = await import('../lib/prisma.js');
const { DEFAULT_TENANT_ID } = await import('../services/tenant/tenantService.js');
const { runEscalationSweep, __testing__ } = await import('../services/workflow/escalationEngineService.js');
const { enqueueCriticalResultTask } = await import('../services/results/resultsInboxService.js');
const { serializeEscalationMetrics } = await import('../observability/escalationMetrics.js');
const logger = (await import('../logging/logger.js')).default;

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

// Distinct from every other suite's tenants. The UUID must satisfy
// tenantContextMiddleware's UUID_RE: version nibble [1-5], variant [89ab].
const TENANT = 'd6600000-0000-4000-8000-00000000fa01';
const TENANT_DECOY = 'd6600000-0000-4000-8000-00000000fa02';

// tenants(id) is referenced by ~685 foreign keys, so each tenant DELETE pays a
// check per constraint. Both hooks therefore carry an explicit timeout: jest's 5s
// default is not enough, and a standalone run must not silently depend on the CI
// runner's --testTimeout=60000.
const HOOK_TIMEOUT_MS = 180000;

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

async function resolveInTenant(tenantId, role) {
  return setTenantTx(tenantId, async (tx) => (
    __testing__.resolveRecipientsForRole(tx, tenantId, role)
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

// notificationOutbox.queue() runs on the prisma singleton rather than inside the
// engine's tenant transaction, so these rows carry the DEFAULT tenant no matter
// which tenant owns the task. tasks.id is a global SERIAL, so the task_id
// predicate is already exact.
async function readEscalationOutboxForTask(taskId) {
  return prisma.$queryRawUnsafe(
    `SELECT id, recipient_id, payload
       FROM notification_outbox
      WHERE (payload->>'task_id') = $1::text
        AND (payload->>'kind') = 'results_inbox_escalation'
      ORDER BY id ASC`,
    String(taskId),
  );
}

async function cleanup() {
  // The tier-2/tier-3 notify rows carry patient_uid, but the tier-1 assignee
  // re-notify payload carries assigned_to_uid instead and no patient_uid — match
  // both, or one row per run is left behind on the default tenant forever.
  await prisma.$executeRawUnsafe(
    `DELETE FROM notification_outbox
      WHERE (payload->>'kind') = 'results_inbox_escalation'
        AND (
          (payload->>'patient_uid') IN ($1::text, $2::text)
          OR (payload->>'assigned_to_uid') IN ($3::text, $4::text)
        )`,
    PATIENT_UID, DECOY_PATIENT_UID, DOCTOR_UID, DECOY_DOCTOR_UID,
  ).catch(() => {});

  for (const tenantId of [TENANT, TENANT_DECOY]) {
    await setTenantTx(tenantId, async (tx) => {
      // Replica mode disables the append-only triggers on the canonical clinical
      // tables for this transaction only — confined to the disposable test
      // database and to tenants this suite created.
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      // Children before parents, every statement scoped to this suite's tenant.
      await tx.$executeRawUnsafe(`DELETE FROM task_comments WHERE tenant_id = $1::uuid`, tenantId);
      await tx.$executeRawUnsafe(`DELETE FROM tasks WHERE tenant_id = $1::uuid`, tenantId);
      await tx.$executeRawUnsafe(`DELETE FROM workflow_sla_instances WHERE tenant_id = $1::uuid`, tenantId);
      await tx.$executeRawUnsafe(`DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid`, tenantId);
      await tx.$executeRawUnsafe(`DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid`, tenantId);
      await tx.$executeRawUnsafe(`DELETE FROM event_outbox WHERE tenant_id = $1::uuid`, tenantId);
      await tx.$executeRawUnsafe(`DELETE FROM escalation_rules WHERE tenant_id = $1::uuid`, tenantId);
      await tx.$executeRawUnsafe(`DELETE FROM users WHERE tenant_id = $1::uuid`, tenantId);
    }).catch(() => {});
  }
  // Parent last, and deliberately NOT swallowed. A tenant this suite cannot drop
  // is worse than a leaked row: it keeps ACTIVE escalation rules, so every later
  // sweep in this database would go on visiting it. Unswallowed, the FK error
  // names the exact blocking child table — the most actionable signal available.
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`, TENANT, TENANT_DECOY,
  );
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
