// Operator pre-flight for the model-wiring rollout: is a clinical-AI module's
// MODEL actually wired and answering (used_ai=true) — not silently falling back
// to the deterministic template? Run this BEFORE trusting a module you just
// enabled for a tenant (see docs/PER_TENANT_ROLLOUT_PLAYBOOK.md §1 pre-flight /
// §7 local-LLM deep tier).
//
// Wraps the existing readiness gate (checkDeepModuleReadiness: provider resolve +
// model-pulled probe + smoke generation) and extends it to STANDARD-tier modules
// (which that gate intentionally skips) by running a tiny smoke generation and
// reporting used_ai.
//
//   # against the deployment's real provider + DB:
//   CLINICAL_AI_PROVIDER=ollama CLINICAL_AI_BASE_URL=http://localhost:11434 \
//   CLINICAL_AI_MODEL=gemma2:9b CLINICAL_AI_TIMEOUT_MS=120000 \
//   node apps/backend/scripts/check-clinical-ai-readiness.mjs --module sepsis_bundle_sentinel [--tenant <uuid>]
//
// GOTCHA: set a generous CLINICAL_AI_TIMEOUT_MS (e.g. 120000). A cold local-LLM
// first inference can exceed the default timeout, which aborts the fetch
// ("fetch failed") and SILENTLY falls back to the deterministic template
// (used_ai=false). This script surfaces exactly that — NOT READY despite a
// correct provider/model — so you catch it before trusting a module.
//
// Exit 0 = READY (provider answered, used_ai=true); exit 1 = NOT READY (template
// fallback / model not pulled / provider misconfigured); exit 2 = usage error.
//
// DATABASE_URL must point at the deployment DB — the module catalog + per-tenant
// overrides (which decide enablement and tier) live there.
process.env.JWT_SECRET ||= 'cli-only-not-a-secret';
process.env.API_KEY ||= 'cli-only';

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
}
const moduleKey = arg('module');
const tenantId = arg('tenant') || null;
if (!moduleKey) {
  console.error('Usage: node scripts/check-clinical-ai-readiness.mjs --module <module_key> [--tenant <uuid>]');
  process.exit(2);
}

const { checkDeepModuleReadiness, generateClinicalText } = await import('../src/services/ai/localLlmClient.js');

const verdict = await checkDeepModuleReadiness(moduleKey, { tenantId, smoke: true });

// checkDeepModuleReadiness short-circuits non-deep modules as ready=true WITHOUT
// smoking them. For the rollout we still want a used_ai confirmation, so run a
// tiny smoke generation for the standard-tier case (the module must already be
// enabled for the tenant, or it template-falls-back — which is exactly what this
// surfaces).
if (verdict.reason === 'not_deep_tier') {
  try {
    const r = await generateClinicalText({
      taskType: moduleKey,
      systemPrompt: 'You are a readiness probe for a clinical-AI module. Reply with strict JSON only: {"ok":true}.',
      userPrompt: 'readiness check',
      tenantId,
    });
    verdict.smokeRan = true;
    verdict.smokeUsedAi = r.usedAi === true;
    verdict.provider = r.provider ?? verdict.provider;
    verdict.model = r.model ?? verdict.model;
    verdict.ready = r.usedAi === true;
    verdict.reason = r.usedAi ? 'standard_tier_smoke_used_ai' : 'standard_tier_template_fallback';
  } catch (err) {
    verdict.smokeRan = true;
    verdict.smokeUsedAi = false;
    verdict.ready = false;
    verdict.reason = `standard_tier_smoke_failed:${err?.message || 'unknown'}`;
  }
}

console.log(JSON.stringify(verdict, null, 2));
const ok = verdict.ready === true && verdict.smokeUsedAi === true;
console.log(
  ok
    ? `\nREADY — ${moduleKey}: provider=${verdict.provider}, model=${verdict.model || '-'}, used_ai=true`
    : `\nNOT READY — ${moduleKey}: ${verdict.reason || 'see verdict above'} (provider=${verdict.provider}, model=${verdict.model || '-'})`,
);
process.exit(ok ? 0 : 1);
