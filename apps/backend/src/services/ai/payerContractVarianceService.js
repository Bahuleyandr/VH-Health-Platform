/**
 * Payer Contract Variance / Underpayment AI.
 *
 * Maintains contracted rates per payer + procedure, and flags insurance
 * claims whose paid amount diverges from the expected contracted amount
 * (underpayment, overpayment, missing contract, missing payment). Rules
 * authoritative: variance category, band, and suggested actions are
 * derived from the contract + claim data. Review-only; the service never
 * auto-appeals, writes off, or modifies billing records.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';

const MODULE_KEY = 'payer_contract_variance';

const VARIANCE_CATEGORIES = new Set(['match', 'underpayment', 'overpayment', 'missing_contract', 'missing_payment', 'unknown']);
const VARIANCE_BANDS = new Set(['within_tolerance', 'review', 'investigate', 'escalate', 'unknown']);
const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'escalated']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'escalated']);
const UNDERPAYMENT_ESCALATE_PCT = 15;
const UNDERPAYMENT_INVESTIGATE_PCT = 5;
const OVERPAYMENT_REVIEW_PCT = 3;
const DEFAULT_TOLERANCE_PCT = 2;

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
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

function optionalInt(value, fieldName = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function toNonNegativeInt(value, fieldName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw AppError.badRequest(`${fieldName} must be a non-negative integer (minor units)`);
  }
  return parsed;
}

function toNumber(value, fallback = 0) {
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNullableDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function sourceHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex');
}

function clampToleranceForDisplay(pct) {
  const parsed = Number(pct);
  if (!Number.isFinite(parsed)) return DEFAULT_TOLERANCE_PCT;
  return Math.max(0, Math.min(100, parsed));
}

export function classifyVariance({
  expectedMinor = null,
  paidMinor = null,
  claimAmountMinor = null,
  tolerancePct = DEFAULT_TOLERANCE_PCT,
} = {}) {
  const expected = expectedMinor === null || expectedMinor === undefined ? null : toNumber(expectedMinor, null);
  const paid = paidMinor === null || paidMinor === undefined ? null : toNumber(paidMinor, null);
  const tolerance = clampToleranceForDisplay(tolerancePct);

  if (expected === null) {
    return {
      variance_category: 'missing_contract',
      variance_band: 'review',
      variance_minor: 0,
      variance_pct: 0,
      reason: 'No contracted rate on file for this payer + procedure combination.',
      tolerance_pct: tolerance,
    };
  }

  if (paid === null || paid === 0) {
    const baseline = expected || toNumber(claimAmountMinor, 0) || 1;
    return {
      variance_category: 'missing_payment',
      variance_band: expected > 0 ? 'investigate' : 'review',
      variance_minor: -expected,
      variance_pct: expected > 0 ? -100 : 0,
      reason: 'No paid amount has been recorded for this claim against the contracted rate.',
      tolerance_pct: tolerance,
      baseline_minor: baseline,
    };
  }

  const diff = paid - expected;
  const denominator = expected > 0 ? expected : Math.max(1, paid);
  const pct = Math.round((diff / denominator) * 10000) / 100;
  const absPct = Math.abs(pct);

  if (absPct <= tolerance) {
    return {
      variance_category: 'match',
      variance_band: 'within_tolerance',
      variance_minor: diff,
      variance_pct: pct,
      reason: `Paid amount is within ${tolerance}% of contracted rate.`,
      tolerance_pct: tolerance,
    };
  }

  if (diff < 0) {
    let band = 'review';
    if (absPct >= UNDERPAYMENT_ESCALATE_PCT) band = 'escalate';
    else if (absPct >= UNDERPAYMENT_INVESTIGATE_PCT) band = 'investigate';
    return {
      variance_category: 'underpayment',
      variance_band: band,
      variance_minor: diff,
      variance_pct: pct,
      reason: `Paid amount is ${absPct}% below the contracted rate.`,
      tolerance_pct: tolerance,
    };
  }

  return {
    variance_category: 'overpayment',
    variance_band: absPct >= OVERPAYMENT_REVIEW_PCT ? 'review' : 'within_tolerance',
    variance_minor: diff,
    variance_pct: pct,
    reason: `Paid amount is ${absPct}% above the contracted rate.`,
    tolerance_pct: tolerance,
  };
}

export function suggestActions({ variance, claim, contract }) {
  const actions = [];
  if (!variance) return actions;
  switch (variance.variance_category) {
    case 'underpayment':
      actions.push('Confirm the contracted rate and compare against the payer remittance line items.');
      actions.push('If the underpayment is confirmed, open an appeal or recoupment request to the payer.');
      if (variance.variance_band === 'escalate') {
        actions.push('Escalate to insurance coordinator and leadership — variance exceeds 15% of contracted rate.');
      }
      break;
    case 'overpayment':
      actions.push('Reconcile with payer; overpayment may be refundable or recoupable.');
      actions.push('Verify coding and units before accepting as legitimate excess payment.');
      break;
    case 'missing_contract':
      actions.push('Add a contracted rate for this payer + procedure in the payer contract registry.');
      actions.push('Verify billing code mapping with the payer.');
      break;
    case 'missing_payment':
      actions.push('Check whether a remittance/EOB was received for this claim.');
      actions.push('If the claim is still pending, track filing date and follow up with payer.');
      break;
    case 'match':
      actions.push('No action required; paid amount matches the contracted rate.');
      break;
    default:
      actions.push('Review the claim and contract manually.');
  }
  if (claim?.status && /denied/i.test(claim.status)) {
    actions.unshift('Claim is marked denied — confirm whether appeal has been drafted.');
  }
  if (contract?.effective_end_date) {
    actions.push(`Confirm contracted rate is still active (ends ${contract.effective_end_date}).`);
  }
  return actions;
}

function normalizeClaim(row) {
  if (!row) return null;
  return {
    id: row.id,
    claim_number: row.claim_number,
    patient_uid: row.patient_uid,
    insurance_provider: row.insurance_provider,
    policy_number: row.policy_number,
    status: row.status,
    claim_amount: toNumber(row.claim_amount),
    approved_amount: row.approved_amount !== null && row.approved_amount !== undefined
      ? toNumber(row.approved_amount)
      : null,
    submitted_at: row.submitted_at,
    reviewed_at: row.reviewed_at,
    rejection_reason: row.rejection_reason,
    procedure_code: row.procedure_code,
    procedure_description: row.procedure_description,
  };
}

function claimAmountMinor(claim) {
  return Math.round(toNumber(claim?.claim_amount) * 100);
}

function paidAmountMinor(claim) {
  if (claim?.approved_amount === null || claim?.approved_amount === undefined) return null;
  return Math.round(toNumber(claim.approved_amount) * 100);
}

export function matchClaimToContract({ claim, contracts, procedureCode = null }) {
  const payer = normalizedText(claim?.insurance_provider);
  const targetCode = cleanText(procedureCode || claim?.procedure_code || '');
  if (!payer) return null;
  const claimSubmittedAt = claim?.submitted_at ? new Date(claim.submitted_at) : null;
  for (const contract of asArray(contracts)) {
    if (!contract) continue;
    if (contract.active === false) continue;
    if (normalizedText(contract.payer_name) !== payer) continue;
    if (targetCode && cleanText(contract.procedure_code) !== targetCode) continue;
    if (claimSubmittedAt && contract.effective_start_date) {
      const start = new Date(contract.effective_start_date);
      if (!Number.isNaN(start.getTime()) && claimSubmittedAt < start) continue;
    }
    if (claimSubmittedAt && contract.effective_end_date) {
      const end = new Date(contract.effective_end_date);
      if (!Number.isNaN(end.getTime()) && claimSubmittedAt > end) continue;
    }
    return contract;
  }
  return null;
}

async function loadClaim(tenantId, claimId) {
  // Tenant-scope the lookup (audit / cross-tenant fix): insurance_claims carries
  // tenant_id (migration 239) but this query previously matched on id only — a
  // cross-tenant claim id would load another tenant's claim (patient_uid,
  // insurance_provider, policy_number, amounts) into this tenant's variance
  // analysis and its persisted review row. SERIAL ids are not globally unique,
  // so the tenant predicate is load-bearing defense-in-depth even before the RLS
  // enforce flip. Sibling clinicalAiWorkflowService / appealLetterGeneratorService
  // loadClaim were already fixed this way.
  const rows = await prisma.$queryRawUnsafe(
    `SELECT c.id, c.claim_number, c.patient_uid, c.insurance_provider,
            c.policy_number, c.claim_amount, c.approved_amount, c.status,
            c.submitted_at, c.reviewed_at, c.rejection_reason
     FROM insurance_claims c
     WHERE c.id = $1
       AND c.tenant_id = $2::uuid
     LIMIT 1`,
    claimId,
    resolveTenantId({ tenantId })
  );
  const claim = rows[0];
  if (!claim) throw AppError.notFound('Insurance claim not found');
  return normalizeClaim(claim);
}

async function loadActiveContracts(tenantId, payerName = null, procedureCode = null) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, payer_name, payer_code, procedure_code, procedure_description,
              expected_rate_minor, currency_code, tolerance_pct,
              effective_start_date, effective_end_date, contract_reference,
              active, metadata, created_at, updated_at
       FROM clinical_ai_payer_contracts
       WHERE tenant_id = $1::uuid
         AND active = TRUE
         AND ($2::text IS NULL OR LOWER(payer_name) = LOWER($2))
         AND ($3::text IS NULL OR procedure_code = $3)
       ORDER BY effective_start_date DESC NULLS LAST, created_at DESC
       LIMIT 500`,
      tenantId,
      payerName ? cleanText(payerName) : null,
      procedureCode ? cleanText(procedureCode) : null
    );
    return rows.map((row) => ({
      ...row,
      expected_rate_minor: toNumber(row.expected_rate_minor),
      tolerance_pct: toNumber(row.tolerance_pct, DEFAULT_TOLERANCE_PCT),
    }));
  } catch (err) {
    if (isMissingSchemaError(err)) return [];
    throw err;
  }
}

export async function upsertPayerContract({
  tenantId = null,
  payerName,
  payerCode = null,
  procedureCode,
  procedureDescription = null,
  expectedRateMinor,
  currencyCode = 'INR',
  tolerancePct = DEFAULT_TOLERANCE_PCT,
  effectiveStartDate = null,
  effectiveEndDate = null,
  contractReference = null,
  notes = null,
  active = true,
  metadata = {},
} = {}) {
  if (!payerName || !cleanText(payerName)) throw AppError.badRequest('payer_name is required');
  if (!procedureCode || !cleanText(procedureCode)) throw AppError.badRequest('procedure_code is required');
  const tid = resolveTenantId({ tenantId });
  const expected = toNonNegativeInt(expectedRateMinor, 'expected_rate_minor');
  const start = toNullableDate(effectiveStartDate) || new Date().toISOString().slice(0, 10);
  const end = toNullableDate(effectiveEndDate);
  const tolerance = clampToleranceForDisplay(tolerancePct);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_payer_contracts
         (tenant_id, payer_name, payer_code, procedure_code, procedure_description,
          expected_rate_minor, currency_code, tolerance_pct, effective_start_date,
          effective_end_date, contract_reference, notes, active, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::date, $11, $12, $13, $14::jsonb, NOW(), NOW())
       ON CONFLICT (tenant_id, LOWER(payer_name), procedure_code, effective_start_date)
       DO UPDATE SET
         payer_code = EXCLUDED.payer_code,
         procedure_description = EXCLUDED.procedure_description,
         expected_rate_minor = EXCLUDED.expected_rate_minor,
         currency_code = EXCLUDED.currency_code,
         tolerance_pct = EXCLUDED.tolerance_pct,
         effective_end_date = EXCLUDED.effective_end_date,
         contract_reference = EXCLUDED.contract_reference,
         notes = EXCLUDED.notes,
         active = EXCLUDED.active,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING id, tenant_id, payer_name, payer_code, procedure_code, procedure_description,
                 expected_rate_minor, currency_code, tolerance_pct,
                 effective_start_date, effective_end_date, contract_reference,
                 notes, active, metadata, created_at, updated_at`,
      tid,
      cleanText(payerName),
      payerCode ? cleanText(payerCode) : null,
      cleanText(procedureCode),
      procedureDescription ? cleanText(procedureDescription) : null,
      expected,
      cleanText(currencyCode) || 'INR',
      tolerance,
      start,
      end,
      contractReference ? cleanText(contractReference) : null,
      notes ? cleanText(notes) : null,
      Boolean(active),
      JSON.stringify(metadata || {})
    );
    const row = rows[0];
    return row ? {
      ...row,
      expected_rate_minor: toNumber(row.expected_rate_minor),
      tolerance_pct: toNumber(row.tolerance_pct, DEFAULT_TOLERANCE_PCT),
    } : null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

export async function listPayerContracts({
  tenantId = null,
  payerName = null,
  procedureCode = null,
  active = null,
  limit = 100,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, payer_name, payer_code, procedure_code, procedure_description,
              expected_rate_minor, currency_code, tolerance_pct, effective_start_date,
              effective_end_date, contract_reference, notes, active, metadata,
              created_at, updated_at
       FROM clinical_ai_payer_contracts
       WHERE tenant_id = $1::uuid
         AND ($2::text IS NULL OR LOWER(payer_name) = LOWER($2))
         AND ($3::text IS NULL OR procedure_code = $3)
         AND ($4::boolean IS NULL OR active = $4)
       ORDER BY payer_name ASC, procedure_code ASC, effective_start_date DESC
       LIMIT $5`,
      tid,
      payerName ? cleanText(payerName) : null,
      procedureCode ? cleanText(procedureCode) : null,
      active === null || active === undefined ? null : Boolean(active),
      safeLimit
    );
    const normalized = rows.map((row) => ({
      ...row,
      expected_rate_minor: toNumber(row.expected_rate_minor),
      tolerance_pct: toNumber(row.tolerance_pct, DEFAULT_TOLERANCE_PCT),
    }));
    return { contracts: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { contracts: [], count: 0 };
    throw err;
  }
}

function normalizeReviewRow(row) {
  if (!row) return row;
  return {
    ...row,
    expected_amount_minor: toNumber(row.expected_amount_minor),
    paid_amount_minor: toNumber(row.paid_amount_minor),
    claim_amount_minor: toNumber(row.claim_amount_minor),
    variance_minor: toNumber(row.variance_minor),
    variance_pct: toNumber(row.variance_pct),
  };
}

async function insertVarianceReview({
  tenantId,
  claimId,
  contractId,
  patientUid,
  generationId,
  payerName,
  procedureCode,
  expectedMinor,
  paidMinor,
  claimMinor,
  varianceMinor,
  variancePct,
  varianceCategory,
  varianceBand,
  reason,
  suggestedActions,
  citations,
  safetyFlags,
  metadata,
}) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_payer_variance_reviews
         (tenant_id, claim_id, contract_id, patient_uid, generation_id,
          payer_name, procedure_code, expected_amount_minor, paid_amount_minor,
          claim_amount_minor, variance_minor, variance_pct,
          variance_category, variance_band, reason, suggested_actions,
          source_citations, safety_flags, reviewer_decision, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16::jsonb, $17::jsonb, $18::jsonb,
               'pending', $19::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, claim_id, contract_id, patient_uid, generation_id,
                 payer_name, procedure_code, expected_amount_minor, paid_amount_minor,
                 claim_amount_minor, variance_minor, variance_pct, variance_category,
                 variance_band, reason, suggested_actions, source_citations,
                 safety_flags, reviewer_decision, reviewed_by, reviewed_at,
                 reviewer_note, metadata, created_at, updated_at`,
      tenantId,
      claimId,
      contractId,
      patientUid,
      generationId,
      payerName,
      procedureCode,
      expectedMinor,
      paidMinor,
      claimMinor,
      varianceMinor,
      variancePct,
      varianceCategory,
      varianceBand,
      reason,
      JSON.stringify(suggestedActions || []),
      JSON.stringify(citations || []),
      JSON.stringify(safetyFlags || []),
      JSON.stringify(metadata || {})
    );
    return normalizeReviewRow(rows[0]) || null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

async function insertGeneration({
  tenantId,
  admissionId = null,
  patientUid = null,
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
       VALUES ($1::uuid, $2::uuid, $3, $4, $4, 'template', NULL,
               'v1', $5, $6, FALSE, $7::jsonb, $8::jsonb, $9::jsonb,
               $10::uuid, 0, 0, 0, 0, $11::jsonb, NOW(), NOW())
       RETURNING id, status, created_at`,
      tenantId,
      patientUid,
      admissionId,
      MODULE_KEY,
      sourceHashValue,
      hasCritical ? 'failed' : 'draft',
      JSON.stringify(safetyFlags),
      JSON.stringify(citations),
      JSON.stringify(draft),
      requestedBy,
      JSON.stringify(metadata || {})
    );
    return rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Payer variance generation persist failed', { error: err.message });
    }
    return null;
  }
}

export async function evaluateClaimVariance({
  req = null,
  claimId,
  procedureCode = null,
  tolerancePctOverride = null,
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const safeClaimId = optionalInt(claimId, 'claim_id');
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const claim = await loadClaim(tenantId, safeClaimId);
  const payerName = claim.insurance_provider;
  const contracts = await loadActiveContracts(tenantId, payerName, procedureCode);
  const contract = matchClaimToContract({ claim, contracts, procedureCode });

  const expectedMinor = contract ? toNumber(contract.expected_rate_minor) : null;
  const paidMinor = paidAmountMinor(claim);
  const claimMinor = claimAmountMinor(claim);
  const tolerance = tolerancePctOverride !== null && tolerancePctOverride !== undefined
    ? clampToleranceForDisplay(tolerancePctOverride)
    : clampToleranceForDisplay(contract?.tolerance_pct ?? module.settings?.default_tolerance_pct ?? DEFAULT_TOLERANCE_PCT);

  const variance = classifyVariance({
    expectedMinor,
    paidMinor,
    claimAmountMinor: claimMinor,
    tolerancePct: tolerance,
  });
  const suggestedActions = suggestActions({ variance, claim, contract });

  const citations = [
    {
      source_type: 'insurance_claim',
      source_id: String(claim.id),
      label: claim.claim_number || 'Insurance claim',
      timestamp: claim.submitted_at || null,
    },
  ];
  if (contract) {
    citations.push({
      source_type: 'payer_contract',
      source_id: String(contract.id),
      label: `${contract.payer_name} — ${contract.procedure_code}`,
      timestamp: contract.effective_start_date || null,
    });
  }

  const safetyFlags = [];
  if (variance.variance_band === 'escalate') {
    safetyFlags.push({
      severity: 'high',
      code: 'PAYER_VARIANCE_ESCALATE',
      message: `Underpayment variance of ${Math.abs(variance.variance_pct)}% exceeds the escalation threshold.`,
    });
  }
  if (variance.variance_category === 'missing_contract') {
    safetyFlags.push({
      severity: 'medium',
      code: 'PAYER_VARIANCE_MISSING_CONTRACT',
      message: 'No contracted rate is on file for this payer + procedure.',
    });
  }
  if (variance.variance_category === 'missing_payment') {
    safetyFlags.push({
      severity: 'medium',
      code: 'PAYER_VARIANCE_MISSING_PAYMENT',
      message: 'No payment has been recorded for this claim.',
    });
  }

  const draft = {
    claim: {
      id: claim.id,
      claim_number: claim.claim_number,
      payer_name: claim.insurance_provider,
      claim_amount_minor: claimMinor,
      paid_amount_minor: paidMinor,
      status: claim.status,
    },
    contract: contract ? {
      id: contract.id,
      payer_name: contract.payer_name,
      procedure_code: contract.procedure_code,
      expected_rate_minor: expectedMinor,
      currency_code: contract.currency_code,
      tolerance_pct: tolerance,
      effective_start_date: contract.effective_start_date,
      effective_end_date: contract.effective_end_date,
      contract_reference: contract.contract_reference,
    } : null,
    variance_category: variance.variance_category,
    variance_band: variance.variance_band,
    expected_amount_minor: expectedMinor || 0,
    paid_amount_minor: paidMinor || 0,
    claim_amount_minor: claimMinor,
    variance_minor: variance.variance_minor,
    variance_pct: variance.variance_pct,
    tolerance_pct: tolerance,
    reason: variance.reason,
    suggested_actions: suggestedActions,
    source_citations: citations,
    safety_flags: safetyFlags,
    rules_authoritative: true,
    decision_support_only: true,
  };

  const generation = await insertGeneration({
    tenantId,
    patientUid: claim.patient_uid,
    sourceHashValue: sourceHash({
      claim_id: safeClaimId,
      contract_id: contract?.id || null,
      expected: expectedMinor,
      paid: paidMinor,
    }),
    draft,
    citations,
    safetyFlags,
    requestedBy: req?.user?.uid || null,
    metadata: {
      claim_id: safeClaimId,
      contract_id: contract?.id || null,
      variance_category: variance.variance_category,
      variance_band: variance.variance_band,
      tolerance_pct: tolerance,
      rules_authoritative: true,
    },
  });

  const reviewRow = await insertVarianceReview({
    tenantId,
    claimId: safeClaimId,
    contractId: contract?.id || null,
    patientUid: claim.patient_uid,
    generationId: generation?.id || null,
    payerName,
    procedureCode: procedureCode || contract?.procedure_code || null,
    expectedMinor: expectedMinor || 0,
    paidMinor: paidMinor || 0,
    claimMinor: claimMinor || 0,
    varianceMinor: variance.variance_minor || 0,
    variancePct: variance.variance_pct || 0,
    varianceCategory: VARIANCE_CATEGORIES.has(variance.variance_category) ? variance.variance_category : 'unknown',
    varianceBand: VARIANCE_BANDS.has(variance.variance_band) ? variance.variance_band : 'unknown',
    reason: variance.reason,
    suggestedActions,
    citations,
    safetyFlags,
    metadata: {
      tolerance_pct: tolerance,
      rules_authoritative: true,
    },
  });
  if (!reviewRow) {
    return {
      review_id: null,
      generation_id: generation?.id || null,
      draft,
      claim,
      contract,
      source_citations: citations,
      safety_flags: safetyFlags,
      module_key: MODULE_KEY,
      review_status: 'schema_unavailable',
      reason: 'clinical_ai_payer_variance_reviews_unavailable',
      decision_support_only: true,
    };
  }

  await publishEvent({
    eventType: 'clinical_ai.payer_variance_evaluated',
    aggregateType: 'clinical_ai_payer_variance_review',
    aggregateId: reviewRow.id,
    patientUid: claim.patient_uid,
    payload: {
      tenant_id: tenantId,
      claim_id: safeClaimId,
      review_id: reviewRow.id,
      variance_category: variance.variance_category,
      variance_band: variance.variance_band,
    },
  });

  return {
    review_id: reviewRow.id,
    generation_id: generation?.id || null,
    draft,
    review: reviewRow,
    claim,
    contract,
    source_citations: citations,
    safety_flags: safetyFlags,
    module_key: MODULE_KEY,
    review_status: reviewRow.reviewer_decision,
    rules_authoritative: true,
    decision_support_only: true,
  };
}

export async function listPayerVarianceReviews({
  tenantId = null,
  claimId = null,
  decision = null,
  category = null,
  band = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const cid = claimId ? optionalInt(claimId, 'claim_id') : null;
  const normalizedDecision = decision && DECISIONS.has(cleanText(decision).toLowerCase())
    ? cleanText(decision).toLowerCase()
    : null;
  const normalizedCategory = category && VARIANCE_CATEGORIES.has(cleanText(category).toLowerCase())
    ? cleanText(category).toLowerCase()
    : null;
  const normalizedBand = band && VARIANCE_BANDS.has(cleanText(band).toLowerCase())
    ? cleanText(band).toLowerCase()
    : null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT r.id, r.tenant_id, r.claim_id, c.claim_number, r.contract_id,
              r.patient_uid, u.name AS patient_name, r.generation_id,
              r.payer_name, r.procedure_code,
              r.expected_amount_minor, r.paid_amount_minor, r.claim_amount_minor,
              r.variance_minor, r.variance_pct, r.variance_category, r.variance_band,
              r.reason, r.suggested_actions, r.source_citations, r.safety_flags,
              r.reviewer_decision, r.reviewed_by, r.reviewed_at, r.reviewer_note,
              r.metadata, r.created_at, r.updated_at
       FROM clinical_ai_payer_variance_reviews r
       LEFT JOIN insurance_claims c ON c.id = r.claim_id
       LEFT JOIN users u ON u.uid = r.patient_uid
       WHERE r.tenant_id = $1::uuid
         AND ($2::int IS NULL OR r.claim_id = $2)
         AND ($3::text IS NULL OR r.reviewer_decision = $3)
         AND ($4::text IS NULL OR r.variance_category = $4)
         AND ($5::text IS NULL OR r.variance_band = $5)
       ORDER BY
         CASE r.variance_band
           WHEN 'escalate' THEN 0
           WHEN 'investigate' THEN 1
           WHEN 'review' THEN 2
           WHEN 'within_tolerance' THEN 3
           ELSE 4
         END,
         r.created_at DESC
       LIMIT $6`,
      tid,
      cid,
      normalizedDecision,
      normalizedCategory,
      normalizedBand,
      safeLimit
    );
    const normalized = rows.map(normalizeReviewRow);
    return { reviews: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { reviews: [], count: 0 };
    throw err;
  }
}

export async function decidePayerVarianceReview({
  tenantId = null,
  reviewId,
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
    `UPDATE clinical_ai_payer_variance_reviews
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, claim_id, patient_uid, generation_id,
               variance_category, variance_band, variance_minor, variance_pct,
               reviewer_decision, reviewed_by, reviewed_at, reviewer_note`,
    optionalInt(reviewId, 'review_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Payer variance review not found');
  return normalizeReviewRow(rows[0]);
}

export default {
  classifyVariance,
  decidePayerVarianceReview,
  evaluateClaimVariance,
  listPayerContracts,
  listPayerVarianceReviews,
  matchClaimToContract,
  suggestActions,
  upsertPayerContract,
};
