// src/services/tenant/tenantProvisioningRegistry.js
//
// THE DECLARATIVE LIST OF TENANT-SCOPED CONFIG A NEW TENANT INHERITS.
//
// Several config tables are seeded by migrations for the default tenant ONLY —
// either by writing the UUID, or by omitting `tenant_id` entirely, because the
// column default is `COALESCE(app.current_tenant_id, <default tenant>)` and a
// migration runs with that GUC unset. Every reader then filters strictly
// on the requesting tenant, so a second tenant's lookup returns zero rows — and
// a zero-row lookup in this codebase is a SILENT non-match, not an error. The
// 2026-08-23 once-over and the 2026-08-24 tenancy re-audit found the same shape
// five times:
//
//   radiology_tat_thresholds  → TAT dashboards render empty, no breach alerts
//   ap_tat_thresholds         → same, for anatomic pathology
//   lab_critical_thresholds   → a CRITICAL lab result never alerts (HIGH)
//   escalation_rules          → the escalation tiers never fire
//   workflow_sla_rules        → no SLA clock starts, so the tiers above have
//                               nothing to fire against (added 2026-08-24)
//
// FOUR of those five are provisioned by this registry. lab_critical_thresholds
// is deliberately NOT — see "WITHDRAWN: lab_critical_thresholds" below before
// adding it back.
//
// Before this module, `tenantService.createTenant` hand-copied the first two
// and the backfill lived as hand-written SQL in migration 727. A hand-maintained
// copy list is exactly what let the others go missing, so the list now lives
// here, once, and BOTH consumers are generated from it:
//
//   * createTenant             → buildTenantCopySql(entry)     ($1 = new tenant)
//   * the backfill migrations  → buildTenantBackfillSql(entry) (every tenant)
//
// `src/tests/unit/tenantProvisioningRegistry.test.js` is the durable guard: it
// re-derives, from the committed migration SQL plus prisma/schema.prisma, the
// tables that receive a default-tenant-pinned seed, and fails when one is
// neither declared here nor on that test's commented exemption list. Adding a
// new default-tenant seed without deciding whether new tenants inherit it is
// therefore a CI failure, not a silent clinical gap discovered in an audit.
// It reads MIGRATIONS — rows inserted by application code are outside its
// reach, and its own limits are enumerated in that file's header.
//
// ADDING AN ENTRY
//   1. add the declaration below (columns = every column a new tenant should
//      inherit; NEVER the surrogate id, tenant_id, or created_at/updated_at),
//   2. write a backfill migration whose body is buildTenantBackfillSql(entry)
//      for the existing tenants,
//   3. drop the table from the exemption list in the guard test.
//   createTenant picks the entry up with no code change.
//
// ---------------------------------------------------------------------------
// WITHDRAWN: lab_critical_thresholds — do not re-add it here
// ---------------------------------------------------------------------------
//
// This table was a registry entry through two rounds of review and is now
// removed from BOTH consumers: migration 728 no longer backfills it, and
// createTenant no longer copies it into a new tenant. The gap it represents is
// real and is recorded in docs/ROADMAP.md under "Explicitly parked"; what is
// withdrawn is the auto-copy, not the finding.
//
// WHY. Copying the default tenant's rows into another tenant was tried twice
// and tripped a DIFFERENT rejection each time, on the lab RESULT-RECORDING
// path:
//
//   round 1 — a (loinc_code, test_code) `row_key` guard let a copied baseline
//     row sit alongside a tenant's own row for the same analyte under a
//     different key. evaluateCriticalThreshold ranks by LOOKUP KEY, not by
//     analyte, so the two tied at the best rank and it threw
//     LAB_CRITICAL_POLICY_MISMATCH {threshold_ambiguous} — "result was not
//     recorded" (labCriticalThresholdService.js).
//   round 2 — a `table_empty_for_tenant` guard removed that tie and exposed
//     the deeper one: lab_critical_thresholds and lab_reference_ranges are two
//     halves of ONE policy. labPanelService.assertCriticalPolicyAgreement
//     compares the reference-range-derived assessment against the
//     threshold-derived one and throws on any disagreement — `policy_presence`
//     when only one side is configured, `threshold_unit` when the units differ
//     — and evaluateCriticalThreshold has its own `threshold_unit` throw plus
//     assertConfiguredCriticalAnalytesNumeric's NON_NUMERIC_FOR_CRITICAL_THRESHOLD.
//     A tenant that received copied thresholds but keeps its own (or no)
//     reference ranges therefore had lab results REJECTED — in every
//     backfilled tenant, which is worse than the silent non-alert being fixed.
//
// The pattern is not a bug to guard our way out of: each round closed one
// throw and opened another, because a hospital's critical limits and reference
// ranges are clinical policy tied to its analyzers, population and units.
// Deciding that hospital A's potassium limits are safe for hospital B is a
// clinical-governance call with an owner, not an engineering default.
//
// WHAT WAS DONE INSTEAD. The absence is now observable rather than silent:
// evaluateCriticalThreshold counts every zero-row lookup and warns, naming the
// tenant and analyte, when a tenant holds no active thresholds at all
// (observability/labCriticalThresholdMetrics.js). The return contract is
// unchanged and it still does not throw — throwing is the failure mode above.

export const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

/**
 * How a copy avoids duplicating rows the target tenant already has.
 *
 *  - `table_empty_for_tenant`: copy the whole baseline only when the tenant has
 *    no rows at all. Correct for a table whose rows are meaningless piecemeal
 *    (a partial TAT threshold set is not a usable set) — and the shape
 *    migration 727 already shipped.
 *  - `row_key`: copy row-by-row, skipping the ones the tenant already has under
 *    the declared key. Comparison is NULL-safe (`IS NOT DISTINCT FROM`) because
 *    these key columns are nullable.
 *
 * CHOOSING BETWEEN THEM. `row_key` is correct only when the declared key is the
 * key the READER uses, and something outside this file keeps the two from
 * drifting — a unique constraint, or a reader that literally selects on those
 * columns. Where the reader matches on an expanded or aliased key set, a
 * row_key guard has to mirror a matcher to stay correct, which is the same
 * class of trap as the hand-maintained copy list this registry replaced. Prefer
 * `table_empty_for_tenant` there and accept under-provisioning.
 *
 * NEITHER GUARD RESCUES A TABLE THE READER CROSS-CHECKS AGAINST ANOTHER TABLE.
 * That is what withdrew lab_critical_thresholds (see the header): no guard
 * expressible here can make a copied row agree with a reference-range row the
 * copy does not touch. When a candidate table has such a partner, the answer is
 * an owner decision, not a third guard kind.
 *
 * `row_key` is not always backed by a unique constraint (escalation_rules has
 * none), which is why the guard is a NOT EXISTS predicate rather than an
 * ON CONFLICT target.
 */
export const PROVISIONING_GUARD_KINDS = Object.freeze({
  TABLE_EMPTY: 'table_empty_for_tenant',
  ROW_KEY: 'row_key',
});

/**
 * A `row_key` guard key is a copied column name, optionally with ONE jsonb text
 * extraction: `display_name` renders as `x.display_name`, and
 * `match_filter->>'sla_key'` renders as `(x.match_filter->>'sla_key')`. The
 * jsonb form exists because an escalation tier's semantic identity lives inside
 * two jsonb columns rather than in scalar ones.
 */
const GUARD_KEY_RE = /^([a-z_][a-z0-9_]*)(->>'[a-z0-9_]+')?$/;

/**
 * The copied column a guard key reads, so callers (and the guard test) can
 * check the key against `entry.columns`.
 *
 * @param {string} key
 * @returns {string}
 */
export function guardKeyBaseColumn(key) {
  const parsed = GUARD_KEY_RE.exec(String(key));
  if (!parsed) throw new TypeError(`unsupported guard key: ${key}`);
  return parsed[1];
}

function guardKeyExpression(alias, key) {
  const parsed = GUARD_KEY_RE.exec(String(key));
  if (!parsed) throw new TypeError(`unsupported guard key: ${key}`);
  return parsed[2] ? `(${alias}.${parsed[1]}${parsed[2]})` : `${alias}.${parsed[1]}`;
}

/**
 * @typedef {Object} TenantProvisioningEntry
 * @property {string}   table          tenant-scoped config table
 * @property {string[]} columns        columns copied verbatim from the default tenant
 * @property {string[]} guardKeyColumns  `row_key` guards only; [] for table-empty
 * @property {string}   guardKind      one of PROVISIONING_GUARD_KINDS
 * @property {string|null} conflictTarget  `ON CONFLICT (…)` columns, or null for a bare
 *                                      `ON CONFLICT DO NOTHING`
 * @property {string}   seededBy       migrations that seeded the default tenant
 * @property {string}   backfilledBy   migration that backfilled existing tenants
 * @property {string}   why            what silently breaks without the rows
 */

/** @type {ReadonlyArray<TenantProvisioningEntry>} */
export const TENANT_PROVISIONING_REGISTRY = Object.freeze([
  Object.freeze({
    table: 'radiology_tat_thresholds',
    columns: Object.freeze([
      'priority', 'modality', 'target_minutes', 'warning_minutes',
      'critical_minutes', 'metadata',
    ]),
    guardKind: PROVISIONING_GUARD_KINDS.TABLE_EMPTY,
    guardKeyColumns: Object.freeze([]),
    // No unique constraint to target; 727 and createTenant both shipped a bare
    // ON CONFLICT DO NOTHING here. Kept byte-identical on purpose.
    conflictTarget: null,
    seededBy: '377_radiology_tat_metrics.sql',
    backfilledBy: '727_tat_threshold_tenant_provisioning.sql',
    why: 'the radiology_tat_metrics view drops orders with no threshold row, so '
      + 'TAT dashboards render empty and RADIOLOGY_TAT_BREACH never fires',
  }),
  Object.freeze({
    table: 'ap_tat_thresholds',
    columns: Object.freeze(['case_kind', 'priority', 'target_hours', 'is_active']),
    guardKind: PROVISIONING_GUARD_KINDS.TABLE_EMPTY,
    guardKeyColumns: Object.freeze([]),
    conflictTarget: 'tenant_id, case_kind, priority',
    seededBy: '385_ap_reports_addenda_tat.sql',
    backfilledBy: '727_tat_threshold_tenant_provisioning.sql',
    why: 'anatomic-pathology TAT metrics and breach detection have nothing to '
      + 'measure against',
  }),
  // lab_critical_thresholds sat here through rounds 1 and 2 and was WITHDRAWN
  // on 2026-08-24. The reasoning is in the header block above; the remaining
  // gap is in docs/ROADMAP.md. Do not re-add it without the clinical sign-off
  // that block names.
  // escalation_rules sat here and was WITHDRAWN on 2026-08-24, for a reason
  // adjacent to the lab_critical_thresholds one above but not identical.
  //
  // Copying operator-authored rules across tenants cannot be keyed safely: a
  // key on the semantic tier identity is BOTH too coarse and too narrow. It
  // omits match_filter.task_kind and match_filter.priority, which
  // buildEligibilitySql really matches on — so a tenant holding a rule for one
  // task kind is silently denied the platform tier for the others — while the
  // NOT EXISTS compares source rows only against the TARGET tenant's rows and
  // never against each other, so one operator's duplicate tier on the default
  // tenant is amplified into EVERY tenant (reproduced on a scratch DB).
  // Copied tiers also carry notify_role DUTY/LEADERSHIP, which resolve against
  // `users` — a table this registry does not provision — so a tenant with
  // nobody in the role family gets ESCALATION_DURABLE_ENQUEUE_UNCONFIRMED, and
  // dispatchAction pages the security webhook directly rather than merely
  // queueing an intent.
  //
  // Unlike lab_critical_thresholds there IS an operator path — PUT
  // /api/v1/admin/workflow/escalation-rules (taskService.upsertEscalationRule)
  // — so a tenant can configure its own tiers. What was genuinely broken was
  // the SWEEP: it discovered its tenant set FROM this table, so a rule-less
  // tenant also lost the open->overdue pass and the orphan-SLA backstop. That
  // is fixed in escalationEngineService.js and needs no copy. Coverage is
  // reported by the canary check instead.
  Object.freeze({
    table: 'workflow_sla_rules',
    // enabled is copied, not defaulted on: a rule the platform baseline
    // deliberately disabled must not come back on for the target tenant.
    // created_at/updated_at are the target tenant's own clocks.
    columns: Object.freeze([
      'rule_code', 'title', 'trigger_event_type', 'target_minutes', 'severity',
      'owner_role_codes', 'escalation_role_codes', 'enabled', 'metadata',
    ]),
    // Round-1 flagged this table and it stayed on the guard test's unresolved
    // list. Verified 2026-08-24: 269 and 393 omit tenant_id entirely (so the
    // column DEFAULT lands them on the default tenant — migrations run with no
    // app.current_tenant_id GUC) and 377/414 pin the literal. Meanwhile every
    // reader resolves `(tenant_id = $1::uuid OR tenant_id IS NULL)` with a
    // tenant-first ORDER BY (canonicalClinicalPlatformService.js:1156-1161,
    // pathwayRuntimePersistence.js:441-447). A default-tenant-PINNED row is
    // therefore invisible to every other tenant — the same defect as the two
    // entries above. Migrations 456/641/677 show the shape those four should
    // have used: `tenant_id NULL`, which every tenant already resolves.
    //
    // Registered rather than left undecided, because the consequence is not
    // only a silent gap. pathwayRuntimePersistence THROWS
    // `Pathway SLA rule is unavailable: <code>` when a required rule_code
    // resolves to nothing; and with no rule, startWorkflowSla returns null, so
    // no workflow_sla_instances row exists — which makes the critical-result,
    // cold-chain and mortuary tiers backfilled by the entry above unable to
    // match anything, since their match_filter.sla_key is compared against
    // workflow_sla_instances.rule_code.
    //
    // row_key is sound here for the three reasons the guard-kind docblock
    // above asks for: rule_code IS the reader's entire lookup key, the reader
    // takes LIMIT 1 and never reports an ambiguity, and
    // idx_workflow_sla_rules_tenant_code (269:148-149) makes a second row for
    // the same (tenant, rule_code) impossible — so this guard cannot drift from
    // what the reader does. No second table has to agree with this one either.
    guardKind: PROVISIONING_GUARD_KINDS.ROW_KEY,
    guardKeyColumns: Object.freeze(['rule_code']),
    // The unique index is on an EXPRESSION, so the inference clause has to
    // repeat it verbatim; `ON CONFLICT (tenant_id, rule_code)` matches no index.
    conflictTarget: "(COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), rule_code",
    seededBy: '269_canonical_clinical_platform.sql + 377_radiology_tat_metrics.sql '
      + '+ 393_cold_chain_alerting.sql + 414_body_custody_events.sql',
    backfilledBy: '728_tenant_config_provisioning_backfill.sql',
    why: 'no SLA clock starts for that tenant, so referral response, critical-result '
      + 'acknowledgement, bed turnaround, discharge blockers, radiology TAT, cold-chain '
      + 'and mortuary custody are unmeasured and the escalation tiers have nothing to '
      + 'fire against; the pathway runtime throws outright',
  }),
]);

export const TENANT_PROVISIONED_TABLES = Object.freeze(
  TENANT_PROVISIONING_REGISTRY.map(entry => entry.table),
);

function assertEntry(entry) {
  if (!entry || typeof entry.table !== 'string' || !entry.table) {
    throw new TypeError('tenant provisioning entry must declare a table');
  }
  if (!Array.isArray(entry.columns) || entry.columns.length === 0) {
    throw new TypeError(`${entry.table}: tenant provisioning entry must declare columns`);
  }
  if (entry.columns.includes('tenant_id')) {
    throw new TypeError(`${entry.table}: tenant_id is supplied by the copy, not declared`);
  }
  if (entry.guardKind === PROVISIONING_GUARD_KINDS.ROW_KEY) {
    if (!Array.isArray(entry.guardKeyColumns) || entry.guardKeyColumns.length === 0) {
      throw new TypeError(`${entry.table}: a row_key guard needs guardKeyColumns`);
    }
    for (const key of entry.guardKeyColumns) {
      // guardKeyBaseColumn throws on anything but `col` / `col->>'json_key'`,
      // which keeps an arbitrary SQL fragment out of the generated predicate.
      const column = guardKeyBaseColumn(key);
      if (!entry.columns.includes(column)) {
        throw new TypeError(`${entry.table}: guard key ${key} reads an uncopied column`);
      }
    }
  }
}

function guardPredicate(entry, targetTenantExpr) {
  if (entry.guardKind === PROVISIONING_GUARD_KINDS.ROW_KEY) {
    const keys = entry.guardKeyColumns
      .map(key => `\n        AND ${guardKeyExpression('x', key)} IS NOT DISTINCT FROM `
        + `${guardKeyExpression('d', key)}`)
      .join('');
    return `AND NOT EXISTS (\n     SELECT 1 FROM ${entry.table} x\n      WHERE x.tenant_id = ${targetTenantExpr}${keys}\n   )`;
  }
  return `AND NOT EXISTS (\n     SELECT 1 FROM ${entry.table} x WHERE x.tenant_id = ${targetTenantExpr}\n   )`;
}

function onConflict(entry) {
  return entry.conflictTarget
    ? `ON CONFLICT (${entry.conflictTarget}) DO NOTHING`
    : 'ON CONFLICT DO NOTHING';
}

function selectList(entry, tenantExpr) {
  return [tenantExpr, ...entry.columns.map(col => `d.${col}`)].join(', ');
}

/**
 * Copy the default tenant's baseline rows for ONE registry entry into ONE
 * tenant. Parameterised: bind the target tenant id as $1.
 *
 * Used by tenantService.createTenant. Idempotent — safe to re-run for a tenant
 * that already has rows (the guard skips them).
 *
 * @param {TenantProvisioningEntry} entry
 * @returns {string} SQL taking exactly one parameter ($1 = target tenant uuid)
 */
export function buildTenantCopySql(entry) {
  assertEntry(entry);
  return `INSERT INTO ${entry.table}
  (tenant_id, ${entry.columns.join(', ')})
SELECT ${selectList(entry, '$1::uuid')}
  FROM ${entry.table} d
 WHERE d.tenant_id = '${DEFAULT_TENANT_ID}'::uuid
   ${guardPredicate(entry, '$1::uuid')}
${onConflict(entry)}`;
}

/**
 * Copy the default tenant's baseline rows for ONE registry entry into EVERY
 * other existing tenant. This is the body a backfill migration carries — the
 * shape migration 727 established, generated instead of retyped.
 *
 * @param {TenantProvisioningEntry} entry
 * @returns {string} standalone SQL statement (no parameters, terminated by `;`)
 */
export function buildTenantBackfillSql(entry) {
  assertEntry(entry);
  return `INSERT INTO ${entry.table}
  (tenant_id, ${entry.columns.join(', ')})
SELECT ${selectList(entry, 't.id')}
  FROM tenants t
 CROSS JOIN ${entry.table} d
 WHERE d.tenant_id = '${DEFAULT_TENANT_ID}'::uuid
   AND t.id <> '${DEFAULT_TENANT_ID}'::uuid
   ${guardPredicate(entry, 't.id')}
${onConflict(entry)};`;
}

export default {
  DEFAULT_TENANT_ID,
  PROVISIONING_GUARD_KINDS,
  TENANT_PROVISIONING_REGISTRY,
  TENANT_PROVISIONED_TABLES,
  guardKeyBaseColumn,
  buildTenantCopySql,
  buildTenantBackfillSql,
};
