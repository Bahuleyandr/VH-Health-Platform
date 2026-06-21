// Deep tenant-isolation regression for the drug-chart SLA sweep fan-out
// (platform audit 2026-06-18, §3 Multi-tenancy).
//
// ROOT CAUSE this test pins:
//   runMissingDrugChartSweep detects candidate admissions tenant-internally
//   (each row carries its true tenant_id), but the *recipient resolution*
//   queries used to be role-only with NO tenant filter, and the notifications
//   INSERT omitted tenant_id. Under the super-admin cron context the GUC is
//   'bypass', so:
//     * findRosterNurseRecipients / findNursingInchargeFallbackRecipients could
//       page a nurse / in-charge belonging to a DIFFERENT tenant, and
//     * the inserted notifications rows fell back to the GUC-reading column
//       DEFAULT, i.e. the LITERAL default tenant — not the admission's tenant.
//
// THE FIX (proven here end-to-end against the real QA Postgres):
//   * recipient resolution is filtered by the admission's users.tenant_id
//     (roster nurses + in-charge fallback + doctors), and
//   * insertDrugChartNotifications writes the admission's tenant_id explicitly
//     AND scopes the recipient sub-select by u.tenant_id, wrapped in
//     setTenantTx(admission.tenant_id) so the GUC/WITH-CHECK match.
//
// This file is self-isolating: it seeds its own two NON-DEFAULT tenants, its
// own users (globally-unique phones), and its own published nursing roster,
// then cleans every row up in afterAll. It exercises the recipient + insert
// layer directly with a synthetic admission object (the exact shape the
// candidate-detection query returns), so it needs no admissions/beds/wards
// fixtures and does not depend on RLS being force-enabled for the test role.

import prisma, { setTenant } from '../lib/prisma.js';
import {
  resolveDrugChartAlertRecipients,
  processMissingDrugChartAdmission,
  DRUG_CHART_MISSING_ALERT_TYPE,
  DRUG_CHART_MISSING_AUDIT_ACTION,
} from '../services/clinical/drugChartSlaService.js';

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const describeIfDb = hasDatabaseUrl ? describe : describe.skip;

// Deliberately NON-default tenants. The literal column DEFAULT on notifications
// is '00000000-0000-4000-8000-000000000001'; using a different uuid for tenant
// A makes "the row carries tenant A, not the literal default" a real assertion.
const TENANT_A = '00000000-0000-4000-8000-00000000dc1a';
const TENANT_B = '00000000-0000-4000-8000-00000000dc1b';
const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';

const SLUG_A = 'dcsla-iso-tenant-a';
const SLUG_B = 'dcsla-iso-tenant-b';

// A shared ward identity both tenants' nurses are rostered against, to prove the
// isolation comes from tenant_id and not from a ward mismatch.
const SHARED_WARD_ID = 970101;
const SHARED_WARD_NAME = 'DCSLA-ISO Ward Shared';
// A second ward with NO roster nurse, to force the in-charge fallback path.
const EMPTY_WARD_ID = 970102;
const EMPTY_WARD_NAME = 'DCSLA-ISO Ward Empty';

// Globally-unique phones (users.phone has a UNIQUE constraint).
const PHONE = {
  nurseA: '9700000001',
  nurseB: '9700000002',
  inchargeA: '9700000003',
  inchargeB: '9700000004',
};

const TAG = 'dcsla-iso';

async function exec(text, params = []) {
  return prisma.$executeRawUnsafe(text, ...params);
}
async function query(text, params = []) {
  const rows = await prisma.$queryRawUnsafe(text, ...params);
  return Array.isArray(rows) ? rows : [];
}

// Created-id bookkeeping so teardown is exact and order-safe.
const created = {
  userIds: [],
  rosterBoardIds: [],
};

async function seedTenant(id, slug) {
  await exec(
    `INSERT INTO tenants (id, slug, name, status)
     VALUES ($1::uuid, $2, $3, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [id, slug, `DCSLA ISO ${slug}`],
  );
}

async function seedUser({ tenantId, phone, role, name }) {
  // Explicit tenant_id (not the GUC default) so the user truly belongs to the
  // intended tenant regardless of session GUC state.
  const rows = await query(
    `INSERT INTO users (phone, name, role, is_active, tenant_id, updated_at)
     VALUES ($1, $2, $3, true, $4::uuid, NOW())
     RETURNING id, uid`,
    [phone, name, role, tenantId],
  );
  created.userIds.push(rows[0].id);
  return rows[0];
}

async function seedRosterNurse({ tenantId, staffId, localDate }) {
  // One published nursing board + a ward assignment for this staff member on the
  // SHARED ward. A full-day shift window guarantees the "current shift" predicate
  // matches whatever local time the test runs at.
  const board = await query(
    `INSERT INTO staff_shift_roster_boards
       (department, roster_date, shift_label, shift_start, shift_end, status)
     VALUES ('nursing', $1::date, $2, '00:00:00'::time, '23:59:59'::time, 'published')
     RETURNING id`,
    [localDate, `${TAG}-${staffId}`],
  );
  const boardId = board[0].id;
  created.rosterBoardIds.push(boardId);
  await exec(
    `INSERT INTO staff_shift_roster_assignments
       (roster_id, staff_id, assignment_target_type, assignment_target_id,
        assignment_target_label, is_lead, status)
     VALUES ($1, $2, 'ward', $3, $4, false, 'published')`,
    [boardId, staffId, SHARED_WARD_ID, SHARED_WARD_NAME],
  );
}

function admission(overrides = {}) {
  // Mirrors the row shape findAdmissionsMissingDrugChart returns.
  return {
    admission_id: 970900,
    tenant_id: TENANT_A,
    patient_uid: '00000000-0000-4000-8000-0000000a1100',
    encounter_id: null,
    admitting_doctor: null,
    attending_doctor: null,
    admitted_at: '2026-05-29T03:30:00.000Z',
    ward_arrived_at: '2026-05-29T03:30:00.000Z',
    bed_id: null,
    bed_number: 'DCSLA-ISO-1',
    ward_id: SHARED_WARD_ID,
    ward_name: SHARED_WARD_NAME,
    patient_name: 'DCSLA ISO Patient',
    minutes_since_ward_arrival: 75,
    ...overrides,
  };
}

async function cleanup() {
  // notifications + audit rows this suite produced (keyed by the synthetic
  // admission ids / recipient users), then roster, then users, then tenants.
  await exec(
    `DELETE FROM notifications WHERE related_id IN ($1::int, $2::int) AND type = $3`,
    [970900, 970901, DRUG_CHART_MISSING_ALERT_TYPE],
  ).catch(() => {});
  if (created.userIds.length) {
    await exec(
      `DELETE FROM notifications WHERE user_id = ANY($1::int[])`,
      [created.userIds],
    ).catch(() => {});
  }
  await exec(
    `DELETE FROM audit_logs
      WHERE action = $1 AND resource = 'admission'
        AND resource_id IN ('970900', '970901')`,
    [DRUG_CHART_MISSING_AUDIT_ACTION],
  ).catch(() => {});
  if (created.rosterBoardIds.length) {
    // assignments cascade on board delete (FK onDelete: Cascade).
    await exec(
      `DELETE FROM staff_shift_roster_boards WHERE id = ANY($1::int[])`,
      [created.rosterBoardIds],
    ).catch(() => {});
  }
  if (created.userIds.length) {
    await exec(`DELETE FROM users WHERE id = ANY($1::int[])`, [created.userIds]).catch(() => {});
  }
  await exec(`DELETE FROM tenants WHERE slug IN ($1, $2)`, [SLUG_A, SLUG_B]).catch(() => {});
}

describeIfDb('Drug-chart SLA sweep tenant isolation (audit 2026-06-18 §3)', () => {
  let nurseA;
  let nurseB;
  let inchargeA;
  let inchargeB;

  beforeAll(async () => {
    await cleanup(); // belt-and-braces against a prior aborted run
    await seedTenant(TENANT_A, SLUG_A);
    await seedTenant(TENANT_B, SLUG_B);

    nurseA = await seedUser({ tenantId: TENANT_A, phone: PHONE.nurseA, role: 'ICU_NURSE', name: 'Tenant-A Nurse' });
    nurseB = await seedUser({ tenantId: TENANT_B, phone: PHONE.nurseB, role: 'ICU_NURSE', name: 'Tenant-B Nurse' });
    inchargeA = await seedUser({ tenantId: TENANT_A, phone: PHONE.inchargeA, role: 'NURSING_INCHARGE', name: 'Tenant-A Incharge' });
    inchargeB = await seedUser({ tenantId: TENANT_B, phone: PHONE.inchargeB, role: 'NURSING_INCHARGE', name: 'Tenant-B Incharge' });

    // Local (Postgres-server tz) date — avoids the UTC/IST midnight drift the
    // backend CLAUDE.md warns about.
    const [{ local_date: localDate }] = await query(`SELECT CURRENT_DATE::text AS local_date`);

    // BOTH nurses rostered on the SAME shared ward (same id + label). Only the
    // tenant filter can keep them apart.
    await seedRosterNurse({ tenantId: TENANT_A, staffId: nurseA.id, localDate });
    await seedRosterNurse({ tenantId: TENANT_B, staffId: nurseB.id, localDate });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('resolves roster nurses for the admission tenant only (tenant-B nurse excluded despite same ward)', async () => {
    const recipients = await resolveDrugChartAlertRecipients({
      admission: admission(),
      now: new Date(),
    });
    const ids = recipients.map((r) => r.id);

    // Tenant-A nurse selected; tenant-B nurse on the identical ward is NOT.
    expect(ids).toContain(nurseA.id);
    expect(ids).not.toContain(nurseB.id);

    // Every resolved recipient is a tenant-A user (defense-in-depth assertion).
    const recipientTenants = await query(
      `SELECT DISTINCT tenant_id::text AS tenant_id FROM users WHERE id = ANY($1::int[])`,
      [ids],
    );
    expect(recipientTenants.every((r) => r.tenant_id === TENANT_A)).toBe(true);
  });

  it('scopes the nursing-incharge fallback to the admission tenant (tenant-B incharge excluded)', async () => {
    // EMPTY ward → no roster nurse → fallback in-charge path fires.
    const recipients = await resolveDrugChartAlertRecipients({
      admission: admission({ admission_id: 970901, ward_id: EMPTY_WARD_ID, ward_name: EMPTY_WARD_NAME }),
      now: new Date(),
    });
    const ids = recipients.map((r) => r.id);
    const kinds = recipients.map((r) => r.recipient_kind);

    // Fallback actually engaged, and only tenant A's in-charge was paged.
    expect(kinds).toContain('nursing_incharge_fallback');
    expect(ids).toContain(inchargeA.id);
    expect(ids).not.toContain(inchargeB.id);
  });

  it('inserts notifications carrying the admission tenant_id (not the literal default, not the other tenant)', async () => {
    const adm = admission();
    // processMissingDrugChartAdmission runs the tenant-scoped notification INSERT
    // first, then a SEPARATE audit-log INSERT. Both must now succeed: the audit
    // INSERT's action param (used both as a SELECT value AND in `WHERE action = $2`)
    // is cast `$2::varchar` at both usages, so it no longer trips Postgres 42P08
    // "inconsistent types deduced for parameter $2". The call must therefore
    // complete without throwing and return a real audit row id.
    const result = await processMissingDrugChartAdmission({ admission: adm, now: new Date() });
    expect(result.audit_id).not.toBeNull();

    // Read back every notification this admission produced. setTenant with the
    // admission tenant is the canonical scoped read; it also proves the rows are
    // visible under the correct tenant GUC.
    const rows = await setTenant(TENANT_A, (tx) => tx.$queryRawUnsafe(
      `SELECT n.id, n.user_id, n.tenant_id::text AS tenant_id
         FROM notifications n
        WHERE n.related_id = $1::int AND n.type = $2`,
      adm.admission_id,
      DRUG_CHART_MISSING_ALERT_TYPE,
    ));

    expect(rows.length).toBeGreaterThanOrEqual(1);
    // Core assertion: every inserted row carries the admission's true tenant.
    expect(rows.every((r) => r.tenant_id === TENANT_A)).toBe(true);
    // It is NOT the GUC-default-fallback (literal default) tenant.
    expect(rows.some((r) => r.tenant_id === DEFAULT_TENANT)).toBe(false);
    // And the tenant-B nurse never received a notification for this admission.
    expect(rows.some((r) => r.user_id === nurseB.id)).toBe(false);
    // The tenant-A nurse did.
    expect(rows.some((r) => r.user_id === nurseA.id)).toBe(true);
  });
});

if (!hasDatabaseUrl) {
  console.warn(
    'drugChartSlaTenantIsolation.deep.test.js skipped: neither DATABASE_URL nor TEST_DATABASE_URL is set.',
  );
}
