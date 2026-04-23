/**
 * Blood Bank Demand and Compatibility Forecast.
 *
 * Projects blood-component demand (PRBC, FFP, platelets, cryoprecipitate,
 * whole blood) across a rolling window against current inventory. Surfaces
 * stock-out risk by blood group + component and massive transfusion
 * protocol (MTP) readiness. Review-only: blood bank / lab staff confirm
 * and act. The service never auto-orders or auto-issues units, and never
 * alters crossmatch or transfusion records. Rules are authoritative;
 * decision support only.
 *
 * Graceful degradation: if no upcoming-procedure schema is available, the
 * forecast returns `missing_inventory_data` / empty demand and warns via
 * safety flags rather than inventing demand.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';

const MODULE_KEY = 'blood_bank_demand_forecast';

export const BLOOD_GROUPS = ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'];
export const COMPONENTS = ['packed_red_cells', 'whole_blood', 'platelets', 'ffp', 'cryoprecipitate'];

const BLOOD_GROUP_SET = new Set(BLOOD_GROUPS);
const COMPONENT_SET = new Set(COMPONENTS);

const RISK_BANDS = new Set(['low', 'moderate', 'high', 'critical', 'unknown']);
const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'escalated']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'escalated']);

// MTP (massive transfusion protocol) inventory thresholds.
export const MTP_PRBC_MIN_UNITS = 6; // universal donor PRBC (O-) reserve
export const MTP_FFP_MIN_UNITS = 4; // universal plasma (AB) reserve
export const MTP_PLATELETS_MIN_UNITS = 1;

// ---------- Small helpers -------------------------------------------------

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizedText(value) {
  return cleanText(value).toLowerCase();
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

function toNonNegativeInt(value, fieldName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw AppError.badRequest(`${fieldName} must be a non-negative integer`);
  }
  return parsed;
}

function optionalInt(value, fieldName = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function sourceHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex');
}

function validateBloodGroup(value) {
  const upper = cleanText(value).toUpperCase();
  if (!BLOOD_GROUP_SET.has(upper)) {
    throw AppError.badRequest(
      `blood_group must be one of: ${BLOOD_GROUPS.join(', ')}`
    );
  }
  return upper;
}

function validateComponent(value) {
  const lower = normalizedText(value);
  if (!COMPONENT_SET.has(lower)) {
    throw AppError.badRequest(
      `component must be one of: ${COMPONENTS.join(', ')}`
    );
  }
  return lower;
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

function pairKey(bloodGroup, component) {
  return `${bloodGroup}::${component}`;
}

// ---------- Pure helpers (exported) --------------------------------------

/**
 * Estimate per-procedure blood component demand from a free-text
 * description. Rule-based keyword matching against common surgical and
 * obstetric categories. Unknown procedures return an empty array — the
 * forecast defers to human review rather than inventing demand.
 *
 * Returns Array<{ component: string, units: number }>.
 */
export function estimatePerProcedureDemand(procedureDescription) {
  const text = normalizedText(procedureDescription);
  if (!text) return [];

  // Order matters — more specific patterns first.
  // Cardiac / aortic surgery — heavy blood product use.
  if (/\b(cabg|coronary\s+artery\s+bypass|open\s+heart|bypass\s+graft|cardiac\s+surgery|aortic\s+(?:valve|aneurysm|dissection|repair)|aortic)\b/i.test(text)) {
    return [
      { component: 'packed_red_cells', units: 3 },
      { component: 'ffp', units: 2 },
      { component: 'platelets', units: 1 },
    ];
  }

  // Major trauma — heavy PRBC, FFP; often triggers MTP.
  if (/\b(trauma|polytrauma|gunshot|stab\s+wound|major\s+trauma|mass\s+casualty)\b/i.test(text)) {
    return [
      { component: 'packed_red_cells', units: 4 },
      { component: 'ffp', units: 2 },
      { component: 'platelets', units: 1 },
    ];
  }

  // Obstetric postpartum hemorrhage (PPH).
  if (/\b(pph|post[-\s]?partum\s+hemorrhage|obstetric\s+hemorrhage|placenta\s+(?:previa|accreta))\b/i.test(text)) {
    return [
      { component: 'packed_red_cells', units: 2 },
      { component: 'ffp', units: 1 },
    ];
  }

  // Liver / transplant / major hepatobiliary.
  if (/\b(liver\s+transplant|hepatic\s+resection|whipple|major\s+hepatobiliary)\b/i.test(text)) {
    return [
      { component: 'packed_red_cells', units: 4 },
      { component: 'ffp', units: 2 },
    ];
  }

  // Major surgery umbrella (OT + major keyword).
  if (/\b(major\s+surgery|ot\b.*major|major\s+abdominal|major\s+orthopedic|spinal\s+fusion|neurosurgery|craniotomy)\b/i.test(text)) {
    return [
      { component: 'packed_red_cells', units: 2 },
    ];
  }

  // Any OT / operating-theatre reference with no modifier — treat as
  // general elective and reserve 2 PRBC by default.
  if (/\b(ot\b|operating\s+theatre|operation\s+theatre|or\s+case|operating\s+room)\b/i.test(text)) {
    return [
      { component: 'packed_red_cells', units: 2 },
    ];
  }

  // Default elective surgery keyword — 1 PRBC reserved.
  if (/\b(elective\s+surgery|surgery|surgical\s+procedure|procedure|operation)\b/i.test(text)) {
    return [
      { component: 'packed_red_cells', units: 1 },
    ];
  }

  return [];
}

/**
 * Aggregate per-procedure demand across multiple upcoming procedures into
 * a (blood_group, component) forecast. If a procedure has no known blood
 * group, distribute to 'O+' (the most common blood group) and note the
 * driver as `default_group`.
 *
 * Input: Array<{ procedure_description, blood_group?, scheduled_at? }>
 * Returns: Array<{ blood_group, component, predicted_units, drivers }>.
 */
export function aggregateDemandForecast(procedures) {
  const byPair = new Map();
  const list = asArray(procedures);

  for (const proc of list) {
    if (!proc) continue;
    const description = proc.procedure_description || proc.procedure_name || '';
    const needs = estimatePerProcedureDemand(description);
    if (!needs.length) continue;

    const rawGroup = proc.blood_group ? cleanText(proc.blood_group).toUpperCase() : null;
    const group = rawGroup && BLOOD_GROUP_SET.has(rawGroup) ? rawGroup : 'O+';
    const defaulted = !rawGroup || !BLOOD_GROUP_SET.has(rawGroup);

    for (const { component, units } of needs) {
      if (!COMPONENT_SET.has(component) || units <= 0) continue;
      const key = pairKey(group, component);
      if (!byPair.has(key)) {
        byPair.set(key, {
          blood_group: group,
          component,
          predicted_units: 0,
          drivers: [],
        });
      }
      const bucket = byPair.get(key);
      bucket.predicted_units += units;
      const driverNotes = [];
      if (defaulted) driverNotes.push('default_group');
      bucket.drivers.push({
        procedure: cleanText(description) || '(unspecified)',
        units,
        scheduled_at: proc.scheduled_at || null,
        notes: driverNotes,
      });
    }
  }

  return Array.from(byPair.values()).sort((a, b) => {
    if (a.blood_group !== b.blood_group) return a.blood_group < b.blood_group ? -1 : 1;
    return a.component < b.component ? -1 : 1;
  });
}

/**
 * Classify stock-out risk per (blood_group, component) pair.
 *
 * projected_shortfall = units_available - units_committed - predicted_units
 *
 * Bands:
 *   projected < 0                              → 'critical'
 *   projected < minimum_stock_level            → 'high'
 *   projected < minimum_stock_level * 1.5      → 'moderate'
 *   else                                       → 'low'
 *
 * Returns an entry for every (group, component) pair that appears in
 * either inventory or predicted demand — so the UI can show zero-demand
 * groups that are low on stock, and zero-stock groups that have demand.
 */
export function classifyStockoutRisk({ inventory = [], predictedDemand = [], windowHours = 24 } = {}) {
  const inv = new Map();
  for (const row of asArray(inventory)) {
    if (!row) continue;
    const group = cleanText(row.blood_group).toUpperCase();
    const component = normalizedText(row.component);
    if (!BLOOD_GROUP_SET.has(group) || !COMPONENT_SET.has(component)) continue;
    inv.set(pairKey(group, component), {
      units_available: toNumber(row.units_available, 0),
      units_committed: toNumber(row.units_committed, 0),
      minimum_stock_level: toNumber(row.minimum_stock_level, 0),
    });
  }

  const demand = new Map();
  for (const row of asArray(predictedDemand)) {
    if (!row) continue;
    const group = cleanText(row.blood_group).toUpperCase();
    const component = normalizedText(row.component);
    if (!BLOOD_GROUP_SET.has(group) || !COMPONENT_SET.has(component)) continue;
    demand.set(pairKey(group, component), toNumber(row.predicted_units, 0));
  }

  const keys = new Set([...inv.keys(), ...demand.keys()]);
  const results = [];

  for (const key of keys) {
    const [bloodGroup, component] = key.split('::');
    const invRow = inv.get(key) || { units_available: 0, units_committed: 0, minimum_stock_level: 0 };
    const predicted = demand.get(key) || 0;
    const projected = invRow.units_available - invRow.units_committed - predicted;

    let band;
    if (projected < 0) {
      band = 'critical';
    } else if (projected < invRow.minimum_stock_level) {
      band = 'high';
    } else if (projected < invRow.minimum_stock_level * 1.5) {
      band = 'moderate';
    } else {
      band = 'low';
    }

    results.push({
      blood_group: bloodGroup,
      component,
      units_available: invRow.units_available,
      units_committed: invRow.units_committed,
      minimum_stock_level: invRow.minimum_stock_level,
      predicted_units: predicted,
      projected_shortfall: projected,
      risk_band: band,
      window_hours: toNumber(windowHours, 24),
    });
  }

  return results.sort((a, b) => {
    const order = { critical: 0, high: 1, moderate: 2, low: 3 };
    if (order[a.risk_band] !== order[b.risk_band]) return order[a.risk_band] - order[b.risk_band];
    if (a.blood_group !== b.blood_group) return a.blood_group < b.blood_group ? -1 : 1;
    return a.component < b.component ? -1 : 1;
  });
}

/**
 * Assess massive transfusion protocol (MTP) readiness. MTP is the
 * emergency protocol for hemorrhagic trauma — requires on-hand
 * universal-donor PRBC (O-), universal plasma (AB), and platelets.
 */
export function assessMtpReadiness(inventory) {
  const list = asArray(inventory);
  const findUnits = (groupPredicate, component) => {
    let total = 0;
    for (const row of list) {
      if (!row) continue;
      const group = cleanText(row.blood_group).toUpperCase();
      const comp = normalizedText(row.component);
      if (!BLOOD_GROUP_SET.has(group) || !COMPONENT_SET.has(comp)) continue;
      if (comp !== component) continue;
      if (!groupPredicate(group)) continue;
      const available = Math.max(0, toNumber(row.units_available, 0) - toNumber(row.units_committed, 0));
      total += available;
    }
    return total;
  };

  const prbcUnits = findUnits((g) => g === 'O-', 'packed_red_cells');
  // Universal plasma = AB (AB+ or AB-) FFP.
  const ffpUnits = findUnits((g) => g === 'AB+' || g === 'AB-', 'ffp');
  const plateletUnits = findUnits(() => true, 'platelets');

  const prbcOk = prbcUnits >= MTP_PRBC_MIN_UNITS;
  const ffpOk = ffpUnits >= MTP_FFP_MIN_UNITS;
  const plateletsOk = plateletUnits >= MTP_PLATELETS_MIN_UNITS;

  const details = [
    {
      label: `O- packed_red_cells (universal donor PRBC)`,
      required: MTP_PRBC_MIN_UNITS,
      available: prbcUnits,
      ok: prbcOk,
    },
    {
      label: `AB ffp (universal plasma)`,
      required: MTP_FFP_MIN_UNITS,
      available: ffpUnits,
      ok: ffpOk,
    },
    {
      label: `platelets (any group)`,
      required: MTP_PLATELETS_MIN_UNITS,
      available: plateletUnits,
      ok: plateletsOk,
    },
  ];

  return {
    ready: prbcOk && ffpOk && plateletsOk,
    prbc_ok: prbcOk,
    ffp_ok: ffpOk,
    platelets_ok: plateletsOk,
    prbc_units_available: prbcUnits,
    ffp_units_available: ffpUnits,
    platelets_units_available: plateletUnits,
    details,
  };
}

/**
 * Roll the per-pair stock-out risks + MTP readiness into a single forecast
 * risk band for headline display.
 */
export function rollUpForecastRiskBand(stockoutRisks, mtpReadiness) {
  const risks = asArray(stockoutRisks);
  const mtpReady = Boolean(mtpReadiness && mtpReadiness.ready);

  if (risks.length === 0) {
    // MTP failure alone (without any demand/inventory data) should still
    // be surfaced, but if truly nothing is known, band is 'unknown'.
    if (mtpReadiness && !mtpReady && typeof mtpReadiness.ready === 'boolean') {
      // Only escalate if we actually inspected MTP inventory (has details).
      if (Array.isArray(mtpReadiness.details) && mtpReadiness.details.length > 0) {
        return 'critical';
      }
    }
    return 'unknown';
  }

  const hasCritical = risks.some((r) => r?.risk_band === 'critical');
  const hasHigh = risks.some((r) => r?.risk_band === 'high');
  const hasModerate = risks.some((r) => r?.risk_band === 'moderate');

  if (hasCritical) return 'critical';
  if (!mtpReady && hasHigh) return 'critical';
  if (hasHigh) return 'high';
  if (hasModerate) return 'moderate';
  return 'low';
}

// ---------- DB loaders ----------------------------------------------------

async function loadInventorySnapshot({ tenantId }) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, blood_group, component, units_available, units_committed,
              minimum_stock_level, expires_earliest, updated_at
       FROM clinical_ai_blood_bank_inventory_snapshots
       WHERE tenant_id = $1::uuid
       ORDER BY blood_group ASC, component ASC`,
      tenantId
    );
    return asArray(rows).map((row) => ({
      id: row.id,
      blood_group: row.blood_group,
      component: row.component,
      units_available: toNumber(row.units_available, 0),
      units_committed: toNumber(row.units_committed, 0),
      minimum_stock_level: toNumber(row.minimum_stock_level, 0),
      expires_earliest: row.expires_earliest || null,
      updated_at: row.updated_at || null,
    }));
  } catch (err) {
    if (isMissingSchemaError(err)) return [];
    throw err;
  }
}

async function loadUpcomingProcedures({ windowStart, windowEnd }) {
  const startIso = windowStart.toISOString();
  const endIso = windowEnd.toISOString();
  const startDate = windowStart.toISOString().slice(0, 10);
  const endDate = windowEnd.toISOString().slice(0, 10);

  // Try ot_schedules first — the existing OT scheduler. scheduled_date +
  // scheduled_time narrow by window.
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id,
              patient_uid,
              procedure_name AS procedure_description,
              scheduled_date,
              scheduled_time,
              blood_arranged
       FROM ot_schedules
       WHERE status IN ('scheduled', 'in_progress', 'confirmed')
         AND scheduled_date >= $1::date
         AND scheduled_date <= $2::date
       ORDER BY scheduled_date ASC, scheduled_time ASC
       LIMIT 500`,
      startDate,
      endDate
    );
    if (rows && rows.length > 0) {
      return rows.map((row) => ({
        source: 'ot_schedules',
        source_id: row.id,
        patient_uid: row.patient_uid || null,
        procedure_description: cleanText(row.procedure_description) || null,
        scheduled_at: row.scheduled_date
          ? `${row.scheduled_date.toString().slice(0, 10)}T${row.scheduled_time || '00:00:00'}`
          : null,
        blood_group: null,
      }));
    }
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.debug('Blood bank forecast: ot_schedules load failed', { error: err.message });
    }
  }

  // Fallback to clinical_orders of type 'surgery'.
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id,
              patient_uid,
              details,
              notes,
              start_date,
              priority
       FROM clinical_orders
       WHERE order_type = 'surgery'
         AND status IN ('ordered', 'scheduled', 'active')
         AND (start_date IS NULL OR (start_date >= $1::date AND start_date <= $2::date))
       ORDER BY start_date ASC NULLS LAST, created_at ASC
       LIMIT 500`,
      startDate,
      endDate
    );
    if (rows && rows.length > 0) {
      return rows.map((row) => {
        const details = row.details || {};
        const description = cleanText(
          details.procedure_name || details.procedure || details.description || row.notes || ''
        );
        return {
          source: 'clinical_orders',
          source_id: row.id,
          patient_uid: row.patient_uid || null,
          procedure_description: description || null,
          scheduled_at: row.start_date ? row.start_date.toString().slice(0, 10) : null,
          blood_group: details.blood_group ? cleanText(details.blood_group).toUpperCase() : null,
        };
      });
    }
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.debug('Blood bank forecast: clinical_orders load failed', { error: err.message });
    }
  }

  // Fallback to admissions with operating / surgical context within window.
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, chief_complaint, admitting_diagnosis, admission_type, admitted_at
       FROM admissions
       WHERE status IN ('admitted', 'in_progress')
         AND admitted_at >= $1::timestamptz
         AND admitted_at <= $2::timestamptz
         AND (
           admission_type IN ('emergency', 'surgical', 'elective_surgery')
           OR admitting_diagnosis ILIKE '%surgery%'
           OR admitting_diagnosis ILIKE '%trauma%'
           OR admitting_diagnosis ILIKE '%hemorrhage%'
         )
       ORDER BY admitted_at ASC
       LIMIT 500`,
      startIso,
      endIso
    );
    return asArray(rows).map((row) => ({
      source: 'admissions',
      source_id: row.id,
      patient_uid: row.patient_uid || null,
      procedure_description: cleanText(row.admitting_diagnosis || row.chief_complaint || '') || null,
      scheduled_at: row.admitted_at ? new Date(row.admitted_at).toISOString() : null,
      blood_group: null,
    }));
  } catch (err) {
    if (isMissingSchemaError(err)) return [];
    logger.debug('Blood bank forecast: admissions load failed', { error: err.message });
    return [];
  }
}

async function insertGeneration({
  tenantId,
  sourceHashValue,
  draft,
  citations,
  safetyFlags,
  requestedBy,
  metadata,
}) {
  const hasCritical = safetyFlags.some((flag) => flag.severity === 'critical');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_generations
         (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model,
          prompt_version, source_hash, status, used_ai, safety_flags, citations, draft,
          generated_by, prompt_tokens, completion_tokens, total_tokens,
          estimated_cost_minor, metadata, created_at, updated_at)
       VALUES ($1::uuid, NULL, NULL, $2, $2, 'template', NULL,
               'v1', $3, $4, FALSE, $5::jsonb, $6::jsonb, $7::jsonb,
               $8::uuid, 0, 0, 0, 0, $9::jsonb, NOW(), NOW())
       RETURNING id, status, created_at`,
      tenantId,
      MODULE_KEY,
      sourceHashValue,
      hasCritical ? 'failed' : 'draft',
      JSON.stringify(safetyFlags),
      JSON.stringify(citations),
      JSON.stringify(draft),
      requestedBy,
      JSON.stringify(metadata || {})
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Blood bank forecast generation persist failed', { error: err.message });
    }
    return null;
  }
}

async function createReviewPlaceholder({ tenantId, generationId, module }) {
  if (!generationId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_reviews
         (tenant_id, generation_id, module_key, patient_uid, admission_id, decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, NULL, NULL, 'pending', $4::jsonb, NOW(), NOW())
       RETURNING id, decision`,
      tenantId,
      generationId,
      MODULE_KEY,
      JSON.stringify({
        review_roles: module?.settings?.reviewRoles || ['BLOOD_BANK_STAFF', 'LAB_STAFF', 'DOCTOR', 'ADMIN'],
        source: 'blood_bank_demand_forecast',
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Blood bank forecast review placeholder failed', { error: err.message });
    }
    return null;
  }
}

function normalizeForecastRow(row) {
  if (!row) return row;
  return {
    ...row,
    forecast_window_hours: toNumber(row.forecast_window_hours, 24),
  };
}

async function insertForecastReview({
  tenantId,
  generationId,
  forecastWindowHours,
  forecastStart,
  forecastEnd,
  predictedDemand,
  inventorySnapshot,
  stockoutRisks,
  mtpReadiness,
  riskBand,
  recommendations,
  citations,
  safetyFlags,
  metadata,
}) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_blood_bank_forecast_reviews
         (tenant_id, generation_id, forecast_window_hours, forecast_start, forecast_end,
          predicted_demand, inventory_snapshot, stockout_risks, mtp_readiness,
          risk_band, recommendations, source_citations, safety_flags,
          reviewer_decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4::timestamptz, $5::timestamptz,
               $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb,
               $10, $11::jsonb, $12::jsonb, $13::jsonb,
               'pending', $14::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, generation_id, forecast_window_hours,
                 forecast_start, forecast_end, predicted_demand,
                 inventory_snapshot, stockout_risks, mtp_readiness, risk_band,
                 recommendations, source_citations, safety_flags,
                 reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
                 metadata, created_at, updated_at`,
      tenantId,
      generationId,
      forecastWindowHours,
      forecastStart.toISOString(),
      forecastEnd.toISOString(),
      JSON.stringify(predictedDemand || []),
      JSON.stringify(inventorySnapshot || []),
      JSON.stringify(stockoutRisks || []),
      JSON.stringify(mtpReadiness || {}),
      RISK_BANDS.has(riskBand) ? riskBand : 'unknown',
      JSON.stringify(recommendations || []),
      JSON.stringify(citations || []),
      JSON.stringify(safetyFlags || []),
      JSON.stringify(metadata || {})
    );
    return normalizeForecastRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

function buildRecommendations({ stockoutRisks, mtpReadiness, hasInventory, hasProcedures }) {
  const actions = [];
  if (!hasInventory) {
    actions.push('Upload a current blood bank inventory snapshot — the forecast has no inventory data to compare against.');
  }
  if (!hasProcedures) {
    actions.push('Confirm upcoming-procedure scheduling is capturing into ot_schedules / clinical_orders — no procedures were detected in the forecast window.');
  }

  const critical = asArray(stockoutRisks).filter((r) => r.risk_band === 'critical');
  for (const row of critical) {
    actions.push(
      `Critical: projected shortfall of ${row.projected_shortfall} ${row.component} units for ${row.blood_group} — review crossmatch queue and consider requesting additional units.`
    );
  }
  const high = asArray(stockoutRisks).filter((r) => r.risk_band === 'high');
  for (const row of high) {
    actions.push(
      `High: ${row.blood_group} ${row.component} projected to drop below minimum stock level (${row.minimum_stock_level}) within the window — proactively review restocking.`
    );
  }

  if (mtpReadiness && !mtpReadiness.ready && Array.isArray(mtpReadiness.details) && mtpReadiness.details.length > 0) {
    const missing = mtpReadiness.details.filter((d) => !d.ok).map((d) => d.label).join(', ');
    if (missing) {
      actions.push(`MTP not ready: ${missing} below threshold — confirm with blood bank lead before accepting major trauma / cardiac cases.`);
    }
  }

  actions.push('Decision-support only — blood bank / lab staff confirm every action. Service never auto-orders or auto-issues units.');
  return actions;
}

// ---------- Public API --------------------------------------------------

/**
 * UPSERT a blood bank inventory snapshot row. Overwrites existing row for
 * the same (tenant, blood_group, component) triple.
 */
export async function upsertBloodBankInventory({
  tenantId = null,
  bloodGroup,
  component,
  unitsAvailable,
  unitsCommitted = 0,
  minimumStockLevel = 0,
  expiresEarliest = null,
  updatedBy = null,
  metadata = {},
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const group = validateBloodGroup(bloodGroup);
  const comp = validateComponent(component);
  const available = toNonNegativeInt(unitsAvailable, 'units_available');
  const committed = toNonNegativeInt(unitsCommitted, 'units_committed');
  const minimum = toNonNegativeInt(minimumStockLevel, 'minimum_stock_level');
  const expires = expiresEarliest ? new Date(expiresEarliest).toISOString().slice(0, 10) : null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_blood_bank_inventory_snapshots
         (tenant_id, blood_group, component, units_available, units_committed,
          minimum_stock_level, expires_earliest, updated_by, metadata,
          updated_at, created_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::date, $8::uuid, $9::jsonb, NOW(), NOW())
       ON CONFLICT (tenant_id, blood_group, component)
       DO UPDATE SET
         units_available = EXCLUDED.units_available,
         units_committed = EXCLUDED.units_committed,
         minimum_stock_level = EXCLUDED.minimum_stock_level,
         expires_earliest = EXCLUDED.expires_earliest,
         updated_by = EXCLUDED.updated_by,
         metadata = clinical_ai_blood_bank_inventory_snapshots.metadata || EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING id, tenant_id, blood_group, component, units_available,
                 units_committed, minimum_stock_level, expires_earliest,
                 metadata, updated_by, updated_at, created_at`,
      tid,
      group,
      comp,
      available,
      committed,
      minimum,
      expires,
      updatedBy,
      JSON.stringify(metadata || {})
    );
    const row = (rows && rows[0]) || null;
    if (!row) return null;
    return {
      ...row,
      units_available: toNumber(row.units_available, 0),
      units_committed: toNumber(row.units_committed, 0),
      minimum_stock_level: toNumber(row.minimum_stock_level, 0),
    };
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

export async function listBloodBankInventory({
  tenantId = null,
  bloodGroup = null,
  component = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalizedGroup = bloodGroup ? validateBloodGroup(bloodGroup) : null;
  const normalizedComponent = component ? validateComponent(component) : null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, blood_group, component, units_available, units_committed,
              minimum_stock_level, expires_earliest, metadata, updated_by,
              updated_at, created_at
       FROM clinical_ai_blood_bank_inventory_snapshots
       WHERE tenant_id = $1::uuid
         AND ($2::text IS NULL OR blood_group = $2)
         AND ($3::text IS NULL OR component = $3)
       ORDER BY blood_group ASC, component ASC`,
      tid,
      normalizedGroup,
      normalizedComponent
    );
    const normalized = asArray(rows).map((row) => ({
      ...row,
      units_available: toNumber(row.units_available, 0),
      units_committed: toNumber(row.units_committed, 0),
      minimum_stock_level: toNumber(row.minimum_stock_level, 0),
    }));
    return { inventory: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { inventory: [], count: 0 };
    throw err;
  }
}

export async function generateBloodBankForecast({
  req = null,
  forecastWindowHours = 24,
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const safeWindow = clampInt(forecastWindowHours, 1, 168, 24);
  const forecastStart = new Date();
  const forecastEnd = new Date(forecastStart.getTime() + safeWindow * 60 * 60 * 1000);

  const inventory = await loadInventorySnapshot({ tenantId });
  const procedures = await loadUpcomingProcedures({ windowStart: forecastStart, windowEnd: forecastEnd });

  const predictedDemand = aggregateDemandForecast(procedures);
  const stockoutRisks = classifyStockoutRisk({
    inventory,
    predictedDemand,
    windowHours: safeWindow,
  });
  const mtpReadiness = assessMtpReadiness(inventory);
  const rolledBand = rollUpForecastRiskBand(stockoutRisks, mtpReadiness);

  const citations = [];
  if (inventory.length > 0) {
    citations.push({
      source_type: 'clinical_ai_blood_bank_inventory_snapshots',
      source_id: `tenant:${tenantId}`,
      label: `Blood bank inventory (${inventory.length} row${inventory.length === 1 ? '' : 's'})`,
      timestamp: forecastStart.toISOString(),
    });
  }
  for (const proc of procedures.slice(0, 25)) {
    citations.push({
      source_type: proc.source,
      source_id: String(proc.source_id),
      label: proc.procedure_description || '(unspecified procedure)',
      timestamp: proc.scheduled_at || null,
    });
  }
  const finalCitations = uniqueCitations(citations);

  const safetyFlags = [];
  if (inventory.length === 0) {
    safetyFlags.push({
      severity: 'medium',
      code: 'MISSING_INVENTORY_DATA',
      message: 'No blood bank inventory snapshot is available for this tenant. Forecast is demand-only.',
    });
  }
  if (procedures.length === 0) {
    safetyFlags.push({
      severity: 'low',
      code: 'MISSING_PROCEDURE_DATA',
      message: 'No upcoming procedures found in ot_schedules / clinical_orders / admissions for the forecast window.',
    });
  }
  if (rolledBand === 'critical') {
    safetyFlags.push({
      severity: 'critical',
      code: 'BLOOD_BANK_CRITICAL_STOCKOUT',
      message: 'Critical stock-out risk detected for at least one blood group + component pair. Escalate to blood bank lead.',
    });
  }
  if (mtpReadiness && !mtpReadiness.ready && Array.isArray(mtpReadiness.details) && mtpReadiness.details.length > 0) {
    safetyFlags.push({
      severity: 'high',
      code: 'MTP_NOT_READY',
      message: 'Massive transfusion protocol readiness criteria not met — at least one of O- PRBC, AB FFP, or platelets is below threshold.',
    });
  }

  const recommendations = buildRecommendations({
    stockoutRisks,
    mtpReadiness,
    hasInventory: inventory.length > 0,
    hasProcedures: procedures.length > 0,
  });

  const draft = {
    forecast_window_hours: safeWindow,
    forecast_start: forecastStart.toISOString(),
    forecast_end: forecastEnd.toISOString(),
    predicted_demand: predictedDemand,
    inventory_snapshot: inventory,
    stockout_risks: stockoutRisks,
    mtp_readiness: mtpReadiness,
    risk_band: rolledBand,
    recommendations,
    source_citations: finalCitations,
    safety_flags: safetyFlags,
    summary: predictedDemand.length
      ? `${predictedDemand.length} blood-component demand forecast(s) across ${procedures.length} procedure(s) — ${rolledBand} risk.`
      : inventory.length === 0
        ? 'Missing inventory data — review deferred.'
        : 'No upcoming blood-demand procedures in window.',
    rules_authoritative: true,
    decision_support_only: true,
  };

  const generation = await insertGeneration({
    tenantId,
    sourceHashValue: sourceHash({
      window_hours: safeWindow,
      inventory_count: inventory.length,
      procedure_count: procedures.length,
      stockout_count: stockoutRisks.length,
    }),
    draft,
    citations: finalCitations,
    safetyFlags,
    requestedBy: req?.user?.uid || null,
    metadata: {
      forecast_window_hours: safeWindow,
      risk_band: rolledBand,
      stockout_count: stockoutRisks.length,
      mtp_ready: Boolean(mtpReadiness?.ready),
      procedure_count: procedures.length,
      inventory_count: inventory.length,
      rules_authoritative: true,
    },
  });

  const reviewRow = await insertForecastReview({
    tenantId,
    generationId: generation?.id || null,
    forecastWindowHours: safeWindow,
    forecastStart,
    forecastEnd,
    predictedDemand,
    inventorySnapshot: inventory,
    stockoutRisks,
    mtpReadiness,
    riskBand: rolledBand,
    recommendations,
    citations: finalCitations,
    safetyFlags,
    metadata: {
      procedure_count: procedures.length,
      inventory_count: inventory.length,
      rules_authoritative: true,
    },
  });

  if (!reviewRow) {
    return {
      review_id: null,
      generation_id: generation?.id || null,
      draft,
      source_citations: finalCitations,
      safety_flags: safetyFlags,
      module_key: MODULE_KEY,
      review_status: 'schema_unavailable',
      reason: inventory.length === 0 && procedures.length === 0
        ? 'missing_inventory_data'
        : 'clinical_ai_blood_bank_forecast_reviews_unavailable',
      rules_authoritative: true,
      decision_support_only: true,
    };
  }

  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    module,
  });

  try {
    await publishEvent({
      eventType: 'clinical_ai.blood_bank_forecast_generated',
      aggregateType: 'clinical_ai_blood_bank_forecast_review',
      aggregateId: reviewRow.id,
      patientUid: null,
      payload: {
        tenant_id: tenantId,
        review_id: reviewRow.id,
        generation_id: generation?.id || null,
        forecast_window_hours: safeWindow,
        risk_band: rolledBand,
        stockout_count: stockoutRisks.length,
        mtp_ready: Boolean(mtpReadiness?.ready),
      },
    });
  } catch (err) {
    logger.warn('Blood bank forecast event publish failed', { error: err?.message });
  }

  return {
    review_id: reviewRow.id,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    review: reviewRow,
    source_citations: finalCitations,
    safety_flags: safetyFlags,
    module_key: MODULE_KEY,
    review_status: clinicalReview?.decision || reviewRow.reviewer_decision || 'pending',
    requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
    rules_authoritative: true,
    decision_support_only: true,
  };
}

export async function listBloodBankForecasts({
  tenantId = null,
  riskBand = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedBand = riskBand && RISK_BANDS.has(cleanText(riskBand).toLowerCase())
    ? cleanText(riskBand).toLowerCase()
    : null;
  const normalizedDecision = reviewerDecision && DECISIONS.has(cleanText(reviewerDecision).toLowerCase())
    ? cleanText(reviewerDecision).toLowerCase()
    : null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, generation_id, forecast_window_hours,
              forecast_start, forecast_end, predicted_demand,
              inventory_snapshot, stockout_risks, mtp_readiness, risk_band,
              recommendations, source_citations, safety_flags,
              reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
              metadata, created_at, updated_at
       FROM clinical_ai_blood_bank_forecast_reviews
       WHERE tenant_id = $1::uuid
         AND ($2::text IS NULL OR risk_band = $2)
         AND ($3::text IS NULL OR reviewer_decision = $3)
       ORDER BY
         CASE risk_band
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'moderate' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         created_at DESC
       LIMIT $4`,
      tid,
      normalizedBand,
      normalizedDecision,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizeForecastRow);
    return { forecasts: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { forecasts: [], count: 0 };
    throw err;
  }
}

export async function decideBloodBankForecast({
  tenantId = null,
  forecastId,
  decision,
  reviewerUid = null,
  note = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = cleanText(decision).toLowerCase();
  if (!FINAL_DECISIONS.has(normalized)) {
    throw AppError.badRequest('decision must be accepted, deferred, rejected, or escalated');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_blood_bank_forecast_reviews
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, tenant_id, generation_id, forecast_window_hours,
               forecast_start, forecast_end, predicted_demand,
               inventory_snapshot, stockout_risks, mtp_readiness, risk_band,
               recommendations, source_citations, safety_flags,
               reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
               metadata, created_at, updated_at`,
    optionalInt(forecastId, 'forecast_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('Blood bank forecast not found');
  return normalizeForecastRow(rows[0]);
}

export default {
  BLOOD_GROUPS,
  COMPONENTS,
  MTP_PRBC_MIN_UNITS,
  MTP_FFP_MIN_UNITS,
  MTP_PLATELETS_MIN_UNITS,
  aggregateDemandForecast,
  assessMtpReadiness,
  classifyStockoutRisk,
  decideBloodBankForecast,
  estimatePerProcedureDemand,
  generateBloodBankForecast,
  listBloodBankForecasts,
  listBloodBankInventory,
  rollUpForecastRiskBand,
  upsertBloodBankInventory,
};
