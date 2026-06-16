/**
 * Cybersecurity / Medical Device Anomaly Detector.
 *
 * Accepts anomaly-event signals from five surfaces:
 *   - user_login       (impossible-travel, rapid-login bursts, unusual hour,
 *                       multi-geo spread)
 *   - admin_action     (brute-force on privileged account, credential
 *                       stuffing, password spraying)
 *   - device_traffic   (biomed device traffic spike, unauthorized
 *                       upstream, connection storm)
 *   - data_export      (excessive volume, off-hours access, rapid burst)
 *   - api_usage        (brute-force style API abuse)
 *
 * Rules are authoritative: signal codes, anomaly category, severity,
 * risk score, and recommended actions are derived deterministically from
 * the supplied event context. Decision-support only — the service never
 * disables accounts, quarantines devices, or blocks traffic. Every output
 * must be reviewed by the security officer / IT admin.
 *
 * Graceful degradation: if the tenant does not yet have the security
 * anomalies schema, the service returns a `schema_unavailable` envelope
 * rather than crashing. The caller is told to defer to human review.
 *
 * Input model: anomaly events are passed in as explicit parameters by the
 * caller. The service does NOT read from audit_logs / sessions /
 * login_attempts tables directly — those feeds live in the auth
 * middleware layer (see loginAnomalyDetector.js) and the caller is
 * expected to pre-aggregate the event window before invoking recordAnomaly.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { generateClinicalText } from './localLlmClient.js';

const MODULE_KEY = 'cybersecurity_anomaly_detector';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt:
    'You support security-officer / IT-admin review of cybersecurity anomalies. Rules are authoritative. Return JSON only and never disable accounts, quarantine devices, or block traffic on your own.',
  user_prompt_template:
    'Given the anomaly event context and the rule-based signals + scoring, return keys: summary, anomaly_category, severity, risk_score, signals, recommended_actions, source_citations, safety_flags.',
};

export const ANOMALY_CATEGORIES = [
  'impossible_login',
  'brute_force',
  'credential_stuffing',
  'excessive_export',
  'suspicious_admin',
  'device_traffic_spike',
  'lateral_movement',
  'unknown',
];

const ANOMALY_CATEGORY_SET = new Set(ANOMALY_CATEGORIES);
const SUBJECT_TYPES = new Set(['user_login', 'admin_action', 'device_traffic', 'data_export', 'api_usage', 'unknown']);
const SEVERITIES = new Set(['low', 'medium', 'high', 'critical', 'unknown']);
const DECISIONS = new Set(['pending', 'acknowledged', 'investigating', 'resolved', 'false_positive', 'escalated']);
const FINAL_DECISIONS = new Set(['acknowledged', 'investigating', 'resolved', 'false_positive', 'escalated']);

const IMPOSSIBLE_TRAVEL_KM = 500;

const REVIEW_DISCLAIMER =
  'Decision-support only — do not automatically disable accounts or devices without security-officer review.';

// ---------- Small helpers ------------------------------------------------

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalInt(value, fieldName = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function sourceHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex');
}

function safeJsonParse(text, fallback) {
  if (!text) return fallback;
  const cleaned = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function uniqueCitations(citations) {
  const seen = new Set();
  return asArray(citations).filter((citation) => {
    if (!citation) return false;
    const key = `${citation.source_type}:${citation.source_id}:${citation.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

// ---------- Pure helpers (exported) --------------------------------------

/**
 * Great-circle distance between two lat/lng points, in kilometres.
 * Returns 0 if any input is null/undefined/NaN.
 */
export function distanceKm({ lat1, lng1, lat2, lng2 } = {}) {
  if (lat1 === null || lat1 === undefined
    || lng1 === null || lng1 === undefined
    || lat2 === null || lat2 === undefined
    || lng2 === null || lng2 === undefined) return 0;
  const la1 = Number(lat1);
  const lo1 = Number(lng1);
  const la2 = Number(lat2);
  const lo2 = Number(lng2);
  if (!Number.isFinite(la1) || !Number.isFinite(lo1)
    || !Number.isFinite(la2) || !Number.isFinite(lo2)) return 0;
  const R = 6371; // mean Earth radius in km
  const dLat = toRadians(la2 - la1);
  const dLon = toRadians(lo2 - lo1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(la1)) * Math.cos(toRadians(la2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Detect login-anomaly signals from a window of recent login events.
 *
 * Each login is expected to look like:
 *   { timestamp, ip, country, city, lat, lng }
 *
 * Returns Array<{ code, severity, description }>.
 */
export function classifyLoginAnomaly({
  recentLogins = [],
  windowMinutes = 60,
} = {}) {
  const logins = asArray(recentLogins)
    .filter((entry) => entry && entry.timestamp)
    .map((entry) => ({
      ...entry,
      tsMs: new Date(entry.timestamp).getTime(),
    }))
    .filter((entry) => Number.isFinite(entry.tsMs))
    .sort((a, b) => a.tsMs - b.tsMs);

  const signals = [];
  const seen = new Set();
  const push = (signal) => {
    if (seen.has(signal.code)) return;
    seen.add(signal.code);
    signals.push(signal);
  };

  const windowMs = Math.max(0, toNumber(windowMinutes, 60)) * 60 * 1000;

  // IMPOSSIBLE_TRAVEL — two logins within the window from locations > 500 km apart.
  for (let i = 1; i < logins.length; i += 1) {
    const prev = logins[i - 1];
    const curr = logins[i];
    const gap = curr.tsMs - prev.tsMs;
    if (gap < 0 || gap > windowMs) continue;
    const km = distanceKm({
      lat1: prev.lat,
      lng1: prev.lng,
      lat2: curr.lat,
      lng2: curr.lng,
    });
    if (km > IMPOSSIBLE_TRAVEL_KM) {
      push({
        code: 'IMPOSSIBLE_TRAVEL',
        severity: 'high',
        description: `Two logins observed within ${windowMinutes} minutes from locations ${Math.round(km)} km apart (${prev.city || prev.country || 'unknown'} → ${curr.city || curr.country || 'unknown'}).`,
      });
      break;
    }
  }

  // MULTIPLE_GEO — 3+ distinct countries in the last 24h.
  const nowMs = logins.length ? logins[logins.length - 1].tsMs : Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const recentCountries = new Set();
  for (const login of logins) {
    if (nowMs - login.tsMs > dayMs) continue;
    const country = cleanText(login.country);
    if (country) recentCountries.add(country.toLowerCase());
  }
  if (recentCountries.size >= 3) {
    push({
      code: 'MULTIPLE_GEO',
      severity: 'medium',
      description: `Logins observed from ${recentCountries.size} distinct countries in the last 24 hours.`,
    });
  }

  // RAPID_LOGINS — 10+ logins in any 5-minute window.
  const fiveMinMs = 5 * 60 * 1000;
  for (let i = 0; i < logins.length; i += 1) {
    let count = 0;
    for (let j = i; j < logins.length; j += 1) {
      if (logins[j].tsMs - logins[i].tsMs > fiveMinMs) break;
      count += 1;
    }
    if (count >= 10) {
      push({
        code: 'RAPID_LOGINS',
        severity: 'high',
        description: `${count} login attempts observed within a 5-minute window — brute-force pattern.`,
      });
      break;
    }
  }

  // UNUSUAL_HOUR — any login between 01:00 and 05:00 local time.
  for (const login of logins) {
    const d = new Date(login.tsMs);
    if (Number.isNaN(d.getTime())) continue;
    const hour = d.getHours();
    if (hour >= 1 && hour < 5) {
      push({
        code: 'UNUSUAL_HOUR',
        severity: 'low',
        description: `Login observed at ${String(hour).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} local time (between 01:00 and 05:00).`,
      });
      break;
    }
  }

  return signals;
}

/**
 * Detect brute-force / credential-stuffing / password-spraying signals
 * from aggregated failed-login counts within a window.
 */
export function classifyBruteForce({
  failedAttempts = 0,
  distinctAccounts = 0,
  sourceIp = null,
  windowMinutes = 10,
} = {}) {
  const fails = Math.max(0, toNumber(failedAttempts, 0));
  const accts = Math.max(0, toNumber(distinctAccounts, 0));
  const window = Math.max(1, toNumber(windowMinutes, 10));
  const signals = [];

  if (accts >= 10 && fails > 0) {
    signals.push({
      code: 'CREDENTIAL_STUFFING',
      severity: 'critical',
      description: `${accts} distinct accounts saw failed attempts${sourceIp ? ` from ${sourceIp}` : ''} within a ${window}-minute window — credential-stuffing pattern.`,
    });
  }

  if (fails >= 20) {
    signals.push({
      code: 'BRUTE_FORCE_SINGLE_ACCOUNT',
      severity: 'high',
      description: `${fails} failed login attempts${sourceIp ? ` from ${sourceIp}` : ''} within a ${window}-minute window — brute-force on a single account.`,
    });
  }

  if (fails >= 5 && accts >= 3) {
    signals.push({
      code: 'PASSWORD_SPRAYING',
      severity: 'high',
      description: `${fails} failed attempts spread across ${accts} accounts${sourceIp ? ` from ${sourceIp}` : ''} — password-spraying pattern.`,
    });
  }

  return signals;
}

/**
 * Detect excessive-export signals from aggregated export activity.
 */
export function classifyExcessiveExport({
  exportCount = 0,
  totalRowsExported = 0,
  windowHours = 24,
  hasOffHoursAccess = false,
} = {}) {
  const count = Math.max(0, toNumber(exportCount, 0));
  const rows = Math.max(0, toNumber(totalRowsExported, 0));
  const window = Math.max(1, toNumber(windowHours, 24));
  const signals = [];

  if (rows > 10000) {
    signals.push({
      code: 'EXCESSIVE_EXPORT_VOLUME',
      severity: 'high',
      description: `${rows} rows exported within a ${window}-hour window — exceeds the 10,000-row volume threshold.`,
    });
  }

  if (hasOffHoursAccess && rows > 1000) {
    signals.push({
      code: 'EXPORT_OFF_HOURS',
      severity: 'medium',
      description: `${rows} rows exported during off-hours — confirm the export was authorized.`,
    });
  }

  if (count >= 5) {
    signals.push({
      code: 'RAPID_EXPORT_BURST',
      severity: 'medium',
      description: `${count} export operations within a ${window}-hour window — rapid-burst pattern.`,
    });
  }

  return signals;
}

/**
 * Detect biomedical device traffic anomalies.
 */
export function classifyDeviceTrafficAnomaly({
  bytesInLastHour = 0,
  baselineBytesPerHour = null,
  connectionAttempts = 0,
  knownUpstreamEndpoints = 0,
} = {}) {
  const bytes = Math.max(0, toNumber(bytesInLastHour, 0));
  const baseline = baselineBytesPerHour === null || baselineBytesPerHour === undefined
    ? null
    : Math.max(0, toNumber(baselineBytesPerHour, 0));
  const attempts = Math.max(0, toNumber(connectionAttempts, 0));
  const known = Math.max(0, toNumber(knownUpstreamEndpoints, 0));
  const signals = [];

  // Unauthorized upstream takes priority — device is reaching out to
  // endpoints that are not on the allowlist. Critical severity.
  if (known === 0 && attempts > 0) {
    signals.push({
      code: 'UNAUTHORIZED_UPSTREAM',
      severity: 'critical',
      description: `Device attempted ${attempts} connection(s) with no known/allowlisted upstream endpoints — possible lateral-movement or exfiltration.`,
    });
  }

  if (baseline !== null && baseline > 0 && bytes > baseline * 5) {
    signals.push({
      code: 'DEVICE_TRAFFIC_SPIKE',
      severity: 'high',
      description: `Device outbound traffic ${bytes} bytes/hour is more than 5x the learned baseline of ${baseline} bytes/hour.`,
    });
  }

  if (attempts > 1000) {
    signals.push({
      code: 'CONNECTION_STORM',
      severity: 'high',
      description: `Device attempted ${attempts} connections in the last hour — connection storm.`,
    });
  }

  return signals;
}

/**
 * Score a bag of signals into { risk_score, severity }.
 *
 * Weights: critical +40, high +25, medium +12, low +5. Clamped 0-100.
 * Severity bands: >=70 critical, >=45 high, >=20 medium, >0 low, 0 unknown.
 */
export function computeAnomalyScore(signals) {
  const weights = { critical: 40, high: 25, medium: 12, low: 5 };
  let score = 0;
  for (const signal of asArray(signals)) {
    score += weights[signal?.severity] || 0;
  }
  score = Math.max(0, Math.min(100, score));

  let severity = 'unknown';
  if (score >= 70) severity = 'critical';
  else if (score >= 45) severity = 'high';
  else if (score >= 20) severity = 'medium';
  else if (score > 0) severity = 'low';

  return { risk_score: score, severity };
}

/**
 * Categorize a bag of signals into a single best-fit anomaly_category.
 *
 * Priority (first match wins):
 *   impossible_login > credential_stuffing > brute_force >
 *   device_traffic_spike > lateral_movement > excessive_export >
 *   suspicious_admin > unknown
 */
export function categorizeAnomaly(signals) {
  const codes = new Set(
    asArray(signals).map((s) => cleanText(s?.code).toUpperCase()).filter(Boolean)
  );
  if (codes.size === 0) return 'unknown';

  if (codes.has('IMPOSSIBLE_TRAVEL') || codes.has('MULTIPLE_GEO')) return 'impossible_login';
  if (codes.has('CREDENTIAL_STUFFING')) return 'credential_stuffing';
  if (codes.has('BRUTE_FORCE_SINGLE_ACCOUNT')
    || codes.has('PASSWORD_SPRAYING')
    || codes.has('RAPID_LOGINS')) return 'brute_force';
  if (codes.has('DEVICE_TRAFFIC_SPIKE') || codes.has('CONNECTION_STORM')) return 'device_traffic_spike';
  if (codes.has('UNAUTHORIZED_UPSTREAM')) return 'lateral_movement';
  if (codes.has('EXCESSIVE_EXPORT_VOLUME')
    || codes.has('EXPORT_OFF_HOURS')
    || codes.has('RAPID_EXPORT_BURST')) return 'excessive_export';
  if (codes.has('SUSPICIOUS_ADMIN')) return 'suspicious_admin';
  if (codes.has('UNUSUAL_HOUR')) return 'impossible_login';

  return 'unknown';
}

/**
 * Recommend reviewer actions based on the anomaly category + severity.
 *
 * The final entry is always the decision-support disclaimer.
 */
export function recommendAnomalyActions(category, severity) {
  const actions = [];
  const cat = cleanText(category).toLowerCase();
  const sev = cleanText(severity).toLowerCase();

  switch (cat) {
    case 'impossible_login':
      actions.push('Force password reset; review session history; notify user via secondary channel.');
      actions.push('Correlate against VPN / proxy logs before assuming malicious intent.');
      break;
    case 'credential_stuffing':
      actions.push('Lock affected accounts; enable MFA for all; contact security officer.');
      actions.push('Block the source IP at the edge and add to the threat-intel feed.');
      break;
    case 'brute_force':
      actions.push('Block source IP; increase login throttling; alert SOC.');
      actions.push('Review recent auth logs for the targeted account(s) and force credential rotation on any successful login from the same IP.');
      break;
    case 'device_traffic_spike':
      actions.push('Isolate device from network; engage biomed + network team.');
      actions.push('Capture a packet sample before isolation to preserve forensic evidence.');
      break;
    case 'lateral_movement':
      actions.push('Isolate device/host from network; engage IR team immediately.');
      actions.push('Preserve memory + disk images for forensic review before any remediation.');
      break;
    case 'excessive_export':
      actions.push('Freeze export tokens; require approval for next export; escalate to compliance.');
      actions.push('Review which patient cohorts / record types were exported and whether any PHI left the environment.');
      break;
    case 'suspicious_admin':
      actions.push('Review the privileged action trail; require re-authentication for further admin changes.');
      actions.push('Confirm the admin account owner acknowledges the action out-of-band.');
      break;
    default:
      actions.push('Review the event context manually and triage with the security team.');
  }

  if (sev === 'critical') {
    actions.push('Page the on-call security officer immediately; start an incident record.');
  } else if (sev === 'high') {
    actions.push('Notify the security officer within the SLA and begin triage.');
  }

  actions.push(REVIEW_DISCLAIMER);
  return actions;
}

// ---------- DB helpers ---------------------------------------------------

async function getActivePrompt(tenantId) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT version, system_prompt, user_prompt_template
       FROM clinical_ai_prompts
       WHERE tenant_id = $1::uuid
         AND module_key = $2
       ORDER BY active DESC, activated_at DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      tenantId,
      MODULE_KEY
    );
    return (rows && rows[0]) || DEFAULT_PROMPT;
  } catch (err) {
    if (isMissingSchemaError(err)) return DEFAULT_PROMPT;
    throw err;
  }
}

async function insertGeneration({
  tenantId,
  sourceHashValue,
  draft,
  citations,
  safetyFlags,
  requestedBy,
  aiResult,
  prompt,
  metadata,
}) {
  const hasCritical = asArray(safetyFlags).some((flag) => flag?.severity === 'critical');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_generations
         (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model,
          prompt_version, source_hash, status, used_ai, safety_flags, citations, draft,
          generated_by, prompt_tokens, completion_tokens, total_tokens,
          estimated_cost_minor, metadata, created_at, updated_at)
       VALUES ($1::uuid, NULL, NULL, $2, $2, $3, $4,
               $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb,
               $12::uuid, $13, $14, $15, $16, $17::jsonb, NOW(), NOW())
       RETURNING id, status, created_at`,
      tenantId,
      MODULE_KEY,
      aiResult?.provider || 'template',
      aiResult?.model || null,
      prompt?.version || 'v1',
      sourceHashValue,
      hasCritical ? 'failed' : 'draft',
      Boolean(aiResult?.usedAi),
      JSON.stringify(safetyFlags),
      JSON.stringify(citations),
      JSON.stringify(draft),
      requestedBy,
      aiResult?.usage?.prompt_tokens || 0,
      aiResult?.usage?.completion_tokens || 0,
      aiResult?.usage?.total_tokens || 0,
      aiResult?.estimatedCostMinor ?? 0,
      JSON.stringify(metadata || {})
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Cybersecurity anomaly generation persist failed', { error: err.message });
    }
    return null;
  }
}

function normalizeAnomalyRow(row) {
  if (!row) return row;
  return {
    ...row,
    risk_score: toNumber(row.risk_score, 0),
  };
}

async function insertAnomalyRow({
  tenantId,
  generationId,
  subjectType,
  subjectId,
  category,
  severity,
  riskScore,
  signals,
  context,
  recommendedActions,
  citations,
  metadata,
}) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_security_anomalies
         (tenant_id, generation_id, subject_type, subject_id, anomaly_category,
          severity, risk_score, signals, context, recommended_actions,
          source_citations, reviewer_decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb,
               $11::jsonb, 'pending', $12::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, generation_id, subject_type, subject_id,
                 anomaly_category, severity, risk_score, detected_at, signals,
                 context, recommended_actions, source_citations, reviewer_decision,
                 reviewed_by, reviewed_at, reviewer_note, metadata,
                 created_at, updated_at`,
      tenantId,
      generationId,
      subjectType,
      subjectId,
      category,
      severity,
      riskScore,
      JSON.stringify(signals || []),
      JSON.stringify(context || {}),
      JSON.stringify(recommendedActions || []),
      JSON.stringify(citations || []),
      JSON.stringify(metadata || {})
    );
    return normalizeAnomalyRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

// ---------- Public API --------------------------------------------------

/**
 * Run the appropriate classifier for the subject_type and return the list
 * of rule-based signals. Exposed for tests and direct callers that already
 * have the module enable-check covered.
 */
function runClassifier(subjectType, inputs) {
  const safe = inputs || {};
  switch (subjectType) {
    case 'user_login':
      return classifyLoginAnomaly(safe);
    case 'admin_action': {
      // Admin actions can be either brute-force on privileged account or
      // a large export authored by an admin. Run both and merge.
      const a = classifyBruteForce(safe);
      const b = classifyExcessiveExport(safe);
      return [...a, ...b];
    }
    case 'device_traffic':
      return classifyDeviceTrafficAnomaly(safe);
    case 'data_export':
      return classifyExcessiveExport(safe);
    case 'api_usage':
      return classifyBruteForce(safe);
    default:
      return [];
  }
}

/**
 * Record a security anomaly event. See module JSDoc for the input model.
 */
export async function recordAnomaly({
  req = null,
  subjectType,
  subjectId = null,
  inputs = {},
  context = {},
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const type = SUBJECT_TYPES.has(subjectType) ? subjectType : 'unknown';
  const subject = subjectId ? cleanText(subjectId).slice(0, 200) : null;

  const signals = runClassifier(type, inputs);
  const { risk_score: riskScore, severity } = computeAnomalyScore(signals);
  const category = categorizeAnomaly(signals);
  const recommendedActions = recommendAnomalyActions(category, severity);

  const citations = [];
  citations.push({
    source_type: 'security_event',
    source_id: subject || `${type}:unknown`,
    label: `${type} anomaly context`,
    timestamp: new Date().toISOString(),
  });

  const safetyFlags = [];
  if (severity === 'critical') {
    safetyFlags.push({
      severity: 'critical',
      code: 'SECURITY_CRITICAL_ANOMALY',
      message: 'Critical cybersecurity anomaly detected — page the on-call security officer.',
    });
  } else if (severity === 'high') {
    safetyFlags.push({
      severity: 'high',
      code: 'SECURITY_HIGH_ANOMALY',
      message: 'High-severity cybersecurity anomaly detected — notify security officer within SLA.',
    });
  }
  safetyFlags.push({
    severity: 'low',
    code: 'SECURITY_REVIEW_NOTICE',
    message: REVIEW_DISCLAIMER,
  });

  const fallbackDraft = {
    subject_type: type,
    subject_id: subject,
    anomaly_category: category,
    severity,
    risk_score: riskScore,
    signals,
    context: context && typeof context === 'object' ? context : {},
    recommended_actions: recommendedActions,
    source_citations: citations,
    safety_flags: safetyFlags,
    summary: signals.length
      ? `${signals.length} security signal(s) detected — ${severity} severity, category ${category}.`
      : 'No security signals detected in the supplied event context.',
    rules_authoritative: true,
    decision_support_only: true,
  };

  let draft = fallbackDraft;
  let aiResult = null;
  const prompt = await getActivePrompt(tenantId);
  try {
    aiResult = await generateClinicalText({
      taskType: MODULE_KEY,
      systemPrompt: prompt.system_prompt,
      userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify({
        subject_type: type,
        subject_id: subject,
        inputs,
        context,
        rule_based_signals: signals,
        rule_based_category: category,
        rule_based_severity: severity,
        rule_based_risk_score: riskScore,
      })}`,
      tenantRegion: req?.tenant?.region || null,
      tenantId,
    });
    const parsed = safeJsonParse(aiResult?.text, {});
    if (parsed && typeof parsed === 'object') {
      draft = {
        ...fallbackDraft,
        summary: cleanText(parsed.summary) || fallbackDraft.summary,
        source_citations: uniqueCitations([
          ...asArray(fallbackDraft.source_citations),
          ...asArray(parsed.source_citations),
        ]),
        safety_flags: [
          ...asArray(fallbackDraft.safety_flags),
          ...asArray(parsed.safety_flags),
        ],
      };
    }
  } catch (err) {
    logger.debug('Cybersecurity anomaly AI narrative unavailable; using template fallback', {
      error: err?.message,
    });
  }

  const finalCitations = uniqueCitations(asArray(draft.source_citations));
  draft.source_citations = finalCitations;
  draft.safety_flags = safetyFlags;

  const generation = await insertGeneration({
    tenantId,
    sourceHashValue: sourceHash({
      subject_type: type,
      subject_id: subject,
      inputs,
      context,
      signal_codes: signals.map((s) => s.code),
    }),
    draft,
    citations: finalCitations,
    safetyFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    prompt,
    metadata: {
      subject_type: type,
      subject_id: subject,
      anomaly_category: category,
      severity,
      risk_score: riskScore,
      signal_codes: signals.map((s) => s.code),
      rules_authoritative: true,
    },
  });

  const anomalyRow = await insertAnomalyRow({
    tenantId,
    generationId: generation?.id || null,
    subjectType: type,
    subjectId: subject,
    category: ANOMALY_CATEGORY_SET.has(category) ? category : 'unknown',
    severity: SEVERITIES.has(severity) ? severity : 'unknown',
    riskScore,
    signals,
    context: context && typeof context === 'object' ? context : {},
    recommendedActions,
    citations: finalCitations,
    metadata: {
      used_ai: Boolean(aiResult?.usedAi),
      provider: aiResult?.provider || 'template',
      signal_codes: signals.map((s) => s.code),
      rules_authoritative: true,
    },
  });

  if (!anomalyRow) {
    return {
      anomaly_id: null,
      generation_id: generation?.id || null,
      draft,
      source_citations: finalCitations,
      safety_flags: safetyFlags,
      module_key: MODULE_KEY,
      prompt_version: prompt.version || 'v1',
      review_status: 'schema_unavailable',
      reason: 'clinical_ai_security_anomalies_unavailable',
      decision_support_only: true,
      rules_authoritative: true,
    };
  }

  try {
    await publishEvent({
      eventType: 'clinical_ai.security_anomaly_detected',
      aggregateType: 'clinical_ai_security_anomaly',
      aggregateId: anomalyRow.id,
      patientUid: null,
      payload: {
        tenant_id: tenantId,
        anomaly_id: anomalyRow.id,
        generation_id: generation?.id || null,
        subject_type: type,
        subject_id: subject,
        anomaly_category: category,
        severity,
        risk_score: riskScore,
        signal_codes: signals.map((s) => s.code),
      },
    });
  } catch (err) {
    logger.warn('Cybersecurity anomaly event publish failed', { error: err?.message });
  }

  return {
    anomaly_id: anomalyRow.id,
    generation_id: generation?.id || null,
    draft,
    anomaly: anomalyRow,
    source_citations: finalCitations,
    safety_flags: safetyFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt.version || 'v1',
    review_status: anomalyRow.reviewer_decision || 'pending',
    ai_metadata: {
      provider: aiResult?.provider || 'template',
      model: aiResult?.model || null,
      used_ai: Boolean(aiResult?.usedAi),
    },
    rules_authoritative: true,
    decision_support_only: true,
  };
}

export async function listSecurityAnomalies({
  tenantId = null,
  subjectType = null,
  severity = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedSubject = subjectType && SUBJECT_TYPES.has(cleanText(subjectType).toLowerCase())
    ? cleanText(subjectType).toLowerCase()
    : null;
  const normalizedSeverity = severity && SEVERITIES.has(cleanText(severity).toLowerCase())
    ? cleanText(severity).toLowerCase()
    : null;
  const normalizedDecision = reviewerDecision && DECISIONS.has(cleanText(reviewerDecision).toLowerCase())
    ? cleanText(reviewerDecision).toLowerCase()
    : null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT a.id, a.tenant_id, a.generation_id, a.subject_type, a.subject_id,
              a.anomaly_category, a.severity, a.risk_score, a.detected_at,
              a.signals, a.context, a.recommended_actions, a.source_citations,
              a.reviewer_decision, a.reviewed_by, a.reviewed_at, a.reviewer_note,
              a.metadata, a.created_at, a.updated_at
       FROM clinical_ai_security_anomalies a
       WHERE a.tenant_id = $1::uuid
         AND ($2::text IS NULL OR a.subject_type = $2)
         AND ($3::text IS NULL OR a.severity = $3)
         AND ($4::text IS NULL OR a.reviewer_decision = $4)
       ORDER BY
         CASE a.severity
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'medium' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         a.detected_at DESC
       LIMIT $5`,
      tid,
      normalizedSubject,
      normalizedSeverity,
      normalizedDecision,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizeAnomalyRow);
    return { anomalies: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { anomalies: [], count: 0 };
    throw err;
  }
}

export async function decideSecurityAnomaly({
  tenantId = null,
  anomalyId,
  decision,
  reviewerUid = null,
  note = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = cleanText(decision).toLowerCase();
  if (!FINAL_DECISIONS.has(normalized)) {
    throw AppError.badRequest('decision must be acknowledged, investigating, resolved, false_positive, or escalated');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_security_anomalies
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, tenant_id, generation_id, subject_type, subject_id,
               anomaly_category, severity, risk_score, detected_at, signals,
               context, recommended_actions, source_citations, reviewer_decision,
               reviewed_by, reviewed_at, reviewer_note, metadata,
               created_at, updated_at`,
    optionalInt(anomalyId, 'anomaly_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('Security anomaly not found');
  return normalizeAnomalyRow(rows[0]);
}

export default {
  ANOMALY_CATEGORIES,
  categorizeAnomaly,
  classifyBruteForce,
  classifyDeviceTrafficAnomaly,
  classifyExcessiveExport,
  classifyLoginAnomaly,
  computeAnomalyScore,
  decideSecurityAnomaly,
  distanceKm,
  listSecurityAnomalies,
  recommendAnomalyActions,
  recordAnomaly,
};
