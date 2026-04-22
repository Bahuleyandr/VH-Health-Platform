import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

export const CLINICAL_AI_MODULES = [
  {
    module_key: 'discharge_summary',
    display_name: 'Discharge Summary Drafts',
    description: 'Drafts clinician-reviewed discharge summaries from inpatient chart context.',
    enabled: true,
    settings: { surface: 'emr', risk: 'high', requiresClinicianSignoff: true },
  },
  {
    module_key: 'handover_summary',
    display_name: 'Nursing Handover Drafts',
    description: 'Drafts shift handover notes from recent patient timeline events.',
    enabled: true,
    settings: { surface: 'clinical', risk: 'medium', requiresClinicianSignoff: true },
  },
  {
    module_key: 'patient_record_summary',
    display_name: 'Patient Record Summary',
    description: 'Future module for longitudinal inpatient-record summaries across admissions.',
    enabled: false,
    settings: { surface: 'emr', risk: 'high', status: 'planned' },
  },
  {
    module_key: 'patient_aftercare_instructions',
    display_name: 'Patient Aftercare Instructions',
    description: 'Future module for patient-friendly discharge instructions with warning signs.',
    enabled: false,
    settings: { surface: 'patient', risk: 'high', status: 'planned' },
  },
  {
    module_key: 'clinical_coding_assist',
    display_name: 'Clinical Coding Assistant',
    description: 'Future module for ICD/CPT coding suggestions from signed clinical documentation.',
    enabled: false,
    settings: { surface: 'revenue_cycle', risk: 'medium', status: 'planned' },
  },
  {
    module_key: 'quality_case_review',
    display_name: 'Quality Case Review',
    description: 'Future module for readmission, mortality, and incident-review summaries.',
    enabled: false,
    settings: { surface: 'quality', risk: 'medium', status: 'planned' },
  },
];

export const DEFAULT_CLINICAL_AI_GUARDRAILS = {
  id: 1,
  enabled: true,
  external_ai_enabled: true,
  daily_token_limit: null,
  daily_cost_limit_minor: null,
  request_token_limit: null,
  fallback_rate_alert_pct: 50,
  max_fallbacks_per_day: null,
  latency_alert_ms: 15000,
  updated_by: null,
  created_at: null,
  updated_at: null,
};

const MODULE_CACHE_MS = 30_000;
let moduleCache = null;
let moduleCacheAt = 0;
let guardrailCache = null;
let guardrailCacheAt = 0;

function sanitizeModuleKey(value) {
  return String(value || '').toLowerCase().trim().replace(/[^a-z0-9_-]/g, '');
}

function defaultModuleFor(moduleKey) {
  const key = sanitizeModuleKey(moduleKey);
  return CLINICAL_AI_MODULES.find((module) => module.module_key === key) || {
    module_key: key,
    display_name: key || 'Unknown module',
    description: null,
    enabled: true,
    provider_override: null,
    model_override: null,
    external_allowed: false,
    max_tokens: null,
    temperature: null,
    settings: {},
  };
}

function isNil(value) {
  return value === null || value === undefined;
}

function nullableInt(value) {
  if (value === '' || isNil(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampInt(value, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = null } = {}) {
  const parsed = nullableInt(value);
  if (parsed === null) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function normalizeModule(row) {
  return {
    module_key: row.module_key,
    display_name: row.display_name,
    description: row.description,
    enabled: Boolean(row.enabled),
    provider_override: row.provider_override || null,
    model_override: row.model_override || null,
    external_allowed: Boolean(row.external_allowed),
    max_tokens: isNil(row.max_tokens) ? null : Number(row.max_tokens),
    temperature: isNil(row.temperature) ? null : Number(row.temperature),
    settings: row.settings || {},
    updated_by: row.updated_by || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function normalizeGuardrails(row = DEFAULT_CLINICAL_AI_GUARDRAILS) {
  return {
    id: 1,
    enabled: Boolean(row.enabled),
    external_ai_enabled: row.external_ai_enabled !== false,
    daily_token_limit: nullableInt(row.daily_token_limit),
    daily_cost_limit_minor: nullableInt(row.daily_cost_limit_minor),
    request_token_limit: nullableInt(row.request_token_limit),
    fallback_rate_alert_pct: clampInt(row.fallback_rate_alert_pct, { min: 0, max: 100, fallback: 50 }),
    max_fallbacks_per_day: nullableInt(row.max_fallbacks_per_day),
    latency_alert_ms: clampInt(row.latency_alert_ms, { min: 1000, max: 300000, fallback: 15000 }),
    updated_by: row.updated_by || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function mergeDefaultWithRow(defaultModule, row) {
  if (!row) return normalizeModule(defaultModule);
  return normalizeModule({
    ...defaultModule,
    ...row,
    settings: {
      ...(defaultModule.settings || {}),
      ...(row.settings || {}),
    },
  });
}

async function seedMissingModules() {
  for (const module of CLINICAL_AI_MODULES) {
    await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_modules
         (module_key, display_name, description, enabled, settings, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW())
       ON CONFLICT (module_key) DO NOTHING`,
      module.module_key,
      module.display_name,
      module.description,
      module.enabled,
      JSON.stringify(module.settings || {})
    );
  }
}

async function seedGuardrails() {
  await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_guardrails
       (id, enabled, external_ai_enabled, fallback_rate_alert_pct, latency_alert_ms, created_at, updated_at)
     VALUES (1, true, true, 50, 15000, NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`
  );
}

async function readModulesFromDb() {
  await seedMissingModules();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT module_key, display_name, description, enabled, provider_override,
            model_override, external_allowed, max_tokens, temperature, settings,
            updated_by, created_at, updated_at
     FROM clinical_ai_modules
     ORDER BY
       CASE WHEN settings->>'status' = 'planned' THEN 2 ELSE 1 END,
       module_key`
  );
  const rowMap = new Map(rows.map((row) => [row.module_key, row]));
  const defaults = CLINICAL_AI_MODULES.map((module) => mergeDefaultWithRow(module, rowMap.get(module.module_key)));
  const extraRows = rows
    .filter((row) => !CLINICAL_AI_MODULES.some((module) => module.module_key === row.module_key))
    .map((row) => normalizeModule(row));
  return [...defaults, ...extraRows];
}

async function readGuardrailsFromDb() {
  await seedGuardrails();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, enabled, external_ai_enabled, daily_token_limit,
            daily_cost_limit_minor, request_token_limit, fallback_rate_alert_pct,
            max_fallbacks_per_day, latency_alert_ms, updated_by, created_at, updated_at
     FROM clinical_ai_guardrails
     WHERE id = 1
     LIMIT 1`
  );
  return normalizeGuardrails(rows[0] || DEFAULT_CLINICAL_AI_GUARDRAILS);
}

export async function listClinicalAiModules({ refresh = false } = {}) {
  if (!refresh && moduleCache && Date.now() - moduleCacheAt < MODULE_CACHE_MS) {
    return moduleCache;
  }

  try {
    moduleCache = await readModulesFromDb();
    moduleCacheAt = Date.now();
    return moduleCache;
  } catch (err) {
    logger.warn('Clinical AI module table unavailable; using defaults', { error: err.message });
    moduleCache = CLINICAL_AI_MODULES.map((module) => normalizeModule(module));
    moduleCacheAt = Date.now();
    return moduleCache;
  }
}

export async function getClinicalAiGuardrails({ refresh = false } = {}) {
  if (!refresh && guardrailCache && Date.now() - guardrailCacheAt < MODULE_CACHE_MS) {
    return guardrailCache;
  }

  try {
    guardrailCache = await readGuardrailsFromDb();
    guardrailCacheAt = Date.now();
    return guardrailCache;
  } catch (err) {
    logger.warn('Clinical AI guardrail table unavailable; using defaults', { error: err.message });
    guardrailCache = normalizeGuardrails(DEFAULT_CLINICAL_AI_GUARDRAILS);
    guardrailCacheAt = Date.now();
    return guardrailCache;
  }
}

export async function getClinicalAiModule(moduleKey) {
  const key = sanitizeModuleKey(moduleKey);
  const modules = await listClinicalAiModules();
  return modules.find((module) => module.module_key === key) || normalizeModule(defaultModuleFor(key));
}

export async function updateClinicalAiModule(moduleKey, data = {}, updatedBy = null) {
  const key = sanitizeModuleKey(moduleKey);
  if (!key) throw new Error('module_key is required');

  const current = await getClinicalAiModule(key);
  const next = {
    display_name: data.display_name ?? current.display_name,
    description: data.description ?? current.description,
    enabled: typeof data.enabled === 'boolean' ? data.enabled : current.enabled,
    provider_override: data.provider_override === undefined ? current.provider_override : data.provider_override || null,
    model_override: data.model_override === undefined ? current.model_override : data.model_override || null,
    external_allowed: typeof data.external_allowed === 'boolean' ? data.external_allowed : current.external_allowed,
    max_tokens: data.max_tokens === undefined || data.max_tokens === '' ? current.max_tokens : data.max_tokens,
    temperature: data.temperature === undefined || data.temperature === '' ? current.temperature : data.temperature,
    settings: data.settings && typeof data.settings === 'object'
      ? { ...(current.settings || {}), ...data.settings }
      : current.settings || {},
  };

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_modules
       (module_key, display_name, description, enabled, provider_override,
        model_override, external_allowed, max_tokens, temperature, settings,
        updated_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::uuid, NOW(), NOW())
     ON CONFLICT (module_key)
     DO UPDATE SET
       display_name = EXCLUDED.display_name,
       description = EXCLUDED.description,
       enabled = EXCLUDED.enabled,
       provider_override = EXCLUDED.provider_override,
       model_override = EXCLUDED.model_override,
       external_allowed = EXCLUDED.external_allowed,
       max_tokens = EXCLUDED.max_tokens,
       temperature = EXCLUDED.temperature,
       settings = EXCLUDED.settings,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING module_key, display_name, description, enabled, provider_override,
               model_override, external_allowed, max_tokens, temperature, settings,
               updated_by, created_at, updated_at`,
    key,
    next.display_name,
    next.description,
    next.enabled,
    next.provider_override,
    next.model_override,
    next.external_allowed,
    next.max_tokens,
    next.temperature,
    JSON.stringify(next.settings),
    updatedBy || null
  );

  moduleCache = null;
  moduleCacheAt = 0;
  return normalizeModule(rows[0]);
}

export async function updateClinicalAiGuardrails(data = {}, updatedBy = null) {
  const current = await getClinicalAiGuardrails();
  const next = {
    enabled: typeof data.enabled === 'boolean' ? data.enabled : current.enabled,
    external_ai_enabled: typeof data.external_ai_enabled === 'boolean'
      ? data.external_ai_enabled
      : current.external_ai_enabled,
    daily_token_limit: data.daily_token_limit === undefined
      ? current.daily_token_limit
      : nullableInt(data.daily_token_limit),
    daily_cost_limit_minor: data.daily_cost_limit_minor === undefined
      ? current.daily_cost_limit_minor
      : nullableInt(data.daily_cost_limit_minor),
    request_token_limit: data.request_token_limit === undefined
      ? current.request_token_limit
      : nullableInt(data.request_token_limit),
    fallback_rate_alert_pct: data.fallback_rate_alert_pct === undefined
      ? current.fallback_rate_alert_pct
      : clampInt(data.fallback_rate_alert_pct, { min: 0, max: 100, fallback: current.fallback_rate_alert_pct }),
    max_fallbacks_per_day: data.max_fallbacks_per_day === undefined
      ? current.max_fallbacks_per_day
      : nullableInt(data.max_fallbacks_per_day),
    latency_alert_ms: data.latency_alert_ms === undefined
      ? current.latency_alert_ms
      : clampInt(data.latency_alert_ms, { min: 1000, max: 300000, fallback: current.latency_alert_ms }),
  };

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_guardrails
       (id, enabled, external_ai_enabled, daily_token_limit, daily_cost_limit_minor,
        request_token_limit, fallback_rate_alert_pct, max_fallbacks_per_day,
        latency_alert_ms, updated_by, created_at, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9::uuid, NOW(), NOW())
     ON CONFLICT (id)
     DO UPDATE SET
       enabled = EXCLUDED.enabled,
       external_ai_enabled = EXCLUDED.external_ai_enabled,
       daily_token_limit = EXCLUDED.daily_token_limit,
       daily_cost_limit_minor = EXCLUDED.daily_cost_limit_minor,
       request_token_limit = EXCLUDED.request_token_limit,
       fallback_rate_alert_pct = EXCLUDED.fallback_rate_alert_pct,
       max_fallbacks_per_day = EXCLUDED.max_fallbacks_per_day,
       latency_alert_ms = EXCLUDED.latency_alert_ms,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING id, enabled, external_ai_enabled, daily_token_limit,
               daily_cost_limit_minor, request_token_limit, fallback_rate_alert_pct,
               max_fallbacks_per_day, latency_alert_ms, updated_by, created_at, updated_at`,
    next.enabled,
    next.external_ai_enabled,
    next.daily_token_limit,
    next.daily_cost_limit_minor,
    next.request_token_limit,
    next.fallback_rate_alert_pct,
    next.max_fallbacks_per_day,
    next.latency_alert_ms,
    updatedBy || null
  );

  guardrailCache = null;
  guardrailCacheAt = 0;
  return normalizeGuardrails(rows[0]);
}

export async function getClinicalAiUsageSummary({ days = 7 } = {}) {
  const windowDays = Math.min(Math.max(parseInt(days, 10) || 7, 1), 90);
  const [overall, byModule, byProvider, recentFailures] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*)::int AS generation_count,
         COALESCE(SUM(CASE WHEN used_ai THEN 1 ELSE 0 END), 0)::int AS ai_generation_count,
         COALESCE(SUM(CASE WHEN used_ai THEN 0 ELSE 1 END), 0)::int AS fallback_count,
         COALESCE(SUM(prompt_tokens), 0)::int AS prompt_tokens,
         COALESCE(SUM(completion_tokens), 0)::int AS completion_tokens,
         COALESCE(SUM(total_tokens), 0)::int AS total_tokens,
         COALESCE(SUM(estimated_cost_minor), 0)::int AS estimated_cost_minor,
         COALESCE(SUM(CASE
           WHEN jsonb_typeof(COALESCE(safety_flags, '[]'::jsonb)) = 'array'
           THEN jsonb_array_length(COALESCE(safety_flags, '[]'::jsonb))
           ELSE 0
         END), 0)::int AS safety_flag_count,
         ROUND(AVG(NULLIF(latency_ms, 0)))::int AS avg_latency_ms,
         MAX(created_at) AS last_generation_at
       FROM clinical_ai_generations
       WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')`,
      windowDays
    ),
    prisma.$queryRawUnsafe(
      `SELECT
         COALESCE(module_key, task_type) AS module_key,
         COUNT(*)::int AS generation_count,
         COALESCE(SUM(CASE WHEN used_ai THEN 1 ELSE 0 END), 0)::int AS ai_generation_count,
         COALESCE(SUM(CASE WHEN used_ai THEN 0 ELSE 1 END), 0)::int AS fallback_count,
         COALESCE(SUM(prompt_tokens), 0)::int AS prompt_tokens,
         COALESCE(SUM(completion_tokens), 0)::int AS completion_tokens,
         COALESCE(SUM(total_tokens), 0)::int AS total_tokens,
         COALESCE(SUM(estimated_cost_minor), 0)::int AS estimated_cost_minor,
         ROUND(AVG(NULLIF(latency_ms, 0)))::int AS avg_latency_ms,
         MAX(created_at) AS last_generation_at
       FROM clinical_ai_generations
       WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
       GROUP BY COALESCE(module_key, task_type)
       ORDER BY generation_count DESC, module_key`,
      windowDays
    ),
    prisma.$queryRawUnsafe(
      `SELECT
         provider,
         COUNT(*)::int AS generation_count,
         COALESCE(SUM(CASE WHEN used_ai THEN 1 ELSE 0 END), 0)::int AS ai_generation_count,
         COALESCE(SUM(CASE WHEN used_ai THEN 0 ELSE 1 END), 0)::int AS fallback_count,
         COALESCE(SUM(prompt_tokens), 0)::int AS prompt_tokens,
         COALESCE(SUM(completion_tokens), 0)::int AS completion_tokens,
         COALESCE(SUM(total_tokens), 0)::int AS total_tokens,
         COALESCE(SUM(estimated_cost_minor), 0)::int AS estimated_cost_minor,
         ROUND(AVG(NULLIF(latency_ms, 0)))::int AS avg_latency_ms,
         MAX(created_at) AS last_generation_at
       FROM clinical_ai_generations
       WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
       GROUP BY provider
       ORDER BY generation_count DESC, provider`,
      windowDays
    ),
    prisma.$queryRawUnsafe(
      `SELECT id, module_key, task_type, provider, model, metadata, created_at
       FROM clinical_ai_generations
       WHERE used_ai = false
         AND metadata ? 'fallback_reason'
         AND created_at >= NOW() - ($1::int * INTERVAL '1 day')
       ORDER BY created_at DESC
       LIMIT 10`,
      windowDays
    ),
  ]);

  return {
    window_days: windowDays,
    overall: overall[0] || {
      generation_count: 0,
      ai_generation_count: 0,
      fallback_count: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      estimated_cost_minor: 0,
      safety_flag_count: 0,
      avg_latency_ms: null,
      last_generation_at: null,
    },
    by_module: byModule,
    by_provider: byProvider,
    recent_failures: recentFailures,
  };
}

function limitState(used, limit) {
  if (!limit || limit <= 0) {
    return {
      used,
      limit: null,
      remaining: null,
      percent_used: null,
      tripped: false,
    };
  }
  const remaining = Math.max(limit - used, 0);
  return {
    used,
    limit,
    remaining,
    percent_used: Math.min(Math.round((used / limit) * 100), 999),
    tripped: used >= limit,
  };
}

export async function getClinicalAiBudgetStatus({ days = 1, guardrails = null, usage = null } = {}) {
  const activeGuardrails = guardrails || await getClinicalAiGuardrails();
  const activeUsage = usage || await getClinicalAiUsageSummary({ days });
  const overall = activeUsage.overall || {};
  const fallbackRatePct = overall.generation_count
    ? Math.round(((overall.fallback_count || 0) / overall.generation_count) * 100)
    : 0;
  const tokenBudget = limitState(overall.total_tokens || 0, activeGuardrails.daily_token_limit);
  const costBudget = limitState(overall.estimated_cost_minor || 0, activeGuardrails.daily_cost_limit_minor);
  const alerts = [];

  if (activeGuardrails.enabled && tokenBudget.tripped) {
    alerts.push({
      severity: 'block',
      code: 'DAILY_TOKEN_LIMIT',
      message: 'Daily clinical AI token budget exhausted',
    });
  }
  if (activeGuardrails.enabled && costBudget.tripped) {
    alerts.push({
      severity: 'block',
      code: 'DAILY_COST_LIMIT',
      message: 'Daily clinical AI estimated cost budget exhausted',
    });
  }
  if (activeGuardrails.enabled && activeGuardrails.max_fallbacks_per_day
      && (overall.fallback_count || 0) >= activeGuardrails.max_fallbacks_per_day) {
    alerts.push({
      severity: 'warn',
      code: 'FALLBACK_COUNT',
      message: 'Clinical AI fallback count exceeded the daily warning threshold',
    });
  }
  if (activeGuardrails.enabled && overall.generation_count >= 5
      && fallbackRatePct >= activeGuardrails.fallback_rate_alert_pct) {
    alerts.push({
      severity: 'warn',
      code: 'FALLBACK_RATE',
      message: 'Clinical AI fallback rate exceeded the warning threshold',
    });
  }
  if (activeGuardrails.enabled && activeGuardrails.latency_alert_ms
      && overall.avg_latency_ms && overall.avg_latency_ms >= activeGuardrails.latency_alert_ms) {
    alerts.push({
      severity: 'warn',
      code: 'LATENCY',
      message: 'Clinical AI average latency exceeded the warning threshold',
    });
  }

  return {
    window_days: Math.min(Math.max(parseInt(days, 10) || 1, 1), 90),
    enabled: activeGuardrails.enabled,
    external_ai_enabled: activeGuardrails.external_ai_enabled,
    token_budget: tokenBudget,
    cost_budget: costBudget,
    request_token_limit: activeGuardrails.request_token_limit,
    fallback_rate_pct: fallbackRatePct,
    alerts,
    blocking_reasons: alerts.filter((alert) => alert.severity === 'block').map((alert) => alert.message),
    tripped: alerts.some((alert) => alert.severity === 'block'),
  };
}

export default {
  CLINICAL_AI_MODULES,
  DEFAULT_CLINICAL_AI_GUARDRAILS,
  getClinicalAiBudgetStatus,
  getClinicalAiGuardrails,
  getClinicalAiModule,
  getClinicalAiUsageSummary,
  listClinicalAiModules,
  updateClinicalAiGuardrails,
  updateClinicalAiModule,
};
