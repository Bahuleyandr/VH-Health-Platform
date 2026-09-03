import { jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE DURABLE GUARD for tenant-scoped config provisioning.
 *
 * The 2026-08-23 once-over and the 2026-08-24 tenancy re-audit found the same
 * defect five times: a migration seeds a config table for the default tenant
 * only, every reader filters strictly on the requesting tenant, and a zero-row
 * lookup is a SILENT non-match. Three of those cost a second tenant its
 * critical lab alerts, its escalation tiers, and its SLA clock outright.
 *
 * FOUR of the five are remediated by a declarative registry
 * (services/tenant/tenantProvisioningRegistry.js) shared by createTenant and
 * the backfill migrations. The fifth, lab_critical_thresholds, was in that
 * registry through two rounds of review and was WITHDRAWN: a copied threshold
 * either ties the reader's best match rank or disagrees with the tenant's
 * lab_reference_ranges, and either way the lab result is REJECTED rather than
 * merely unalerted. It is exempted below, its remaining gap is parked in
 * docs/ROADMAP.md, and the withdrawal itself is pinned by the
 * `lab_critical_thresholds stays withdrawn` suite so a third attempt has to
 * delete an assertion rather than slip through.
 *
 * This suite is what stops the SIXTH table from repeating the pattern: it
 * re-derives, from the migration SQL plus prisma/schema.prisma, every
 * tenant-scoped table that receives a default-tenant-pinned seed, and fails
 * when one is neither in the registry nor on the explicit exemption list below.
 *
 * When this test fails on a table you just seeded, the question to answer is
 * "should a NEW tenant inherit these rows?" — then either add a registry entry
 * plus a backfill migration, or add the table below with the reason it must not
 * inherit. Both answers are cheap; discovering the answer in an audit is not.
 *
 * WHAT "EVERY … PINNED SEED" MEANS HERE, precisely — the first version of this
 * classifier claimed it and had SIX holes; review closed three, then found
 * three more. Two of the six were already in the tree (migrations 311 and 403).
 * All six are closed, and each has a regression case in `classifier coverage`
 * below that fails against the classifier as it stood before that route:
 *
 *   1. The pinning tenant may be a PL/pgSQL variable rather than the literal
 *      UUID (`v_tenant uuid := '0000…0001'` … `VALUES (v_tenant, …)`, the shape
 *      migration 311 uses). Variables bound to the default tenant anywhere in
 *      the file are resolved and count as naming it.
 *   2. `INSERT INTO t SELECT …` with NO column list still supplies tenant_id —
 *      it just does not name it. Such a statement is classified on whether it
 *      names the default tenant, not skipped. The same applies to the
 *      `INSERT INTO t AS alias (cols…)` form, whose column list the original
 *      regex could not see past the alias.
 *   3. Reading the `tenants` table is only a fan-out when the scan is NOT
 *      narrowed to one row. `SELECT id FROM tenants WHERE slug = 'default'` is
 *      a PIN written the long way, and is now classified as one.
 *   4. …but route 3's early-out then ran AHEAD of everything else, so a
 *      statement that scans `tenants` un-narrowed for a reason unrelated to the
 *      tenant it writes (`JOIN tenants t ON t.id = s.tenant_id` as an existence
 *      check) was dismissed as a fan-out before its literal pin was considered.
 *      The classifier now locates tenant_id in the INSERT's column list and
 *      reads the expression at that position FIRST; only when that expression
 *      is not itself the default tenant does the fan-out early-out decide.
 *      That is also what keeps 727/728's own backfills fanned out — they carry
 *      the default-tenant literal, but in the clause that selects the SOURCE
 *      rows, while tenant_id is supplied by `t.id`.
 *   5. `VALUES (DEFAULT, …)` NAMES tenant_id and supplies nothing for it, so
 *      the column DEFAULT is what lands the row — but naming tenant_id used to
 *      be read as "the statement supplies it", and only the statement was then
 *      searched for the default tenant. The column DEFAULT now decides that
 *      shape too. Which defaults count is spelled out on
 *      `defaultLandsOnDefaultTenant`, and deliberately includes a COALESCE
 *      whose arguments are REVERSED — `COALESCE('<default>', current_setting(…))`
 *      never reaches the GUC, so it pins the default tenant for a migration and
 *      for every application write alike.
 *   6. A `;`-delimited chunk can hold more than one INSERT, and only the first
 *      was ever looked at: a data-modifying CTE
 *      (`WITH x AS (INSERT INTO a … RETURNING …) INSERT INTO b …`) hid table `b`
 *      entirely — the shape migration 403 ships. Every INSERT in a chunk is now
 *      classified, each on its own text (see `insertSites`).
 *
 * WHAT IT STILL CANNOT SEE, stated so nobody mistakes silence for coverage.
 * These are limits of the classifier, not of the registry:
 *
 *   a. Only migrations. It reads src/migrations/*.sql; rows written by
 *      application code are outside it entirely.
 *   b. Values it cannot constant-fold: a function call, or a variable assigned
 *      from a query (`SELECT id INTO v FROM tenants WHERE slug='default'`) or
 *      bound by `DECLARE v uuid DEFAULT '<default>'` rather than `:=`. No
 *      instance today — the tree's only `SELECT … INTO` reads from `tenants`
 *      (591, 596, 597) take a settings value, not a tenant id.
 *   c. Transitive pins. `INSERT INTO a … SELECT src.tenant_id … FROM src`,
 *      where `src` itself holds only default-tenant rows, reads as "supplied by
 *      the source". Each statement is judged on its own text; nothing here
 *      follows the data from one table to another.
 *   d. A `tenants` narrowing that is not a scalar equality — `id IN (…)`,
 *      `= ANY(…)`, a scalar subquery — reads as un-narrowed, so such a
 *      statement is a fan-out unless the value it writes into tenant_id is
 *      itself the default tenant. No instance in the tree today.
 *   e. Comments are stripped per line, so a `--` INSIDE a string literal
 *      truncates that literal — 311:164, 311:178 and 056:59 all do this today.
 *      A default-tenant literal written after such a `--` would disappear
 *      before the classifier ever saw it, and the unbalanced quote left behind
 *      can make the tenant_id value reader mis-split the value list. Of the
 *      three, only 311's two statements target a tenant-scoped table, and both
 *      still resolve correctly because the truncation falls after the tenant_id
 *      position — but nothing here verifies that for the next one.
 *   f. The column DEFAULT it consults is the one in the CURRENT
 *      prisma/schema.prisma, not the one in force when the migration ran. A
 *      default a later migration adds, changes, or drops silently re-decides
 *      every historical seed on that table.
 *   g. Table names resolve against prisma MODEL names, so a write to a name
 *      with no model is skipped — today only migration 255's
 *      `CREATE TEMP TABLE vh_current_bed_seed`, which is correct, but a real
 *      table missing from schema.prisma would be skipped just as quietly.
 */

const queryRawMock = jest.fn();
const executeRawMock = jest.fn().mockResolvedValue(1);

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawMock,
    $executeRawUnsafe: executeRawMock,
  },
}));

const {
  DEFAULT_TENANT_ID,
  PROVISIONING_GUARD_KINDS,
  TENANT_PROVISIONING_REGISTRY,
  TENANT_PROVISIONED_TABLES,
  guardKeyBaseColumn,
  buildTenantCopySql,
  buildTenantBackfillSql,
} = await import('../../services/tenant/tenantProvisioningRegistry.js');
const { createTenant } = await import('../../services/tenant/tenantService.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(HERE, '../../..');
const MIGRATIONS_DIR = path.join(BACKEND_ROOT, 'src/migrations');
const SCHEMA_PATH = path.join(BACKEND_ROOT, 'prisma/schema.prisma');

// Migration SQL is LF-pinned, while the Prisma schema and historical blobs can
// still arrive as CRLF. Normalising keeps the byte-compare below a statement
// about content rather than about the host.
function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

// ---------------------------------------------------------------------------
// EXEMPTIONS — tenant-scoped tables that DO get a default-tenant-pinned seed and
// deliberately do NOT provision to new tenants. Every entry states why.
// ---------------------------------------------------------------------------

// (A) Not per-tenant configuration at all: the migration writes evidence or
//     repairs existing data. Nothing for a new tenant to inherit.
const EXEMPT_NOT_CONFIGURATION = {
  audit_logs: 'every migration stamps its own audit row — provenance, not config',
  billing_advances: '206 mirrors existing advance rows into a new table (data backfill)',
  india_compliance_evidence: 'compliance evidence captured for the founding deployment',
  users: '082 repairs FK-referenced user rows; identities are never copied between tenants',
};

// (B) The founding hospital's own physical plant and rota. A second hospital's
//     beds, wards, theatres and shifts are different by definition — copying
//     them would be actively wrong — and each has an operator write path.
const EXEMPT_SITE_SPECIFIC = {
  beds: 'physical plant; bedService owns the write path',
  wards: 'physical plant; bedService owns the write path',
  housekeeping_zones: 'physical plant; housekeepingController owns the write path',
  or_rooms: 'physical plant; orBoardService owns the write path',
  staff_shifts: 'per-hospital rota; shiftService owns the write path',
};

// (C) Operator-authored content with a real service/route INSERT path, so a
//     tenant can populate it without hand-written SQL. The default-tenant seed
//     is a convenience for the founding install, not a baseline other tenants
//     silently depend on. (Contrast lab_critical_thresholds in block D, which
//     has no write path at all — so a tenant cannot fix it by itself either.)
const EXEMPT_OPERATOR_AUTHORED = {
  billing_service_master: 'billingV2Service',
  packages: 'billingMastersService',
  payers: 'billingMastersService',
  tpas: 'billingMastersService',
  pharmacy_catalog: 'pharmacyOrderController',
  clinical_order_sets: 'orderSetGovernanceService / orderSetsService',
  clinical_order_set_items: 'orderSetGovernanceService / orderSetsService',
  clinical_ai_prompts: 'clinicalAiWorkflowService',
  smart_phrases: 'smartPhrasesService',
  data_processing_activities: 'dataProcessingActivityService',
  data_retention_policies: 'dataRetentionPolicyService',
  // Migration 311's starter dataset, surfaced once the classifier learned to
  // resolve the DO block's `v_tenant` variable (route 1 above). Decided here
  // rather than parked: both rows are titled "Sample …(starter)" and carry
  // metadata {is_starter:true, sample:true}, and 311's own header calls them a
  // starter dataset "demonstrable in CI without live hospital data". Copying a
  // demo formulary and a demo antibiogram into a real second hospital would put
  // fabricated clinical content in front of its clinicians, so a new tenant
  // must NOT inherit them — and does not need to: knowledgeBaseService and
  // knowledgeDocumentService own real INSERT paths, and
  // scripts/knowledge-curation-import.mjs builds the real thing from that
  // tenant's own pharmacy_catalog / antibiogram_90d.
  knowledge_bases: '311 seeds SAMPLE/starter KBs only; knowledgeBaseService owns the write path',
  knowledge_documents: '311 seeds SAMPLE documents only; knowledgeDocumentService owns the write path',
  // WITHDRAWN from the registry on 2026-08-24 after three rounds of review.
  // Unlike the lab thresholds this HAS an operator path — PUT
  // /api/v1/admin/workflow/escalation-rules (taskService.upsertEscalationRule)
  // — so a tenant can author its own tiers. The copy was withdrawn because it
  // cannot be keyed safely: the semantic-tier key omits match_filter.task_kind
  // and .priority that buildEligibilitySql matches on (silently denying a
  // tenant the platform tier), while its NOT EXISTS never compares source rows
  // against each other (amplifying one operator's duplicate tier into every
  // tenant — reproduced on a scratch DB). Copied tiers page the security
  // webhook through dispatchAction and resolve notify_role DUTY/LEADERSHIP
  // against `users`, which nothing here provisions. Coverage is reported by
  // canaryHealthCheck instead, and the sweep no longer depends on the table
  // for its tenant set.
  escalation_rules: 'operator-authored via taskService.upsertEscalationRule; copy withdrawn — see canary coverage',
};

// (D) SAME CLASS AS THE REGISTRY, NOT REMEDIATED HERE. Default-tenant-only seed,
//     no INSERT path found in non-test source — so a second tenant cannot obtain
//     these rows at all. Each needs a clinical or commercial owner decision on
//     whether the founding hospital's rows are a safe platform baseline to
//     inherit. They are listed here to keep the guard green WITHOUT hiding them:
//     this block is the backlog.
//     Two tables moved on 2026-08-24, in opposite directions. workflow_sla_rules
//     LEFT: it is now the fourth registry entry, backfilled by 728, because a
//     missing rule is not only a silent gap — it makes pathwayRuntimePersistence
//     throw and leaves 728's own escalation tiers with nothing to match.
//     lab_critical_thresholds ARRIVED, withdrawn from the registry after two
//     rounds of review; its entry below carries the reason.
const EXEMPT_UNRESOLVED_BASELINE = {
  lab_reference_ranges: 'reference intervals are a lab-methodology decision, not a copy',
  // WITHDRAWN FROM THE REGISTRY on 2026-08-24 after two rounds of review, not
  // merely never added. Both are halves of ONE clinical policy that must agree:
  // labPanelService.assertCriticalPolicyAgreement compares the
  // reference-range-derived critical assessment against the
  // lab_critical_thresholds-derived one and throws LAB_CRITICAL_POLICY_MISMATCH
  // on any disagreement (`policy_presence` when only one side is configured,
  // `threshold_unit` when the units differ), and evaluateCriticalThreshold has
  // its own ambiguity and unit throws. Copying thresholds alone therefore made
  // every backfilled tenant REJECT lab results — worse than the silent
  // non-alert. They must be provisioned together, with clinical sign-off on the
  // limits, the intervals and the units. Parked in docs/ROADMAP.md.
  lab_critical_thresholds: 'critical limits must agree with lab_reference_ranges and units; '
    + 'auto-copy attempted twice and withdrawn — needs clinical sign-off, see docs/ROADMAP.md',
  vaccine_catalogue: 'national schedule, but versioned — needs an owner on which release to seed',
  pmjay_packages: 'national PMJAY package master; empanelment differs per hospital',
  ledger_accounts: 'chart of accounts; finance owner decision',
  or_procedure_catalog: 'surgical catalogue; scope of services differs per hospital',
  radiology_report_templates: 'reporting templates; radiology owner decision',
  radiology_peer_review_settings: 'peer-review policy; radiology owner decision',
  discharge_summary_templates: 'document templates; medical-records owner decision',
  maternity_anc_advice: 'patient-facing ANC advice content; clinical owner decision',
};

const EXEMPT_TABLES = new Map([
  ...Object.entries(EXEMPT_NOT_CONFIGURATION),
  ...Object.entries(EXEMPT_SITE_SPECIFIC),
  ...Object.entries(EXEMPT_OPERATOR_AUTHORED),
  ...Object.entries(EXEMPT_UNRESOLVED_BASELINE),
]);

// ---------------------------------------------------------------------------
// Enumeration. Static: reads the committed migration SQL and schema.prisma, so
// it needs no database and cannot go stale against one.
// ---------------------------------------------------------------------------

/**
 * Does a tenant_id column DEFAULT land the row on the DEFAULT TENANT when a
 * migration is what runs the INSERT? Three spellings reach that outcome, and
 * every one of them carries the default-tenant literal somewhere inside the
 * default expression — so keying on the literal is exhaustive BY CONSTRUCTION,
 * not by luck:
 *
 *   DEFAULT '<default tenant>'::uuid
 *       the pre-400 form (ledger_accounts 342, ledger_balances 345,
 *       appointment_archive 346, reconciliation_checks 349). Always the
 *       default tenant.
 *   DEFAULT COALESCE(current_setting('app.current_tenant_id', true), '<default tenant>')
 *       the house idiom. A migration runs with that GUC unset, so the fallback
 *       is what lands.
 *   DEFAULT COALESCE('<default tenant>', current_setting('app.current_tenant_id', true))
 *       the same idiom with the arguments REVERSED. COALESCE returns its first
 *       non-null argument, so the GUC is never reached: this one pins the
 *       default tenant for a migration AND for every application write.
 *
 * Do not narrow this to a `DEFAULT '<literal>'` pattern and do not drop
 * defaults that contain COALESCE. Either narrowing keeps the first form and
 * loses the third — the one spelling that is a hardcoded pin under every
 * caller rather than only under a migration.
 *
 * @param {string} fieldSuffix  the schema.prisma tenant_id line after its type
 */
function defaultLandsOnDefaultTenant(fieldSuffix) {
  return fieldSuffix.includes(DEFAULT_TENANT_ID);
}

/**
 * Tables with a tenant_id column, and whether that column DEFAULTS to the
 * default tenant. The default is what makes an INSERT that omits tenant_id —
 * or writes the bare keyword `DEFAULT` into it — land on the default tenant
 * instead of being a global row: the distinction that separates
 * lab_critical_thresholds (defaulted → pinned) from a table whose tenant_id is
 * nullable with no such default.
 *
 * Lookup is by prisma MODEL name. Every model in this schema is named for its
 * table except `migrations`/`_migrations`, so a name a migration writes to and
 * this map does not hold is not a table at all — today the only such name is
 * migration 255's `vh_current_bed_seed`, a CREATE TEMP TABLE.
 */
function readTenantScopedTables() {
  const schema = readText(SCHEMA_PATH);
  const tables = new Map();
  const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let match;
  while ((match = modelRe.exec(schema))) {
    const field = /^\s*tenant_id\s+(\S+)(.*)$/m.exec(match[2]);
    if (!field) continue;
    tables.set(match[1], { defaultsToDefaultTenant: defaultLandsOnDefaultTenant(field[2]) });
  }
  return tables;
}

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(name => name.endsWith('.sql'))
    // 000_baseline.sql is a schema-only pg_dump: DDL, no seeds.
    .filter(name => name !== '000_baseline.sql')
    .sort();
}

const DEFAULT_TENANT_SLUG = 'default'; // migrations 012/013/300 seed it.

// `INSERT INTO [public.]table [AS alias] [(cols…)]`. The optional alias matters:
// without it the column list of an upsert written `INSERT INTO t AS target (…)`
// is invisible, and the statement falls into the no-column-list branch.
const INSERT_RE = /\bINSERT\s+INTO\s+(?:public\.)?"?(\w+)"?(?:\s+AS\s+[a-z_][a-z0-9_]*)?\s*(\(([^)]*)\))?/i;
const INSERT_SITE_RE = new RegExp(INSERT_RE.source, 'gi');

/**
 * Every INSERT in one `;`-delimited chunk, and the text each one is classified
 * on. A chunk holds more than one when a data-modifying CTE writes a row and
 * feeds it forward — migration 403's shape:
 *
 *   WITH dental_items(…) AS (VALUES …),
 *        service_master_upsert AS (
 *          INSERT INTO billing_service_master (…) SELECT … RETURNING tenant_id, code
 *        )
 *   INSERT INTO service_catalog (…) SELECT …
 *
 * A single `INSERT_RE.exec` returns only the first, so the SECOND target table
 * was never even looked up — the classifier decided about billing_service_master
 * and service_catalog was invisible.
 *
 * Each site is classified on its OWN text — from its `INSERT INTO` to the start
 * of the next one — prefixed with the chunk's preamble (the `WITH` list, or a
 * DO block's `DECLARE`). The preamble is what keeps a CTE's narrowing visible;
 * cutting at the next `INSERT INTO` is what stops a SIBLING insert's `tenants`
 * fan-out, or its default-tenant literal, from deciding this one.
 *
 * @param {string} chunk  comment-stripped SQL
 * @returns {Array<{table: string, text: string}>}
 */
function insertSites(chunk) {
  INSERT_SITE_RE.lastIndex = 0;
  const matches = [...chunk.matchAll(INSERT_SITE_RE)];
  if (matches.length === 0) return [];
  const preamble = chunk.slice(0, matches[0].index);
  return matches.map((match, index) => ({
    table: match[1],
    text: preamble + chunk.slice(match.index, matches[index + 1]?.index ?? chunk.length),
  }));
}

// A tenants scan, capturing its alias: `FROM tenants t`, `JOIN tenants AS x`.
const TENANTS_SCAN_RE = /\b(?:FROM|JOIN)\s+(?:public\.)?tenants\b(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi;

// Words that can follow `tenants` and are keywords, not an alias.
const NOT_AN_ALIAS = new Set([
  'as', 'on', 'where', 'cross', 'inner', 'left', 'right', 'full', 'join',
  'natural', 'group', 'order', 'limit', 'union', 'select', 'having', 'using',
  'returning', 'set', 'and', 'or',
]);

// The right-hand side of a single-row narrowing: a literal, a bind parameter,
// or a bare identifier. `(?![.\w])` is what keeps a COLUMN reference out —
// `tenant.id = header.tenant_id` is a join condition across many tenants, not a
// narrowing to one.
const SCALAR_RHS = "(?:'([^']*)'|\\$\\d+|([a-z_][a-z0-9_]*)(?![.\\w]))";

/**
 * PL/pgSQL variables bound to the default tenant by a literal assignment
 * anywhere in the file (`v_tenant uuid := '0000…0001';`). Migration 311 pins
 * its starter seed through one of these instead of writing the UUID inline.
 */
function defaultTenantVariables(sql) {
  const names = new Set();
  const re = new RegExp(`\\b([a-z_][a-z0-9_]*)\\s*(?:uuid\\s*)?:=\\s*'${DEFAULT_TENANT_ID}'`, 'gi');
  let m;
  while ((m = re.exec(sql))) names.add(m[1].toLowerCase());
  return names;
}

/** Does this statement pin the default tenant, literally or through a variable? */
function namesDefaultTenant(statement, variables) {
  if (statement.includes(DEFAULT_TENANT_ID)) return true;
  return [...variables].some(name => new RegExp(`\\b${name}\\b`, 'i').test(statement));
}

/**
 * How a statement uses the `tenants` table.
 *
 * Reading it is only a FAN-OUT while the scan stays unnarrowed (the
 * `FROM tenants t CROSS JOIN …` shape of migrations 434, 727, 728). A scan
 * narrowed by `slug = …` / `id = …` against a literal, bind parameter, or
 * variable selects ONE tenant, and when that one is the default tenant the
 * statement is a pin written the long way.
 */
function classifyTenantsScan(statement, variables) {
  let reads = false;
  let narrowedToOne = false;
  let narrowedToDefault = false;
  TENANTS_SCAN_RE.lastIndex = 0;
  let scan;
  while ((scan = TENANTS_SCAN_RE.exec(statement))) {
    reads = true;
    let alias = scan[1] ? scan[1].toLowerCase() : null;
    if (alias && NOT_AN_ALIAS.has(alias)) alias = null;
    const qualifier = alias ? `${alias}\\.` : '(?:[a-z_][a-z0-9_]*\\.)?';
    const narrowRe = new RegExp(`\\b${qualifier}(slug|id)\\s*=\\s*${SCALAR_RHS}`, 'gi');
    let narrow;
    while ((narrow = narrowRe.exec(statement))) {
      const [, column, literal, identifier] = narrow;
      narrowedToOne = true;
      if (literal != null) {
        if (column.toLowerCase() === 'slug' && literal === DEFAULT_TENANT_SLUG) {
          narrowedToDefault = true;
        }
        if (column.toLowerCase() === 'id' && literal === DEFAULT_TENANT_ID) {
          narrowedToDefault = true;
        }
      } else if (identifier && variables.has(identifier.toLowerCase())) {
        narrowedToDefault = true;
      }
    }
  }
  return { reads, narrowedToOne, narrowedToDefault };
}

// ---------------------------------------------------------------------------
// Reading the VALUE a statement supplies for tenant_id.
//
// `namesDefaultTenant` asks whether the default tenant appears ANYWHERE in the
// statement, which cannot tell a pin from a source filter: migration 727's
// backfill fans out over every tenant and still carries the literal, in
// `WHERE d.tenant_id = '<default>'::uuid`. Locating the tenant_id column in the
// INSERT's column list and reading the expression at that position is what
// separates the two — and it is what lets a pin be recognised in a statement
// that also scans `tenants` for some other purpose.
// ---------------------------------------------------------------------------

/** Walk `text` tracking paren depth and single-quoted literals ('' escapes). */
function scanSql(text, visit) {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === "'") {
        if (text[i + 1] === "'") i += 1;
        else quoted = false;
      }
      continue;
    }
    if (ch === "'") { quoted = true; continue; }
    if (ch === '(') { depth += 1; continue; }
    if (ch === ')') { depth -= 1; continue; }
    const stop = visit(i, depth);
    if (stop !== undefined) return stop;
  }
  return -1;
}

/** Split a comma-separated SQL list on its DEPTH-0 commas. */
function splitTopLevel(text) {
  const cuts = [];
  scanSql(text, (i, depth) => {
    if (depth === 0 && text[i] === ',') cuts.push(i);
    return undefined;
  });
  const parts = [];
  let from = 0;
  for (const cut of [...cuts, text.length]) {
    parts.push(text.slice(from, cut).trim());
    from = cut + 1;
  }
  return parts;
}

/** Index of the first depth-0 occurrence of any of `words`, or -1. */
function indexOfTopLevelKeyword(text, words) {
  return scanSql(text, (i, depth) => {
    if (depth !== 0) return undefined;
    const before = i === 0 ? ' ' : text[i - 1];
    if (/[a-z0-9_]/i.test(before)) return undefined;
    for (const word of words) {
      if (text.slice(i, i + word.length).toUpperCase() !== word) continue;
      const after = text[i + word.length] ?? ' ';
      if (!/[a-z0-9_]/i.test(after)) return i;
    }
    return undefined;
  });
}

/**
 * The expressions a statement supplies for tenant_id: one per VALUES tuple, or
 * one for the SELECT list. Empty when the shape is not one this file reads — no
 * column list, no tenant_id in it, a source clause that is neither `VALUES (…)`
 * nor `SELECT …`, or a value list too short to reach the tenant_id position.
 *
 * Empty means UNKNOWN, never "not a pin", and so does an expression this file
 * cannot resolve (a `*`, a function call, a bind parameter): every caller falls
 * back to the whole-statement tests below rather than concluding anything.
 */
function tenantIdValueExpressions(statement, insert) {
  if (!insert[2]) return [];
  const columns = insert[3].split(',').map(c => c.trim().replace(/"/g, '').toLowerCase());
  const position = columns.indexOf('tenant_id');
  if (position < 0) return [];

  const body = statement.slice(insert.index + insert[0].length);
  const head = /^\s*/.exec(body)[0].length;

  const values = /^VALUES\s*\(/i.exec(body.slice(head));
  if (values) {
    const clause = body.slice(head + values[0].length - 1);
    const stop = indexOfTopLevelKeyword(clause, ['ON', 'RETURNING']);
    return splitTopLevel(stop < 0 ? clause : clause.slice(0, stop))
      .filter(tuple => tuple.startsWith('('))
      .map(tuple => splitTopLevel(tuple.slice(1, tuple.lastIndexOf(')'))))
      .filter(row => row.length > position)
      .map(row => row[position]);
  }

  const select = /^SELECT\s+(?:DISTINCT\s+(?:ON\s*\([^)]*\)\s*)?)?/i.exec(body.slice(head));
  if (select) {
    const clause = body.slice(head + select[0].length);
    const stop = indexOfTopLevelKeyword(clause, ['FROM', 'WHERE', 'RETURNING', 'ON']);
    const list = splitTopLevel(stop < 0 ? clause : clause.slice(0, stop));
    return list.length > position ? [list[position]] : [];
  }

  return [];
}

/**
 * Is this one statement a seed pinned to the default tenant?
 *
 * @param {string} statement       comment-stripped SQL
 * @param {{defaultsToDefaultTenant: boolean}} meta  the target table
 * @param {Set<string>} variables  default-tenant variables in scope
 */
function isDefaultTenantPinnedInsert(statement, meta, variables) {
  const insert = INSERT_RE.exec(statement);
  if (!insert) return false;

  const supplied = tenantIdValueExpressions(statement, insert);
  // The value written into tenant_id IS the default tenant. Decided here,
  // ahead of the fan-out early-out below: a statement may scan `tenants`
  // un-narrowed for a reason that has nothing to do with the tenant it writes
  // (`JOIN tenants t ON t.id = s.tenant_id` as an existence check), and the
  // early-out used to discard it before the literal was ever considered.
  if (supplied.some(expr => namesDefaultTenant(expr, variables))) return true;
  // `VALUES (DEFAULT, …)` NAMES tenant_id and supplies nothing for it, so the
  // column DEFAULT is what lands the row even though the column list mentions
  // it. Only ever adds a finding: a table whose default is not the default
  // tenant falls through to the tests below unchanged.
  if (meta.defaultsToDefaultTenant && supplied.some(expr => /^DEFAULT$/i.test(expr))) return true;

  const scan = classifyTenantsScan(statement, variables);
  if (scan.reads && !scan.narrowedToOne) return false; // genuine fan-out
  if (scan.narrowedToDefault) return true;

  const hasColumnList = Boolean(insert[2]);
  const columns = (insert[3] || '').split(',').map(c => c.trim().replace(/"/g, ''));
  // No column list means every column is supplied positionally, tenant_id
  // included — the column DEFAULT is unreachable, so only what the statement
  // names can pin it.
  if (!hasColumnList) return namesDefaultTenant(statement, variables);
  if (columns.includes('tenant_id')) return namesDefaultTenant(statement, variables);
  // tenant_id omitted from an explicit column list → the column DEFAULT decides.
  return meta.defaultsToDefaultTenant;
}

/**
 * @returns {Map<string, string[]>} table → migrations that seed it for the
 * default tenant only.
 */
function findDefaultTenantPinnedSeeds() {
  const tenantTables = readTenantScopedTables();
  const found = new Map();
  for (const file of migrationFiles()) {
    const sql = readText(path.join(MIGRATIONS_DIR, file))
      .split('\n')
      .map(line => line.replace(/--.*$/, ''))
      .join('\n');
    const variables = defaultTenantVariables(sql);
    for (const chunk of sql.split(/;\s*\n/)) {
      // EVERY insert in the chunk, not just the first — see insertSites.
      for (const site of insertSites(chunk)) {
        const meta = tenantTables.get(site.table);
        if (!meta) continue;
        if (!isDefaultTenantPinnedInsert(site.text, meta, variables)) continue;

        if (!found.has(site.table)) found.set(site.table, []);
        if (!found.get(site.table).includes(file)) found.get(site.table).push(file);
      }
    }
  }
  return found;
}

describe('tenant provisioning registry — the durable guard', () => {
  const pinnedSeeds = findDefaultTenantPinnedSeeds();

  it('finds default-tenant-pinned seeds at all (the enumeration is not silently empty)', () => {
    // A regex that stops matching would make every other assertion here vacuous.
    expect(pinnedSeeds.size).toBeGreaterThan(20);
    for (const table of TENANT_PROVISIONED_TABLES) {
      expect([...pinnedSeeds.keys()]).toContain(table);
    }
  });

  it('leaves no default-tenant-seeded config table undecided', () => {
    const undecided = [...pinnedSeeds.entries()]
      .filter(([table]) => !TENANT_PROVISIONED_TABLES.includes(table))
      .filter(([table]) => !EXEMPT_TABLES.has(table))
      .map(([table, files]) => `${table} (seeded by ${files.join(', ')})`);

    expect(undecided).toEqual([]);
  });

  it('keeps the exemption list free of tables that no longer have such a seed', () => {
    // A stale exemption is a licence for a future seed to slip through unread.
    const stale = [...EXEMPT_TABLES.keys()].filter(table => !pinnedSeeds.has(table));
    expect(stale).toEqual([]);
  });

  it('never exempts and provisions the same table', () => {
    const both = TENANT_PROVISIONED_TABLES.filter(table => EXEMPT_TABLES.has(table));
    expect(both).toEqual([]);
  });

  it('states a non-empty reason for every exemption', () => {
    for (const [table, reason] of EXEMPT_TABLES) {
      expect(typeof reason).toBe('string');
      expect(reason.trim().length).toBeGreaterThan(10);
      expect(table).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('classifier coverage — the six routes that used to evade the guard', () => {
  const meta = { defaultsToDefaultTenant: true };
  const noMeta = { defaultsToDefaultTenant: false };

  it('resolves a tenant id held in a PL/pgSQL variable (migration 311)', () => {
    const sql = [
      "  v_tenant   uuid := '00000000-0000-4000-8000-000000000001';",
      '  INSERT INTO knowledge_bases (tenant_id, name)',
      "  VALUES (v_tenant, 'Sample Formulary (starter)')",
    ].join('\n');
    const variables = defaultTenantVariables(sql);
    expect(variables.has('v_tenant')).toBe(true);
    expect(isDefaultTenantPinnedInsert(sql, meta, variables)).toBe(true);
    // …and it is the live migration, not just this fixture, that is caught.
    expect([...findDefaultTenantPinnedSeeds().get('knowledge_bases')])
      .toContain('311_knowledge_curation.sql');
  });

  it('classifies an INSERT … SELECT with no column list instead of skipping it', () => {
    const pinned = "INSERT INTO some_config SELECT '00000000-0000-4000-8000-000000000001'::uuid, 'x'";
    const notPinned = 'INSERT INTO some_config SELECT candidate.* FROM candidate';
    // The column DEFAULT is unreachable without a column list, so
    // defaultsToDefaultTenant must not decide it either way.
    expect(isDefaultTenantPinnedInsert(pinned, noMeta, new Set())).toBe(true);
    expect(isDefaultTenantPinnedInsert(notPinned, meta, new Set())).toBe(false);
  });

  it('reads the column list through an `AS alias` upsert target', () => {
    const sql = 'INSERT INTO user_devices AS target (tenant_id, user_uid) VALUES (p_tenant_id, p_uid)';
    // tenant_id IS declared and comes from a parameter — not a default-tenant pin.
    expect(isDefaultTenantPinnedInsert(sql, meta, new Set())).toBe(false);
  });

  it('treats a tenants scan narrowed to the default tenant as a pin, not a fan-out', () => {
    const narrowed = "INSERT INTO some_config (tenant_id, k) SELECT id, 'v' FROM tenants WHERE slug = 'default'";
    const narrowedById = "INSERT INTO some_config (tenant_id, k) SELECT id, 'v' FROM tenants WHERE id = '00000000-0000-4000-8000-000000000001'";
    const fanout = "INSERT INTO some_config (tenant_id, k) SELECT t.id, 'v' FROM tenants t";
    expect(isDefaultTenantPinnedInsert(narrowed, meta, new Set())).toBe(true);
    expect(isDefaultTenantPinnedInsert(narrowedById, meta, new Set())).toBe(true);
    expect(isDefaultTenantPinnedInsert(fanout, meta, new Set())).toBe(false);
  });

  it('does not mistake a join condition on tenants.id for a narrowing', () => {
    // migration 595's shape: `JOIN tenants AS tenant ON tenant.id = header.tenant_id`
    // reaches every tenant, so it must stay a fan-out.
    const sql = 'INSERT INTO some_config (tenant_id, k) '
      + 'SELECT header.tenant_id, header.k FROM header '
      + 'JOIN tenants AS tenant ON tenant.id = header.tenant_id';
    expect(classifyTenantsScan(sql, new Set()))
      .toEqual({ reads: true, narrowedToOne: false, narrowedToDefault: false });
    expect(isDefaultTenantPinnedInsert(sql, meta, new Set())).toBe(false);
  });

  it('reads a literal pin that ALSO scans tenants un-narrowed (route 4)', () => {
    // The un-narrowed `tenants` scan here is an existence check on the source
    // row, not the thing that supplies tenant_id — the literal is. Route 3 put
    // the fan-out early-out ahead of every other test, so this statement was
    // dismissed as a fan-out before the literal was ever considered. The value
    // written into tenant_id now decides first.
    const sql = 'INSERT INTO some_config (tenant_id, k) '
      + "SELECT '00000000-0000-4000-8000-000000000001'::uuid, s.k "
      + 'FROM staging s JOIN tenants t ON t.id = s.tenant_id';
    // The scan itself is still, correctly, an un-narrowed one …
    expect(classifyTenantsScan(sql, new Set()))
      .toEqual({ reads: true, narrowedToOne: false, narrowedToDefault: false });
    // … and the statement is still, correctly, a pin. `noMeta` proves the
    // verdict comes from the literal and not from the column DEFAULT.
    expect(tenantIdValueExpressions(sql, INSERT_RE.exec(sql)))
      .toEqual(["'00000000-0000-4000-8000-000000000001'::uuid"]);
    expect(isDefaultTenantPinnedInsert(sql, noMeta, new Set())).toBe(true);

    // The shape this must NOT break: 727/728's own backfill carries the same
    // literal, but in the clause that SELECTS the source rows, while tenant_id
    // is supplied by the fan-out. It stays a fan-out.
    const backfill = "INSERT INTO some_config (tenant_id, k) SELECT t.id, d.k "
      + 'FROM tenants t CROSS JOIN some_config d '
      + "WHERE d.tenant_id = '00000000-0000-4000-8000-000000000001'::uuid "
      + "AND t.id <> '00000000-0000-4000-8000-000000000001'::uuid";
    expect(tenantIdValueExpressions(backfill, INSERT_RE.exec(backfill))).toEqual(['t.id']);
    expect(isDefaultTenantPinnedInsert(backfill, meta, new Set())).toBe(false);
  });

  it('lets the column DEFAULT decide when the statement writes DEFAULT (route 5)', () => {
    // `VALUES (DEFAULT, …)` NAMES tenant_id and supplies nothing for it, so the
    // column DEFAULT is what lands the row. The classifier read "tenant_id is
    // in the column list" as "the statement supplies it" and asked only whether
    // the STATEMENT named the default tenant — which this one does not.
    const sql = "INSERT INTO some_config (tenant_id, k) VALUES (DEFAULT, 'v')";
    expect(isDefaultTenantPinnedInsert(sql, meta, new Set())).toBe(true);
    expect(isDefaultTenantPinnedInsert(sql, noMeta, new Set())).toBe(false);

    // …and `meta` is read off the column DEFAULT, which pins the default tenant
    // in all three spellings — including the reversed COALESCE, whose literal
    // is the FIRST argument, so the GUC is never reached and every caller lands
    // on the default tenant. A census keyed on `DEFAULT '<literal>'`, or one
    // that drops any default containing COALESCE, loses exactly that spelling.
    const literal = ` String @default(dbgenerated("'${DEFAULT_TENANT_ID}'::uuid"))`;
    const houseIdiom = ' String @default(dbgenerated("COALESCE((NULLIF(current_setting('
      + `'app.current_tenant_id'::text, true), ''::text))::uuid, '${DEFAULT_TENANT_ID}'::uuid)"))`;
    const reversed = ` String @default(dbgenerated("COALESCE('${DEFAULT_TENANT_ID}'::uuid, `
      + '(NULLIF(current_setting(\'app.current_tenant_id\'::text, true), \'\'::text))::uuid)"))';
    expect(defaultLandsOnDefaultTenant(literal)).toBe(true);
    expect(defaultLandsOnDefaultTenant(houseIdiom)).toBe(true);
    expect(defaultLandsOnDefaultTenant(reversed)).toBe(true);
    expect(defaultLandsOnDefaultTenant(' String? @db.Uuid')).toBe(false);
  });

  it('classifies every INSERT in a data-modifying CTE, not just the first (route 6)', () => {
    // `INSERT_RE.exec` returns ONE match, so a chunk holding two INSERTs was
    // decided entirely on the first: the second target table was never even
    // looked up in schema.prisma.
    const sql = 'WITH seeded AS ('
      + 'INSERT INTO other_table (a) VALUES (1) RETURNING a'
      + ') INSERT INTO some_config (tenant_id, k) '
      + "SELECT '00000000-0000-4000-8000-000000000001'::uuid, seeded.a FROM seeded";
    expect(INSERT_RE.exec(sql)[1]).toBe('other_table'); // what the old walk saw
    const sites = insertSites(sql);
    expect(sites.map(site => site.table)).toEqual(['other_table', 'some_config']);
    expect(isDefaultTenantPinnedInsert(sites[1].text, noMeta, new Set())).toBe(true);

    // Each site carries the chunk's preamble but stops at the next INSERT, so a
    // SIBLING insert's fan-out cannot decide this one …
    const sibling = 'WITH fanned AS ('
      + "INSERT INTO other_table (tenant_id, a) SELECT t.id, 1 FROM tenants t RETURNING a"
      + ') INSERT INTO some_config (tenant_id, k) '
      + "VALUES ('00000000-0000-4000-8000-000000000001', 'v')";
    expect(isDefaultTenantPinnedInsert(insertSites(sibling)[1].text, noMeta, new Set())).toBe(true);
    // … and, symmetrically, a sibling's default-tenant literal cannot pin it.
    const litSibling = 'WITH pinned AS ('
      + "INSERT INTO other_table (tenant_id, a) VALUES ('00000000-0000-4000-8000-000000000001', 1) "
      + 'RETURNING a'
      + ") INSERT INTO some_config (tenant_id, k) SELECT t.id, 'v' FROM tenants t";
    expect(isDefaultTenantPinnedInsert(insertSites(litSibling)[1].text, meta, new Set())).toBe(false);

    // The live instance: migration 403's second INSERT was invisible. It is now
    // read, and it is a genuine fan-out (`FROM tenants t`), so seeing it adds no
    // finding — the hole was real even though nothing had fallen through it.
    const chunks = readText(path.join(MIGRATIONS_DIR, '403_dental_seed_billing_linkage.sql'))
      .split('\n').map(line => line.replace(/--.*$/, '')).join('\n')
      .split(/;\s*\n/);
    const multi = chunks.map(chunk => insertSites(chunk)).filter(sites2 => sites2.length > 1);
    expect(multi).toHaveLength(1);
    expect(multi[0].map(site => site.table))
      .toEqual(['billing_service_master', 'service_catalog']);
    expect(readTenantScopedTables().has('service_catalog')).toBe(true);
    expect(findDefaultTenantPinnedSeeds().has('service_catalog')).toBe(false);
  });

  it('still recognises the plain pinned and fanned-out shapes', () => {
    const literal = "INSERT INTO some_config (tenant_id, k) VALUES ('00000000-0000-4000-8000-000000000001', 'v')";
    const byDefault = "INSERT INTO some_config (k) VALUES ('v')";
    expect(isDefaultTenantPinnedInsert(literal, meta, new Set())).toBe(true);
    expect(isDefaultTenantPinnedInsert(byDefault, meta, new Set())).toBe(true);
    expect(isDefaultTenantPinnedInsert(byDefault, noMeta, new Set())).toBe(false);
  });
});

describe('registry declarations', () => {
  it('covers the three tables it provisions, with the defect each one causes', () => {
    // Three, not five: the audits found five tenant-scoped config tables
    // seeded default-tenant-only. lab_critical_thresholds and escalation_rules
    // are both WITHDRAWN — copying either can put a tenant into a state a
    // reader rejects or pages on. Both are exempted with a reason below, and
    // reported by the canary instead.
    expect(TENANT_PROVISIONED_TABLES).toEqual([
      'radiology_tat_thresholds',
      'ap_tat_thresholds',
      'workflow_sla_rules',
    ]);
    for (const entry of TENANT_PROVISIONING_REGISTRY) {
      expect(entry.why.length).toBeGreaterThan(20);
      expect(entry.seededBy).toMatch(/\.sql/);
      expect(entry.backfilledBy).toMatch(/^\d{3}_.*\.sql$/);
    }
  });

  it('never copies the surrogate key, the tenant, or the row clocks', () => {
    for (const entry of TENANT_PROVISIONING_REGISTRY) {
      for (const forbidden of ['id', 'tenant_id', 'created_at', 'updated_at']) {
        expect(entry.columns).not.toContain(forbidden);
      }
      expect(entry.columns.length).toBeGreaterThan(0);
      expect(new Set(entry.columns).size).toBe(entry.columns.length);
    }
  });

  it('gives every row_key guard its key columns and every guard a known kind', () => {
    const kinds = Object.values(PROVISIONING_GUARD_KINDS);
    for (const entry of TENANT_PROVISIONING_REGISTRY) {
      expect(kinds).toContain(entry.guardKind);
      if (entry.guardKind === PROVISIONING_GUARD_KINDS.ROW_KEY) {
        expect(entry.guardKeyColumns.length).toBeGreaterThan(0);
        // A guard may read INTO a copied column (`match_filter->>'sla_key'`),
        // but never a column the copy does not carry.
        for (const key of entry.guardKeyColumns) {
          expect(entry.columns).toContain(guardKeyBaseColumn(key));
        }
      } else {
        expect(entry.guardKeyColumns).toEqual([]);
      }
    }
  });

  it('escalation_rules stays withdrawn — no copy, no guard key to get wrong', () => {
    // Withdrawn 2026-08-24. The semantic-tier key was BOTH too coarse (it omits
    // match_filter.task_kind and .priority, which buildEligibilitySql matches
    // on, silently denying a tenant the platform tier) and not
    // self-deduplicating (the NOT EXISTS compares source rows only against the
    // target tenant's, so one operator's duplicate tier is amplified into every
    // tenant). Copied tiers also page the security webhook via dispatchAction
    // and resolve notify_role against `users`, which this registry does not
    // provision.
    expect(TENANT_PROVISIONED_TABLES).not.toContain('escalation_rules');
    const migration = readText(
      path.join(MIGRATIONS_DIR, '728_tenant_config_provisioning_backfill.sql'),
    );
    // No executable copy, and no commented-out one waiting to be re-enabled:
    // the only mention left is the header explaining the withdrawal.
    expect(migration.toUpperCase()).not.toContain('INSERT INTO ESCALATION_RULES');
  });

  it('targets the real expression index when it names an ON CONFLICT target', () => {
    // idx_workflow_sla_rules_tenant_code (269:148-149) is on
    // (COALESCE(tenant_id, <zero uuid>), rule_code); a plain
    // `ON CONFLICT (tenant_id, rule_code)` infers no index and errors.
    const entry = TENANT_PROVISIONING_REGISTRY.find(e => e.table === 'workflow_sla_rules');
    expect(buildTenantBackfillSql(entry)).toContain(
      "ON CONFLICT ((COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), rule_code) DO NOTHING",
    );
    const migration = readText(path.join(MIGRATIONS_DIR, '269_canonical_clinical_platform.sql'));
    expect(migration).toContain(
      "ON workflow_sla_rules (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), rule_code)",
    );
  });

  it('scopes both generated forms to the default tenant as the source', () => {
    for (const entry of TENANT_PROVISIONING_REGISTRY) {
      for (const sql of [buildTenantCopySql(entry), buildTenantBackfillSql(entry)]) {
        // The default tenant's rows are always aliased `d` — as the copy's FROM,
        // as the backfill's CROSS JOIN against `tenants t`.
        expect(sql).toMatch(new RegExp(`(FROM|CROSS JOIN) ${entry.table} d\\b`));
        expect(sql).toContain(`d.tenant_id = '${DEFAULT_TENANT_ID}'::uuid`);
        expect(sql).toContain('NOT EXISTS');
        expect(sql).toContain('DO NOTHING');
      }
      // The per-tenant copy takes exactly one bound parameter.
      expect(buildTenantCopySql(entry)).not.toMatch(/\$2/);
      // The backfill never writes back onto the source tenant.
      expect(buildTenantBackfillSql(entry))
        .toContain(`t.id <> '${DEFAULT_TENANT_ID}'::uuid`);
    }
  });

  it('rejects a malformed entry instead of generating half a statement', () => {
    expect(() => buildTenantCopySql({ table: 'x', columns: [] })).toThrow(/columns/);
    expect(() => buildTenantCopySql({ table: '', columns: ['a'] })).toThrow(/table/);
    expect(() => buildTenantCopySql({ table: 'x', columns: ['tenant_id'] }))
      .toThrow(/tenant_id is supplied by the copy/);
    expect(() => buildTenantCopySql({
      table: 'x',
      columns: ['a'],
      guardKind: PROVISIONING_GUARD_KINDS.ROW_KEY,
      guardKeyColumns: [],
    })).toThrow(/guardKeyColumns/);
    // A guard that reads a column the copy does not carry would compare the
    // tenant's row against a value this statement never writes.
    expect(() => buildTenantCopySql({
      table: 'x',
      columns: ['a'],
      guardKind: PROVISIONING_GUARD_KINDS.ROW_KEY,
      guardKeyColumns: ['b'],
    })).toThrow(/uncopied column/);
    // Guard keys are a closed grammar, so no arbitrary SQL reaches the predicate.
    expect(() => buildTenantCopySql({
      table: 'x',
      columns: ['a'],
      guardKind: PROVISIONING_GUARD_KINDS.ROW_KEY,
      guardKeyColumns: ['a) OR true --'],
    })).toThrow(/unsupported guard key/);
    expect(guardKeyBaseColumn("match_filter->>'sla_key'")).toBe('match_filter');
  });
});

describe('the backfill migrations are generated from the registry', () => {
  it.each(TENANT_PROVISIONING_REGISTRY.map(entry => [entry.table, entry]))(
    'migration for %s carries the registry-generated statement verbatim',
    (_table, entry) => {
      const file = path.join(MIGRATIONS_DIR, entry.backfilledBy);
      expect(fs.existsSync(file)).toBe(true);
      // Byte-for-byte: 727 shipped this shape by hand and the registry now
      // reproduces it exactly, so "refactor, not rewrite" is verifiable rather
      // than asserted. 728 was generated from the same builder.
      expect(readText(file)).toContain(buildTenantBackfillSql(entry));
    },
  );

  it('takes migration 728 as a pure data backfill (no schema change to db pull)', () => {
    const sql = readText(
      path.join(MIGRATIONS_DIR, '728_tenant_config_provisioning_backfill.sql'),
    );
    expect(sql).not.toMatch(/\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|TYPE|FUNCTION|TRIGGER|VIEW)\b/i);
  });
});

describe('lab_critical_thresholds stays withdrawn', () => {
  // Rounds 1 and 2 both shipped a backfill for this table and both were wrong,
  // in DIFFERENT ways — a copied row tied evaluateCriticalThreshold's best match
  // rank (round 1), and then disagreed with the tenant's lab_reference_ranges,
  // which labPanelService.assertCriticalPolicyAgreement rejects (round 2). Both
  // turn a silent non-alert into a REJECTED lab result. A third attempt must
  // start by deleting these assertions and reading docs/ROADMAP.md, not by
  // adding a third guard kind.
  const MIGRATION_728 = readText(
    path.join(MIGRATIONS_DIR, '728_tenant_config_provisioning_backfill.sql'),
  );

  it('is exempted rather than provisioned, so no copy is generated for it', () => {
    expect(TENANT_PROVISIONED_TABLES).not.toContain('lab_critical_thresholds');
    expect(EXEMPT_TABLES.has('lab_critical_thresholds')).toBe(true);
    expect(EXEMPT_TABLES.get('lab_critical_thresholds')).toMatch(/ROADMAP/);
  });

  it('is written by no migration except its default-tenant seeds', () => {
    // 151 and 193 seed the default tenant; nothing may copy those rows onward.
    const writers = migrationFiles().filter((file) => (
      /INSERT\s+INTO\s+(?:public\.)?lab_critical_thresholds/i
        .test(readText(path.join(MIGRATIONS_DIR, file)))
    ));
    expect(writers).toEqual([
      '151_lab_results_and_alerts.sql',
      '193_troponin_i_critical_threshold_alias.sql',
    ]);
  });

  it('leaves migration 728 with no lab-threshold statement and no skip report', () => {
    // Comment-stripped: 728's header explains the withdrawal at length and must
    // be free to name the table. What must not exist is executable SQL touching
    // it.
    const executable = MIGRATION_728
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    expect(executable).not.toMatch(/lab_critical_thresholds/);
    // The RAISE NOTICE + TENANT_CONFIG_PROVISIONING_SKIPPED audit rows existed
    // only to make the table-empty trade discoverable. With the entry gone they
    // named a case that cannot occur — no non-default tenant can hold a
    // threshold row, because no INSERT path exists — so they are gone too, and
    // no other entry in 728 needs them: both remaining guards are row-keyed, so
    // a partially-provisioned tenant is a per-row outcome, not a skipped tenant.
    expect(executable).not.toMatch(/RAISE NOTICE/);
    expect(executable).not.toContain('TENANT_CONFIG_PROVISIONING_SKIPPED');
    expect(executable).not.toContain('INSERT INTO audit_logs');
  });

  it('still has no operator INSERT path in non-test source (the reason it is parked)', () => {
    const SOURCE_ROOTS = ['src/services', 'src/controllers', 'src/routes', 'src/utils'];
    const offenders = [];
    for (const root of SOURCE_ROOTS) {
      const dir = path.join(BACKEND_ROOT, root);
      const stack = [dir];
      while (stack.length) {
        const current = stack.pop();
        for (const item of fs.readdirSync(current, { withFileTypes: true })) {
          const full = path.join(current, item.name);
          if (item.isDirectory()) stack.push(full);
          else if (item.name.endsWith('.js')
            && /INSERT\s+INTO\s+(?:public\.)?lab_critical_thresholds/i.test(readText(full))) {
            offenders.push(path.relative(BACKEND_ROOT, full));
          }
        }
      }
    }
    // If this ever fails, the gap parked in docs/ROADMAP.md has been closed and
    // that entry must be updated — the absence of a write path is precisely why
    // an unconfigured tenant cannot fix itself.
    expect(offenders).toEqual([]);
  });
});

describe('createTenant consumes the registry', () => {
  const NEW_TENANT_ID = '77777777-7777-4777-8777-777777777777';

  beforeEach(() => {
    queryRawMock.mockReset();
    executeRawMock.mockReset().mockResolvedValue(1);
    queryRawMock.mockResolvedValueOnce([{ id: NEW_TENANT_ID, slug: 'new', settings: {} }]);
  });

  it('runs exactly one generated copy per registry entry for the new tenant', async () => {
    await createTenant({ slug: 'new', name: 'New Hospital' });

    // First $executeRawUnsafe is the entitlement seed (not registry-driven).
    const copies = executeRawMock.mock.calls.slice(1);
    expect(copies).toHaveLength(TENANT_PROVISIONING_REGISTRY.length);
    TENANT_PROVISIONING_REGISTRY.forEach((entry, index) => {
      expect(copies[index]).toEqual([buildTenantCopySql(entry), NEW_TENANT_ID]);
    });
  });

  it('propagates a failed copy rather than returning a half-provisioned tenant', async () => {
    executeRawMock.mockReset();
    executeRawMock.mockResolvedValueOnce(1); // entitlement seed
    executeRawMock.mockRejectedValueOnce(new Error('relation does not exist'));

    await expect(createTenant({ slug: 'new', name: 'New Hospital' }))
      .rejects.toThrow('relation does not exist');
  });

  it('keeps no hand-written copy of a registry table in the service', async () => {
    const service = readText(
      path.join(BACKEND_ROOT, 'src/services/tenant/tenantService.js'),
    );
    for (const table of TENANT_PROVISIONED_TABLES) {
      expect(service).not.toContain(`INSERT INTO ${table}`);
    }
  });
});
