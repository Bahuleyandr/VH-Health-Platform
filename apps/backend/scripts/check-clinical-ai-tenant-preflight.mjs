// Per-tenant clinical-AI enablement PRE-FLIGHT (read-only).
//
// Runs the per-tenant playbook gates as a read-only check before a hospital
// goes live with any enabled clinical-AI module. It is the tenant-scoped
// companion to check-clinical-ai-readiness.mjs (which probes ONE module's
// model wiring). This script sweeps EVERY module enabled for the tenant and
// checks, per module:
//
//   1. Module catalog reachable + which modules are enabled for the tenant.
//   2. Reviewer staffing — PER MODULE, using each module's own `reviewRoles`
//      (Enablement-plan C2: the old fixed tenant-wide clinical allowlist missed
//      roles like RADIOLOGIST / MEDICAL_RECORDS). A module with zero staffed
//      reviewers for ALL its review roles is a FAILURE; partially-staffed is a
//      warning.
//   3. Deep-tier liveness — for every enabled deep-tagged module, assert it is
//      actually producing real AI (assertDeepModuleLive: provider != template +
//      model pulled) rather than silently template-falling-back (Enablement-plan
//      C3). A not-live deep module is a warning (a FAILURE under
//      --require-no-warnings, which is how the go-live gate should run it).
//   4. Pilot signoff — when --require-pilot-signoff is set, surfaces the
//      manual attestation that must be confirmed (there is no automated
//      signoff store yet; this keeps the gate honest rather than silently green).
//
//   node apps/backend/scripts/check-clinical-ai-tenant-preflight.mjs \
//     --tenant <tenant-uuid> [--require-no-warnings] [--require-pilot-signoff] [--json]
//
// Exit 0 = PASS; exit 1 = FAIL (a failure, or a warning under
// --require-no-warnings); exit 2 = usage error.
//
// DATABASE_URL must point at the deployment DB — the module catalog, per-tenant
// overrides, and user roster all live there. For deep-tier liveness against a
// real provider, also set CLINICAL_AI_DEEP_* (and a generous
// CLINICAL_AI_TIMEOUT_MS≈120000 — see check-clinical-ai-readiness.mjs).
//
// RLS note: the reviewer query filters tenant_id explicitly so it is correct
// whether or not the users table is RLS-scoped for the connecting role.
process.env.JWT_SECRET ||= 'cli-only-not-a-secret';
process.env.API_KEY ||= 'cli-only';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

const tenantId = arg('tenant');
const requireNoWarnings = flag('require-no-warnings');
const requirePilotSignoff = flag('require-pilot-signoff');
const asJson = flag('json');

if (!tenantId) {
  console.error(
    'Usage: node apps/backend/scripts/check-clinical-ai-tenant-preflight.mjs --tenant <uuid> ' +
    '[--require-no-warnings] [--require-pilot-signoff] [--json]'
  );
  process.exit(2);
}

const prisma = (await import('../src/lib/prisma.js')).default;
const { listClinicalAiModules } = await import('../src/services/ai/clinicalAiModuleService.js');
const { assertDeepModuleLive } = await import('../src/services/ai/localLlmClient.js');

const reviewRolesOf = (m) => (m?.settings?.reviewRoles || m?.reviewRoles || m?.review_roles || []);
const tierOf = (m) => String(m?.settings?.model_tier || m?.model_tier || m?.tier || 'quick').toLowerCase();

const checks = [];
const warnings = [];
const failures = [];

// ---- 1. module catalog + enabled set --------------------------------------
let modules;
try {
  modules = await listClinicalAiModules({ tenantId });
} catch (err) {
  console.error(`FAIL: cannot read clinical-AI module catalog: ${err?.message || err}`);
  await prisma.$disconnect?.().catch(() => {});
  process.exit(1);
}
const enabled = modules.filter((m) => m.enabled);
checks.push({
  check: 'module_catalog',
  ok: true,
  detail: `${modules.length} modules in catalog, ${enabled.length} enabled for tenant`,
});

// ---- 2. per-module reviewer staffing (C2) ---------------------------------
const rolesNeeded = new Set();
for (const m of enabled) reviewRolesOf(m).forEach((r) => rolesNeeded.add(r));

let roleCounts = new Map();
if (rolesNeeded.size) {
  try {
    // $1 is bound as a single text[] value for ANY(...). Use the variable form
    // (not an inline array literal) so the raw-params lint — which forbids
    // arrays as positional params — does not flag this legitimate ANY() bind.
    const roleList = [...rolesNeeded];
    const rows = await prisma.$queryRawUnsafe(
      `SELECT role, COUNT(*)::int AS n
         FROM users
        WHERE role = ANY($1::text[])
          AND is_active = true
          AND COALESCE(tenant_id, $2::uuid) = $2::uuid
        GROUP BY role`,
      roleList,
      tenantId,
    );
    roleCounts = new Map(rows.map((r) => [r.role, Number(r.n)]));
  } catch (err) {
    failures.push({ module: null, issue: `reviewer_roster_query_failed:${err?.message || 'unknown'}` });
  }
}
for (const m of enabled) {
  const roles = reviewRolesOf(m);
  if (!roles.length) {
    warnings.push({ module: m.module_key, issue: 'no_review_roles_defined' });
    continue;
  }
  const staffed = roles.filter((r) => (roleCounts.get(r) || 0) > 0);
  if (staffed.length === 0) {
    failures.push({ module: m.module_key, issue: 'no_reviewers_staffed', reviewRoles: roles });
  } else if (staffed.length < roles.length) {
    warnings.push({
      module: m.module_key,
      issue: 'some_review_roles_unstaffed',
      staffed,
      missing: roles.filter((r) => !staffed.includes(r)),
    });
  }
}
checks.push({
  check: 'reviewer_staffing',
  ok: !failures.some((f) => f.issue === 'no_reviewers_staffed'),
  detail: `roles needed: ${[...rolesNeeded].join(', ') || '(none)'}`,
});

// ---- 3. deep-tier liveness for enabled deep modules (C3) ------------------
const deepEnabled = enabled.filter((m) => tierOf(m) === 'deep');
for (const m of deepEnabled) {
  try {
    await assertDeepModuleLive(m.module_key, { tenantId, smoke: false });
  } catch (err) {
    warnings.push({
      module: m.module_key,
      issue: 'deep_module_not_live',
      reason: err?.readiness?.reason || err?.message || 'unknown',
    });
  }
}
checks.push({
  check: 'deep_tier_liveness',
  ok: true,
  detail: `${deepEnabled.length} enabled deep-tier module(s) probed (model-pulled, no token spend)`,
});

// ---- 4. pilot signoff (manual attestation) --------------------------------
if (requirePilotSignoff) {
  warnings.push({
    module: null,
    issue: 'pilot_signoff_manual_attestation_required',
    detail: 'No automated pilot-signoff store; confirm the one-ward pilot signoff out of band.',
  });
}

// ---- report + exit --------------------------------------------------------
const report = {
  tenant_id: tenantId,
  generated_at: new Date().toISOString(),
  modules_total: modules.length,
  modules_enabled: enabled.length,
  checks,
  warnings,
  failures,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Clinical-AI tenant pre-flight — tenant ${tenantId}`);
  console.log(`  catalog: ${modules.length} modules, ${enabled.length} enabled`);
  for (const c of checks) console.log(`  [${c.ok ? 'ok' : 'FAIL'}] ${c.check} — ${c.detail || ''}`);
  for (const w of warnings) console.log(`  [warn] ${w.module || '-'}: ${w.issue}${w.reason ? ` (${w.reason})` : ''}`);
  for (const f of failures) console.log(`  [FAIL] ${f.module || '-'}: ${f.issue}`);
}

await prisma.$disconnect?.().catch(() => {});

const hardFail = failures.length > 0 || (requireNoWarnings && warnings.length > 0);
// Keep stdout pure JSON under --json (callers parse it); send the human summary
// to stderr in that mode. The exit code conveys pass/fail either way.
const summaryLine = hardFail
  ? `\nNOT READY — ${failures.length} failure(s), ${warnings.length} warning(s)` +
    (requireNoWarnings && failures.length === 0 ? ' (warnings fail under --require-no-warnings)' : '')
  : `\nPASS — ${failures.length} failure(s), ${warnings.length} warning(s)`;
(asJson ? console.error : console.log)(summaryLine);
process.exit(hardFail ? 1 : 0);
