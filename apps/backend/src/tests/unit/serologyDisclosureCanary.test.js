/**
 * SEROLOGY DISCLOSURE CANARY — the standing gate for a class this branch has
 * already been caught by twice.
 *
 * THE CLASS. A row's `metadata` (or an item's values) reaches a role union far
 * wider than the serology audience because the response is served through a
 * generic `Success` schema that declares nothing about what is inside it:
 *
 *   1. GET /api/v1/cath-lab/cases/:id/readiness/labs sits behind the cath
 *      REPORT-READ gate, which admits RECEPTIONIST and TECHNICIAN, and returned
 *      `items[].value_text` for hiv/hbsag/hcv — plus `is_critical` and the bare
 *      code in `critical_items`, which on a qualitative marker ARE the result.
 *      Fixed with cathLabReadinessProjection.js, applied on that GET and on
 *      GET /cases/:id (which carries the same items twice: once in
 *      `lab_readiness`, once verbatim in the labs check's
 *      `metadata.live_evidence`).
 *   2. stemiPathwayService.getActivationTx returned the cath
 *      `cath_lab_readiness_checks` rows whole inside `primary_pci_evidence`,
 *      under STEMI_ROUTE_ROLES — wider again (LAB_STAFF, RADIOLOGIST). Fixed in
 *      7dd54906b with readinessWithoutLabEvidence.
 *
 * BOTH WERE FOUND BY A HUMAN READING THE DIFF. Nothing in the suite would have
 * caught a third: cathLabRouteGuards pins the wiring without running a handler,
 * cathDeviceReuseSurfaceEnforcement pins the two surfaces it knows about, and
 * stemiPathwayService.test pins the one service function it knows about. Each
 * is a list of places someone already thought of.
 *
 * SO THIS SUITE DOES NOT HOLD A LIST. It poisons the persistence layer with a
 * sentinel serology value, WALKS every router's stack to enumerate every GET
 * that exists today, requests each one as EVERY role the platform's role policy
 * knows about, and fails if the sentinel — or a serology item's criticality, or
 * its name in a `critical_items` list — comes back in ANY 2xx body to a role
 * that is not entitled to serology detail. A new GET route added anywhere on
 * these mounts is enumerated the moment it is declared; the author does not
 * have to remember this file exists.
 *
 * NEITHER POPULATION IS NAMED HERE, because naming them is what turns a class
 * into two instances. RECEPTIONIST and TECHNICIAN were the roles someone
 * happened to be looking at; the third leak will be a role nobody is thinking
 * about, added to one of these unions months from now.
 *
 *   ENTITLED  — derived from roleSeesSerologyDetail(), the ONE predicate the
 *               projection itself asks (cathDeviceReuseService.js), applied to
 *               the canonical role list the route-policy validators assert
 *               against (rolePolicyGraph.getRolePolicyRoleCodes). Derived, but
 *               PINNED below to a written allow-list: widening the serology
 *               audience must be a reviewed decision, not a side effect of
 *               editing a capability group three files away.
 *   REACHABLE — derived EMPIRICALLY, per route: the roles that actually answer
 *               2xx. Not read off a role constant, because the mount gate, the
 *               per-route roleGuard and the handler's own refusals all narrow
 *               it, and only running them says by how much.
 *
 * The property is then asserted for every role in `reachable − ENTITLED`, per
 * route. That remainder is the class.
 *
 * WHY THE REACHABLE SET IS SNAPSHOTTED. A 2xx-derived population can SHRINK
 * silently — a rotted fixture, a new 500, a tightened validator — leaving fewer
 * roles under test and a green run that proves less than it claims. The
 * derivation is therefore compared in BOTH directions against
 * src/tests/fixtures/serologyDisclosureCanary.reachable.json, and a difference
 * either way is a failure that says which direction it went.
 *
 * REGENERATING THAT SNAPSHOT IS DELIBERATE — from apps/backend:
 *
 *   CANARY_WRITE_SNAPSHOT=1 node --experimental-vm-modules \
 *     node_modules/jest/bin/jest.js --runInBand \
 *     --testPathPatterns serologyDisclosureCanary
 *
 * That rewrites the fixture AND THEN FAILS, so the flag can never be left on in
 * CI: a run that regenerates is never a run that passes. Read the diff before
 * committing it. A set that GREW means a role gained access to that route — the
 * canary already asserts the property for it, so accept the line knowingly. A
 * set that SHRANK is either an intentional tightening or a fixture that rotted,
 * and the two look identical from here.
 *
 * WHAT IS REAL AND WHAT IS STUBBED. The routers, their mount role gates, their
 * per-route role guards, cathLabService, cathLabReadinessService,
 * stemiPathwayService, cathDeviceReuseService and the projection module are all
 * REAL — the point is to drive the builders that assemble these responses, not
 * a fixture of what someone thinks they assemble. Only the database, the PHI
 * audit sink, the tenant resolver, the idempotency claim and the per-route
 * patient guards are stubbed. The patient guards in particular are neutralised
 * deliberately: they are pinned in cathLabRouteGuards, and leaving them live
 * would answer 403 everywhere and make this canary vacuous.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const PATIENT = 'cccccccc-3333-4333-8333-333333333333';
const CASE_ID = 10;
const ACTIVATION_ID = 41;
const DEVICE_ID = 77;

/**
 * The poison. A value no real analyser would produce, so a single substring
 * test over a serialised body is a complete answer for `value_text` — no
 * guessing which key a future response smuggles it out through.
 */
const SENTINEL = 'SEROLOGY-SENTINEL-9f3a';

/** The three qualitative markers. Spelled out rather than imported so this
 * suite still fails if someone "fixes" a leak by shrinking the analyte map. */
const SEROLOGY_CODES = new Set(['hiv', 'hbsag', 'hcv']);

/**
 * EXAMPLE actors, and nothing more.
 *
 * These two are the roles the projection was written for, and they are kept
 * ONLY so the coverage floor below can name a concrete 2xx it expects. They are
 * NOT the tested population — that is derived per route further down — because
 * a canary whose actors are a literal can only ever catch the leak someone had
 * already imagined.
 */
const EXAMPLE_ACTORS = ['RECEPTIONIST', 'TECHNICIAN'];

/** Where the derived reachable set is snapshotted. See the header. */
const REACHABLE_SNAPSHOT_PATH = new URL(
  '../fixtures/serologyDisclosureCanary.reachable.json',
  import.meta.url,
);
const WRITE_SNAPSHOT = process.env.CANARY_WRITE_SNAPSHOT === '1';

// ---------------------------------------------------------------------------
// A prisma stub that answers by the SQL's FROM target
// ---------------------------------------------------------------------------

const NOW = Date.now();
const isoAgo = (days) => new Date(NOW - days * 86_400_000).toISOString();
const epochOf = (iso) => (iso == null ? null : BigInt(Date.parse(iso)));
const OBSERVED = isoAgo(1);

/**
 * One lab_results row. This — not cath_case_lab_readiness_items — is where
 * refreshCaseLabReadiness actually reads a VALUE from: the stored item rows are
 * the waiver source and the write-once baseline, and the items[] the response
 * carries are rebuilt from lab_results on every read. Poisoning only the stored
 * table would produce a canary that could never go red.
 */
function labResult({
  id, test_code, value_text, value_numeric = null, unit = null,
  abnormal_flag = null, is_critical = false,
}) {
  return {
    id,
    test_code,
    loinc_code: null,
    value_text,
    value_numeric,
    unit,
    abnormal_flag,
    is_critical,
    status: 'final',
    signed_off_at: OBSERVED,
    performed_at: OBSERVED,
    received_at: OBSERVED,
    result_origin: 'analyzer',
    external_reported_on: null,
    signed_off_at_epoch_ms: epochOf(OBSERVED),
    performed_at_epoch_ms: epochOf(OBSERVED),
    received_at_epoch_ms: epochOf(OBSERVED),
  };
}

// Seven results, one per required item, all signed and one day old so every
// item resolves `result_final` inside both the lab window and the serology one.
// hbsag carries the sentinel and is flagged critical; potassium is the CONTROL
// — an ordinary quantitative critical, which must survive every projection, so
// an "emptied everything" fix cannot pass this suite.
const LAB_RESULTS = [
  labResult({ id: 901, test_code: 'HGB', value_text: '12.4', value_numeric: 12.4, unit: 'g/dL' }),
  labResult({ id: 902, test_code: 'PLT', value_text: '250', value_numeric: 250, unit: '10^3/uL' }),
  labResult({ id: 903, test_code: 'CREA', value_text: '0.9', value_numeric: 0.9, unit: 'mg/dL' }),
  labResult({
    id: 904, test_code: 'K', value_text: '6.9', value_numeric: 6.9, unit: 'mmol/L',
    abnormal_flag: 'HH', is_critical: true,
  }),
  labResult({ id: 905, test_code: 'HIV', value_text: 'Non-reactive' }),
  labResult({
    id: 906, test_code: 'HBSAG', value_text: SENTINEL, abnormal_flag: 'AA', is_critical: true,
  }),
  labResult({ id: 907, test_code: 'HCV', value_text: 'Non-reactive' }),
];

const ITEM_ORDER = ['hb', 'platelets', 'creatinine', 'potassium', 'hiv', 'hbsag', 'hcv'];

/** The seven persisted item rows, poisoned to match. Belt and braces: nothing
 * returns these VALUES today, but the case LIST now reads this table for its
 * per-case readiness summary — which is why the rows carry `case_id`: the
 * summary groups by it, and rows without one would leave the list surface
 * silently untested. */
const STORED_ITEMS = ITEM_ORDER.map((code, index) => ({
  case_id: CASE_ID,
  item_code: code,
  required: true,
  state: 'result_final',
  value_text: code === 'hbsag' ? SENTINEL : String(900 + index),
  value_numeric: null,
  unit: null,
  abnormal_flag: code === 'hbsag' ? 'AA' : null,
  is_critical: code === 'hbsag' || code === 'potassium',
  observed_at: OBSERVED,
  source: 'lab_result',
  lab_result_id: 901 + index,
  investigation_id: null,
  specimen_id: null,
  ordered_at: null,
  waived_by: null,
  waived_at: null,
  waive_reason: null,
  refreshed_at: OBSERVED,
}));

/** The items[] shape a readiness refresh writes into the labs check's
 * metadata.live_evidence — a verbatim copy of the same list. */
const LIVE_EVIDENCE = ITEM_ORDER.map((code) => {
  const result = LAB_RESULTS[ITEM_ORDER.indexOf(code)];
  return {
    item_code: code,
    required: true,
    state: 'result_final',
    value_text: result.value_text,
    value_numeric: result.value_numeric,
    unit: result.unit,
    abnormal_flag: result.abnormal_flag,
    is_critical: result.is_critical,
    observed_at: OBSERVED,
    source: 'lab_result',
    lab_result_id: result.id,
    investigation_id: null,
    specimen_id: null,
    ordered_at: null,
    waived_by: null,
    waived_at: null,
    waive_reason: null,
  };
});

const LABS_CHECK_METADATA = Object.freeze({
  auto_managed: true,
  critical_warning: true,
  critical_items: ['potassium', 'hbsag'],
  auto_pending_reason: null,
  live_evidence: LIVE_EVIDENCE,
  live_evidence_refreshed_at: OBSERVED,
});

const READINESS_TYPE_ORDER = [
  'consent', 'labs', 'allergy_renal_risk', 'anticoagulation',
  'blood_bank', 'equipment', 'implants_device_rep', 'timeout',
];

const LABS_CHECK_ROW = {
  id: 5,
  tenant_id: TENANT,
  case_id: CASE_ID,
  check_type: 'labs',
  status: 'pending',
  required: true,
  completed_by: null,
  completed_at: null,
  evidence_owner: 'lab_readiness',
  source_name: 'lab_results',
  source_version: null,
  attachment_ref: `lab_readiness:${CASE_ID}`,
  notes: null,
  created_at: OBSERVED,
  updated_at: OBSERVED,
  metadata: LABS_CHECK_METADATA,
};

const READINESS_CHECK_ROWS = READINESS_TYPE_ORDER.map((type, index) => (
  type === 'labs' ? LABS_CHECK_ROW : {
    id: 5 + index + 1,
    tenant_id: TENANT,
    case_id: CASE_ID,
    check_type: type,
    status: 'pass',
    required: true,
    completed_by: null,
    completed_at: OBSERVED,
    evidence_owner: null,
    source_name: null,
    source_version: null,
    attachment_ref: null,
    notes: null,
    created_at: OBSERVED,
    updated_at: OBSERVED,
    metadata: { auto_managed: false },
  }
));

const CASE_ROW = {
  id: 10n,
  tenant_id: TENANT,
  patient_uid: PATIENT,
  encounter_id: null,
  facility_id: 4,
  appointment_id: null,
  requested_procedure: 'Primary PCI',
  indication: 'STEMI',
  urgency: 'emergency',
  lab_room: 'CATH-1',
  status: 'readiness_pending',
  planned_start_at: OBSERVED,
  planned_end_at: null,
  // null so computeCheckDecision's `started` stays false — an in-progress case
  // freezes the readiness row as history and the refresh would stop deciding.
  actual_start_at: null,
  actual_end_at: null,
  team: [],
  timeline_event_id: null,
  audit_event_id: null,
  sla_rule_code: null,
  sla_instance_id: null,
  created_by: null,
  updated_by: null,
  created_at: OBSERVED,
  updated_at: OBSERVED,
  metadata: {},
};

/**
 * A configured settings row whose only job is auto_pass:false. With all seven
 * items present and the case not started, the compiled-in default (auto_pass
 * true) would flip the labs check to `pass`, which drags recomputeCaseStatusTx
 * and an audit insert into every single request this suite makes. Turning it
 * off is an ordinary tenant configuration and changes nothing about what the
 * response DISCLOSES — which is the only thing under test here.
 */
const READINESS_SETTINGS_ROW = {
  tenant_id: TENANT,
  required_items: [...ITEM_ORDER],
  lab_validity_days: 30,
  auto_pass: false,
  external_results_count: true,
  updated_by: null,
  created_at: OBSERVED,
  updated_at: OBSERVED,
};

const ACTIVATION_ROW = {
  id: 41n,
  tenant_id: TENANT,
  activation_uid: '44444444-4444-4444-8444-444444444444',
  patient_uid: PATIENT,
  encounter_id: null,
  emergency_visit_id: null,
  prehospital_handover_id: null,
  cath_case_id: 10n,
  activation_source: 'clinician',
  symptom_onset_at: null,
  last_known_well_at: null,
  first_medical_contact_at: null,
  door_time_at: OBSERVED,
  ecg_at: null,
  activated_at: OBSERVED,
  lab_notified_at: OBSERVED,
  in_lab_at: null,
  device_deployed_at: null,
  completed_at: null,
  stood_down_at: null,
  team: [],
  status: 'lab_notified',
  stand_down_reason: null,
  activation_criteria: {},
  owner_target_minutes: {},
  clock_metadata: {},
  canonical_timeline_event_id: null,
  canonical_audit_event_id: null,
  metadata: {},
  created_by: null,
  updated_by: null,
  created_at: OBSERVED,
  updated_at: OBSERVED,
};

const STEMI_SETTINGS_ROW = {
  tenant_id: TENANT,
  enabled: true,
  enabled_at: OBSERVED,
  enabled_by: null,
  clock_definition_source: 'Owner STEMI clock SOP',
  clock_definition_version: '2026.07',
  clock_definition_attachment_refs: [],
  activation_criteria_source: 'Owner STEMI activation SOP',
  activation_criteria_version: '2026.07',
  activation_criteria: {},
  door_to_ecg_target_minutes: 10,
  door_to_lab_target_minutes: 30,
  door_to_balloon_target_minutes: 90,
  notification_role_codes: ['CATH_LAB_INCHARGE', 'CATH_LAB_STAFF'],
  acceptance_snapshot: {},
  metadata: {},
  created_at: OBSERVED,
  updated_at: OBSERVED,
};

const USER_ROW = { id: 9, uid: ACTOR, tenant_id: TENANT, name: 'Canary Staff', role: 'DOCTOR' };
const TENANT_ROW = { id: TENANT, settings: {} };

const DEVICE_ROW = {
  id: 77n,
  tenant_id: TENANT,
  facility_id: 4,
  catalog_item_id: 5,
  device_tag: 'RP00000077',
  origin_usage_id: 900n,
  origin_unit_index: 1,
  cycle_count: 1,
  max_cycles_snapshot: 3,
  status: 'available',
  current_usage_id: null,
  exposure_flag: true,
  exposure_markers: ['hbsag'],
  last_reprocessed_at: null,
  last_reprocessed_by: null,
  last_cycle_type: null,
  last_function_check: null,
  quarantine_reason: null,
  quarantined_at: null,
  discard_reason: null,
  discard_note: null,
  discarded_at: null,
  discarded_by: null,
  created_by: null,
  created_at: null,
  updated_at: null,
  metadata: {},
  item_name: 'Diagnostic catheter',
  category: 'catheter',
  manufacturer: null,
  model: null,
};

const REPORT_ROW = {
  id: 20n,
  tenant_id: TENANT,
  case_id: 10n,
  procedure_log_id: null,
  patient_uid: PATIENT,
  encounter_id: null,
  report_type: 'diagnostic',
  template_id: 30,
  template_version: 1,
  narrative_sections: {},
  coded_fields: {},
  findings_summary: 'Canary report',
  status: 'draft',
  viewer_study_accession: null,
  preliminary_by: null,
  preliminary_at: null,
  signed_by: null,
  signed_at: null,
  created_by: null,
  updated_by: null,
  created_at: OBSERVED,
  updated_at: OBSERVED,
  metadata: {},
  template_code: 'CATH_DIAG',
  template_name: 'Diagnostic cath',
  signed_by_name: null,
  signed_by_role: null,
  procedure_ended_at: null,
  procedure_to_signed_minutes: null,
};

const CATALOG_ROW = {
  id: 5,
  tenant_id: TENANT,
  // Same facility as CASE_ROW: the catalogue reads are case-pinned and answer
  // 403 CATH_CONSUMABLE_FACILITY_MISMATCH across facilities.
  facility_id: 4,
  code: 'CATH-DIAG',
  name: 'Diagnostic catheter',
  category: 'catheter',
  unit: 'each',
  is_implant: false,
  reprocessable: true,
  active: true,
  metadata: {},
  created_at: OBSERVED,
  updated_at: OBSERVED,
};

/**
 * The append-only clinical audit row.
 *
 * cathReportService FAILS CLOSED on a read whose audit event did not land, so
 * without this every report read answers 500 and drops out of the canary's
 * coverage. This is the one write primitive stubbed to succeed — the audit
 * INSERT's RETURNING — not a builder.
 */
const AUDIT_EVENT_ROW = {
  id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  tenant_id: TENANT,
  patient_uid: PATIENT,
  action: 'cath_lab.report_viewed',
  occurred_at: OBSERVED,
};

/**
 * The tables this canary seeds. Everything else answers empty, which is what an
 * unseeded tenant looks like, and is recorded so the coverage note can say
 * which reads went hungry.
 */
const SEEDED = new Map(Object.entries({
  cath_lab_readiness_checks: READINESS_CHECK_ROWS,
  cath_lab_readiness_settings: [READINESS_SETTINGS_ROW],
  cath_case_lab_readiness_items: STORED_ITEMS,
  cath_lab_cases: [CASE_ROW],
  lab_results: LAB_RESULTS,
  stemi_activations: [ACTIVATION_ROW],
  stemi_pathway_settings: [STEMI_SETTINGS_ROW],
  cath_reprocessable_devices: [DEVICE_ROW],
  cath_procedure_reports: [REPORT_ROW],
  cath_consumable_catalog: [CATALOG_ROW],
  users: [USER_ROW],
  tenants: [TENANT_ROW],
}));

const unstubbed = new Set();

/**
 * The table a statement is ABOUT: the first `FROM` at parenthesis depth zero.
 *
 * Depth matters, and it is the whole reason this is not a substring test.
 * listCases counts readiness rows in a scalar subquery inside its SELECT list,
 * so "does the SQL mention cath_lab_readiness_checks" answers the CASE LIST
 * with eight readiness rows — a fixture artefact that reads exactly like a
 * leak, and cost this suite a false positive before the rule was tightened.
 */
function primaryTable(sql) {
  const scanner = /\(|\)|\bFROM\s+([a-z_][a-z0-9_]*)/gi;
  let depth = 0;
  let top = null;
  for (let match = scanner.exec(sql); match; match = scanner.exec(sql)) {
    if (match[0] === '(') { depth += 1; continue; }
    if (match[0] === ')') { depth -= 1; continue; }
    if (depth === 0 && top === null) top = match[1].toLowerCase();
  }
  return top;
}

function rowsFor(sql) {
  const text = String(sql ?? '');
  // The one WRITE primitive stubbed to succeed. cathReportService fails closed
  // when its audit event does not land, so without a RETURNING row every report
  // read answers 500 and drops out of this canary's coverage.
  if (/INSERT INTO clinical_audit_events/.test(text)) return [AUDIT_EVENT_ROW];
  // The cath readiness refresh takes its freshness clock from the DATABASE
  // (clock_timestamp() on its own transaction), so a stub client has to answer
  // it. It has no FROM, which is why it needs a branch above the FROM guard.
  if (/clock_timestamp/i.test(text)) return [{ as_of_epoch_ms: BigInt(Date.now()) }];
  if (!/\bFROM\b/i.test(text)) return [];
  // The readiness refresh's own labs read is `... AND check_type = 'labs' FOR
  // UPDATE` and takes rows[0] as THE labs check; answering it with the whole
  // eight-row list would hand it the `consent` row instead.
  if (/FROM cath_lab_readiness_checks/.test(text) && /check_type = 'labs'/.test(text)) {
    return [LABS_CHECK_ROW];
  }
  const table = primaryTable(text);
  if (table && SEEDED.has(table)) return SEEDED.get(table);
  if (table) unstubbed.add(table);
  return [];
}

const queryRawUnsafeMock = jest.fn(async (sql) => rowsFor(sql));
const queryRawMock = jest.fn(async (strings, ...values) => rowsFor(
  Array.isArray(strings) ? strings.join(' ? ') : strings,
));
const executeRawUnsafeMock = jest.fn(async () => 1);
const executeRawMock = jest.fn(async () => 1);

/**
 * Prisma model reads land on the same empty answer rather than a TypeError:
 * a route that starts reading through the client instead of raw SQL must not
 * silently 500 its way out of this canary's coverage.
 */
const MODEL_METHODS = {
  findMany: async () => [],
  findFirst: async () => null,
  findUnique: async () => null,
  count: async () => 0,
  aggregate: async () => ({}),
  groupBy: async () => [],
  create: async () => ({}),
  createMany: async () => ({ count: 0 }),
  update: async () => ({}),
  updateMany: async () => ({ count: 0 }),
  upsert: async () => ({}),
  delete: async () => ({}),
  deleteMany: async () => ({ count: 0 }),
};

const baseDb = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $queryRaw: queryRawMock,
  $executeRawUnsafe: executeRawUnsafeMock,
  $executeRaw: executeRawMock,
  $on: () => {},
  $connect: async () => {},
  $disconnect: async () => {},
};

const dbStub = new Proxy(baseDb, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (prop === '$transaction') {
      return async (arg) => (typeof arg === 'function'
        ? arg(dbStub)
        : Promise.all(Array.isArray(arg) ? arg : []));
    }
    if (typeof prop !== 'string' || prop.startsWith('$') || prop === 'then') return undefined;
    return { ...MODEL_METHODS };
  },
  has(target, prop) {
    return prop in target || (typeof prop === 'string' && !prop.startsWith('$'));
  },
});

const setTenant = jest.fn(async (_tenantId, fn) => fn(dbStub));
const setTenantTx = jest.fn(async (_tenantId, fn) => fn(dbStub));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  __esModule: true,
  default: dbStub,
  prismaReadOnly: dbStub,
  setTenant,
  setTenantTx,
  isTenantTransactionClient: () => false,
  circuitBreakerStatus: () => ({}),
  pinSessionTimeZoneToUrl: (url) => url,
  evaluateTenantRlsPosture: () => ({}),
  tenantRlsRuntimeRole: () => null,
  tenantRlsRolePosture: async () => ({}),
  logTenantRlsRolePosture: async () => {},
  rlsDisabledLogLevel: () => 'warn',
  tenantRlsPostureMustFailClosed: () => false,
  ensureTenantRlsRuntimeRoleGrants: async () => {},
}));

jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess: jest.fn(),
  logPhiAccessBatch: jest.fn(async () => {}),
}));

// getTenantById is REQUIRED here, not optional politeness: careTeamEnforcement
// imports it by name, so a factory without it makes the whole graph fail to
// LINK — the trap dev-ea hit on the cath report suite.
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => TENANT,
  requireTenantId: (value) => value ?? TENANT,
  getTenantById: async () => ({ id: TENANT, settings: {} }),
}));

jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: () => (_req, _res, next) => next(),
}));

// Pinned in cathLabRouteGuards. Live, they answer 403 for every request here
// and the canary would prove nothing.
jest.unstable_mockModule('../../middleware/routePatientAccessGuards.js', () => ({
  routePatientGuard: () => (_req, _res, next) => next(),
  selectorTenantOf: () => null,
  positiveIntOrNull: () => null,
  positiveBigIntTextOrNull: () => null,
  PG_INT4_MAX: 2147483647,
  PG_INT8_MAX: 9223372036854775807n,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  __esModule: true,
  default: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, verbose: () => {},
  },
}));

const { default: cathLabRoutes } = await import('../../routes/clinical/cathLabRoutes.js');
const { default: stemiPathwayRoutes } = await import('../../routes/clinical/stemiPathwayRoutes.js');
const { default: governanceRoutes } = await import('../../routes/clinical/cathReprocessingPolicyRoutes.js');
const { requireRole } = await import('../../middleware/rbacMiddleware.js');
const {
  CATH_LAB_ROUTE_ROLES,
  CATH_REPROCESSING_POLICY_ROUTE_ROLES,
  STEMI_ROUTE_ROLES,
} = await import('../../config/routeRolePolicy.js');
const { getRolePolicyRoleCodes } = await import('../../config/rolePolicyGraph.js');
const { roleSeesSerologyDetail } = await import(
  '../../services/clinical/cathDeviceReuseService.js'
);

// ---------------------------------------------------------------------------
// The two role populations — both derived, neither typed out
// ---------------------------------------------------------------------------

/**
 * The canonical role list. rolePolicyGraph's ROLE_CODES is what
 * routeRolePolicy's own builders validate every route constant against
 * (assertKnownPolicyRole), so a role that can appear in ANY of these three
 * mount unions is in here by construction — including TECHNICIAN, which
 * utils/roles.js ALL_ROLES does not carry and which is one of the two roles the
 * projection was written for. Deriving from the smaller list would have
 * silently dropped it.
 */
const ALL_ROLES = [...new Set(getRolePolicyRoleCodes())].sort();

/**
 * The serology audience, asked of the projection's OWN predicate rather than
 * re-decided here. Plan 2 already reviewed that judgement in one place; this
 * file must not mint a second opinion that drifts from it.
 */
const ENTITLED = ALL_ROLES.filter(roleSeesSerologyDetail);
const ENTITLED_SET = new Set(ENTITLED);

/**
 * The pin. Deriving ENTITLED is what makes this suite close a class; writing it
 * down is what stops the derivation from quietly answering "everyone".
 *
 * Adding a role to a capability group in rolePolicyGraph.js, or to
 * CLINICAL_STAFF_ROUTE_ROLES' include list, widens who may read a patient's
 * blood-borne serology across every surface in this repo. That is a reviewed
 * decision. It must not be reachable as a side effect of an unrelated edit two
 * files away, and it must not make this canary test LESS by moving a role out
 * of the remainder. So the derived set is compared to this list and the failure
 * names exactly which roles arrived or left.
 *
 * WHAT THE LIST MEANS, AND WHAT IT DOES NOT (read before "fixing" it):
 *
 * The predicate is membership in CLINICAL_STAFF_ROUTE_ROLES — the platform's
 * existing answer to "who may read a patient's clinical narrative" — reused
 * rather than minted. Its ONLY consumers are the cath route projections
 * (routes/clinical/cathLabRoutes.js) and cathLabReadinessProjection.js. Nothing
 * under routes/lab or services/lab calls it, so it never gates the lab
 * surface: a PATHOLOGIST, LAB_INCHARGE or LAB_STAFF reads serology values on
 * the lab mount under the LAB route roles exactly as before. Their absence
 * from this list is therefore NOT "pathologists cannot see serology"; it is
 * "on the cath and STEMI surfaces this canary covers, they are not in the
 * audience for a patient's blood-borne narrative", which is route-appropriate:
 *   - on the cath mount the lab roles are in no route's reachable set at all
 *     (see the snapshot), so the exclusion never bites them there;
 *   - on the STEMI mount the strip is UNCONDITIONAL
 *     (stemiPathwayService.readinessWithoutLabEvidence): no role, entitled or
 *     not, sees live_evidence/critical_items in activation evidence, because a
 *     STEMI activation is not a lab surface. The lab roles appear in the STEMI
 *     remainder and the property holds for every role. If STEMI evidence is
 *     ever made role-projected instead of stripped, THIS is where that
 *     judgement gets re-examined.
 * Likewise absent, and correctly so for these surfaces: RECEPTIONIST,
 * TECHNICIAN, RADIOLOGIST/RADIOLOGY_STAFF, BLOOD_BANK_*, DIALYSIS_TECHNICIAN,
 * EMERGENCY_RESPONDER, QUALITY_OFFICER and INFECTION_CONTROL_OFFICER (the
 * governance officers administer policy, not patients).
 */
const ENTITLED_ALLOW_LIST = [
  'ADMIN',
  'ADMISSION_OFFICER',
  'ANAESTHETIST',
  'ANESTHETIST',
  'CATH_LAB_INCHARGE',
  'CATH_LAB_STAFF',
  'CMO',
  'CNO',
  'CONSULTANT',
  'DOCTOR',
  'DUTY_DOCTOR',
  'ER_STAFF',
  'ICU_INCHARGE',
  'ICU_NURSE',
  'ICU_STAFF',
  'IPD_COUNSELLOR',
  'IP_INCHARGE',
  'IP_STAFF_NURSE',
  'JUNIOR_DOCTOR',
  'MEDICAL_RECORDS',
  'MEDICAL_SUPERINTENDENT',
  'NURSING_INCHARGE',
  'NURSING_STAFF',
  'NURSING_SUPERINTENDENT',
  'OP_INCHARGE',
  'OP_STAFF_NURSE',
  'OT_INCHARGE',
  'OT_NURSE',
  'OT_STAFF',
  'PHARMACIST',
  'PHARMACY_INCHARGE',
  'PHARMACY_STAFF',
  'RESIDENT',
  'SENIOR_DOCTOR',
  'SUPER_ADMIN',
];

// ---------------------------------------------------------------------------
// The app under test — the same three mounts app.js builds, with the same
// mount role gates. The PHI logger and the STEMI patientAccessGuard are left
// off: both refuse or annotate, neither shapes a body.
// ---------------------------------------------------------------------------

const MOUNTS = [
  { prefix: '/api/v1/cath-lab', router: cathLabRoutes, roles: CATH_LAB_ROUTE_ROLES },
  { prefix: '/api/v1/stemi-pathway', router: stemiPathwayRoutes, roles: STEMI_ROUTE_ROLES },
  {
    prefix: '/api/v1/cath-reprocessing',
    router: governanceRoutes,
    roles: CATH_REPROCESSING_POLICY_ROUTE_ROLES,
  },
];

const APPS = new Map();

function appFor(role) {
  const cached = APPS.get(role);
  if (cached) return cached;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = 'req-canary';
    req.tenantId = TENANT;
    req.user = { uid: ACTOR, id: 9, role, rawRole: role, roles: [role], scope: 'full' };
    next();
  });
  for (const mount of MOUNTS) {
    app.use(mount.prefix, requireRole(...mount.roles), mount.router);
  }
  APPS.set(role, app);
  return app;
}

// ---------------------------------------------------------------------------
// Route enumeration BY WALKING the router stacks
// ---------------------------------------------------------------------------

/**
 * Every route layer under `router`, recursing into mounted sub-routers.
 *
 * Express 5 keeps no readable copy of a `use()` mount path — only compiled
 * matchers — so a nested mount is only followed when `layer.slash` says it was
 * mounted at the root (which is how cathLabRoutes mounts cathSchedulingRoutes).
 * Anything else THROWS rather than guessing a prefix: a walker that quietly
 * emitted the wrong path would 404 and turn this canary vacuous for exactly
 * the routes someone just added.
 */
function routeLayers(router, prefix = '') {
  const found = [];
  for (const layer of router.stack ?? []) {
    if (layer.route) {
      const methods = Object.entries(layer.route.methods ?? {})
        .filter(([, enabled]) => enabled)
        .map(([method]) => method.toUpperCase());
      found.push({
        path: `${prefix}${layer.route.path}`,
        methods,
        stack: layer.route.stack,
      });
      continue;
    }
    const nested = layer.handle?.stack;
    if (!Array.isArray(nested)) continue;
    if (layer.slash !== true) {
      throw new Error(
        'serologyDisclosureCanary cannot resolve the mount path of a nested router '
        + 'that is not mounted at "/". Teach routeLayers() the new prefix — do not '
        + 'delete this check, or every route under that mount silently drops out of '
        + 'the canary.',
      );
    }
    found.push(...routeLayers(layer.handle, prefix));
  }
  return found;
}

/**
 * Substitute a fixture id for each :param. Keyed on the segment BEFORE the
 * param, because `:id` means a case under /cases and a report under /reports.
 */
const PARAM_VALUES = new Map(Object.entries({
  'cases/id': String(CASE_ID),
  'cases/caseId': String(CASE_ID),
  'reports/id': '20',
  'devices/deviceId': String(DEVICE_ID),
  'activations/id': String(ACTIVATION_ID),
  'consumables/usageId': '501',
  'labs/item': 'hbsag',
  'order-sets/slot': 'pre',
  'catalog/id': '5',
  'report-templates/id': '30',
}));

const PARAM_FALLBACKS = new Map(Object.entries({
  id: '1', caseId: String(CASE_ID), item: 'hbsag', slot: 'pre',
  deviceId: String(DEVICE_ID), usageId: '501', reportId: '20', activationId: String(ACTIVATION_ID),
}));

function fillParams(path) {
  const segments = path.split('/');
  return segments.map((segment, index) => {
    if (!segment.startsWith(':')) return segment;
    const name = segment.slice(1).replace(/[^A-Za-z0-9_]/g, '');
    const previous = segments[index - 1] ?? '';
    return PARAM_VALUES.get(`${previous}/${name}`) ?? PARAM_FALLBACKS.get(name) ?? '1';
  }).join('/');
}

/** The two case-scoped reads whose authority rides in the query string. */
function queryFor(path) {
  if (path.endsWith('/devices/lookup')) return `?case_id=${CASE_ID}&tag=RP00000077`;
  if (path.includes('/consumables/catalog')) return `?case_id=${CASE_ID}`;
  return '';
}

const ALL_ROUTES = MOUNTS.flatMap((mount) => routeLayers(mount.router).map((route) => ({
  ...route,
  mount: mount.prefix,
  fullPath: `${mount.prefix}${route.path}`,
})));

const GET_ROUTES = ALL_ROUTES
  .filter((route) => route.methods.includes('GET'))
  .map((route) => ({
    ...route,
    url: `${mountUrl(route)}${queryFor(route.fullPath)}`,
  }))
  .sort((a, b) => a.fullPath.localeCompare(b.fullPath));

function mountUrl(route) {
  return `${route.mount}${fillParams(route.path)}`;
}

const WRITE_ROUTES = ALL_ROUTES.filter(
  (route) => route.mount === '/api/v1/cath-lab' && route.methods.some((m) => m !== 'GET'),
);

// ---------------------------------------------------------------------------
// The disclosure predicate
// ---------------------------------------------------------------------------

function* walkJson(node, path = '$') {
  yield [path, node];
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) yield* walkJson(node[index], `${path}[${index}]`);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) yield* walkJson(value, `${path}.${key}`);
  }
}

const VALUE_KEYS = ['value_text', 'value_numeric', 'abnormal_flag'];

function serologyItemLeaks(item, where) {
  const leaks = [];
  if (!item || typeof item !== 'object') return leaks;
  if (!SEROLOGY_CODES.has(String(item.item_code ?? ''))) return leaks;
  if (item.is_critical === true) {
    leaks.push(`${where}.is_critical === true on ${item.item_code} (only a reactive marker is critical)`);
  }
  for (const key of VALUE_KEYS) {
    if (item[key] != null) {
      leaks.push(`${where}.${key} = ${JSON.stringify(item[key])} on ${item.item_code}`);
    }
  }
  return leaks;
}

/** Everything about this body that a non-clinical reader must not have seen. */
function disclosures(body) {
  const leaks = [];
  const serialised = JSON.stringify(body ?? null);
  if (serialised.includes(SENTINEL)) leaks.push(`the serialised body contains ${SENTINEL}`);
  for (const [path, node] of walkJson(body)) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    if (Array.isArray(node.critical_items)) {
      const named = node.critical_items.filter((code) => SEROLOGY_CODES.has(String(code)));
      if (named.length) leaks.push(`${path}.critical_items names ${named.join(', ')}`);
    }
    if (Array.isArray(node.live_evidence)) {
      node.live_evidence.forEach((item, index) => {
        leaks.push(...serologyItemLeaks(item, `${path}.live_evidence[${index}]`));
      });
    }
    leaks.push(...serologyItemLeaks(node, path));
  }
  return [...new Set(leaks)];
}

// ---------------------------------------------------------------------------
// Drive every enumerated GET as EVERY role, at module scope
// ---------------------------------------------------------------------------
//
// At MODULE scope, not in beforeAll, and that is not a style choice: the tested
// population is `reachable − ENTITLED`, and it.each() needs its cases while the
// describe bodies are being evaluated — which is before any hook has run. A
// beforeAll would force the population back to something typed out by hand,
// which is the exact thing this refinement removes.
//
// Cost: ALL_ROLES x GET_ROUTES requests against a stubbed persistence layer.
// The mount gate refuses most of them in a few microseconds, so the sweep is
// dominated by the roles that actually reach a handler. Per-route fan-out keeps
// it comfortably under a second; the app is stateless per request, and the
// prisma stub answers by SQL text, not by call order.

/** `${role} ${fullPath}` -> { status, body } */
const RESPONSES = new Map();
const key = (role, route) => `${role} ${route.fullPath}`;

for (const role of ALL_ROLES) {
  const app = appFor(role);
  // Serial over roles, parallel over that role's routes: one role's sweep is
  // ~23 requests against a stubbed database, and keeping the roles in order
  // keeps a failure's console output readable.
  const answers = await Promise.all(GET_ROUTES.map(async (route) => {
    const res = await request(app).get(route.url);
    return [key(role, route), { status: res.status, body: res.body }];
  }));
  for (const [entry, value] of answers) RESPONSES.set(entry, value);
}

const statusOf = (role, route) => RESPONSES.get(key(role, route))?.status ?? 500;

/** Empirically reachable: the roles this route actually answered 2xx. */
const REACHABLE = new Map(GET_ROUTES.map((route) => [
  route.fullPath,
  ALL_ROLES.filter((role) => statusOf(role, route) < 300),
]));

/** The class under test, per route: reachable, and NOT entitled to serology. */
const REMAINDER = new Map(GET_ROUTES.map((route) => [
  route.fullPath,
  (REACHABLE.get(route.fullPath) ?? []).filter((role) => !ENTITLED_SET.has(role)),
]));

const snapshotLabel = (route) => `GET ${route.fullPath}`;
const LIVE_SNAPSHOT = Object.fromEntries(
  GET_ROUTES.map((route) => [snapshotLabel(route), [...(REACHABLE.get(route.fullPath) ?? [])].sort()]),
);
const STORED_SNAPSHOT = existsSync(REACHABLE_SNAPSHOT_PATH)
  ? JSON.parse(readFileSync(REACHABLE_SNAPSHOT_PATH, 'utf8'))
  : null;

afterAll(() => {
  const cell = (role, route) => {
    const res = RESPONSES.get(key(role, route));
    const why = res && res.status >= 300
      ? ` ${res.body?.details?.code ?? res.body?.error?.code ?? res.body?.message ?? ''}`.slice(0, 44)
      : '';
    return `${role.slice(0, 4).toLowerCase()}:${res?.status}${why}`;
  };
  const rows = GET_ROUTES.map((route) => {
    const reach = REACHABLE.get(route.fullPath) ?? [];
    const rest = REMAINDER.get(route.fullPath) ?? [];
    return `  ${route.fullPath.padEnd(52)} reach ${String(reach.length).padStart(2)}/${ALL_ROLES.length}`
      + `  tested ${String(rest.length).padStart(2)}  ${EXAMPLE_ACTORS.map((role) => cell(role, route)).join('  ')}`;
  });
  const reached = GET_ROUTES.filter((route) => (REACHABLE.get(route.fullPath) ?? []).length > 0);
  const tested = GET_ROUTES.filter((route) => (REMAINDER.get(route.fullPath) ?? []).length > 0);
  process.stdout.write(
    `\nserology disclosure canary — ${GET_ROUTES.length} GET routes walked as `
    + `${ALL_ROLES.length} roles (${ENTITLED.length} entitled), ${reached.length} reachable, `
    + `${tested.length} carrying a non-entitled reader\n${rows.join('\n')}\n`
    + (unstubbed.size ? `  (tables answered empty: ${[...unstubbed].sort().join(', ')})\n` : ''),
  );
});

describe('route enumeration is by walking, not by a list', () => {
  it('finds every GET the three mounts declare, including the nested scheduling router', () => {
    const paths = GET_ROUTES.map((route) => route.fullPath);
    // A floor, not a census: cathLabRouteGuards owns the exact census, and a
    // hard equality here would make every new route a two-file edit and tempt
    // the author to delete a line instead of thinking.
    expect(paths.length).toBeGreaterThanOrEqual(20);
    // The nested mount really was followed.
    expect(paths).toContain('/api/v1/cath-lab/schedule');
    expect(paths).toContain('/api/v1/cath-lab/cases/:id/schedule');
    // ...and each mount contributed.
    for (const mount of MOUNTS) {
      expect(paths.some((path) => path.startsWith(mount.prefix))).toBe(true);
    }
    // Params were substituted, so nothing is requested with a literal ':'.
    expect(GET_ROUTES.every((route) => !route.url.includes(':'))).toBe(true);
  });
});

describe('the poison really is in the persistence layer', () => {
  it('CATH_LAB_STAFF reads the sentinel and the serology criticality (positive control)', () => {
    // Without this the suite below is indistinguishable from one whose fixture
    // never carried anything to redact.
    const route = GET_ROUTES.find(
      (r) => r.fullPath === '/api/v1/cath-lab/cases/:id/readiness/labs',
    );
    const { status, body } = RESPONSES.get(key('CATH_LAB_STAFF', route));
    expect(status).toBe(200);
    const hbsag = body.data.items.find((item) => item.item_code === 'hbsag');
    expect(hbsag).toMatchObject({
      value_text: SENTINEL, abnormal_flag: 'AA', is_critical: true, state: 'result_final',
    });
    expect(body.data.critical_items).toEqual(['potassium', 'hbsag']);
    expect(body.data.critical_warning).toBe(true);
    // The real builder produced this, not the fixture: the items were rebuilt
    // from lab_results, so the canary below is testing a live projection.
    expect(body.data.items).toHaveLength(ITEM_ORDER.length);
  });

  it('the case LIST really carries a readiness summary, and it is value-free', () => {
    // A coverage floor for the surface Plan 3 follow-up B added. The canary
    // below can only catch a leak on a payload that EXISTS, so this asserts the
    // summary is there — and then asserts what it is made of. Everything here
    // is a status, a flag, a count, an item code or a timestamp: there is no
    // value, no abnormal flag, no per-item criticality and no `critical_items`,
    // which is why GET /cases needs no serology projection. Adding any of them
    // makes this test the place the decision has to be re-argued.
    const route = GET_ROUTES.find((r) => r.fullPath === '/api/v1/cath-lab/cases');
    const { status, body } = RESPONSES.get(key('CATH_LAB_STAFF', route));
    expect(status).toBe(200);
    const summary = body.data.cases[0].lab_readiness_summary;
    expect(summary).not.toBeNull();
    expect(Object.keys(summary).sort()).toEqual([
      'auto_managed', 'check_status', 'critical_warning',
      'live_evidence_refreshed_at', 'missing_count', 'missing_items',
    ]);
    // The fixture's own critical value (a potassium of 6.9 AND a reactive
    // hbsag) reaches the flag, so the advisory is real...
    expect(summary.critical_warning).toBe(true);
    // ...and nothing in the payload says WHICH.
    expect(JSON.stringify(summary)).not.toContain('hbsag');
    expect(JSON.stringify(summary)).not.toContain(SENTINEL);
  });

  it('CATH_LAB_STAFF reads it on GET /cases/:id too, in both places it lives', () => {
    const route = GET_ROUTES.find((r) => r.fullPath === '/api/v1/cath-lab/cases/:id');
    const { status, body } = RESPONSES.get(key('CATH_LAB_STAFF', route));
    expect(status).toBe(200);
    const hbsag = body.data.case.lab_readiness.items.find((i) => i.item_code === 'hbsag');
    expect(hbsag.value_text).toBe(SENTINEL);
    const labs = body.data.case.readiness.find((row) => row.check_type === 'labs');
    expect(labs.metadata.critical_items).toEqual(['potassium', 'hbsag']);
    expect(labs.metadata.live_evidence.find((i) => i.item_code === 'hbsag').value_text)
      .toBe(SENTINEL);
  });
});

describe('the entitled set is derived, and pinned so it cannot widen quietly', () => {
  it('roleSeesSerologyDetail admits exactly the reviewed allow-list', () => {
    const added = ENTITLED.filter((role) => !ENTITLED_ALLOW_LIST.includes(role));
    const removed = ENTITLED_ALLOW_LIST.filter((role) => !ENTITLED_SET.has(role));
    // Named rather than diffed so the failure reads as a decision to make:
    // every role in `added` may now read a patient's blood-borne serology on
    // every surface in this repo, and every role in `removed` has just left the
    // audience — and left this canary's remainder, which it must not do by
    // accident.
    expect({
      added_to_the_serology_audience: added,
      removed_from_the_serology_audience: removed,
    }).toEqual({
      added_to_the_serology_audience: [],
      removed_from_the_serology_audience: [],
    });
    expect(ENTITLED).toEqual(ENTITLED_ALLOW_LIST);
  });

  it('the derivation ran over the whole platform role list, not a subset', () => {
    // A canonical list that stopped covering the mount unions would shrink the
    // sweep without shrinking anything visible.
    const mountRoles = [...new Set([
      ...CATH_LAB_ROUTE_ROLES,
      ...STEMI_ROUTE_ROLES,
      ...CATH_REPROCESSING_POLICY_ROUTE_ROLES,
    ])].sort();
    expect(mountRoles.filter((role) => !ALL_ROLES.includes(role))).toEqual([]);
    // The two example actors are in it, and are NOT entitled — so the remainder
    // below is a superset of what this file used to test.
    for (const role of EXAMPLE_ACTORS) {
      expect(ALL_ROLES).toContain(role);
      expect(ENTITLED_SET.has(role)).toBe(false);
    }
  });
});

describe('the reachable set is snapshotted so it cannot silently shrink', () => {
  it('CANARY_WRITE_SNAPSHOT is never left on', () => {
    if (!WRITE_SNAPSHOT) {
      expect(WRITE_SNAPSHOT).toBe(false);
      return;
    }
    writeFileSync(REACHABLE_SNAPSHOT_PATH, `${JSON.stringify(LIVE_SNAPSHOT, null, 2)}\n`);
    // Rewriting and passing would let a green CI run silently redefine what the
    // canary is allowed to see. Rewriting and FAILING cannot.
    throw new Error(
      'CANARY_WRITE_SNAPSHOT=1 rewrote serologyDisclosureCanary.reachable.json and failed '
      + 'deliberately. Read the diff, then rerun without the flag.',
    );
  });

  it('every enumerated GET has a snapshot entry, and every entry is still enumerated', () => {
    expect(STORED_SNAPSHOT).not.toBeNull();
    const live = Object.keys(LIVE_SNAPSHOT).sort();
    const stored = Object.keys(STORED_SNAPSHOT ?? {}).sort();
    expect({
      new_routes_add_them: live.filter((label) => !stored.includes(label)),
      snapshot_routes_no_longer_enumerated: stored.filter((label) => !live.includes(label)),
    }).toEqual({
      new_routes_add_them: [],
      snapshot_routes_no_longer_enumerated: [],
    });
  });

  it.each(GET_ROUTES.map((route) => [snapshotLabel(route), route]))(
    '%s answers 2xx to exactly the roles the snapshot records',
    (label, route) => {
      const stored = STORED_SNAPSHOT?.[label];
      if (!Array.isArray(stored)) {
        throw new Error(`NEW ROUTE — add it: ${label} has no entry in the reachable snapshot. `
          + 'Regenerate with CANARY_WRITE_SNAPSHOT=1 and read the diff.');
      }
      const live = LIVE_SNAPSHOT[label];
      const grew = live.filter((role) => !stored.includes(role));
      const shrank = stored.filter((role) => !live.includes(role));
      const problems = [];
      if (grew.length) {
        problems.push(`${label} GREW: ${grew.join(', ')} — a role gained access; the canary `
          + 'already asserts the property for it — update the snapshot deliberately');
      }
      if (shrank.length) {
        problems.push(`${label} SHRANK: ${shrank.join(', ')} — either an intentional tightening `
          + '(update the snapshot) or the fixtures rotted and the canary is testing less than '
          + 'it claims');
      }
      expect(problems).toEqual([]);
    },
  );
});

describe('no serology value, criticality or item name reaches a non-entitled reader', () => {
  // The tested population is DERIVED: every role that this route actually
  // answered 2xx, minus the roles roleSeesSerologyDetail() admits. Nothing here
  // names RECEPTIONIST or TECHNICIAN; they simply fall out of the remainder,
  // and so will whoever is added to one of these unions next.
  const cases = GET_ROUTES.flatMap((route) => (REMAINDER.get(route.fullPath) ?? []).map((role) => [
    `${role} ${route.fullPath}`, role, route,
  ]));

  it('the remainder is not empty — a canary with no actors tests nothing', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)('%s', (_label, role, route) => {
    const { body } = RESPONSES.get(key(role, route));
    // Only 2xx answers are in `cases` at all: a refusal is a fine answer to a
    // role outside the audience, a disclosure is not.
    expect({ route: route.fullPath, role, leaks: disclosures(body) })
      .toEqual({ route: route.fullPath, role, leaks: [] });
  });
});

describe('coverage floor — the canary cannot pass by reaching nothing', () => {
  it('most of the enumerated GETs really were reached, not refused', () => {
    // A fixture that drifted until every route answered 403/404/500 would make
    // every assertion above pass by having no cases at all. The rest are
    // refusals the role gates are SUPPOSED to make or reads this fixture
    // deliberately does not seed.
    const reached = GET_ROUTES.filter(
      (route) => (REMAINDER.get(route.fullPath) ?? []).length > 0,
    );
    expect(reached.length).toBeGreaterThanOrEqual(14);
  });

  it.each([
    '/api/v1/cath-lab/cases/:id',
    '/api/v1/cath-lab/cases/:id/readiness/labs',
    '/api/v1/stemi-pathway/activations/:id',
  ])('a RECEPTIONIST really does get a 2xx from %s', (fullPath) => {
    const route = GET_ROUTES.find((r) => r.fullPath === fullPath);
    expect(route).toBeDefined();
    const { status } = RESPONSES.get(key('RECEPTIONIST', route));
    expect(status).toBeLessThan(300);
  });

  it.each([
    '/api/v1/cath-lab/cases/:id',
    '/api/v1/cath-lab/cases/:id/readiness/labs',
    '/api/v1/stemi-pathway/activations/:id',
  ])('%s still has a NON-ENTITLED reader to test the property on', (fullPath) => {
    // These are the three surfaces that actually leaked. If a change ever
    // emptied their remainder — every reachable role became entitled — the
    // canary would go green on them while asserting nothing at all. That is
    // indistinguishable from a fix, and is the failure mode this floor exists
    // for. Tightening a gate is fine; tightening it INTO this state is a
    // deliberate decision that has to be made here.
    const rest = REMAINDER.get(fullPath);
    expect(rest).toBeDefined();
    expect({ route: fullPath, non_entitled_readers: rest?.length ?? 0 })
      .not.toEqual({ route: fullPath, non_entitled_readers: 0 });
  });

  it('...and those three bodies are not empty shells', () => {
    const bodyFor = (fullPath) => RESPONSES.get(
      key('RECEPTIONIST', GET_ROUTES.find((r) => r.fullPath === fullPath)),
    ).body;
    const labs = bodyFor('/api/v1/cath-lab/cases/:id/readiness/labs').data;
    expect(labs.items).toHaveLength(ITEM_ORDER.length);
    // The advisory the front desk IS admitted for survives, and the ordinary
    // quantitative critical is still named and still valued: a projection that
    // simply emptied everything would fail here.
    expect(labs.critical_warning).toBe(true);
    expect(labs.critical_items).toEqual(['potassium']);
    expect(labs.items.find((item) => item.item_code === 'potassium'))
      .toMatchObject({ value_text: '6.9', abnormal_flag: 'HH', is_critical: true });
    // ...and the serology items keep their CHECKLIST, blanked not dropped.
    const hbsag = labs.items.find((item) => item.item_code === 'hbsag');
    expect(hbsag).toMatchObject({ state: 'result_final', source: 'lab_result' });
    expect(Object.keys(hbsag).sort())
      .toEqual(Object.keys(labs.items.find((i) => i.item_code === 'potassium')).sort());

    const view = bodyFor('/api/v1/cath-lab/cases/:id').data.case;
    expect(view.lab_readiness.items).toHaveLength(ITEM_ORDER.length);
    expect(view.readiness.find((row) => row.check_type === 'labs').metadata.live_evidence)
      .toHaveLength(ITEM_ORDER.length);

    const activation = bodyFor('/api/v1/stemi-pathway/activations/:id').data;
    expect(activation.primary_pci_evidence.readiness_checks).toHaveLength(
      READINESS_TYPE_ORDER.length,
    );
    expect(String(activation.activation.id)).toBe(String(ACTIVATION_ID));
  });
});

describe('writes on the cath mount cannot become a second leak channel', () => {
  // A write route that admitted a non-clinical role and then echoed back what
  // it wrote would be the same disclosure through a different door — and the
  // GET walk above cannot see it, because a write is not walked. So the write
  // side is pinned structurally instead: every non-GET on the cath mount must
  // refuse every role the MOUNT admits that is not entitled to serology detail.
  //
  // Derived from the same predicate as ENTITLED, for the same reason: the probe
  // population must grow on its own when the cath mount's union does.
  //
  // Proven by PROBING the chain rather than by reading a name: the gates are
  // anonymous closures built by the router's own roleGuard(), so only running
  // them says which one is mounted.
  const OUTSIDE_CLINICAL_STAFF = [...new Set(CATH_LAB_ROUTE_ROLES)]
    .filter((role) => !ENTITLED_SET.has(role))
    .sort();

  /**
   * The ONE documented exception, and what it costs to add another.
   *
   * CATH_REPORT_EDIT_ROLES (roleHelpers.js) deliberately contains RECEPTIONIST
   * — "report reads include both image viewers and report editors so
   * transcription staff can reopen their drafts". These four routes author a
   * report NARRATIVE the person is transcribing; none of them reads, writes or
   * echoes cath_lab_readiness_checks metadata or a readiness item, which is
   * what this file is about. They are named here rather than silently skipped
   * so that a fifth route joining this list is a deliberate edit with a reason,
   * not a green run.
   */
  const REPORT_AUTHORING_EXCEPTIONS = new Map(Object.entries({
    'POST /api/v1/cath-lab/report-templates/:id/supersede': ['RECEPTIONIST'],
    'POST /api/v1/cath-lab/cases/:caseId/reports': ['RECEPTIONIST'],
    'PATCH /api/v1/cath-lab/reports/:id': ['RECEPTIONIST'],
    'POST /api/v1/cath-lab/reports/:id/preliminary': ['RECEPTIONIST'],
  }));

  it('the probe roles are real roles the MOUNT admits but clinical staff does not', () => {
    expect(OUTSIDE_CLINICAL_STAFF).toContain('RECEPTIONIST');
    expect(OUTSIDE_CLINICAL_STAFF).toContain('TECHNICIAN');
  });

  it('there is at least one non-GET route to probe', () => {
    expect(WRITE_ROUTES.length).toBeGreaterThanOrEqual(15);
  });

  it('every documented exception still names a route that exists', () => {
    // An exception left behind by a deleted or renamed route would quietly
    // widen the rule for whatever takes its place.
    const labels = WRITE_ROUTES.map((route) => `${route.methods.join('/')} ${route.fullPath}`);
    for (const label of REPORT_AUTHORING_EXCEPTIONS.keys()) expect(labels).toContain(label);
  });

  it.each(WRITE_ROUTES.map((route) => [`${route.methods.join('/')} ${route.fullPath}`, route]))(
    '%s refuses every role outside CLINICAL_STAFF_ROUTE_ROLES before the handler',
    (label, route) => {
      const allowed = REPORT_AUTHORING_EXCEPTIONS.get(label) ?? [];
      const notRefused = [];
      for (const role of OUTSIDE_CLINICAL_STAFF) {
        // Only the layers IN FRONT of the handler are run: the handler itself
        // would go to the database, and reaching it is already the failure.
        const guards = route.stack.slice(0, -1).map((layer) => layer.handle);
        let refused = false;
        for (const guard of guards) {
          let passed = false;
          const res = {
            statusCode: null,
            req: {},
            status(code) { this.statusCode = code; return this; },
            json() { return this; },
            send() { return this; },
          };
          guard(
            { user: { role, rawRole: role, roles: [role] }, params: {}, get: () => undefined },
            res,
            () => { passed = true; },
          );
          if (!passed) { refused = true; break; }
        }
        if (!refused && !allowed.includes(role)) notRefused.push(role);
      }
      expect({ route: label, notRefused }).toEqual({ route: label, notRefused: [] });
    },
  );
});
