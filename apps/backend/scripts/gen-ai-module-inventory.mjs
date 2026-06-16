// Generates docs/CLINICAL_AI_MODULE_INVENTORY.md from the canonical
// CLINICAL_AI_MODULES registry. The register is machine-generated so the
// counts (total / enabled / deep-tier / patient-facing / KB) can never drift
// from the code — re-run this after any change to clinicalAiModuleService.js.
//
//   node apps/backend/scripts/gen-ai-module-inventory.mjs
//
// CODE-GROUNDED WIRING: in addition to the registry metadata, this greps the
// backend source for each module_key to record whether a service / route / test
// references it — so the "every module is wired" claim is machine-checked, not
// asserted. Caveat: a key-grep MISSES a module wired via a differently-named
// service (e.g. `deterioration_early_warning` is implemented by `news2Service.js`,
// which never contains the literal key). So "no service ref" means VERIFY, not
// "definitely a shell". Flagged modules are listed for manual confirmation.
//
// NOTE: importing the registry transitively constructs the Prisma singleton,
// which validates (but never opens) a connection string at import time. We set
// throwaway env defaults so the script runs standalone with no DB and no .env.
// Nothing here connects to a database.
process.env.DATABASE_URL ||= 'postgresql://gen:gen@127.0.0.1:5432/gen';
process.env.JWT_SECRET ||= 'gen-only-not-a-secret';
process.env.API_KEY ||= 'gen-only';

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

// Dynamic import so the env defaults above run FIRST. Static `import` declarations
// are hoisted and evaluated before any top-level statement, which would construct
// the (transitively imported) Prisma singleton before DATABASE_URL is set.
const { CLINICAL_AI_MODULES } = await import('../src/services/ai/clinicalAiModuleService.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..', '..');

const GEN_DATE = process.argv[2] || new Date().toISOString().slice(0, 10);
let COMMIT = process.argv[3];
if (!COMMIT) {
  try { COMMIT = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT }).toString().trim(); }
  catch { COMMIT = 'unknown'; }
}

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
const yn = (b) => (b ? '✅' : '—');
const PATIENT_SURFACES = ['patient', 'patient_communication', 'virtual_ward'];

// ── Code-grounded wiring scan ───────────────────────────────────────────────
// For each module_key, list the backend source files that reference it (outside
// the registry + this generator), and classify them. Uses `git grep` so only
// tracked files are scanned (fast, deterministic).
const REGISTRY_FILE = 'clinicalAiModuleService.js';
function scanRefs(key) {
  let files = [];
  try {
    files = execSync(`git grep -lF "${key}" -- apps/backend/src`, { cwd: REPO_ROOT })
      .toString().trim().split('\n').filter(Boolean);
  } catch {
    files = []; // git grep exits 1 when there are no matches
  }
  const nonRegistry = files.filter(
    (f) => !f.endsWith(REGISTRY_FILE) && !f.includes('gen-ai-module-inventory'),
  );
  const isTest = (f) => f.includes('/tests/') || f.includes('.test.');
  const svc = nonRegistry.some((f) => f.includes('/services/') && !isTest(f));
  const route = nonRegistry.some((f) => f.includes('/routes/') && !isTest(f));
  const test = nonRegistry.some(isTest);
  return { svc, route, test, refCount: nonRegistry.length };
}

const rows = CLINICAL_AI_MODULES.map((m) => {
  const s = m.settings || {};
  const surface = s.surface || '';
  const patientFacing = s.patientFacing === true || PATIENT_SURFACES.includes(surface);
  const wiring = scanRefs(m.module_key);
  return {
    key: m.module_key,
    name: m.display_name || m.module_key,
    surface,
    enabled: !!m.enabled,
    risk: s.risk || '',
    roles: Array.isArray(s.reviewRoles) ? s.reviewRoles.join(', ') : '',
    deep: s.model_tier === 'deep',
    patient: patientFacing,
    kb: Array.isArray(s.knowledgeBases) && s.knowledgeBases.length > 0,
    signoff: s.requiresClinicianSignoff === true,
    svc: wiring.svc,
    route: wiring.route,
    test: wiring.test,
    refCount: wiring.refCount,
  };
});

const total = rows.length;
const enabledRows = rows.filter((r) => r.enabled);
const deepRows = rows.filter((r) => r.deep);
const patientRows = rows.filter((r) => r.patient);
const kbRows = rows.filter((r) => r.kb);
const signoffRows = rows.filter((r) => r.signoff);
const svcRows = rows.filter((r) => r.svc);
const routeRows = rows.filter((r) => r.route);
const testRows = rows.filter((r) => r.test);
// Flag: the module_key is referenced by NO service AND NO route in the source.
// Either a true shell, or (more often) wired via a differently-named service —
// MANUAL verification required for each of these.
const flaggedRows = rows.filter((r) => !r.svc && !r.route);

const sorted = [...rows].sort((a, b) => {
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  if (a.surface !== b.surface) return a.surface.localeCompare(b.surface);
  return a.name.localeCompare(b.name);
});

let md = '';
md += '# Clinical AI Module Inventory — VH Health Platform\n\n';
md += `> **Generated:** ${GEN_DATE} · **Source of truth:** \`apps/backend/src/services/ai/clinicalAiModuleService.js\` (\`CLINICAL_AI_MODULES\`) · **Repo commit:** \`${COMMIT}\`\n`;
md += '> Machine-generated (registry metadata + a `git grep` wiring scan). Refresh with `node apps/backend/scripts/gen-ai-module-inventory.mjs`. Do not hand-edit the tables.\n\n';

md += '## Summary\n\n';
md += '| Metric | Count |\n|---|---:|\n';
md += `| **Total governed modules** | ${total} |\n`;
md += `| Enabled by default (seed) | ${enabledRows.length} |\n`;
md += `| Require clinician sign-off | ${signoffRows.length} |\n`;
md += `| Deep-tier (need GPU+Ollama for full quality) | ${deepRows.length} |\n`;
md += `| Patient-facing (OFF by policy) | ${patientRows.length} |\n`;
md += `| Declare curated-KB grounding | ${kbRows.length} |\n`;
md += `| **Key-referenced by a service** | ${svcRows.length} |\n`;
md += `| **Key-referenced by a route** | ${routeRows.length} |\n`;
md += `| **Key-referenced by a test** | ${testRows.length} |\n`;
md += `| **Flagged — no service/route ref by key (verify)** | ${flaggedRows.length} |\n\n`;

md += '## Wiring verification (code-grounded)\n\n';
md += `A \`git grep\` of each \`module_key\` over \`apps/backend/src\`: **${svcRows.length}/${total}** are referenced by a service and **${routeRows.length}/${total}** by a route. This replaces the old hand-asserted "everything is wired" claim with a machine-checked signal.\n\n`;
if (flaggedRows.length) {
  md += `**${flaggedRows.length} module(s) are not referenced by their literal key in any service or route** — these need MANUAL verification. A flag does NOT mean "shell": a module is often implemented by a differently-named service that never contains the key string (e.g. \`deterioration_early_warning\` → \`news2Service.js\`). Confirm each before treating it as unimplemented:\n\n`;
  md += '| Module | key | Surface | Refs (non-registry) |\n|---|---|---|---:|\n';
  for (const r of flaggedRows) md += `| ${esc(r.name)} | \`${r.key}\` | ${esc(r.surface)} | ${r.refCount} |\n`;
  md += '\n';
} else {
  md += '_Every module_key is referenced by at least one service or route in the source._\n\n';
}

md += '### Enabled by default (seed)\n\n';
md += 'The only modules ON for a freshly-migrated tenant. Everything else is opt-in per tenant via `clinical_ai_tenant_modules`.\n\n';
md += '| Module | key | Surface | Risk |\n|---|---|---|---|\n';
for (const r of enabledRows) md += `| ${esc(r.name)} | \`${r.key}\` | ${esc(r.surface)} | ${esc(r.risk)} |\n`;
md += '\n';

md += `### Deep-tier modules (${deepRows.length})\n\n`;
md += 'Route to the deep model tier when `CLINICAL_AI_DEEP_*` + an Ollama GPU node are configured. **Until then they fall back to a deterministic template** (recorded as `generation_mode: template_fallback`, but not gated) — confirm `used_ai:true` with an operator smoke-gen before enabling any of these.\n\n';
md += '| Module | key | Surface | Default ON |\n|---|---|---|---|\n';
for (const r of deepRows) md += `| ${esc(r.name)} | \`${r.key}\` | ${esc(r.surface)} | ${yn(r.enabled)} |\n`;
md += '\n';

md += `### Curated-KB-grounded modules (${kbRows.length})\n\n`;
md += 'Pull curation-approved formulary/antibiogram/protocol chunks into the prompt (gated by `settings.knowledgeBases`; grounds via the admission workflow graph, the shared `runExplainerPipeline`, or a direct service call). Grounding no-ops gracefully until the embedder (`CLINICAL_AI_EMBED_URL` + `nomic-embed-text`) and **approved** KB content exist.\n\n';
md += '| Module | key | Knowledge bases |\n|---|---|---|\n';
for (const m of CLINICAL_AI_MODULES) {
  const s = m.settings || {};
  if (Array.isArray(s.knowledgeBases) && s.knowledgeBases.length) {
    md += `| ${esc(m.display_name || m.module_key)} | \`${m.module_key}\` | ${esc(s.knowledgeBases.join(', '))} |\n`;
  }
}
md += '\n';

md += `### Patient-facing modules (${patientRows.length}) — OFF by policy\n\n`;
md += 'Built and governed, but deliberately kept off until a decision to go patient-facing.\n\n';
md += '| Module | key | Surface |\n|---|---|---|\n';
for (const r of patientRows) md += `| ${esc(r.name)} | \`${r.key}\` | ${esc(r.surface)} |\n`;
md += '\n';

md += `## Full module register (${total})\n\n`;
md += 'Sorted: enabled first, then by surface. **Default** = seed default (per-tenant override wins at runtime). **Svc/Route/Test** = the module_key is referenced by a service / route / test file (code-grounded `git grep`; a `—` may still be wired via a differently-named service). **Deep** = needs GPU tier. **Pt** = patient-facing. **KB** = declares curated-KB grounding.\n\n';
md += '| # | Module | key | Surface | Default | Risk | Svc | Route | Test | Deep | Pt | KB |\n';
md += '|---:|---|---|---|:---:|---|:---:|:---:|:---:|:---:|:---:|:---:|\n';
sorted.forEach((r, i) => {
  md += `| ${i + 1} | ${esc(r.name)} | \`${r.key}\` | ${esc(r.surface)} | ${yn(r.enabled)} | ${esc(r.risk)} | ${yn(r.svc)} | ${yn(r.route)} | ${yn(r.test)} | ${yn(r.deep)} | ${yn(r.patient)} | ${yn(r.kb)} |\n`;
});
md += '\n';

md += '## How "enabled" works (3 layers)\n\n';
md += '1. **Code `enabled` flag** = seed default only (the table above).\n';
md += '2. **`clinical_ai_modules` table** = the seeded catalog; once a row exists the DB value wins and code-default flips are inert.\n';
md += '3. **`clinical_ai_tenant_modules` table** = the per-tenant on/off switch (`updateClinicalAiTenantModule`). **This is what you write to enable a module for a hospital.** Empty at bootstrap → every tenant inherits the seed defaults until overridden.\n\n';
md += 'For an external LLM provider, a module also needs its per-module `external_allowed` flag set **in addition** to the env-level `CLINICAL_AI_ALLOW_EXTERNAL`.\n\n';

md += '## Activation checklist (per module, before flipping ON)\n\n';
md += '- [ ] Provider reachable — `CLINICAL_AI_PROVIDER`/`BASE_URL`/`MODEL` (+ `DEEP_*` for deep-tier modules) configured and a smoke-gen returns `ai_metadata.used_ai: true`.\n';
md += '- [ ] Reviewers staffed — at least one active user holds each role in the module\'s sign-off `reviewRoles[]`.\n';
md += '- [ ] (KB modules) embedder configured + curation-**approved** chunks exist, else grounding silently no-ops.\n';
md += '- [ ] (high/critical or `two_person_for_enablement`) a second approver + an accepted `clinical_ai_model_eval_runs` row.\n';
md += '- [ ] Per-tenant toggle written to `clinical_ai_tenant_modules` (not the global catalog).\n';
md += '- [ ] Patient-facing modules stay OFF pending an explicit go-patient-facing decision.\n\n';

md += '---\n';
md += '_Provenance: registry attributes are read directly from the registry array; Svc/Route/Test columns are a `git grep` of the module_key over `apps/backend/src` at generation time. Live per-tenant enablement (which modules a running hospital actually has ON) lives in `clinical_ai_tenant_modules` and must be queried from that deployment\'s database — it is not represented here._\n';

const outPath = path.join(REPO_ROOT, 'docs', 'CLINICAL_AI_MODULE_INVENTORY.md');
fs.writeFileSync(outPath, md, 'utf8');
console.log(`WROTE ${outPath}`);
console.log(`total=${total} enabled=${enabledRows.length} svc=${svcRows.length} route=${routeRows.length} test=${testRows.length} flagged=${flaggedRows.length} deep=${deepRows.length} patient=${patientRows.length} kb=${kbRows.length}`);
process.exit(0);
