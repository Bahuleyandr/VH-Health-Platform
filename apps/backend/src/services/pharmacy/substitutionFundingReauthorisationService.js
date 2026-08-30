import { createHash } from 'node:crypto';

import { SECURITY_CONFIG } from '../../config/securityConfig.js';
import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { lockTenantPatientMergeStability } from '../../utils/patientMergeStabilityLock.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  lockPharmacyFundingAuthorityTx,
  resolveAuthoritativeCounterFundingTx,
  resolvePharmacyFundingPatientUidTx,
} from './pharmacyCapService.js';
import { assertPharmacyFacilityGrant } from './pharmacyFacilityAuthorityService.js';
import { clinicalOrderItemsSha256 } from './pharmacistVerificationService.js';

export const SUBSTITUTION_FUNDING_APPROVAL_KIND =
  'pharmacy_substitution_funding_reauthorisation';
export const SUBSTITUTION_FUNDING_APPROVAL_CONTRACT =
  'pharmacy_substitution_funding_reauthorisation_v1';
export const SUBSTITUTION_FUNDING_TASK_CONTRACT =
  'pharmacy_substitution_funding_task_v1';
export const SUBSTITUTION_FUNDING_TASK_STAGE = 'substitution_reauthorisation';

export const SUBSTITUTION_FUNDING_PROPOSER_ROLES = Object.freeze([
  'PHARMACY_STAFF',
  'PHARMACY_INCHARGE',
]);
export const SUBSTITUTION_FUNDING_TPA_APPROVER_ROLES = Object.freeze([
  'INSURANCE_COORDINATOR',
  'CLAIMS_MANAGER',
  'FINANCE_INCHARGE',
]);
export const SUBSTITUTION_FUNDING_PAYMENT_APPROVER_ROLES = Object.freeze([
  'FINANCE_INCHARGE',
  'BILLING_INCHARGE',
]);
export const SUBSTITUTION_FUNDING_APPROVER_ROLES = Object.freeze([
  ...new Set([
    ...SUBSTITUTION_FUNDING_TPA_APPROVER_ROLES,
    ...SUBSTITUTION_FUNDING_PAYMENT_APPROVER_ROLES,
  ]),
]);

const ACTIVE_TASK_STATUSES = new Set(['open', 'in_progress', 'blocked', 'overdue']);
const DISPENSABLE_ORDER_STATUSES = new Set([
  'PENDING',
  'CONFIRMED',
  'PREPARING',
  'PARTIALLY_DISPENSED',
]);
const DISPENSABLE_PRESCRIPTION_STATUSES = new Set(['active', 'pharmacy_linked']);
const TPA_PAYMENT_MODES = new Set(['insurance', 'corporate_tpa', 'tpa']);
const PATIENT_PAYMENT_RAILS = new Set([
  'CASH',
  'CARD',
  'UPI',
  'NETBANKING',
  'CHEQUE',
  'DD',
  'WALLET',
]);
const SELECTOR_KEYS = new Set([
  'order_line_index',
  'final_catalog_id',
  'inventory_item_id',
  'inventory_batch_id',
  'quantity',
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PG_INT4_MAX = 2_147_483_647n;
const NUMERIC_14_4 = Object.freeze({
  precision: 14,
  scale: 4,
  multiplier: 10_000n,
  maxScaled: 99_999_999_999_999n,
});
const NUMERIC_14_2 = Object.freeze({
  precision: 14,
  scale: 2,
  multiplier: 100n,
  maxScaled: 99_999_999_999_999n,
});
const NUMERIC_12_2 = Object.freeze({
  precision: 12,
  scale: 2,
  multiplier: 100n,
  maxScaled: 999_999_999_999n,
});
const NUMERIC_10_2 = Object.freeze({
  precision: 10,
  scale: 2,
  multiplier: 100n,
  maxScaled: 9_999_999_999n,
});
const APPROVED_SUBSTITUTION_FUNDING_EVIDENCE = new WeakSet();
const APPROVED_SUBSTITUTION_FUNDING_SNAPSHOTS = new WeakMap();
const EXPIRED_APPROVAL_RESULT = Object.freeze({ expired: true });

function substitutionFundingApprovalPolicy(fundingSource) {
  if (fundingSource === 'tpa_claim') {
    return Object.freeze({
      taskResourceType: 'pharmacy_tpa_line_decision',
      assignedRole: 'INSURANCE_COORDINATOR',
      permittedRoles: SUBSTITUTION_FUNDING_TPA_APPROVER_ROLES,
    });
  }
  if (fundingSource === 'billing_payment') {
    return Object.freeze({
      taskResourceType: 'pharmacy_posted_payment',
      assignedRole: 'FINANCE_INCHARGE',
      permittedRoles: SUBSTITUTION_FUNDING_PAYMENT_APPROVER_ROLES,
    });
  }
  if (fundingSource === 'mixed') {
    return Object.freeze({
      taskResourceType: 'pharmacy_tpa_line_decision',
      assignedRole: 'FINANCE_INCHARGE',
      permittedRoles: Object.freeze(['FINANCE_INCHARGE']),
    });
  }
  throw AppError.conflict(
    'The substitution funding source has no independent approval policy',
    'SUBSTITUTION_FUNDING_APPROVER_POLICY_INVALID',
  );
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(
    typeof value === 'string' ? value : stableJson(value),
  ).digest('hex');
}

function positiveInt4(value, label) {
  const text = String(value ?? '').trim();
  const parsed = /^\d+$/.test(text) ? BigInt(text) : null;
  if (parsed == null || parsed <= 0n || parsed > PG_INT4_MAX) {
    throw AppError.badRequest(`${label} must be a positive 32-bit integer`);
  }
  return Number.parseInt(parsed.toString(), 10);
}

function nonNegativeInt4(value, label) {
  const text = String(value ?? '').trim();
  const parsed = /^\d+$/.test(text) ? BigInt(text) : null;
  if (parsed == null || parsed < 0n || parsed > PG_INT4_MAX) {
    throw AppError.badRequest(`${label} must be a non-negative 32-bit integer`);
  }
  return Number.parseInt(parsed.toString(), 10);
}

function nextPositiveInt4(value, label) {
  const next = BigInt(positiveInt4(value, label)) + 1n;
  if (next > PG_INT4_MAX) {
    throw AppError.conflict(
      `${label} cannot advance beyond the 32-bit authority range`,
      'SUBSTITUTION_FUNDING_AUTHORITY_DRIFT',
    );
  }
  return Number.parseInt(next.toString(), 10);
}

function canonicalScaledDecimal(scaled, schema) {
  const whole = scaled / schema.multiplier;
  const fraction = (scaled % schema.multiplier).toString().padStart(schema.scale, '0');
  return `${whole.toString()}.${fraction}`;
}

function parseScaledDecimal(value, schema, {
  label,
  positive = false,
  authority = true,
  code = 'SUBSTITUTION_FUNDING_AUTHORITY_DRIFT',
} = {}) {
  const text = String(value ?? '').trim();
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(text);
  const fraction = match?.[2] || '';
  const scaled = match
    && fraction.length <= schema.scale
    ? (BigInt(match[1]) * schema.multiplier)
      + BigInt(fraction.padEnd(schema.scale, '0') || '0')
    : null;
  if (scaled == null || scaled > schema.maxScaled || (positive ? scaled <= 0n : scaled < 0n)) {
    const message = `${label} must ${positive ? 'be positive, ' : ''}fit NUMERIC(${schema.precision},${schema.scale}), and have at most ${schema.scale} decimal places`;
    throw authority
      ? AppError.conflict(message, code)
      : AppError.badRequest(message, code);
  }
  return Object.freeze({
    scaled,
    canonical: canonicalScaledDecimal(scaled, schema),
  });
}

function requestQuantity(value, label = 'quantity') {
  return parseScaledDecimal(value, NUMERIC_14_4, {
    label,
    positive: true,
    authority: false,
    code: 'SUBSTITUTION_FUNDING_QUANTITY_INVALID',
  });
}

function authorityQuantity(value, label, { positive = false } = {}) {
  return parseScaledDecimal(value, NUMERIC_14_4, { label, positive });
}

function authorityMoney12(value, label, { positive = false } = {}) {
  return parseScaledDecimal(value, NUMERIC_12_2, { label, positive });
}

function authorityMoney14(value, label, { positive = false } = {}) {
  return parseScaledDecimal(value, NUMERIC_14_2, { label, positive });
}

function authorityMoney10(value, label, { positive = false } = {}) {
  return parseScaledDecimal(value, NUMERIC_10_2, { label, positive });
}

function checkedMoney12(scaled, label) {
  if (scaled < 0n || scaled > NUMERIC_12_2.maxScaled) {
    throw AppError.conflict(
      `${label} exceeds NUMERIC(12,2) funding authority`,
      'SUBSTITUTION_FUNDING_AUTHORITY_DRIFT',
    );
  }
  return Object.freeze({ scaled, canonical: canonicalScaledDecimal(scaled, NUMERIC_12_2) });
}

function checkedMoney10(scaled, label) {
  if (scaled < 0n || scaled > NUMERIC_10_2.maxScaled) {
    throw AppError.conflict(
      `${label} exceeds NUMERIC(10,2) order authority`,
      'SUBSTITUTION_FUNDING_AUTHORITY_DRIFT',
    );
  }
  return Object.freeze({ scaled, canonical: canonicalScaledDecimal(scaled, NUMERIC_10_2) });
}

function halfUpQuantityPrice(quantity, unitPrice, label) {
  const product = quantity.scaled * unitPrice.scaled;
  const wholeMinorUnits = product / NUMERIC_14_4.multiplier;
  const discarded = product % NUMERIC_14_4.multiplier;
  const rounded = wholeMinorUnits + (discarded >= 5_000n ? 1n : 0n);
  return checkedMoney12(rounded, label);
}

export const substitutionFundingNumericTesting = Object.freeze({
  canonicalQuantity(value) {
    return requestQuantity(value, 'test quantity').canonical;
  },
  canonicalMoney12(value) {
    return parseScaledDecimal(value, NUMERIC_12_2, {
      label: 'test NUMERIC(12,2)',
      authority: false,
    }).canonical;
  },
  canonicalMoney10(value) {
    return parseScaledDecimal(value, NUMERIC_10_2, {
      label: 'test NUMERIC(10,2)',
      authority: false,
    }).canonical;
  },
  projectedSubtotal(quantity, unitPrice) {
    return halfUpQuantityPrice(
      requestQuantity(quantity, 'test quantity'),
      parseScaledDecimal(unitPrice, NUMERIC_12_2, {
        label: 'test unit price',
        positive: true,
        authority: false,
      }),
      'test subtotal',
    ).canonical;
  },
});

function requireUuid(value, label) {
  const uid = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(uid)) {
    throw AppError.unauthorized(`${label} is required`);
  }
  return uid;
}

function jsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizedDate(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function componentArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeReleaseKey(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text || 'ir';
}

function routesMatch(a, b) {
  const left = a == null ? '' : String(a).trim().toLowerCase();
  const right = b == null ? '' : String(b).trim().toLowerCase();
  return left === right;
}

function strengthComponentsEqual(a, b) {
  const left = componentArray(a);
  const right = componentArray(b);
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  const keyFor = (component) => (
    `${String(component?.ingredient ?? '').trim().toLowerCase()}|`
    + `${String(component?.amount ?? '').trim()}|`
    + `${String(component?.unit ?? '').trim().toLowerCase()}`
  );
  const counts = new Map();
  for (const component of left) {
    const key = keyFor(component);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const component of right) {
    const key = keyFor(component);
    const count = counts.get(key) || 0;
    if (!count) return false;
    counts.set(key, count - 1);
  }
  return [...counts.values()].every((count) => count === 0);
}

function substitutionAllowed(original, substitute) {
  if (!original || !substitute) return false;
  if (original.composition_id == null
      || Number(original.composition_id) !== Number(substitute.composition_id)) return false;
  if (original.composition_confidence !== 'high'
      || substitute.composition_confidence !== 'high') return false;
  if (!original.strength_key || original.strength_key !== substitute.strength_key) return false;
  if (!original.form_key || original.form_key !== substitute.form_key) return false;
  if (normalizeReleaseKey(original.release_key)
      !== normalizeReleaseKey(substitute.release_key)) return false;
  if (!routesMatch(original.route, substitute.route)) return false;
  const originalComponents = componentArray(original.strength_components);
  const combination = (Array.isArray(original.active_ingredients)
      && original.active_ingredients.length >= 2)
    || (Array.isArray(originalComponents) && originalComponents.length >= 2);
  return !combination
    || strengthComponentsEqual(originalComponents, substitute.strength_components);
}

function priorInventoryBillableTotal(line, alreadyDispensedScaled) {
  if (alreadyDispensedScaled === 0n) return 0n;
  for (const candidate of [line?.inventory_billable_total, line?.substitution_billable_total]) {
    if (candidate == null || candidate === '') continue;
    return authorityMoney12(candidate, 'prior inventory billable total').scaled;
  }
  const history = Array.isArray(line?.substitution_history) ? line.substitution_history : [];
  if (history.length && history.every((entry) => (
    entry?.line_total != null || entry?.billable_subtotal != null
  ))) {
    const total = history.reduce((sum, entry) => (
      sum + authorityMoney12(
        entry.line_total ?? entry.billable_subtotal,
        'substitution history billable total',
      ).scaled
    ), 0n);
    return checkedMoney12(total, 'prior substitution history total').scaled;
  }
  throw AppError.conflict(
    'Prior inventory dispense quantity has no immutable billing evidence',
    'PHARMACY_ORDER_BILLING_EVIDENCE_CONFLICT',
  );
}

export function normalizeSubstitutionFundingSelector(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(
      'A substitution funding selector object is required',
      'SUBSTITUTION_FUNDING_SELECTOR_INVALID',
    );
  }
  const forbiddenFields = Object.keys(value).filter((key) => !SELECTOR_KEYS.has(key));
  if (forbiddenFields.length) {
    throw AppError.badRequest(
      'Patient, facility, prescription, price, payment, and funding authority are server-derived',
      'SUBSTITUTION_FUNDING_CALLER_AUTHORITY_FORBIDDEN',
      { forbidden_fields: forbiddenFields.sort() },
    );
  }
  return {
    order_line_index: nonNegativeInt4(value.order_line_index, 'order_line_index'),
    final_catalog_id: positiveInt4(value.final_catalog_id, 'final_catalog_id'),
    inventory_item_id: positiveInt4(value.inventory_item_id, 'inventory_item_id'),
    inventory_batch_id: positiveInt4(value.inventory_batch_id, 'inventory_batch_id'),
    quantity: requestQuantity(value.quantity).canonical,
  };
}

export function substitutionFundingMaterializationKey({ tenantId, proposerUid, idempotencyKey }) {
  const key = String(idempotencyKey || '').trim();
  if (!/^[A-Za-z0-9_\-:.]{1,200}$/.test(key)) {
    throw AppError.badRequest(
      'Idempotency-Key is required for substitution funding proposals',
      'SUBSTITUTION_FUNDING_IDEMPOTENCY_REQUIRED',
    );
  }
  return `substitution-funding:${sha256({
    tenant_id: requireTenantId(tenantId),
    proposer_uid: requireUuid(proposerUid, 'proposer_uid'),
    idempotency_key: key,
  })}`;
}

export function substitutionFundingApprovalCommandKey({ tenantId, approvalId }) {
  return sha256({
    contract: SUBSTITUTION_FUNDING_APPROVAL_CONTRACT,
    command: 'approve',
    tenant_id: requireTenantId(tenantId),
    approval_id: positiveInt4(approvalId, 'approval_id'),
  });
}

function proposalRequestSha256({ orderId, selector, proposerUid }) {
  return sha256({
    contract: SUBSTITUTION_FUNDING_APPROVAL_CONTRACT,
    pharmacy_order_id: positiveInt4(orderId, 'pharmacy_order_id'),
    selector,
    proposer_uid: requireUuid(proposerUid, 'proposer_uid'),
  });
}

async function assertActiveActorTx(tx, {
  tenantId,
  actorUid,
  actorRole = null,
  permittedRoles,
  code,
}) {
  const uid = requireUuid(actorUid, 'actor_uid');
  const rows = await tx.$queryRawUnsafe(
    `SELECT uid::text AS uid,UPPER(role) AS role
       FROM users
      WHERE tenant_id=$1::uuid AND uid=$2::uuid
        AND is_active=TRUE AND status='active' AND is_deleted=FALSE
        AND merged_into_uid IS NULL
      LIMIT 2
      FOR KEY SHARE`,
    tenantId,
    uid,
  );
  const canonicalRole = String(rows[0]?.role || '').toUpperCase();
  if (rows.length !== 1
      || !permittedRoles.has(canonicalRole)
      || (actorRole && canonicalRole !== String(actorRole).trim().toUpperCase())) {
    throw AppError.forbidden(
      'The actor is not an active permitted tenant identity',
      code,
      { allowed_roles: [...permittedRoles] },
    );
  }
  return { uid, role: canonicalRole };
}

function quantityEvidence(line, { orderedKeys, dispensedKeys, remainingKeys }) {
  const first = (keys) => keys.map((key) => line?.[key])
    .find((value) => value !== null && value !== undefined && value !== '');
  const ordered = authorityQuantity(first(orderedKeys), 'ordered quantity', { positive: true });
  const dispensedValue = first(dispensedKeys);
  const dispensed = authorityQuantity(dispensedValue ?? '0', 'dispensed quantity');
  const explicitRemaining = first(remainingKeys);
  if (dispensed.scaled > ordered.scaled) {
    throw AppError.conflict(
      'Medication fulfilment quantities are internally inconsistent',
      'SUBSTITUTION_FUNDING_AUTHORITY_DRIFT',
    );
  }
  const remaining = explicitRemaining == null
    ? authorityQuantity(
      canonicalScaledDecimal(ordered.scaled - dispensed.scaled, NUMERIC_14_4),
      'remaining quantity',
    )
    : authorityQuantity(explicitRemaining, 'remaining quantity');
  if (dispensed.scaled + remaining.scaled !== ordered.scaled) {
    throw AppError.conflict(
      'Medication fulfilment quantities are internally inconsistent',
      'SUBSTITUTION_FUNDING_AUTHORITY_DRIFT',
    );
  }
  return {
    ordered,
    dispensed,
    remaining,
    evidence: Object.freeze({
      ordered_quantity: ordered.canonical,
      dispensed_quantity: dispensed.canonical,
      remaining_quantity: remaining.canonical,
    }),
  };
}

function projectProspectiveOrderItems({
  orderItems,
  orderLineIndex,
  prescriptionLineIndex,
  originalCatalog,
  finalCatalog,
  inventoryItemId,
  quantity,
  lineQuantity,
}) {
  const projected = orderItems.map((line) => ({ ...line }));
  const line = projected[orderLineIndex];
  const selectedQuantity = authorityQuantity(quantity, 'selected substitution quantity', {
    positive: true,
  });
  const priorInventoryQuantity = authorityQuantity(
    line.inventory_dispensed_quantity ?? lineQuantity.dispensed.canonical,
    'prior inventory dispensed quantity',
  );
  const priorBillableTotalScaled = priorInventoryBillableTotal(
    line,
    priorInventoryQuantity.scaled,
  );
  const unitPrice = authorityMoney12(finalCatalog.unit_price, 'substitute unit price', {
    positive: true,
  });
  const billableSubtotal = halfUpQuantityPrice(
    selectedQuantity,
    unitPrice,
    'billable subtotal',
  );
  const cumulativeBillableTotal = checkedMoney12(
    priorBillableTotalScaled + billableSubtotal.scaled,
    'cumulative billable total',
  );
  if (selectedQuantity.scaled > lineQuantity.remaining.scaled) {
    throw AppError.conflict(
      'The requested quantity exceeds the authoritative order remainder',
      'SUBSTITUTION_FUNDING_QUANTITY_EXCEEDS_REMAINDER',
    );
  }
  const remainingAfter = authorityQuantity(
    canonicalScaledDecimal(
      lineQuantity.remaining.scaled - selectedQuantity.scaled,
      NUMERIC_14_4,
    ),
    'remaining quantity after substitution',
  );
  const resultingDispensed = authorityQuantity(
    canonicalScaledDecimal(
      lineQuantity.dispensed.scaled + selectedQuantity.scaled,
      NUMERIC_14_4,
    ),
    'resulting dispensed quantity',
  );
  const resultingInventoryDispensed = authorityQuantity(
    canonicalScaledDecimal(
      priorInventoryQuantity.scaled + selectedQuantity.scaled,
      NUMERIC_14_4,
    ),
    'resulting inventory dispensed quantity',
  );
  projected[orderLineIndex] = {
    ...line,
    order_line_index: orderLineIndex,
    prescription_line_index: prescriptionLineIndex,
    catalog_id: Number(finalCatalog.catalog_id),
    inventory_item_id: inventoryItemId,
    name: finalCatalog.name,
    medication_name: finalCatalog.name,
    ordered_qty: lineQuantity.ordered.canonical,
    dispensed_qty: resultingDispensed.canonical,
    remaining_qty: remainingAfter.canonical,
    inventory_dispensed_quantity: resultingInventoryDispensed.canonical,
    inventory_remaining_quantity: remainingAfter.canonical,
    substitution_billable_total: cumulativeBillableTotal.canonical,
    inventory_billable_total: cumulativeBillableTotal.canonical,
    price: unitPrice.canonical,
    line_total: cumulativeBillableTotal.canonical,
    substitution_history: [
      ...(Array.isArray(line.substitution_history) ? line.substitution_history : []),
      {
        original_catalog_id: Number(originalCatalog.catalog_id),
        original_name: originalCatalog.name,
        final_catalog_id: Number(finalCatalog.catalog_id),
        quantity: selectedQuantity.canonical,
        unit_price: unitPrice.canonical,
        billable_subtotal: billableSubtotal.canonical,
        line_total: cumulativeBillableTotal.canonical,
      },
    ],
  };
  const authoritativeAmount = checkedMoney10(projected.reduce((sum, candidate, index) => {
    if (index === orderLineIndex) return sum + cumulativeBillableTotal.scaled;
    const issued = authorityQuantity(
      candidate?.inventory_dispensed_quantity ?? '0',
      'other line inventory dispensed quantity',
    );
    return sum + priorInventoryBillableTotal(candidate, issued.scaled);
  }, 0n), 'prospective authoritative amount');
  return {
    order_items: projected,
    order_items_sha256: clinicalOrderItemsSha256(projected),
    authoritative_amount: authoritativeAmount.canonical,
    billable_subtotal: billableSubtotal.canonical,
    cumulative_line_total: cumulativeBillableTotal.canonical,
    remaining_quantity: remainingAfter.canonical,
    original_catalog_id: Number(originalCatalog.catalog_id),
  };
}

async function resolveLiveFundingCapacityTx(tx, {
  tenantId,
  authority,
  funding,
}) {
  let approvedTpaAmount = checkedMoney12(0n, 'approved TPA amount');
  let tpaDecisionId = null;
  let tpaClaimId = null;
  let tpaDecisionEvidence = [];
  if (authority.tpa_mode) {
    const claims = await tx.$queryRawUnsafe(
      `SELECT claim.id,claim.status,claim.approved_amount
         FROM tpa_claims claim
        WHERE claim.tenant_id=$1::uuid AND claim.id=$2::int
          AND claim.invoice_id=$3::int AND claim.patient_uid=$4::uuid
          AND claim.admission_id IS NOT DISTINCT FROM $5::int
          AND claim.status IN ('approved','partially_approved','paid')
        LIMIT 2
        FOR UPDATE`,
      tenantId,
      funding.fundingTpaClaimId,
      funding.invoiceId,
      authority.patient_uid,
      authority.admission_id,
    );
    if (claims.length !== 1) {
      throw AppError.conflict(
        'The exact live TPA claim no longer owns this patient, admission, and invoice',
        'SUBSTITUTION_FUNDING_TPA_AUTHORITY_STALE',
      );
    }
    const decisions = await tx.$queryRawUnsafe(
      `SELECT decision.id,decision.invoice_item_id,decision.approved_amount,
              decision.non_payable_amount,decision.reason_code,decision.reason_text,
              decision.recorded_by::text,decision.recorded_at,
              decision.source_authority_version,decision.source_authority_sha256
         FROM tpa_claim_line_decisions decision
         WHERE decision.tenant_id=$1::uuid AND decision.invalidated_at IS NULL
          AND decision.claim_id=$2::int
         ORDER BY decision.id
         FOR UPDATE OF decision`,
      tenantId,
      funding.fundingTpaClaimId,
    );
    const exactDecisions = decisions.filter((decision) => (
      Number(decision.invoice_item_id) === Number(funding.invoiceItemId)
      && Number(decision.source_authority_version) === authority.base_order_version
      && String(decision.source_authority_sha256) === authority.base_order_items_sha256
    ));
    if (exactDecisions.length !== 1) {
      throw AppError.conflict(
        'The exact live TPA claim no longer authorises this pharmacy line',
        'SUBSTITUTION_FUNDING_TPA_AUTHORITY_STALE',
      );
    }
    const totalDecisionScaled = decisions.reduce((sum, decision) => (
      sum + authorityMoney12(
        decision.approved_amount,
        'current TPA line decision amount',
      ).scaled
    ), 0n);
    const claimApprovedAmount = authorityMoney14(
      claims[0].approved_amount ?? '0',
      'TPA claim approved amount',
    );
    if (totalDecisionScaled > claimApprovedAmount.scaled) {
      throw AppError.conflict(
        'Current TPA line decisions exceed the locked claim approval amount',
        'SUBSTITUTION_FUNDING_TPA_AUTHORITY_STALE',
      );
    }
    const exactDecision = exactDecisions[0];
    tpaDecisionId = Number(exactDecision.id);
    tpaClaimId = Number(claims[0].id);
    approvedTpaAmount = authorityMoney12(
      exactDecision.approved_amount,
      'approved TPA amount',
    );
    tpaDecisionEvidence = decisions.map((decision) => Object.freeze({
      tpa_decision_id: Number(decision.id),
      invoice_item_id: Number(decision.invoice_item_id),
      approved_amount: authorityMoney12(
        decision.approved_amount,
        'current TPA line decision amount',
      ).canonical,
      non_payable_amount: authorityMoney12(
        decision.non_payable_amount,
        'current TPA non-payable amount',
      ).canonical,
      reason_code: String(decision.reason_code || ''),
      reason_text: decision.reason_text == null ? null : String(decision.reason_text),
      recorded_by: decision.recorded_by == null ? null : String(decision.recorded_by),
      recorded_at: decision.recorded_at instanceof Date
        ? decision.recorded_at.toISOString()
        : String(decision.recorded_at),
      source_authority_version: decision.source_authority_version == null
        ? null
        : Number(decision.source_authority_version),
      source_authority_sha256: decision.source_authority_sha256 == null
        ? null
        : String(decision.source_authority_sha256),
    }));
    if (!['tpa_claim', 'mixed'].includes(String(funding.fundingSource || '').toLowerCase())
        || Number(funding.fundingTpaClaimId) !== tpaClaimId) {
      throw AppError.conflict(
        'The materialized funding event does not bind the exact live TPA decision',
        'SUBSTITUTION_FUNDING_TPA_AUTHORITY_STALE',
      );
    }
  } else if (funding.fundingTpaClaimId != null) {
    throw AppError.conflict(
      'A non-TPA order is linked to TPA funding authority',
      'SUBSTITUTION_FUNDING_TPA_AUTHORITY_STALE',
    );
  } else if (String(funding.fundingSource || '').toLowerCase() !== 'billing_payment') {
    throw AppError.conflict(
      'A self-pay substitution must resolve exclusively to posted patient payment authority',
      'SUBSTITUTION_FUNDING_PAYMENT_AUTHORITY_STALE',
    );
  }

  const payments = await tx.$queryRawUnsafe(
    `SELECT payment.id,payment.amount,payment.mode,payment.reference,
            payment.collected_at
       FROM billing_payments payment
      WHERE payment.tenant_id=$1::uuid AND payment.invoice_id=$2::int
        AND payment.patient_uid=$3::uuid AND payment.reversed=FALSE
      ORDER BY payment.collected_at NULLS LAST,payment.id
      FOR UPDATE OF payment`,
    tenantId,
    funding.invoiceId,
    authority.patient_uid,
  );
  const paymentIds = payments.map((payment) => Number(payment.id));
  const allocations = paymentIds.length
    ? await tx.$queryRawUnsafe(
      `SELECT allocation.id::text AS allocation_id,allocation.billing_payment_id,
              allocation.pharmacy_order_id,allocation.invoice_id,
              allocation.invoice_item_id,allocation.source_authority_version,
              allocation.source_authority_sha256,allocation.allocated_amount,
              allocation.allocation_command_sha256,allocation.allocated_by::text,
              allocation.allocated_at,allocation.evidence
         FROM pharmacy_payment_allocations allocation
        WHERE allocation.tenant_id=$1::uuid
          AND allocation.billing_payment_id=ANY($2::int[])
        ORDER BY allocation.billing_payment_id,allocation.id
        FOR UPDATE OF allocation`,
      tenantId,
      paymentIds,
    )
    : [];
  const allocationIds = allocations.map((allocation) => String(allocation.allocation_id));
  const reversals = allocationIds.length
    ? await tx.$queryRawUnsafe(
      `SELECT reversal.id::text AS reversal_id,reversal.allocation_id::text,
              reversal.reversed_amount,reversal.reversal_command_sha256,
              reversal.reversed_by::text,reversal.reversed_at
         FROM pharmacy_payment_allocation_reversals reversal
        WHERE reversal.tenant_id=$1::uuid
          AND reversal.allocation_id=ANY($2::bigint[])
        ORDER BY reversal.allocation_id,reversal.id
        FOR UPDATE OF reversal`,
      tenantId,
      allocationIds,
    )
    : [];
  const reversalsByAllocation = new Map();
  for (const reversal of reversals) {
    const allocationId = String(reversal.allocation_id);
    const bucket = reversalsByAllocation.get(allocationId) || [];
    bucket.push(reversal);
    reversalsByAllocation.set(allocationId, bucket);
  }
  const allocationByPayment = new Map(paymentIds.map((paymentId) => [paymentId, []]));
  const allocationEvidence = allocations.map((allocation) => {
    const amount = authorityMoney12(allocation.allocated_amount, 'allocated payment amount', {
      positive: true,
    });
    const reversalEvidence = (reversalsByAllocation.get(String(allocation.allocation_id)) || [])
      .map((reversal) => ({
        reversal_id: String(reversal.reversal_id),
        reversed_amount: authorityMoney12(
          reversal.reversed_amount,
          'reversed allocation amount',
          { positive: true },
        ).canonical,
        reversal_command_sha256: String(reversal.reversal_command_sha256),
        reversed_by: String(reversal.reversed_by),
        reversed_at: reversal.reversed_at instanceof Date
          ? reversal.reversed_at.toISOString()
          : String(reversal.reversed_at),
      }));
    const reversedScaled = reversalEvidence.reduce((sum, reversal) => (
      sum + authorityMoney12(reversal.reversed_amount, 'reversed allocation amount', {
        positive: true,
      }).scaled
    ), 0n);
    if (reversedScaled > amount.scaled) {
      throw AppError.conflict(
        'Payment allocation reversal evidence exceeds its immutable allocation',
        'SUBSTITUTION_FUNDING_AUTHORITY_DRIFT',
      );
    }
    const netScaled = amount.scaled - reversedScaled;
    const sameOrderTarget = Number(allocation.pharmacy_order_id) === authority.pharmacy_order_id
      && Number(allocation.invoice_id) === Number(funding.invoiceId)
      && Number(allocation.invoice_item_id) === Number(funding.invoiceItemId);
    const baseAuthority = sameOrderTarget
      && Number(allocation.source_authority_version) === authority.base_order_version
      && String(allocation.source_authority_sha256) === authority.base_order_items_sha256;
    const prospectiveAuthority = sameOrderTarget
      && Number(allocation.source_authority_version) === authority.prospective_order_version
      && String(allocation.source_authority_sha256) === authority.prospective_order_items_sha256;
    if (sameOrderTarget && netScaled > 0n && !baseAuthority && !prospectiveAuthority) {
      throw AppError.conflict(
        'The order has a live payment allocation on an unrecognised authority generation',
        'SUBSTITUTION_FUNDING_ALLOCATION_AUTHORITY_AMBIGUOUS',
      );
    }
    const internal = {
      allocationId: String(allocation.allocation_id),
      billingPaymentId: Number(allocation.billing_payment_id),
      pharmacyOrderId: Number(allocation.pharmacy_order_id),
      invoiceId: Number(allocation.invoice_id),
      invoiceItemId: Number(allocation.invoice_item_id),
      sourceAuthorityVersion: Number(allocation.source_authority_version),
      sourceAuthoritySha256: String(allocation.source_authority_sha256),
      netScaled,
      allocatedScaled: amount.scaled,
      baseAuthority,
      prospectiveAuthority,
      allocationCommandSha256: String(allocation.allocation_command_sha256),
      allocatedBy: String(allocation.allocated_by).toLowerCase(),
      evidence: jsonObject(allocation.evidence),
      allocatedAt: allocation.allocated_at instanceof Date
        ? allocation.allocated_at.toISOString()
        : String(allocation.allocated_at),
    };
    allocationByPayment.get(Number(allocation.billing_payment_id))?.push(internal);
    return Object.freeze({
      allocation_id: internal.allocationId,
      billing_payment_id: Number(allocation.billing_payment_id),
      pharmacy_order_id: Number(allocation.pharmacy_order_id),
      invoice_id: Number(allocation.invoice_id),
      invoice_item_id: Number(allocation.invoice_item_id),
      source_authority_version: Number(allocation.source_authority_version),
      source_authority_sha256: String(allocation.source_authority_sha256),
      allocated_amount: amount.canonical,
      reversed_amount: canonicalScaledDecimal(reversedScaled, NUMERIC_12_2),
      net_amount: canonicalScaledDecimal(netScaled, NUMERIC_12_2),
      allocation_command_sha256: String(allocation.allocation_command_sha256),
      allocated_by: String(allocation.allocated_by),
      allocated_at: allocation.allocated_at instanceof Date
        ? allocation.allocated_at.toISOString()
        : String(allocation.allocated_at),
      base_authority: baseAuthority,
      prospective_authority: prospectiveAuthority,
      reversals: reversalEvidence,
    });
  });
  const refunds = await tx.$queryRawUnsafe(
    `SELECT refund.id,refund.amount,refund.mode,refund.reference,
            refund.approval_status,refund.raised_at,refund.approved_at,refund.paid_at
       FROM billing_refunds refund
      WHERE refund.tenant_id=$1::uuid AND refund.invoice_id=$2::int
        AND refund.patient_uid=$3::uuid
        AND UPPER(refund.approval_status)<>'REJECTED'
      ORDER BY refund.id`,
    tenantId,
    funding.invoiceId,
    authority.patient_uid,
  );
  const refundEvidence = refunds.map((refund) => Object.freeze({
    refund_id: Number(refund.id),
    amount: authorityMoney12(refund.amount, 'active refund reservation amount', {
      positive: true,
    }).canonical,
    mode: String(refund.mode || '').toUpperCase(),
    reference: refund.reference || null,
    approval_status: String(refund.approval_status || '').toUpperCase(),
    raised_at: refund.raised_at instanceof Date
      ? refund.raised_at.toISOString()
      : String(refund.raised_at),
    approved_at: refund.approved_at == null
      ? null
      : refund.approved_at instanceof Date
        ? refund.approved_at.toISOString()
        : String(refund.approved_at),
    paid_at: refund.paid_at == null
      ? null
      : refund.paid_at instanceof Date
        ? refund.paid_at.toISOString()
        : String(refund.paid_at),
  }));
  const refundReservationScaled = refundEvidence.reduce((sum, refund) => (
    sum + authorityMoney12(refund.amount, 'active refund reservation amount', {
      positive: true,
    }).scaled
  ), 0n);
  checkedMoney12(refundReservationScaled, 'active refund reservations');

  const patientRailPlans = [];
  const excludedPaymentEvidence = [];
  let patientGrossScaled = 0n;
  for (const payment of payments) {
    const paymentId = Number(payment.id);
    const amount = authorityMoney12(payment.amount, 'posted payment amount', { positive: true });
    const mode = String(payment.mode || '').trim().toUpperCase();
    const paymentAllocations = allocationByPayment.get(paymentId) || [];
    const totalAllocatedScaled = paymentAllocations.reduce(
      (sum, allocation) => sum + allocation.netScaled,
      0n,
    );
    const baseAllocatedScaled = paymentAllocations.reduce(
      (sum, allocation) => sum + (allocation.baseAuthority ? allocation.netScaled : 0n),
      0n,
    );
    const prospectiveAllocatedScaled = paymentAllocations.reduce(
      (sum, allocation) => sum + (allocation.prospectiveAuthority ? allocation.netScaled : 0n),
      0n,
    );
    const otherAllocatedScaled = totalAllocatedScaled
      - baseAllocatedScaled
      - prospectiveAllocatedScaled;
    if (totalAllocatedScaled > amount.scaled
        || baseAllocatedScaled + prospectiveAllocatedScaled > totalAllocatedScaled) {
      throw AppError.conflict(
        'Posted payment allocation evidence exceeds immutable payment capacity',
        'SUBSTITUTION_FUNDING_AUTHORITY_DRIFT',
      );
    }
    const commonEvidence = {
      payment_id: paymentId,
      amount: amount.canonical,
      mode,
      reference: payment.reference || null,
      collected_at: payment.collected_at instanceof Date
        ? payment.collected_at.toISOString()
        : String(payment.collected_at),
      allocation_ids: paymentAllocations.map((allocation) => allocation.allocationId),
      net_allocated_amount: canonicalScaledDecimal(totalAllocatedScaled, NUMERIC_12_2),
      base_allocated_amount: canonicalScaledDecimal(
        baseAllocatedScaled,
        NUMERIC_12_2,
      ),
      prospective_allocated_amount: canonicalScaledDecimal(
        prospectiveAllocatedScaled,
        NUMERIC_12_2,
      ),
      other_allocated_amount: canonicalScaledDecimal(otherAllocatedScaled, NUMERIC_12_2),
    };
    if (!PATIENT_PAYMENT_RAILS.has(mode)) {
      if (baseAllocatedScaled > 0n || prospectiveAllocatedScaled > 0n) {
        throw AppError.conflict(
          'The order has a live allocation on an excluded insurance or non-patient rail',
          'SUBSTITUTION_FUNDING_ALLOCATION_AUTHORITY_AMBIGUOUS',
        );
      }
      excludedPaymentEvidence.push(Object.freeze({
        ...commonEvidence,
        exclusion_reason: TPA_PAYMENT_MODES.has(mode.toLowerCase()) || mode === 'INSURANCE'
          ? 'insurance_or_tpa_payment_not_additive'
          : 'non_patient_payment_rail',
      }));
      continue;
    }
    patientGrossScaled += amount.scaled;
    const rawCapacityScaled = amount.scaled - otherAllocatedScaled;
    const evidence = Object.freeze({
      ...commonEvidence,
      raw_transfer_capacity: canonicalScaledDecimal(rawCapacityScaled, NUMERIC_12_2),
    });
    patientRailPlans.push(Object.freeze({
      paymentId,
      mode,
      amountScaled: amount.scaled,
      baseAllocatedScaled,
      prospectiveAllocatedScaled,
      otherAllocatedScaled,
      rawCapacityScaled,
      baseAllocations: Object.freeze(paymentAllocations.filter(
        (allocation) => allocation.baseAuthority && allocation.netScaled > 0n,
      )),
      prospectiveAllocations: Object.freeze(paymentAllocations.filter(
        (allocation) => allocation.prospectiveAuthority && allocation.netScaled > 0n,
      )),
      otherAllocations: Object.freeze(paymentAllocations.filter(
        (allocation) => !allocation.baseAuthority
          && !allocation.prospectiveAuthority
          && allocation.netScaled > 0n,
      )),
      evidence,
    }));
  }
  checkedMoney12(patientGrossScaled, 'posted patient-payment total');
  if (refundReservationScaled > patientGrossScaled) {
    throw AppError.conflict(
      'Active refund reservations exceed posted patient-rail payments',
      'SUBSTITUTION_FUNDING_REFUND_AUTHORITY_INVALID',
    );
  }
  const patientNetScaled = patientGrossScaled - refundReservationScaled;
  const baseAllocatedScaled = patientRailPlans.reduce(
    (sum, payment) => sum + payment.baseAllocatedScaled,
    0n,
  );
  const prospectiveAllocatedScaled = patientRailPlans.reduce(
    (sum, payment) => sum + payment.prospectiveAllocatedScaled,
    0n,
  );
  const otherAllocatedScaled = patientRailPlans.reduce(
    (sum, payment) => sum + payment.otherAllocatedScaled,
    0n,
  );
  checkedMoney12(baseAllocatedScaled, 'base patient-payment allocation total');
  checkedMoney12(prospectiveAllocatedScaled, 'prospective patient-payment allocation total');
  checkedMoney12(otherAllocatedScaled, 'other patient-payment allocation total');
  if (prospectiveAllocatedScaled > 0n) {
    throw AppError.conflict(
      'The prospective funding tuple already has movement evidence; replay the durable dispense command',
      'SUBSTITUTION_FUNDING_CONSUMPTION_ALREADY_RECORDED',
    );
  }
  if (otherAllocatedScaled > patientNetScaled) {
    throw AppError.conflict(
      'Other live allocations and refund reservations exceed patient-payment authority',
      'SUBSTITUTION_FUNDING_PAYMENT_AUTHORITY_STALE',
    );
  }
  const availableForOrderScaled = patientNetScaled - otherAllocatedScaled;
  const prospectiveAmount = authorityMoney10(
    authority.prospective_authoritative_amount,
    'prospective authoritative amount',
    { positive: true },
  );
  const tpaUsedScaled = approvedTpaAmount.scaled > prospectiveAmount.scaled
    ? prospectiveAmount.scaled
    : approvedTpaAmount.scaled;
  const patientAmountRequiredScaled = prospectiveAmount.scaled - tpaUsedScaled;
  if (availableForOrderScaled < patientAmountRequiredScaled) {
    throw AppError.conflict(
      'Live TPA headroom and posted unreversed payment capacity do not cover the substitution',
      'SUBSTITUTION_FUNDING_CAPACITY_INSUFFICIENT',
      {
        prospective_authoritative_amount: prospectiveAmount.canonical,
        tpa_used_amount: canonicalScaledDecimal(tpaUsedScaled, NUMERIC_12_2),
        available_patient_payment_amount: canonicalScaledDecimal(
          availableForOrderScaled,
          NUMERIC_12_2,
        ),
      },
    );
  }
  const combinedAuthority = checkedMoney12(
    tpaUsedScaled + availableForOrderScaled,
    'combined funding authority',
  );
  const fundingSource = tpaUsedScaled > 0n
    ? patientAmountRequiredScaled > 0n ? 'mixed' : 'tpa_claim'
    : 'billing_payment';
  const fundingReference = [
    tpaUsedScaled > 0n ? `tpa:${tpaClaimId}:decision:${tpaDecisionId}` : null,
    patientAmountRequiredScaled > 0n
      ? `patient-payments:${patientRailPlans.map((payment) => payment.paymentId).join(',')}`
      : null,
  ].filter(Boolean).join(';');
  const sourceEvidence = {
    contract: 'pharmacy_substitution_funding_sources_v1',
    tpa_claim_id: tpaClaimId,
    tpa_decision_id: tpaDecisionId,
    tpa_decision_ids: tpaDecisionEvidence.map((decision) => decision.tpa_decision_id),
    payment_ids: payments.map((payment) => Number(payment.id)),
    patient_rail_payment_ids: patientRailPlans.map((payment) => payment.paymentId),
    excluded_payment_ids: excludedPaymentEvidence.map((payment) => payment.payment_id),
    refund_ids: refundEvidence.map((refund) => refund.refund_id),
    allocation_ids: allocationEvidence.map((allocation) => allocation.allocation_id),
    payments: patientRailPlans.map((payment) => payment.evidence),
    excluded_payments: excludedPaymentEvidence,
    refunds: refundEvidence,
    allocations: allocationEvidence,
    tpa_decisions: tpaDecisionEvidence,
  };
  const evidence = {
    contract: 'pharmacy_substitution_funding_capacity_v1',
    funding_source: fundingSource,
    funding_reference: fundingReference,
    materialized_funding_source: funding.fundingSource,
    materialized_funding_reference: funding.fundingReference,
    invoice_id: funding.invoiceId,
    invoice_item_id: funding.invoiceItemId,
    funding_event_id: funding.fundingEventId,
    tpa_claim_id: tpaClaimId,
    tpa_decision_id: tpaDecisionId,
    locked_approved_tpa_amount: approvedTpaAmount.canonical,
    tpa_used_amount: canonicalScaledDecimal(tpaUsedScaled, NUMERIC_12_2),
    patient_payment_required_amount: canonicalScaledDecimal(
      patientAmountRequiredScaled,
      NUMERIC_12_2,
    ),
    posted_patient_payment_amount: canonicalScaledDecimal(
      patientGrossScaled,
      NUMERIC_12_2,
    ),
    active_refund_reservation_amount: canonicalScaledDecimal(
      refundReservationScaled,
      NUMERIC_12_2,
    ),
    net_patient_payment_amount: canonicalScaledDecimal(patientNetScaled, NUMERIC_12_2),
    base_allocated_payment_amount: canonicalScaledDecimal(
      baseAllocatedScaled,
      NUMERIC_12_2,
    ),
    prospective_allocated_payment_amount: canonicalScaledDecimal(
      prospectiveAllocatedScaled,
      NUMERIC_12_2,
    ),
    other_allocated_payment_amount: canonicalScaledDecimal(
      otherAllocatedScaled,
      NUMERIC_12_2,
    ),
    available_patient_payment_amount: canonicalScaledDecimal(
      availableForOrderScaled,
      NUMERIC_12_2,
    ),
    combined_authority_amount: combinedAuthority.canonical,
    headroom_amount: canonicalScaledDecimal(
      combinedAuthority.scaled - prospectiveAmount.scaled,
      NUMERIC_12_2,
    ),
    reservation_required_amount: canonicalScaledDecimal(
      patientAmountRequiredScaled,
      NUMERIC_12_2,
    ),
    source_evidence_sha256: sha256(sourceEvidence),
    source_evidence: sourceEvidence,
  };
  return Object.freeze({
    evidence: Object.freeze({ ...evidence, evidence_sha256: sha256(evidence) }),
    reservationPlan: Object.freeze({
      patientAmountRequiredScaled,
      tpaUsedScaled,
      lockedApprovedTpaAmountScaled: approvedTpaAmount.scaled,
      baseAllocatedScaled,
      prospectiveAllocatedScaled,
      otherAllocatedScaled,
      patientGrossScaled,
      refundReservationScaled,
      patientNetScaled,
      availableForOrderScaled,
      prospectiveAmountScaled: prospectiveAmount.scaled,
      tpaDecisionId,
      tpaClaimId,
      payments: Object.freeze(patientRailPlans),
    }),
  });
}

async function lockSubstitutionFundingPatientAuthorityTx(tx, {
  tenantId,
  orderId,
}) {
  const tid = requireTenantId(tenantId);
  const exactOrderId = positiveInt4(orderId, 'pharmacy_order_id');
  await lockTenantPatientMergeStability(tx, tid);
  const preflight = await tx.$queryRawUnsafe(
    `SELECT pharmacy_order.facility_id,patient.uid::text AS patient_uid
       FROM pharmacy_orders pharmacy_order
       JOIN facilities facility
         ON facility.tenant_id=pharmacy_order.tenant_id
        AND facility.id=pharmacy_order.facility_id AND facility.status='active'
       JOIN users patient
         ON patient.tenant_id=pharmacy_order.tenant_id
        AND patient.id=pharmacy_order.patient_id
        AND patient.role='PATIENT' AND patient.is_active=TRUE
        AND patient.status='active' AND patient.is_deleted=FALSE
        AND patient.merged_into_uid IS NULL
      WHERE pharmacy_order.tenant_id=$1::uuid AND pharmacy_order.id=$2::int
        AND (pharmacy_order.uid IS NULL OR pharmacy_order.uid=patient.uid)
      LIMIT 2`,
    tid,
    exactOrderId,
  );
  if (preflight.length !== 1) {
    throw AppError.notFound('The active tenant pharmacy order was not found');
  }
  const patientUid = await resolvePharmacyFundingPatientUidTx(tx, {
    tenantId: tid,
    orderId: exactOrderId,
    patientUid: preflight[0].patient_uid,
  });
  await lockPharmacyFundingAuthorityTx(tx, { tenantId: tid, patientUid });
  await tx.$queryRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtextextended($1::text,753))::text AS lock_acquired`,
    `vh:substitution-funding:order:${tid}:${exactOrderId}`,
  );
  return Object.freeze({
    tenantId: tid,
    orderId: exactOrderId,
    patientUid,
    facilityId: positiveInt4(preflight[0].facility_id, 'facility_id'),
  });
}

async function lockSubstitutionFundingOrderTx(tx, fundingLock) {
  const orders = await tx.$queryRawUnsafe(
    `SELECT pharmacy_order.id,pharmacy_order.patient_id,
            pharmacy_order.facility_id,UPPER(pharmacy_order.status) AS order_status,
            pharmacy_order.items_list,pharmacy_order.total_amount,
            pharmacy_order.inventory_authority_version,
            pharmacy_order.payment_mode,pharmacy_order.payment_metadata,
            pharmacy_order.funding_admission_id,
            patient.uid::text AS patient_uid
       FROM pharmacy_orders pharmacy_order
       JOIN facilities facility
         ON facility.tenant_id=pharmacy_order.tenant_id
        AND facility.id=pharmacy_order.facility_id AND facility.status='active'
       JOIN users patient
         ON patient.tenant_id=pharmacy_order.tenant_id
        AND patient.id=pharmacy_order.patient_id
        AND patient.role='PATIENT' AND patient.is_active=TRUE
        AND patient.status='active' AND patient.is_deleted=FALSE
        AND patient.merged_into_uid IS NULL
      WHERE pharmacy_order.tenant_id=$1::uuid AND pharmacy_order.id=$2::int
        AND pharmacy_order.facility_id=$3::int
        AND patient.uid=$4::uuid
        AND (pharmacy_order.uid IS NULL OR pharmacy_order.uid=patient.uid)
      LIMIT 2
      FOR UPDATE OF pharmacy_order,patient`,
    fundingLock.tenantId,
    fundingLock.orderId,
    fundingLock.facilityId,
    fundingLock.patientUid,
  );
  if (orders.length !== 1) {
    throw AppError.conflict(
      'The pharmacy order patient or facility authority changed',
      'SUBSTITUTION_FUNDING_AUTHORITY_DRIFT',
    );
  }
  return orders[0];
}

async function resolveSubstitutionFundingAuthorityTx(tx, {
  tenantId,
  orderId,
  selector: rawSelector,
  proposerUid,
  proposerRole = null,
  fundingLock: suppliedFundingLock = null,
}) {
  const tid = requireTenantId(tenantId);
  const exactOrderId = positiveInt4(orderId, 'pharmacy_order_id');
  const selector = normalizeSubstitutionFundingSelector(rawSelector);
  const fundingLock = suppliedFundingLock || await lockSubstitutionFundingPatientAuthorityTx(tx, {
    tenantId: tid,
    orderId: exactOrderId,
  });
  if (fundingLock.tenantId !== tid || fundingLock.orderId !== exactOrderId) {
    throw AppError.internal(
      'Substitution funding pre-lock is bound to a different authority tuple',
      'SUBSTITUTION_FUNDING_LOCK_ORDER_INVALID',
    );
  }
  const proposer = await assertActiveActorTx(tx, {
    tenantId: tid,
    actorUid: proposerUid,
    actorRole: proposerRole,
    permittedRoles: new Set(SUBSTITUTION_FUNDING_PROPOSER_ROLES),
    code: 'SUBSTITUTION_FUNDING_PROPOSER_FORBIDDEN',
  });
  const facilityGrant = await assertPharmacyFacilityGrant(tx, {
    tenantId: tid,
    facilityId: fundingLock.facilityId,
    actorUid: proposer.uid,
    actorRole: proposer.role,
    forUpdate: true,
  });
  const order = await lockSubstitutionFundingOrderTx(tx, fundingLock);
  const patientUid = fundingLock.patientUid;
  if (!DISPENSABLE_ORDER_STATUSES.has(order.order_status)) {
    throw AppError.conflict(
      `The pharmacy order cannot accept a substitution from ${order.order_status || 'unknown'}`,
      'SUBSTITUTION_FUNDING_ORDER_STATE_INVALID',
    );
  }
  const baseOrderVersion = positiveInt4(
    order.inventory_authority_version,
    'inventory_authority_version',
  );
  const orderItems = Array.isArray(order.items_list) ? order.items_list : [];
  const orderLine = orderItems[selector.order_line_index];
  if (!orderLine || typeof orderLine !== 'object' || Array.isArray(orderLine)
      || Number(orderLine.order_line_index) !== selector.order_line_index) {
    throw AppError.conflict(
      'The selected order line is not authoritative',
      'SUBSTITUTION_FUNDING_ORDER_LINE_INVALID',
    );
  }
  const prescriptionLineIndex = nonNegativeInt4(
    orderLine.prescription_line_index,
    'prescription_line_index',
  );
  const prescriptions = await tx.$queryRawUnsafe(
    `SELECT prescription.id,LOWER(prescription.status) AS prescription_status,
            prescription.medications,COALESCE(prescription.revision,1)::int AS revision,
            prescription.appointment_id,prescription.admission_id,
            prescription.doctor_uid
       FROM e_prescriptions prescription
       JOIN users prescriber
         ON prescriber.tenant_id=prescription.tenant_id
        AND prescriber.uid=prescription.doctor_uid
        AND prescriber.role='DOCTOR' AND prescriber.is_active=TRUE
        AND prescriber.status='active' AND prescriber.is_deleted=FALSE
        AND prescriber.merged_into_uid IS NULL
      WHERE prescription.tenant_id=$1::uuid
        AND prescription.pharmacy_order_id=$2::int
        AND prescription.patient_id=$3::int
        AND prescription.patient_uid=$4::uuid
        AND LOWER(COALESCE(prescription.status,'')) IN ('active','pharmacy_linked')
        AND (LOWER(COALESCE(prescription.lifecycle_status,'draft'))='signed'
          OR prescription.signed_at IS NOT NULL
          OR prescription.locked_at IS NOT NULL)
      ORDER BY prescription.id
      LIMIT 2
      FOR UPDATE OF prescription,prescriber`,
    tid,
    exactOrderId,
    Number(order.patient_id),
    patientUid,
  );
  if (prescriptions.length !== 1
      || !DISPENSABLE_PRESCRIPTION_STATUSES.has(prescriptions[0].prescription_status)) {
    throw AppError.conflict(
      'One active signed prescription must own the exact pharmacy order',
      'SUBSTITUTION_FUNDING_PRESCRIPTION_AUTHORITY_INVALID',
    );
  }
  const prescription = prescriptions[0];
  const medications = Array.isArray(prescription.medications) ? prescription.medications : [];
  const prescriptionLine = medications[prescriptionLineIndex];
  const originalCatalogId = positiveInt4(
    prescriptionLine?.catalog_id,
    'prescription catalog id',
  );
  const historicalOriginalIds = Array.isArray(orderLine.substitution_history)
    ? orderLine.substitution_history.map((entry) => Number(entry?.original_catalog_id))
    : [];
  if (!prescriptionLine
      || ![Number(orderLine.catalog_id), ...historicalOriginalIds].includes(originalCatalogId)) {
    throw AppError.conflict(
      'The order line no longer matches its signed prescription line',
      'SUBSTITUTION_FUNDING_ORDER_LINE_INVALID',
    );
  }
  if (selector.final_catalog_id === originalCatalogId) {
    throw AppError.badRequest(
      'The substitute must differ from the prescribed catalog item',
      'SUBSTITUTION_FUNDING_SAME_CATALOG',
    );
  }
  const prescriptionQuantity = quantityEvidence(prescriptionLine, {
    orderedKeys: ['quantity', 'qty', 'ordered_quantity'],
    dispensedKeys: ['dispensed_quantity'],
    remainingKeys: ['remaining_quantity'],
  });
  const orderQuantity = quantityEvidence(orderLine, {
    orderedKeys: ['ordered_qty', 'quantity', 'qty'],
    dispensedKeys: ['inventory_dispensed_quantity', 'dispensed_qty'],
    remainingKeys: ['inventory_remaining_quantity', 'remaining_qty'],
  });
  const requestedQuantity = authorityQuantity(
    selector.quantity,
    'selected substitution quantity',
    { positive: true },
  );
  if (requestedQuantity.scaled > prescriptionQuantity.remaining.scaled
      || requestedQuantity.scaled > orderQuantity.remaining.scaled) {
    throw AppError.conflict(
      'The requested quantity exceeds the authoritative order or prescription remainder',
      'SUBSTITUTION_FUNDING_QUANTITY_EXCEEDS_REMAINDER',
    );
  }
  const catalogRows = await tx.$queryRawUnsafe(
    `SELECT catalog.id AS catalog_id,catalog.composition_id,catalog.strength_key,
            catalog.strength_components,catalog.form_key,catalog.release_key,
            catalog.route,catalog.composition_confidence,catalog.unit_price,catalog.name
       FROM pharmacy_catalog catalog
      WHERE catalog.tenant_id=$1::uuid AND catalog.is_active=TRUE
        AND catalog.id=ANY($2::int[])
      ORDER BY catalog.id
      FOR UPDATE OF catalog`,
    tid,
    [originalCatalogId, selector.final_catalog_id],
  );
  if (catalogRows.length !== 2) {
    throw AppError.conflict(
      'The prescribed and substitute catalog identities must both remain active',
      'SUBSTITUTION_FUNDING_CATALOG_AUTHORITY_INVALID',
    );
  }
  const compositionIds = [...new Set(catalogRows
    .map((catalog) => Number(catalog.composition_id))
    .filter((id) => Number.isInteger(id) && id > 0))];
  const compositions = compositionIds.length
    ? await tx.$queryRawUnsafe(
      `SELECT id,active_ingredients
         FROM drug_compositions
        WHERE id=ANY($1::int[])
        ORDER BY id
        FOR KEY SHARE`,
      compositionIds,
    )
    : [];
  const ingredientsByComposition = new Map(compositions.map((composition) => [
    Number(composition.id),
    composition.active_ingredients,
  ]));
  const catalogById = new Map(catalogRows.map((catalog) => [
    Number(catalog.catalog_id),
    {
      ...catalog,
      catalog_id: Number(catalog.catalog_id),
      composition_id: catalog.composition_id == null ? null : Number(catalog.composition_id),
      active_ingredients: catalog.composition_id == null
        ? null
        : ingredientsByComposition.get(Number(catalog.composition_id)) ?? null,
    },
  ]));
  const originalCatalog = catalogById.get(originalCatalogId);
  const finalCatalog = catalogById.get(selector.final_catalog_id);
  if (!substitutionAllowed(originalCatalog, finalCatalog)) {
    throw AppError.conflict(
      'The substitute is no longer composition, strength, form, release, and route equivalent',
      'SUBSTITUTION_FUNDING_EQUIVALENCE_INVALID',
    );
  }
  const finalUnitPrice = authorityMoney12(
    finalCatalog.unit_price,
    'substitute unit price',
    { positive: true },
  );
  const inventoryItems = await tx.$queryRawUnsafe(
    `SELECT item.id,item.catalog_id,item.facility_id,item.schedule_class,
            item.is_narcotic,item.status
       FROM pharmacy_inventory_items item
      WHERE item.tenant_id=$1::uuid AND item.id=$2::int
        AND item.catalog_id=$3::int AND item.facility_id=$4::int
      LIMIT 2
      FOR UPDATE OF item`,
    tid,
    selector.inventory_item_id,
    selector.final_catalog_id,
    Number(order.facility_id),
  );
  if (inventoryItems.length !== 1 || inventoryItems[0].status !== 'active') {
    throw AppError.conflict(
      'The substitute inventory item is no longer active in the order facility',
      'SUBSTITUTION_FUNDING_INVENTORY_AUTHORITY_INVALID',
    );
  }
  const batches = await tx.$queryRawUnsafe(
    `SELECT batch.id,batch.batch_number,batch.lot_number,batch.expiry_date,
            batch.remaining_quantity,batch.status,
            (batch.expiry_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS is_expired
       FROM pharmacy_inventory_batches batch
      WHERE batch.tenant_id=$1::uuid AND batch.id=$2::int
        AND batch.inventory_item_id=$3::int AND batch.facility_id=$4::int
      LIMIT 2
      FOR UPDATE OF batch`,
    tid,
    selector.inventory_batch_id,
    selector.inventory_item_id,
    Number(order.facility_id),
  );
  const batchRemainingQuantity = batches.length === 1
    ? authorityQuantity(batches[0].remaining_quantity, 'batch remaining quantity')
    : null;
  if (batches.length !== 1 || batches[0].status !== 'in_stock'
      || !batches[0].expiry_date || batches[0].is_expired === true
      || batchRemainingQuantity.scaled < requestedQuantity.scaled) {
    throw AppError.conflict(
      'The selected batch is not a usable, unexpired, sufficiently stocked batch',
      'SUBSTITUTION_FUNDING_BATCH_AUTHORITY_INVALID',
    );
  }
  const baseOrderItemsSha256 = clinicalOrderItemsSha256(orderItems);
  const projection = projectProspectiveOrderItems({
    orderItems,
    orderLineIndex: selector.order_line_index,
    prescriptionLineIndex,
    originalCatalog,
    finalCatalog,
    inventoryItemId: selector.inventory_item_id,
    quantity: requestedQuantity.canonical,
    lineQuantity: orderQuantity,
  });
  const paymentMetadata = jsonObject(order.payment_metadata);
  const paymentMode = String(
    order.payment_mode || paymentMetadata.payment_mode || '',
  ).trim().toLowerCase();
  if (!paymentMode) {
    throw AppError.conflict(
      'The order has no server-authoritative payment mode',
      'SUBSTITUTION_FUNDING_PAYMENT_MODE_REQUIRED',
    );
  }
  const base = {
    pharmacy_order_id: exactOrderId,
    patient_id: Number(order.patient_id),
    patient_uid: patientUid,
    facility_id: Number(order.facility_id),
    facility_grant_id: String(facilityGrant.grant_id),
    order_status: order.order_status,
    order_version: baseOrderVersion,
    order_items_sha256: baseOrderItemsSha256,
    authoritative_amount: authorityMoney10(
      order.total_amount,
      'base authoritative amount',
    ).canonical,
    payment_mode: paymentMode,
    admission_id: order.funding_admission_id == null
      ? null
      : positiveInt4(order.funding_admission_id, 'funding_admission_id'),
    prescription_id: Number(prescription.id),
    prescription_revision: positiveInt4(prescription.revision, 'prescription revision'),
    prescription_status: prescription.prescription_status,
    prescription_line_index: prescriptionLineIndex,
    original_catalog_id: originalCatalogId,
  };
  const prospectiveTuple = {
    order_version: nextPositiveInt4(
      baseOrderVersion,
      'inventory_authority_version',
    ),
    order_items_sha256: projection.order_items_sha256,
    authoritative_amount: projection.authoritative_amount,
    payment_mode: paymentMode,
    order_line_index: selector.order_line_index,
    prescription_line_index: prescriptionLineIndex,
    original_catalog_id: originalCatalogId,
    final_catalog_id: selector.final_catalog_id,
    inventory_item_id: selector.inventory_item_id,
    inventory_batch_id: selector.inventory_batch_id,
    quantity: selector.quantity,
    unit_price: finalUnitPrice.canonical,
    billable_subtotal: projection.billable_subtotal,
    cumulative_line_total: projection.cumulative_line_total,
    remaining_quantity: projection.remaining_quantity,
    batch_number: batches[0].batch_number || null,
    lot_number: batches[0].lot_number || null,
    expiry_date: normalizedDate(batches[0].expiry_date),
    batch_remaining_quantity: batchRemainingQuantity.canonical,
    schedule_class: inventoryItems[0].schedule_class || null,
    is_narcotic: inventoryItems[0].is_narcotic === true,
  };
  const prospective = {
    ...prospectiveTuple,
    prospective_fingerprint: sha256(prospectiveTuple),
  };
  const funding = await resolveAuthoritativeCounterFundingTx(tx, {
    tenantId: tid,
    patientId: base.patient_id,
    orderId: exactOrderId,
    paymentMode,
    totalAmount: base.authoritative_amount,
    orderVersion: baseOrderVersion,
    orderItemsSha256: baseOrderItemsSha256,
  });
  const invoiceRows = await tx.$queryRawUnsafe(
    `SELECT invoice.status AS invoice_status,invoice.patient_uid::text,
            invoice.admission_id,item.source_authority_version,
            item.source_authority_sha256,item.source_ref_active
       FROM billing_invoice_items item
       JOIN billing_invoices invoice
         ON invoice.tenant_id=item.tenant_id AND invoice.id=item.invoice_id
      WHERE item.tenant_id=$1::uuid AND item.id=$2::int AND item.invoice_id=$3::int
        AND item.source_ref_type='pharmacy_order' AND item.source_ref_id=$4::bigint
      LIMIT 2
      FOR UPDATE OF item,invoice`,
    tid,
    funding.invoiceItemId,
    funding.invoiceId,
    exactOrderId,
  );
  const invoiceAuthority = invoiceRows[0];
  if (invoiceRows.length !== 1
      || invoiceAuthority.invoice_status !== 'DRAFT'
      || invoiceAuthority.source_ref_active !== true
      || String(invoiceAuthority.patient_uid) !== patientUid
      || (invoiceAuthority.admission_id == null ? null : Number(invoiceAuthority.admission_id))
        !== base.admission_id
      || Number(invoiceAuthority.source_authority_version) !== baseOrderVersion
      || String(invoiceAuthority.source_authority_sha256) !== baseOrderItemsSha256) {
    throw AppError.conflict(
      'Substitution funding can only roll forward one exact active line on a draft invoice',
      'SUBSTITUTION_FUNDING_INVOICE_NOT_DRAFT',
      {
        invoice_id: Number(funding.invoiceId),
        invoice_item_id: Number(funding.invoiceItemId),
        next_action: 'complete_governed_credit_rebill_or_refund_before_substitution',
      },
    );
  }
  const capacity = await resolveLiveFundingCapacityTx(tx, {
    tenantId: tid,
    authority: {
      pharmacy_order_id: exactOrderId,
      patient_uid: patientUid,
      admission_id: base.admission_id,
      base_order_version: baseOrderVersion,
      base_order_items_sha256: baseOrderItemsSha256,
      prospective_order_version: prospective.order_version,
      prospective_order_items_sha256: prospective.order_items_sha256,
      prospective_authoritative_amount: prospective.authoritative_amount,
      tpa_mode: TPA_PAYMENT_MODES.has(paymentMode),
    },
    funding,
  });
  const proposal = {
    contract: SUBSTITUTION_FUNDING_APPROVAL_CONTRACT,
    selector,
    proposer: {
      uid: proposer.uid,
      role: proposer.role,
      facility_grant_id: String(facilityGrant.grant_id),
    },
    base,
    prospective,
    funding: capacity.evidence,
  };
  const approvalPolicy = substitutionFundingApprovalPolicy(
    capacity.evidence.funding_source,
  );
  return {
    ...proposal,
    proposal_sha256: sha256(proposal),
    funding_reservation_plan: capacity.reservationPlan,
    task_resource_type: approvalPolicy.taskResourceType,
    task_assigned_role: approvalPolicy.assignedRole,
    permitted_approver_roles: [...approvalPolicy.permittedRoles],
    invoice_id: funding.invoiceId,
    invoice_item_id: funding.invoiceItemId,
    tpa_claim_id: funding.fundingTpaClaimId,
  };
}

function proposalResponse({ approval, task, authority, expiresAt }) {
  return {
    contract: SUBSTITUTION_FUNDING_APPROVAL_CONTRACT,
    approval_id: Number(approval.id),
    approval_status: 'pending',
    task_id: Number(task.id),
    task_status: String(task.status),
    task_resource_type: authority.task_resource_type,
    proposal_sha256: authority.proposal_sha256,
    expires_at: expiresAt.toISOString(),
    proposer: authority.proposer,
    invoice_id: authority.invoice_id,
    invoice_item_id: authority.invoice_item_id,
    tpa_claim_id: authority.tpa_claim_id,
    base: authority.base,
    prospective: authority.prospective,
    funding: authority.funding,
  };
}

async function expireSubstitutionFundingProposalTx(tx, {
  tenantId,
  approvalId,
  taskId,
  proposalSha256,
}) {
  const expiredApprovals = await tx.$queryRawUnsafe(
    `UPDATE approvals
        SET status='expired',decided_at=COALESCE(decided_at,NOW()),updated_at=NOW()
      WHERE tenant_id=$1::uuid AND id=$2::int AND status='pending'
        AND expires_at IS NOT NULL AND expires_at<=NOW()
        AND subject_resource_id=$3
      RETURNING id,status`,
    tenantId,
    Number(approvalId),
    proposalSha256,
  );
  if (expiredApprovals.length !== 1) {
    throw AppError.conflict(
      'The expired funding approval changed before closure',
      'SUBSTITUTION_FUNDING_EXPIRY_STATE_CONFLICT',
    );
  }
  const cancelledTasks = await tx.$queryRawUnsafe(
    `UPDATE tasks
        SET status='cancelled',cancelled_at=COALESCE(cancelled_at,NOW()),
            cancellation_reason=COALESCE(cancellation_reason,$4),updated_at=NOW(),
            metadata=metadata || $5::jsonb
      WHERE tenant_id=$1::uuid AND id=$2::int
        AND status IN ('open','in_progress','blocked','overdue','cancelled')
        AND metadata->>'proposal_sha256'=$3
        AND metadata->>'contract'=$6 AND metadata->>'stage'=$7
      RETURNING id,status`,
    tenantId,
    Number(taskId),
    proposalSha256,
    'Substitution funding approval expired',
    JSON.stringify({
      domain_evidence: {
        kind: 'substitution_funding_approval_expired',
        approval_id: Number(approvalId),
        proposal_sha256: proposalSha256,
      },
    }),
    SUBSTITUTION_FUNDING_TASK_CONTRACT,
    SUBSTITUTION_FUNDING_TASK_STAGE,
  );
  if (cancelledTasks.length !== 1) {
    throw AppError.conflict(
      'The expired funding task changed before closure',
      'SUBSTITUTION_FUNDING_EXPIRY_STATE_CONFLICT',
    );
  }
}

async function closeExpiredSubstitutionFundingTasksTx(tx, {
  tenantId,
  orderId,
}) {
  const expired = await tx.$queryRawUnsafe(
    `SELECT approval.id AS approval_id,approval.subject_resource_id AS proposal_sha256,
            approval.metadata
       FROM approvals approval
      WHERE approval.tenant_id=$1::uuid
        AND approval.approval_kind=$3 AND approval.status='pending'
        AND approval.metadata->>'contract'=$4
        AND approval.metadata->>'stage'=$5
        AND approval.metadata->>'pharmacy_order_id'=$2
        AND approval.expires_at IS NOT NULL AND approval.expires_at<=NOW()
      ORDER BY approval.id
      FOR UPDATE OF approval`,
    tenantId,
    String(orderId),
    SUBSTITUTION_FUNDING_APPROVAL_KIND,
    SUBSTITUTION_FUNDING_APPROVAL_CONTRACT,
    SUBSTITUTION_FUNDING_TASK_STAGE,
  );
  for (const row of expired) {
    const taskId = positiveInt4(row.metadata?.task_id, 'expired funding task id');
    const taskRows = await tx.$queryRawUnsafe(
      `SELECT id
         FROM tasks
        WHERE tenant_id=$1::uuid AND id=$2::int
          AND related_resource_type IN
            ('pharmacy_tpa_line_decision','pharmacy_posted_payment')
          AND related_resource_id=$3
          AND metadata->>'contract'=$4 AND metadata->>'stage'=$5
          AND metadata->>'proposal_sha256'=$6
        LIMIT 2
        FOR UPDATE`,
      tenantId,
      taskId,
      String(orderId),
      SUBSTITUTION_FUNDING_TASK_CONTRACT,
      SUBSTITUTION_FUNDING_TASK_STAGE,
      row.proposal_sha256,
    );
    if (taskRows.length !== 1) {
      throw AppError.conflict(
        'The expired funding task binding is missing or ambiguous',
        'SUBSTITUTION_FUNDING_EXPIRY_STATE_CONFLICT',
      );
    }
    await expireSubstitutionFundingProposalTx(tx, {
      tenantId,
      approvalId: Number(row.approval_id),
      taskId,
      proposalSha256: row.proposal_sha256,
    });
  }
}

function assertProposalReplay(row, { requestSha256, proposerUid }) {
  const metadata = jsonObject(row?.metadata);
  if (!row
      || row.approval_kind !== SUBSTITUTION_FUNDING_APPROVAL_KIND
      || metadata.contract !== SUBSTITUTION_FUNDING_APPROVAL_CONTRACT
      || metadata.request_sha256 !== requestSha256
      || String(metadata.proposer_uid || '').toLowerCase() !== proposerUid
      || String(row.created_by || '').toLowerCase() !== proposerUid
      || !metadata.response_snapshot) {
    throw AppError.unprocessable(
      'The idempotency key is already bound to a different substitution funding proposal',
      'SUBSTITUTION_FUNDING_PROPOSAL_MISMATCH',
    );
  }
  return metadata.response_snapshot;
}

async function lockSubstitutionFundingApprovalTaskTx(tx, {
  tenantId,
  approvalId,
}) {
  const approvals = await tx.$queryRawUnsafe(
    `SELECT id,approval_kind,subject_resource_type,subject_resource_id,status,
            approved_by,expires_at,created_by,decided_by,decided_at,
            workflow_run_id,workflow_step_id,task_id,materialization_key,metadata,
            (expires_at IS NOT NULL AND expires_at<=NOW()) AS is_expired
       FROM approvals
      WHERE tenant_id=$1::uuid AND id=$2::int
      LIMIT 2
      FOR UPDATE`,
    tenantId,
    approvalId,
  );
  if (approvals.length !== 1) {
    throw AppError.notFound('Substitution funding approval not found');
  }
  const approval = approvals[0];
  const metadata = jsonObject(approval.metadata);
  const taskId = positiveInt4(metadata.task_id, 'substitution funding task id');
  const tasks = await tx.$queryRawUnsafe(
    `SELECT id,status,workflow_run_id,related_resource_type,related_resource_id,
            assigned_to_role,assigned_to_uid,created_by,metadata
       FROM tasks
      WHERE tenant_id=$1::uuid AND id=$2::int
      LIMIT 2
      FOR UPDATE`,
    tenantId,
    taskId,
  );
  if (tasks.length !== 1) {
    throw AppError.conflict(
      'The proposal task is missing',
      'SUBSTITUTION_FUNDING_APPROVAL_CONTRACT_INVALID',
    );
  }
  const task = tasks[0];
  assertApprovalAndTaskContract({ approval, task, approvalId });
  return Object.freeze({ approval, task, metadata });
}

export async function createSubstitutionFundingProposal({
  tenantId,
  orderId,
  selector,
  proposerUid,
  proposerRole = null,
  idempotencyKey,
}) {
  const tid = requireTenantId(tenantId);
  const uid = requireUuid(proposerUid, 'proposer_uid');
  const normalizedSelector = normalizeSubstitutionFundingSelector(selector);
  const materializationKey = substitutionFundingMaterializationKey({
    tenantId: tid,
    proposerUid: uid,
    idempotencyKey,
  });
  const requestSha256 = proposalRequestSha256({
    orderId,
    selector: normalizedSelector,
    proposerUid: uid,
  });
  const result = await setTenantTx(tid, async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text,753))::text AS lock_acquired`,
      `vh:substitution-funding:materialization:${tid}:${materializationKey}`,
    );
    const existing = await tx.$queryRawUnsafe(
      `SELECT id,approval_kind,subject_resource_id,status,created_by,metadata,
              (expires_at IS NOT NULL AND expires_at<=NOW()) AS is_expired
         FROM approvals
        WHERE tenant_id=$1::uuid AND materialization_key=$2
        LIMIT 2`,
      tid,
      materializationKey,
    );
    if (existing.length) {
      if (existing.length !== 1) {
        throw AppError.conflict(
          'Substitution funding proposal materialization is ambiguous',
          'SUBSTITUTION_FUNDING_PROPOSAL_AMBIGUOUS',
        );
      }
      const replaySnapshot = assertProposalReplay(existing[0], {
        requestSha256,
        proposerUid: uid,
      });
      if (existing[0].status !== 'pending' && !existing[0].is_expired) {
        return replaySnapshot;
      }
      const replayFundingLock = await lockSubstitutionFundingPatientAuthorityTx(tx, {
        tenantId: tid,
        orderId,
      });
      const locked = await lockSubstitutionFundingApprovalTaskTx(tx, {
        tenantId: tid,
        approvalId: positiveInt4(existing[0].id, 'approval_id'),
      });
      const lockedSnapshot = assertProposalReplay(locked.approval, {
        requestSha256,
        proposerUid: uid,
      });
      if (locked.approval.is_expired) {
        if (locked.approval.status === 'pending') {
          await expireSubstitutionFundingProposalTx(tx, {
            tenantId: tid,
            approvalId: Number(locked.approval.id),
            taskId: Number(locked.task.id),
            proposalSha256: locked.metadata.proposal_sha256,
          });
        }
        return EXPIRED_APPROVAL_RESULT;
      }
      if (locked.approval.status !== 'pending') return lockedSnapshot;
      const replayAuthority = await resolveSubstitutionFundingAuthorityTx(tx, {
        tenantId: tid,
        orderId,
        selector: normalizedSelector,
        proposerUid: uid,
        proposerRole,
        fundingLock: replayFundingLock,
      });
      if (replayAuthority.proposal_sha256 !== locked.metadata.proposal_sha256
          || stableJson(replayAuthority.base) !== stableJson(locked.metadata.authority?.base)
          || stableJson(replayAuthority.prospective)
            !== stableJson(locked.metadata.authority?.prospective)
          || stableJson(replayAuthority.funding)
            !== stableJson(locked.metadata.authority?.funding)) {
        throw AppError.conflict(
          'The pending substitution funding proposal drifted before replay',
          'SUBSTITUTION_FUNDING_AUTHORITY_DRIFT',
        );
      }
      return lockedSnapshot;
    }
    const fundingLock = await lockSubstitutionFundingPatientAuthorityTx(tx, {
      tenantId: tid,
      orderId,
    });
    await closeExpiredSubstitutionFundingTasksTx(tx, {
      tenantId: tid,
      orderId: fundingLock.orderId,
    });
    const activeTasks = await tx.$queryRawUnsafe(
      `SELECT id,status,metadata
         FROM tasks
        WHERE tenant_id=$1::uuid
          AND related_resource_type IN
            ('pharmacy_tpa_line_decision','pharmacy_posted_payment')
          AND related_resource_id=$2
          AND status IN ('open','in_progress','blocked','overdue')
        ORDER BY id
        LIMIT 2
        FOR UPDATE`,
      tid,
      String(fundingLock.orderId),
    );
    if (activeTasks.length) {
      throw AppError.conflict(
        'An active exact pharmacy funding task already owns this order',
        'SUBSTITUTION_FUNDING_TASK_CONFLICT',
        { task_id: Number(activeTasks[0].id) },
      );
    }
    const authority = await resolveSubstitutionFundingAuthorityTx(tx, {
      tenantId: tid,
      orderId,
      selector: normalizedSelector,
      proposerUid: uid,
      proposerRole,
      fundingLock,
    });
    const taskMetadata = {
      contract: SUBSTITUTION_FUNDING_TASK_CONTRACT,
      stage: SUBSTITUTION_FUNDING_TASK_STAGE,
      proposal_sha256: authority.proposal_sha256,
      proposer_uid: uid,
      facility_id: authority.base.facility_id,
      patient_uid: authority.base.patient_uid,
      pharmacy_order_id: authority.base.pharmacy_order_id,
      invoice_id: authority.invoice_id,
      invoice_item_id: authority.invoice_item_id,
      tpa_claim_id: authority.tpa_claim_id,
      base_order_version: authority.base.order_version,
      base_order_items_sha256: authority.base.order_items_sha256,
      prospective_order_version: authority.prospective.order_version,
      prospective_order_items_sha256: authority.prospective.order_items_sha256,
      prospective_authoritative_amount: authority.prospective.authoritative_amount,
      permitted_roles: authority.permitted_approver_roles,
    };
    const tasks = await tx.$queryRawUnsafe(
      `INSERT INTO tasks
        (tenant_id,task_kind,title,description,patient_uid,related_resource_type,
         related_resource_id,priority,status,assigned_to_role,created_by,metadata,
         sla_completion_semantics)
       VALUES ($1::uuid,'review',$2,$3,$4::uuid,$5,$6,'high','open',$7,$8::uuid,
               $9::jsonb,'none')
       RETURNING id,status,related_resource_type,related_resource_id,metadata`,
      tid,
      `Approve substitution funding for pharmacy order ${authority.base.pharmacy_order_id}`,
      'Review the locked prospective order amount and exact live TPA or posted-payment headroom. This task does not move stock or mutate billing.',
      authority.base.patient_uid,
      authority.task_resource_type,
      String(authority.base.pharmacy_order_id),
      authority.task_assigned_role,
      uid,
      JSON.stringify(taskMetadata),
    );
    const task = tasks[0];
    const ttlMinutes = positiveInt4(
      SECURITY_CONFIG.controlledDispenseWitness.approvalTtlMinutes,
      'substitution funding approval TTL minutes',
    );
    const approvalMetadata = {
      contract: SUBSTITUTION_FUNDING_APPROVAL_CONTRACT,
      stage: SUBSTITUTION_FUNDING_TASK_STAGE,
      proposal_sha256: authority.proposal_sha256,
      request_sha256: requestSha256,
      proposer_uid: uid,
      task_id: Number(task.id),
      task_resource_type: authority.task_resource_type,
      pharmacy_order_id: authority.base.pharmacy_order_id,
      invoice_id: authority.invoice_id,
      invoice_item_id: authority.invoice_item_id,
      tpa_claim_id: authority.tpa_claim_id,
      selector: normalizedSelector,
      authority: {
        base: authority.base,
        prospective: authority.prospective,
        funding: authority.funding,
      },
      permitted_approver_roles: authority.permitted_approver_roles,
    };
    const approvals = await tx.$queryRawUnsafe(
      `INSERT INTO approvals
        (tenant_id,approval_kind,subject_resource_type,subject_resource_id,
         required_approvers,required_role,status,expires_at,created_by,
         materialization_key,metadata)
       VALUES ($1::uuid,$2,'pharmacy_substitution_funding_proposal',$3,
               1,$4,'pending',NOW()+($5::int*INTERVAL '1 minute'),$6::uuid,$7,$8::jsonb)
       RETURNING id,status,created_by,expires_at,metadata`,
      tid,
      SUBSTITUTION_FUNDING_APPROVAL_KIND,
      authority.proposal_sha256,
      authority.task_assigned_role,
      ttlMinutes,
      uid,
      materializationKey,
      JSON.stringify(approvalMetadata),
    );
    const approval = approvals[0];
    const expiresAt = approval.expires_at instanceof Date
      ? approval.expires_at
      : new Date(approval.expires_at);
    if (Number.isNaN(expiresAt.getTime())) {
      throw AppError.internal(
        'The substitution funding approval expiry could not be materialized',
        'SUBSTITUTION_FUNDING_EXPIRY_INVALID',
      );
    }
    const response = proposalResponse({ approval, task, authority, expiresAt });
    const updatedApprovals = await tx.$queryRawUnsafe(
      `UPDATE approvals
          SET metadata=metadata || $3::jsonb,updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::int AND status='pending'
        RETURNING id`,
      tid,
      Number(approval.id),
      JSON.stringify({ response_snapshot: response }),
    );
    const updatedTasks = await tx.$queryRawUnsafe(
      `UPDATE tasks
          SET metadata=metadata || $3::jsonb,updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::int AND status='open'
        RETURNING id`,
      tid,
      Number(task.id),
      JSON.stringify({ approval_id: Number(approval.id) }),
    );
    if (updatedApprovals.length !== 1 || updatedTasks.length !== 1) {
      throw AppError.conflict(
        'The reciprocal funding proposal links could not be persisted',
        'SUBSTITUTION_FUNDING_LINK_CONFLICT',
      );
    }
    return response;
  });
  if (result === EXPIRED_APPROVAL_RESULT) {
    throw AppError.conflict(
      'The substitution funding proposal has expired',
      'SUBSTITUTION_FUNDING_APPROVAL_EXPIRED',
    );
  }
  return result;
}

function assertApprovalAndTaskContract({ approval, task, approvalId }) {
  const metadata = jsonObject(approval?.metadata);
  const taskMetadata = jsonObject(task?.metadata);
  const expectedTaskId = Number(metadata.task_id);
  const valid = approval
    && task
    && approval.approval_kind === SUBSTITUTION_FUNDING_APPROVAL_KIND
    && approval.subject_resource_type === 'pharmacy_substitution_funding_proposal'
    && approval.subject_resource_id === metadata.proposal_sha256
    && metadata.contract === SUBSTITUTION_FUNDING_APPROVAL_CONTRACT
    && metadata.stage === SUBSTITUTION_FUNDING_TASK_STAGE
    && approval.workflow_run_id == null
    && approval.workflow_step_id == null
    && approval.task_id == null
    && Number(task.id) === expectedTaskId
    && task.workflow_run_id == null
    && task.related_resource_type === metadata.task_resource_type
    && task.related_resource_id === String(metadata.pharmacy_order_id)
    && taskMetadata.contract === SUBSTITUTION_FUNDING_TASK_CONTRACT
    && taskMetadata.stage === SUBSTITUTION_FUNDING_TASK_STAGE
    && taskMetadata.proposal_sha256 === metadata.proposal_sha256
    && Number(taskMetadata.approval_id) === Number(approvalId);
  if (!valid) {
    throw AppError.conflict(
      'The substitution funding approval and task contract is inconsistent',
      'SUBSTITUTION_FUNDING_APPROVAL_CONTRACT_INVALID',
    );
  }
  return { metadata, taskMetadata };
}

function approvalRequestSha256({ approvalId, proposalSha256, approverUid }) {
  return sha256({
    contract: SUBSTITUTION_FUNDING_APPROVAL_CONTRACT,
    decision: 'approve',
    approval_id: Number(approvalId),
    proposal_sha256: proposalSha256,
    approver_uid: approverUid,
  });
}

function assertCommandReceiptContract(receipt, {
  commandKeySha256,
  requestSha256,
  approval,
  task,
  metadata,
  approverUid,
}) {
  const valid = receipt
    && receipt.command_key_sha256 === commandKeySha256
    && receipt.command_type === 'SUBSTITUTION_FUNDING_APPROVAL'
    && Number(receipt.task_id) === Number(task.id)
    && receipt.task_resource_type === task.related_resource_type
    && receipt.task_resource_id === task.related_resource_id
    && Number(receipt.pharmacy_order_id) === Number(metadata.pharmacy_order_id)
    && Number(receipt.invoice_item_id) === Number(metadata.invoice_item_id)
    && (receipt.tpa_claim_id == null ? null : Number(receipt.tpa_claim_id))
      === (metadata.tpa_claim_id == null ? null : Number(metadata.tpa_claim_id))
    && receipt.request_sha256 === requestSha256
    && String(receipt.created_by || '').toLowerCase() === approverUid
    && Number(approval.id) > 0;
  if (!valid) {
    throw AppError.unprocessable(
      'The immutable funding command is bound to a different approval or actor',
      'SUBSTITUTION_FUNDING_APPROVAL_COMMAND_MISMATCH',
    );
  }
}

function completeReceiptResponse(receipt) {
  const response = jsonObject(receipt?.response_body);
  if (receipt?.status !== 'COMPLETE') {
    throw AppError.conflict(
      'The substitution funding approval receipt is incomplete',
      'SUBSTITUTION_FUNDING_APPROVAL_RECEIPT_INVALID',
    );
  }
  return approvedSubstitutionFundingReceiptContract(response);
}

export async function approveSubstitutionFundingProposal({
  tenantId,
  orderId,
  approvalId,
  approverUid,
  approverRole = null,
}) {
  const tid = requireTenantId(tenantId);
  const exactOrderId = positiveInt4(orderId, 'pharmacy_order_id');
  const exactApprovalId = positiveInt4(approvalId, 'approval_id');
  const approverUidNormalized = requireUuid(approverUid, 'approver_uid');
  const commandKeySha256 = substitutionFundingApprovalCommandKey({
    tenantId: tid,
    approvalId: exactApprovalId,
  });
  const result = await setTenantTx(tid, async (tx) => {
    const preflightRows = await tx.$queryRawUnsafe(
      `SELECT id,approval_kind,subject_resource_type,subject_resource_id,status,
              created_by,metadata,
              (expires_at IS NOT NULL AND expires_at<=NOW()) AS is_expired
         FROM approvals
        WHERE tenant_id=$1::uuid AND id=$2::int
        LIMIT 2`,
      tid,
      exactApprovalId,
    );
    if (preflightRows.length !== 1) {
      throw AppError.notFound('Substitution funding approval not found');
    }
    const preflight = preflightRows[0];
    const preflightMetadata = jsonObject(preflight.metadata);
    if (preflight.approval_kind !== SUBSTITUTION_FUNDING_APPROVAL_KIND
        || preflight.subject_resource_type !== 'pharmacy_substitution_funding_proposal'
        || preflight.subject_resource_id !== preflightMetadata.proposal_sha256
        || preflightMetadata.contract !== SUBSTITUTION_FUNDING_APPROVAL_CONTRACT
        || preflightMetadata.stage !== SUBSTITUTION_FUNDING_TASK_STAGE
        || Number(preflightMetadata.pharmacy_order_id) !== exactOrderId) {
      throw AppError.conflict(
        'The approval belongs to a different pharmacy order',
        'SUBSTITUTION_FUNDING_APPROVAL_ORDER_MISMATCH',
      );
    }
    const permittedRoles = new Set(
      Array.isArray(preflightMetadata.permitted_approver_roles)
        ? preflightMetadata.permitted_approver_roles
          .map((role) => String(role).toUpperCase())
        : [],
    );
    const expectedPolicy = substitutionFundingApprovalPolicy(
      preflightMetadata.authority?.funding?.funding_source,
    );
    const expectedRoles = new Set(expectedPolicy.permittedRoles);
    if (permittedRoles.size !== expectedRoles.size
        || [...expectedRoles].some((role) => !permittedRoles.has(role))
        || preflightMetadata.task_resource_type !== expectedPolicy.taskResourceType) {
      throw AppError.conflict(
        'The proposal carries an unregistered approver policy',
        'SUBSTITUTION_FUNDING_APPROVER_POLICY_INVALID',
      );
    }
    const fundingLock = await lockSubstitutionFundingPatientAuthorityTx(tx, {
      tenantId: tid,
      orderId: exactOrderId,
    });
    await tx.$queryRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text,753))::text AS lock_acquired`,
      `vh:substitution-funding:approval:${tid}:${exactApprovalId}`,
    );
    const approver = await assertActiveActorTx(tx, {
      tenantId: tid,
      actorUid: approverUidNormalized,
      actorRole: approverRole,
      permittedRoles: expectedRoles,
      code: 'SUBSTITUTION_FUNDING_APPROVER_FORBIDDEN',
    });
    if (approver.uid === String(preflightMetadata.proposer_uid || '').toLowerCase()) {
      throw AppError.forbidden(
        'The proposer cannot approve their own substitution funding request',
        'SUBSTITUTION_FUNDING_SELF_APPROVAL_FORBIDDEN',
      );
    }
    const locked = await lockSubstitutionFundingApprovalTaskTx(tx, {
      tenantId: tid,
      approvalId: exactApprovalId,
    });
    const { approval, task, metadata } = locked;
    if (Number(metadata.pharmacy_order_id) !== exactOrderId) {
      throw AppError.conflict(
        'The approval belongs to a different pharmacy order',
        'SUBSTITUTION_FUNDING_APPROVAL_ORDER_MISMATCH',
      );
    }
    const lockedPolicy = substitutionFundingApprovalPolicy(
      metadata.authority?.funding?.funding_source,
    );
    const lockedPermittedRoles = new Set(
      Array.isArray(metadata.permitted_approver_roles)
        ? metadata.permitted_approver_roles.map((role) => String(role).toUpperCase())
        : [],
    );
    if (lockedPolicy.taskResourceType !== task.related_resource_type
        || lockedPolicy.assignedRole !== task.assigned_to_role
        || lockedPermittedRoles.size !== lockedPolicy.permittedRoles.length
        || lockedPolicy.permittedRoles.some((role) => !lockedPermittedRoles.has(role))
        || !lockedPermittedRoles.has(approver.role)) {
      throw AppError.conflict(
        'The locked proposal carries an inconsistent approver policy',
        'SUBSTITUTION_FUNDING_APPROVER_POLICY_INVALID',
      );
    }
    const requestSha256 = approvalRequestSha256({
      approvalId: exactApprovalId,
      proposalSha256: metadata.proposal_sha256,
      approverUid: approver.uid,
    });
    const receipts = await tx.$queryRawUnsafe(
      `SELECT id::text AS id,command_key_sha256,command_type,task_id,
              task_resource_type,task_resource_id,pharmacy_order_id,
              invoice_item_id,tpa_claim_id,request_sha256,status,response_body,
              created_by,created_at,completed_at
         FROM pharmacy_funding_commands
        WHERE tenant_id=$1::uuid AND command_key_sha256=$2
        LIMIT 2
        FOR UPDATE`,
      tid,
      commandKeySha256,
    );
    if (receipts.length > 1) {
      throw AppError.conflict(
        'The substitution funding command receipt is ambiguous',
        'SUBSTITUTION_FUNDING_APPROVAL_RECEIPT_INVALID',
      );
    }
    let command = receipts[0] || null;
    if (command) {
      assertCommandReceiptContract(command, {
        commandKeySha256,
        requestSha256,
        approval,
        task,
        metadata,
        approverUid: approver.uid,
      });
      if (approval.status !== 'approved'
          || String(approval.decided_by || '').toLowerCase() !== approver.uid
          || task.status !== 'completed') {
        throw AppError.conflict(
          'The approval receipt disagrees with the task or approval state',
          'SUBSTITUTION_FUNDING_APPROVAL_RECEIPT_INVALID',
        );
      }
    }
    if (approval.is_expired) {
      if (approval.status === 'pending'
          && (ACTIVE_TASK_STATUSES.has(task.status) || task.status === 'cancelled')
          && !command) {
        await expireSubstitutionFundingProposalTx(tx, {
          tenantId: tid,
          approvalId: exactApprovalId,
          taskId: Number(task.id),
          proposalSha256: metadata.proposal_sha256,
        });
        return EXPIRED_APPROVAL_RESULT;
      }
      throw AppError.conflict(
        'The substitution funding proposal has expired',
        'SUBSTITUTION_FUNDING_APPROVAL_EXPIRED',
      );
    }
    if (!command && (approval.status !== 'pending' || !ACTIVE_TASK_STATUSES.has(task.status))) {
      throw AppError.conflict(
        'The substitution funding proposal is no longer pending',
        'SUBSTITUTION_FUNDING_APPROVAL_NOT_PENDING',
      );
    }
    if (!command) {
      const claimed = await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_funding_commands
          (tenant_id,command_key_sha256,command_type,task_id,task_resource_type,
           task_resource_id,pharmacy_order_id,invoice_item_id,tpa_claim_id,
           request_sha256,status,created_by)
         VALUES ($1::uuid,$2,'SUBSTITUTION_FUNDING_APPROVAL',$3::int,$4,$5,$6::int,
                 $7::int,$8::int,$9,'IN_PROGRESS',$10::uuid)
         RETURNING id::text AS id,command_key_sha256,command_type,task_id,
                   task_resource_type,task_resource_id,pharmacy_order_id,
                   invoice_item_id,tpa_claim_id,request_sha256,status,response_body,
                   created_by,created_at,completed_at`,
        tid,
        commandKeySha256,
        Number(task.id),
        task.related_resource_type,
        task.related_resource_id,
        exactOrderId,
        Number(metadata.invoice_item_id),
        metadata.tpa_claim_id == null ? null : Number(metadata.tpa_claim_id),
        requestSha256,
        approver.uid,
      );
      command = claimed[0] || null;
      if (!command) {
        throw AppError.conflict(
          'The immutable funding approval receipt could not be claimed',
          'SUBSTITUTION_FUNDING_APPROVAL_STATE_CONFLICT',
        );
      }
      assertCommandReceiptContract(command, {
        commandKeySha256,
        requestSha256,
        approval,
        task,
        metadata,
        approverUid: approver.uid,
      });
    }
    const authority = await resolveSubstitutionFundingAuthorityTx(tx, {
      tenantId: tid,
      orderId: exactOrderId,
      selector: metadata.selector,
      proposerUid: metadata.proposer_uid,
      fundingLock,
    });
    if (authority.proposal_sha256 !== metadata.proposal_sha256
        || authority.proposal_sha256 !== approval.subject_resource_id
        || stableJson(authority.base) !== stableJson(metadata.authority?.base)
        || stableJson(authority.prospective) !== stableJson(metadata.authority?.prospective)
        || stableJson(authority.funding) !== stableJson(metadata.authority?.funding)
        || authority.task_resource_type !== task.related_resource_type
        || authority.task_assigned_role !== task.assigned_to_role
        || Number(authority.invoice_item_id) !== Number(metadata.invoice_item_id)
        || (authority.tpa_claim_id == null ? null : Number(authority.tpa_claim_id))
          !== (metadata.tpa_claim_id == null ? null : Number(metadata.tpa_claim_id))) {
      throw AppError.conflict(
        'Order, prescription, catalog, batch, facility, patient, or funding authority drifted',
        'SUBSTITUTION_FUNDING_AUTHORITY_DRIFT',
      );
    }
    if (receipts.length === 1) return completeReceiptResponse(command);
    const approvedRows = await tx.$queryRawUnsafe(
      `UPDATE approvals
          SET status='approved',
              approved_by=jsonb_build_array(jsonb_build_object(
                'uid',$3::text,'role',$4::text,'at',NOW()
              )),
              decided_by=$3::uuid,decided_at=NOW(),
              metadata=metadata || $5::jsonb,updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::int AND status='pending'
        RETURNING id,status,decided_by,decided_at,approved_by`,
      tid,
      exactApprovalId,
      approver.uid,
      approver.role,
      JSON.stringify({
        approved_receipt_id: String(command.id),
        approval_command_key_sha256: commandKeySha256,
        approver_uid: approver.uid,
        approver_role: approver.role,
      }),
    );
    const completedTasks = await tx.$queryRawUnsafe(
      `UPDATE tasks
          SET status='completed',completed_at=NOW(),updated_at=NOW(),
              metadata=metadata || $4::jsonb
        WHERE tenant_id=$1::uuid AND id=$2::int
          AND status IN ('open','in_progress','blocked','overdue')
          AND metadata->>'proposal_sha256'=$3
        RETURNING id,status,completed_at`,
      tid,
      Number(task.id),
      metadata.proposal_sha256,
      JSON.stringify({
        domain_evidence: {
          kind: 'substitution_funding_approved',
          approval_id: exactApprovalId,
          receipt_id: String(command.id),
          proposal_sha256: metadata.proposal_sha256,
        },
      }),
    );
    if (approvedRows.length !== 1 || completedTasks.length !== 1) {
      throw AppError.conflict(
        'The funding approval or task changed before decision completion',
        'SUBSTITUTION_FUNDING_APPROVAL_STATE_CONFLICT',
      );
    }
    const approvedAt = approvedRows[0].decided_at instanceof Date
      ? approvedRows[0].decided_at.toISOString()
      : String(approvedRows[0].decided_at);
    const response = {
      contract: SUBSTITUTION_FUNDING_APPROVAL_CONTRACT,
      approval_id: exactApprovalId,
      approval_status: 'approved',
      task_id: Number(task.id),
      task_status: 'completed',
      receipt_id: String(command.id),
      proposal_sha256: metadata.proposal_sha256,
      expires_at: approval.expires_at instanceof Date
        ? approval.expires_at.toISOString()
        : String(approval.expires_at),
      proposer: authority.proposer,
      approver_uid: approver.uid,
      approver_role: approver.role,
      approved_at: approvedAt,
      task_resource_type: task.related_resource_type,
      invoice_id: authority.invoice_id,
      invoice_item_id: authority.invoice_item_id,
      tpa_claim_id: authority.tpa_claim_id,
      base: authority.base,
      prospective: authority.prospective,
      funding: authority.funding,
    };
    const validatedResponse = approvedSubstitutionFundingReceiptContract(response);
    const completedReceipts = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_funding_commands
          SET status='COMPLETE',response_body=$3::jsonb,completed_at=NOW()
        WHERE tenant_id=$1::uuid AND command_key_sha256=$2
          AND status='IN_PROGRESS'
        RETURNING id::text AS id,status,response_body`,
      tid,
      commandKeySha256,
      JSON.stringify(validatedResponse),
    );
    if (completedReceipts.length !== 1) {
      throw AppError.conflict(
        'The immutable funding approval receipt could not be completed',
        'SUBSTITUTION_FUNDING_APPROVAL_STATE_CONFLICT',
      );
    }
    return validatedResponse;
  });
  if (result === EXPIRED_APPROVAL_RESULT) {
    throw AppError.conflict(
      'The substitution funding proposal has expired',
      'SUBSTITUTION_FUNDING_APPROVAL_EXPIRED',
    );
  }
  return result;
}

function assertExpectedProposal(expectedProposal, { authority, metadata }) {
  if (!expectedProposal || typeof expectedProposal !== 'object'
      || Array.isArray(expectedProposal)
      || !expectedProposal.selector) {
    throw AppError.badRequest(
      'The exact substitution selector is required to consume funding approval',
      'SUBSTITUTION_FUNDING_EXPECTED_PROPOSAL_REQUIRED',
    );
  }
  const expectedSelector = normalizeSubstitutionFundingSelector(expectedProposal.selector);
  const optionalBindings = [
    ['proposal_sha256', authority.proposal_sha256],
    ['base_order_version', authority.base.order_version],
    ['base_order_items_sha256', authority.base.order_items_sha256],
    ['prospective_order_version', authority.prospective.order_version],
    ['prospective_order_items_sha256', authority.prospective.order_items_sha256],
    ['prospective_authoritative_amount', authority.prospective.authoritative_amount],
    ['prospective_fingerprint', authority.prospective.prospective_fingerprint],
  ];
  const optionalMismatch = optionalBindings.some(([key, actual]) => (
    Object.hasOwn(expectedProposal, key)
    && String(expectedProposal[key]) !== String(actual)
  ));
  if (stableJson(expectedSelector) !== stableJson(metadata.selector) || optionalMismatch) {
    throw AppError.conflict(
      'The approved funding proposal does not match the exact substitution being dispensed',
      'SUBSTITUTION_FUNDING_CONSUMPTION_MISMATCH',
    );
  }
}

async function reserveSubstitutionFundingPatientCapacityTx(tx, {
  tenantId,
  approvalId,
  receiptId,
  authority,
  approverUid,
}) {
  const plan = authority.funding_reservation_plan;
  if (!plan || typeof plan !== 'object'
      || typeof plan.patientAmountRequiredScaled !== 'bigint'
      || typeof plan.tpaUsedScaled !== 'bigint'
      || typeof plan.baseAllocatedScaled !== 'bigint'
      || typeof plan.prospectiveAllocatedScaled !== 'bigint'
      || !Array.isArray(plan.payments)) {
    throw AppError.internal(
      'Live substitution funding reservation plan is unavailable',
      'SUBSTITUTION_FUNDING_RESERVATION_PLAN_INVALID',
    );
  }
  if (plan.prospectiveAllocatedScaled !== 0n) {
    throw AppError.conflict(
      'The prospective funding tuple already has movement evidence; replay the durable dispense command',
      'SUBSTITUTION_FUNDING_CONSUMPTION_ALREADY_RECORDED',
    );
  }
  const exactReceiptId = String(receiptId || '');
  if (!/^\d+$/.test(exactReceiptId)) {
    throw AppError.internal(
      'The immutable approval receipt identity is invalid',
      'SUBSTITUTION_FUNDING_APPROVAL_RECEIPT_INVALID',
    );
  }
  const reversalReason = 'Approved substitution funding transfer to prospective authority';
  const reversals = [];
  for (const payment of plan.payments) {
    for (const allocation of payment.baseAllocations) {
      const reversalAmount = checkedMoney12(
        allocation.netScaled,
        'base allocation transfer amount',
      );
      const reversalCommandSha256 = sha256({
        contract: SUBSTITUTION_FUNDING_APPROVAL_CONTRACT,
        command: 'reverse_base_patient_payment_allocation',
        tenant_id: tenantId,
        approval_id: approvalId,
        receipt_id: exactReceiptId,
        proposal_sha256: authority.proposal_sha256,
        allocation_id: allocation.allocationId,
        reversed_amount: reversalAmount.canonical,
        base_order_version: authority.base.order_version,
        base_order_items_sha256: authority.base.order_items_sha256,
        prospective_order_version: authority.prospective.order_version,
        prospective_order_items_sha256: authority.prospective.order_items_sha256,
      });
      const reversalEvidenceBody = {
        contract: 'pharmacy_substitution_funding_allocation_reversal_v1',
        approval_id: approvalId,
        receipt_id: exactReceiptId,
        proposal_sha256: authority.proposal_sha256,
        source_evidence_sha256: authority.funding.source_evidence_sha256,
        allocation_id: allocation.allocationId,
        billing_payment_id: allocation.billingPaymentId,
        reversed_amount: reversalAmount.canonical,
        base_order_version: authority.base.order_version,
        base_order_items_sha256: authority.base.order_items_sha256,
        prospective_order_version: authority.prospective.order_version,
        prospective_order_items_sha256: authority.prospective.order_items_sha256,
        approver_uid: approverUid,
      };
      const reversalEvidence = {
        ...reversalEvidenceBody,
        evidence_sha256: sha256(reversalEvidenceBody),
      };
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_payment_allocation_reversals
          (tenant_id,allocation_id,pharmacy_order_id,invoice_id,invoice_item_id,
           billing_payment_id,source_authority_version,source_authority_sha256,
           reversed_amount,reversal_command_sha256,reason,reversed_by,evidence)
         VALUES ($1::uuid,$2::bigint,$3::int,$4::int,$5::int,$6::int,$7::int,$8,
                 $9::numeric,$10,$11,$12::uuid,$13::jsonb)
         ON CONFLICT (tenant_id,reversal_command_sha256) DO NOTHING
         RETURNING id::text AS reversal_id,allocation_id::text,pharmacy_order_id,
                   invoice_id,invoice_item_id,billing_payment_id,source_authority_version,
                   source_authority_sha256,reversed_amount,reversal_command_sha256,
                   reason,reversed_by::text,reversed_at,evidence`,
        tenantId,
        allocation.allocationId,
        allocation.pharmacyOrderId,
        allocation.invoiceId,
        allocation.invoiceItemId,
        allocation.billingPaymentId,
        allocation.sourceAuthorityVersion,
        allocation.sourceAuthoritySha256,
        reversalAmount.canonical,
        reversalCommandSha256,
        reversalReason,
        approverUid,
        JSON.stringify(reversalEvidence),
      );
      if (rows.length !== 1
          || String(rows[0].allocation_id) !== allocation.allocationId
          || authorityMoney12(
            rows[0].reversed_amount,
            'persisted base allocation transfer amount',
            { positive: true },
          ).scaled !== allocation.netScaled
          || String(rows[0].reversal_command_sha256) !== reversalCommandSha256
          || String(rows[0].reversed_by).toLowerCase() !== approverUid
          || stableJson(jsonObject(rows[0].evidence)) !== stableJson(reversalEvidence)) {
        throw AppError.conflict(
          'The base funding allocation transfer receipt is missing or mismatched',
          'SUBSTITUTION_FUNDING_ALLOCATION_CONFLICT',
        );
      }
      reversals.push(Object.freeze({
        reversal_id: String(rows[0].reversal_id),
        allocation_id: allocation.allocationId,
        billing_payment_id: allocation.billingPaymentId,
        reversed_amount: reversalAmount.canonical,
        reversal_command_sha256: reversalCommandSha256,
        reversed_by: approverUid,
        reversed_at: rows[0].reversed_at instanceof Date
          ? rows[0].reversed_at.toISOString()
          : String(rows[0].reversed_at),
        evidence_sha256: reversalEvidence.evidence_sha256,
      }));
    }
  }

  let remainingScaled = plan.patientAmountRequiredScaled;
  const allocations = [];
  for (const payment of plan.payments) {
    if (remainingScaled === 0n) break;
    const amountScaled = payment.rawCapacityScaled > remainingScaled
      ? remainingScaled
      : payment.rawCapacityScaled;
    if (amountScaled === 0n) continue;
    const allocationAmount = checkedMoney12(
      amountScaled,
      'substitution funding allocation amount',
    );
    const allocationCommandSha256 = sha256({
      contract: SUBSTITUTION_FUNDING_APPROVAL_CONTRACT,
      command: 'reserve_patient_payment_capacity',
      tenant_id: tenantId,
      approval_id: approvalId,
      receipt_id: String(receiptId),
      proposal_sha256: authority.proposal_sha256,
      billing_payment_id: payment.paymentId,
      allocated_amount: allocationAmount.canonical,
      prospective_order_version: authority.prospective.order_version,
      prospective_order_items_sha256: authority.prospective.order_items_sha256,
    });
    const allocationEvidenceBody = {
      contract: 'pharmacy_substitution_funding_allocation_v1',
      approval_id: approvalId,
      receipt_id: exactReceiptId,
      proposal_sha256: authority.proposal_sha256,
      source_evidence_sha256: authority.funding.source_evidence_sha256,
      billing_payment_id: payment.paymentId,
      payment_mode: payment.mode,
      allocated_amount: allocationAmount.canonical,
      base_order_version: authority.base.order_version,
      base_order_items_sha256: authority.base.order_items_sha256,
      prospective_order_version: authority.prospective.order_version,
      prospective_order_items_sha256: authority.prospective.order_items_sha256,
      refund_ids: authority.funding.source_evidence.refund_ids,
      tpa_claim_id: authority.tpa_claim_id,
      tpa_decision_id: authority.funding.tpa_decision_id,
      tpa_used_amount: authority.funding.tpa_used_amount,
      patient_payment_required_amount: authority.funding.patient_payment_required_amount,
      proposer_uid: authority.proposer.uid,
      approver_uid: approverUid,
    };
    const allocationEvidence = {
      ...allocationEvidenceBody,
      evidence_sha256: sha256(allocationEvidenceBody),
    };
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO pharmacy_payment_allocations
        (tenant_id,pharmacy_order_id,invoice_id,invoice_item_id,
         billing_payment_id,source_authority_version,source_authority_sha256,
         allocated_amount,allocation_command_sha256,allocated_by,evidence)
       VALUES ($1::uuid,$2::int,$3::int,$4::int,$5::int,$6::int,$7,
               $8::numeric,$9,$10::uuid,$11::jsonb)
       RETURNING id::text AS allocation_id,billing_payment_id,allocated_amount,
                 source_authority_version,source_authority_sha256,
                 allocation_command_sha256,allocated_by::text,allocated_at,evidence`,
      tenantId,
      authority.base.pharmacy_order_id,
      authority.invoice_id,
      authority.invoice_item_id,
      payment.paymentId,
      authority.prospective.order_version,
      authority.prospective.order_items_sha256,
      allocationAmount.canonical,
      allocationCommandSha256,
      approverUid,
      JSON.stringify(allocationEvidence),
    );
    if (rows.length !== 1
        || String(rows[0].allocation_command_sha256) !== allocationCommandSha256
        || String(rows[0].source_authority_sha256)
          !== authority.prospective.order_items_sha256
        || Number(rows[0].source_authority_version) !== authority.prospective.order_version
        || authorityMoney12(
          rows[0].allocated_amount,
          'persisted substitution funding allocation amount',
          { positive: true },
        ).scaled !== amountScaled
        || String(rows[0].allocated_by).toLowerCase() !== approverUid
        || stableJson(jsonObject(rows[0].evidence)) !== stableJson(allocationEvidence)) {
      throw AppError.conflict(
        'The patient-payment reservation receipt does not match the approved tuple',
        'SUBSTITUTION_FUNDING_ALLOCATION_CONFLICT',
      );
    }
    allocations.push(Object.freeze({
      allocation_id: String(rows[0].allocation_id),
      billing_payment_id: Number(rows[0].billing_payment_id),
      allocated_amount: allocationAmount.canonical,
      allocation_command_sha256: allocationCommandSha256,
      source_authority_version: authority.prospective.order_version,
      source_authority_sha256: authority.prospective.order_items_sha256,
      allocated_by: approverUid,
      allocated_at: rows[0].allocated_at instanceof Date
        ? rows[0].allocated_at.toISOString()
        : String(rows[0].allocated_at),
      evidence_sha256: allocationEvidence.evidence_sha256,
    }));
    remainingScaled -= amountScaled;
  }
  if (remainingScaled !== 0n) {
    throw AppError.conflict(
      'The approved patient-payment headroom could not be atomically reserved',
      'SUBSTITUTION_FUNDING_CAPACITY_INSUFFICIENT',
    );
  }
  let tpaRollForward = null;
  if (plan.tpaDecisionId != null) {
    const tpaUsed = checkedMoney12(plan.tpaUsedScaled, 'TPA amount used by substitution');
    const patientRequired = checkedMoney12(
      plan.patientAmountRequiredScaled,
      'patient amount required by substitution',
    );
    const decisionRows = await tx.$queryRawUnsafe(
      `UPDATE tpa_claim_line_decisions
          SET approved_amount=$7::numeric,non_payable_amount=$8::numeric,
              recorded_by=$9::uuid,recorded_at=NOW(),
              source_authority_version=$10::int,source_authority_sha256=$11,
              invalidated_at=NULL,invalidated_by=NULL
        WHERE tenant_id=$1::uuid AND id=$2::int AND claim_id=$3::int
          AND invoice_item_id=$4::int AND invalidated_at IS NULL
          AND source_authority_version=$5::int AND source_authority_sha256=$6
          AND approved_amount=$12::numeric
        RETURNING id,claim_id,invoice_item_id,approved_amount,non_payable_amount,
                  reason_code,reason_text,recorded_by::text,recorded_at,
                  source_authority_version,source_authority_sha256`,
      tenantId,
      plan.tpaDecisionId,
      plan.tpaClaimId,
      authority.invoice_item_id,
      authority.base.order_version,
      authority.base.order_items_sha256,
      tpaUsed.canonical,
      patientRequired.canonical,
      approverUid,
      authority.prospective.order_version,
      authority.prospective.order_items_sha256,
      canonicalScaledDecimal(plan.lockedApprovedTpaAmountScaled, NUMERIC_12_2),
    );
    if (decisionRows.length !== 1
        || authorityMoney12(
          decisionRows[0].approved_amount,
          'rolled-forward TPA approved amount',
        ).scaled !== plan.tpaUsedScaled
        || authorityMoney12(
          decisionRows[0].non_payable_amount,
          'rolled-forward TPA non-payable amount',
        ).scaled !== plan.patientAmountRequiredScaled
        || Number(decisionRows[0].source_authority_version)
          !== authority.prospective.order_version
        || String(decisionRows[0].source_authority_sha256)
          !== authority.prospective.order_items_sha256
        || String(decisionRows[0].recorded_by).toLowerCase() !== approverUid) {
      throw AppError.conflict(
        'The TPA line decision could not be rolled forward to the approved tuple',
        'SUBSTITUTION_FUNDING_TPA_AUTHORITY_STALE',
      );
    }
    tpaRollForward = Object.freeze({
      tpa_claim_id: Number(decisionRows[0].claim_id),
      tpa_decision_id: Number(decisionRows[0].id),
      invoice_item_id: Number(decisionRows[0].invoice_item_id),
      approved_amount: tpaUsed.canonical,
      non_payable_amount: patientRequired.canonical,
      source_authority_version: authority.prospective.order_version,
      source_authority_sha256: authority.prospective.order_items_sha256,
      recorded_by: approverUid,
      recorded_at: decisionRows[0].recorded_at instanceof Date
        ? decisionRows[0].recorded_at.toISOString()
        : String(decisionRows[0].recorded_at),
    });
  }

  const transferredRows = await tx.$queryRawUnsafe(
    `SELECT allocation.id::text AS allocation_id,allocation.billing_payment_id,
            allocation.source_authority_version,allocation.source_authority_sha256,
            allocation.allocated_amount,allocation.allocation_command_sha256,
            allocation.allocated_by::text,allocation.evidence,
            payment.mode
       FROM pharmacy_payment_allocations allocation
       JOIN billing_payments payment
         ON payment.tenant_id=allocation.tenant_id
        AND payment.id=allocation.billing_payment_id
        AND payment.invoice_id=allocation.invoice_id
        AND payment.patient_uid=$7::uuid AND payment.reversed=FALSE
      WHERE allocation.tenant_id=$1::uuid AND allocation.pharmacy_order_id=$2::int
        AND allocation.invoice_id=$3::int AND allocation.invoice_item_id=$4::int
        AND ((allocation.source_authority_version=$5::int
          AND allocation.source_authority_sha256=$6)
          OR (allocation.source_authority_version=$8::int
          AND allocation.source_authority_sha256=$9))
      ORDER BY allocation.id
      FOR UPDATE OF allocation,payment`,
    tenantId,
    authority.base.pharmacy_order_id,
    authority.invoice_id,
    authority.invoice_item_id,
    authority.base.order_version,
    authority.base.order_items_sha256,
    authority.base.patient_uid,
    authority.prospective.order_version,
    authority.prospective.order_items_sha256,
  );
  const transferredIds = transferredRows.map((row) => String(row.allocation_id));
  const transferredReversals = transferredIds.length
    ? await tx.$queryRawUnsafe(
      `SELECT allocation_id::text,reversed_amount
         FROM pharmacy_payment_allocation_reversals
        WHERE tenant_id=$1::uuid AND allocation_id=ANY($2::bigint[])
        ORDER BY allocation_id,id
        FOR UPDATE`,
      tenantId,
      transferredIds,
    )
    : [];
  const transferredReversedByAllocation = new Map();
  for (const reversal of transferredReversals) {
    const allocationId = String(reversal.allocation_id);
    const current = transferredReversedByAllocation.get(allocationId) || 0n;
    transferredReversedByAllocation.set(
      allocationId,
      current + authorityMoney12(
        reversal.reversed_amount,
        'transferred allocation reversal amount',
        { positive: true },
      ).scaled,
    );
  }
  let liveBaseScaled = 0n;
  let liveProspectiveScaled = 0n;
  for (const row of transferredRows) {
    const allocated = authorityMoney12(
      row.allocated_amount,
      'transferred patient-payment allocation amount',
      { positive: true },
    );
    const reversed = transferredReversedByAllocation.get(String(row.allocation_id)) || 0n;
    if (reversed > allocated.scaled) {
      throw AppError.conflict(
        'Transferred payment reversal evidence exceeds its allocation',
        'SUBSTITUTION_FUNDING_ALLOCATION_CONFLICT',
      );
    }
    const net = allocated.scaled - reversed;
    const baseAuthority = Number(row.source_authority_version) === authority.base.order_version
      && String(row.source_authority_sha256) === authority.base.order_items_sha256;
    const prospectiveAuthority = Number(row.source_authority_version)
      === authority.prospective.order_version
      && String(row.source_authority_sha256) === authority.prospective.order_items_sha256;
    if (baseAuthority) liveBaseScaled += net;
    if (prospectiveAuthority) {
      if (!PATIENT_PAYMENT_RAILS.has(String(row.mode || '').trim().toUpperCase())) {
        throw AppError.conflict(
          'The prospective tuple was allocated to a non-patient payment rail',
          'SUBSTITUTION_FUNDING_ALLOCATION_CONFLICT',
        );
      }
      const rowEvidence = jsonObject(row.evidence);
      if (rowEvidence.contract !== 'pharmacy_substitution_funding_allocation_v1'
          || Number(rowEvidence.approval_id) !== approvalId
          || String(rowEvidence.receipt_id) !== exactReceiptId
          || rowEvidence.proposal_sha256 !== authority.proposal_sha256
          || rowEvidence.source_evidence_sha256
            !== authority.funding.source_evidence_sha256
          || String(row.allocated_by).toLowerCase() !== approverUid) {
        throw AppError.conflict(
          'The prospective payment allocation is not bound to the approved receipt',
          'SUBSTITUTION_FUNDING_ALLOCATION_CONFLICT',
        );
      }
      liveProspectiveScaled += net;
    }
  }
  if (liveBaseScaled !== 0n || liveProspectiveScaled !== plan.patientAmountRequiredScaled) {
    throw AppError.conflict(
      'The patient-payment transfer did not produce the exact prospective funding balance',
      'SUBSTITUTION_FUNDING_ALLOCATION_CONFLICT',
    );
  }
  return Object.freeze({
    replayed: false,
    required_amount: canonicalScaledDecimal(plan.patientAmountRequiredScaled, NUMERIC_12_2),
    tpa_used_amount: canonicalScaledDecimal(plan.tpaUsedScaled, NUMERIC_12_2),
    reversal_ids: Object.freeze(reversals.map((reversal) => reversal.reversal_id)),
    reversals: Object.freeze(reversals),
    allocation_ids: Object.freeze(allocations.map((allocation) => allocation.allocation_id)),
    allocations: Object.freeze(allocations),
    tpa_roll_forward: tpaRollForward,
    source_evidence_sha256: authority.funding.source_evidence_sha256,
  });
}

// The caller must resolve durable final-command replay before invoking this for a non-replay.
// Invoke in the same transaction before controlled-witness, invoice-line, order, or stock
// mutation. Funding transfer rows then commit or roll back with the exact prospective tuple.
export async function consumeApprovedSubstitutionFundingReauthorisationTx(tx, {
  tenantId,
  orderId,
  approvalId,
  proposerUid,
  expectedProposal,
}) {
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal(
      'Substitution funding consumption requires the caller transaction',
      'SUBSTITUTION_FUNDING_TRANSACTION_REQUIRED',
    );
  }
  const tid = requireTenantId(tenantId);
  const exactOrderId = positiveInt4(orderId, 'pharmacy_order_id');
  const exactApprovalId = positiveInt4(approvalId, 'approval_id');
  const exactProposerUid = requireUuid(proposerUid, 'proposer_uid');
  const preflightRows = await tx.$queryRawUnsafe(
    `SELECT id,approval_kind,subject_resource_type,subject_resource_id,status,
            created_by,metadata
       FROM approvals
      WHERE tenant_id=$1::uuid AND id=$2::int
      LIMIT 2`,
    tid,
    exactApprovalId,
  );
  if (preflightRows.length !== 1) {
    throw AppError.notFound('Substitution funding approval not found');
  }
  const preflight = preflightRows[0];
  const preflightMetadata = jsonObject(preflight.metadata);
  if (preflight.approval_kind !== SUBSTITUTION_FUNDING_APPROVAL_KIND
      || preflight.subject_resource_type !== 'pharmacy_substitution_funding_proposal'
      || preflight.subject_resource_id !== preflightMetadata.proposal_sha256
      || preflightMetadata.contract !== SUBSTITUTION_FUNDING_APPROVAL_CONTRACT
      || preflightMetadata.stage !== SUBSTITUTION_FUNDING_TASK_STAGE
      || Number(preflightMetadata.pharmacy_order_id) !== exactOrderId
      || String(preflightMetadata.proposer_uid || '').toLowerCase() !== exactProposerUid
      || String(preflight.created_by || '').toLowerCase() !== exactProposerUid) {
    throw AppError.conflict(
      'The funding approval is not bound to the exact order and proposer',
      'SUBSTITUTION_FUNDING_APPROVAL_REQUIRED',
    );
  }
  const fundingLock = await lockSubstitutionFundingPatientAuthorityTx(tx, {
    tenantId: tid,
    orderId: exactOrderId,
  });
  await tx.$queryRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtextextended($1::text,753))::text AS lock_acquired`,
    `vh:substitution-funding:approval:${tid}:${exactApprovalId}`,
  );
  const locked = await lockSubstitutionFundingApprovalTaskTx(tx, {
    tenantId: tid,
    approvalId: exactApprovalId,
  });
  const { approval, task, metadata } = locked;
  if (approval.status !== 'approved'
      || approval.is_expired
      || task.status !== 'completed'
      || Number(metadata.pharmacy_order_id) !== exactOrderId
      || String(metadata.proposer_uid || '').toLowerCase() !== exactProposerUid) {
    throw AppError.conflict(
      'A current independently approved funding proposal is required',
      approval.is_expired
        ? 'SUBSTITUTION_FUNDING_APPROVAL_EXPIRED'
        : approval.status !== 'approved'
          ? 'SUBSTITUTION_FUNDING_APPROVAL_REQUIRED'
          : 'SUBSTITUTION_FUNDING_TASK_NOT_COMPLETE',
    );
  }
  const approverUid = requireUuid(approval.decided_by, 'approval decided_by');
  const requestSha256 = approvalRequestSha256({
    approvalId: exactApprovalId,
    proposalSha256: metadata.proposal_sha256,
    approverUid,
  });
  const commandKeySha256 = substitutionFundingApprovalCommandKey({
    tenantId: tid,
    approvalId: exactApprovalId,
  });
  const receipts = await tx.$queryRawUnsafe(
    `SELECT id::text AS id,command_key_sha256,command_type,task_id,
            task_resource_type,task_resource_id,pharmacy_order_id,
            invoice_item_id,tpa_claim_id,request_sha256,status,response_body,
            created_by,created_at,completed_at
       FROM pharmacy_funding_commands
      WHERE tenant_id=$1::uuid AND command_key_sha256=$2
      LIMIT 2
      FOR UPDATE`,
    tid,
    commandKeySha256,
  );
  if (receipts.length !== 1) {
    throw AppError.conflict(
      'The immutable approved funding receipt is missing or ambiguous',
      'SUBSTITUTION_FUNDING_APPROVAL_RECEIPT_INVALID',
    );
  }
  const receipt = receipts[0];
  assertCommandReceiptContract(receipt, {
    commandKeySha256,
    requestSha256,
    approval,
    task,
    metadata,
    approverUid,
  });
  const receiptResponse = completeReceiptResponse(receipt);
  const approvalPolicy = substitutionFundingApprovalPolicy(
    metadata.authority?.funding?.funding_source,
  );
  const approver = await assertActiveActorTx(tx, {
    tenantId: tid,
    actorUid: approverUid,
    actorRole: receiptResponse.approver_role,
    permittedRoles: new Set(approvalPolicy.permittedRoles),
    code: 'SUBSTITUTION_FUNDING_APPROVER_FORBIDDEN',
  });
  const permittedRoles = new Set(
    Array.isArray(metadata.permitted_approver_roles)
      ? metadata.permitted_approver_roles.map((role) => String(role).toUpperCase())
      : [],
  );
  if (task.related_resource_type !== approvalPolicy.taskResourceType
      || task.assigned_to_role !== approvalPolicy.assignedRole
      || permittedRoles.size !== approvalPolicy.permittedRoles.length
      || approvalPolicy.permittedRoles.some((role) => !permittedRoles.has(role))
      || approver.role !== String(receiptResponse.approver_role).toUpperCase()
      || approver.uid === exactProposerUid) {
    throw AppError.conflict(
      'The approved funding actor or task policy no longer matches the source',
      'SUBSTITUTION_FUNDING_APPROVER_POLICY_INVALID',
    );
  }
  const authority = await resolveSubstitutionFundingAuthorityTx(tx, {
    tenantId: tid,
    orderId: exactOrderId,
    selector: metadata.selector,
    proposerUid: exactProposerUid,
    fundingLock,
  });
  if (authority.proposal_sha256 !== metadata.proposal_sha256
      || authority.proposal_sha256 !== receiptResponse.proposal_sha256
      || stableJson(authority.base) !== stableJson(metadata.authority?.base)
      || stableJson(authority.base) !== stableJson(receiptResponse.base)
      || stableJson(authority.prospective) !== stableJson(metadata.authority?.prospective)
      || stableJson(authority.prospective) !== stableJson(receiptResponse.prospective)
      || stableJson(authority.funding) !== stableJson(metadata.authority?.funding)
      || stableJson(authority.funding) !== stableJson(receiptResponse.funding)
      || authority.task_resource_type !== task.related_resource_type
      || authority.task_assigned_role !== task.assigned_to_role
      || Number(receiptResponse.invoice_item_id) !== Number(metadata.invoice_item_id)
      || String(receiptResponse.expires_at) !== (
        approval.expires_at instanceof Date
          ? approval.expires_at.toISOString()
          : String(approval.expires_at)
      )) {
    throw AppError.conflict(
      'The approved base, prospective, or live funding tuple drifted before dispense',
      'SUBSTITUTION_FUNDING_AUTHORITY_DRIFT',
    );
  }
  assertExpectedProposal(expectedProposal, { authority, metadata });
  const fundingMovement = await reserveSubstitutionFundingPatientCapacityTx(tx, {
    tenantId: tid,
    approvalId: exactApprovalId,
    receiptId: String(receipt.id),
    authority,
    approverUid: approver.uid,
  });
  const canonicalFunding = Object.freeze({
    approval_id: exactApprovalId,
    receipt_id: String(receipt.id),
    proposal_sha256: authority.proposal_sha256,
    payment_mode: authority.base.payment_mode,
    funding_source: authority.funding.funding_source,
    funding_reference: authority.funding.funding_reference,
    prospective_authoritative_amount: authority.prospective.authoritative_amount,
    tpa_used_amount: authority.funding.tpa_used_amount,
    patient_payment_required_amount: authority.funding.patient_payment_required_amount,
    source_evidence_sha256: authority.funding.source_evidence_sha256,
    allocation_ids: fundingMovement.allocation_ids,
    reversal_ids: fundingMovement.reversal_ids,
    tpa_roll_forward: fundingMovement.tpa_roll_forward,
  });
  const snapshot = Object.freeze({
    contract: SUBSTITUTION_FUNDING_APPROVAL_CONTRACT,
    approval_id: exactApprovalId,
    receipt_id: String(receipt.id),
    proposal_sha256: authority.proposal_sha256,
    proposer_uid: exactProposerUid,
    approver_uid: approver.uid,
    approver_role: approver.role,
    expires_at: receiptResponse.expires_at,
    task_id: Number(task.id),
    task_resource_type: task.related_resource_type,
    invoice_id: authority.invoice_id,
    invoice_item_id: authority.invoice_item_id,
    tpa_claim_id: authority.tpa_claim_id,
    funding_source: authority.funding.funding_source,
    funding_reference: authority.funding.funding_reference,
    combined_authority_amount: authority.funding.combined_authority_amount,
    base: Object.freeze({ ...authority.base }),
    prospective: Object.freeze({ ...authority.prospective }),
    canonical_funding: canonicalFunding,
    funding_movement: fundingMovement,
  });
  const evidence = Object.freeze({});
  APPROVED_SUBSTITUTION_FUNDING_EVIDENCE.add(evidence);
  APPROVED_SUBSTITUTION_FUNDING_SNAPSHOTS.set(evidence, snapshot);
  return evidence;
}

export function substitutionFundingReauthorisationEvidenceSnapshot(evidence) {
  if (!evidence
      || !APPROVED_SUBSTITUTION_FUNDING_EVIDENCE.has(evidence)
      || !APPROVED_SUBSTITUTION_FUNDING_SNAPSHOTS.has(evidence)) {
    throw AppError.internal(
      'Substitution funding evidence must come from the governed consumer',
      'SUBSTITUTION_FUNDING_EVIDENCE_INVALID',
    );
  }
  return APPROVED_SUBSTITUTION_FUNDING_SNAPSHOTS.get(evidence);
}

export function approvedSubstitutionFundingReceiptContract(value = {}) {
  const receipt = jsonObject(value);
  const proposer = jsonObject(receipt.proposer);
  const base = jsonObject(receipt.base);
  const prospective = jsonObject(receipt.prospective);
  const funding = jsonObject(receipt.funding);
  const sourceEvidence = jsonObject(funding.source_evidence);
  const prospectiveTuple = { ...prospective };
  delete prospectiveTuple.prospective_fingerprint;
  const fundingEvidence = { ...funding };
  delete fundingEvidence.evidence_sha256;
  const invalid = () => AppError.conflict(
    'Approved substitution funding evidence is incomplete',
    'SUBSTITUTION_FUNDING_APPROVAL_RECEIPT_INVALID',
  );
  const exactInt4 = (candidate, { positive = true } = {}) => {
    const text = String(candidate ?? '').trim();
    if (!/^\d+$/.test(text)) return false;
    const parsed = BigInt(text);
    return parsed <= PG_INT4_MAX && (positive ? parsed > 0n : parsed >= 0n);
  };
  const exactBigserial = (candidate) => {
    const text = String(candidate ?? '').trim();
    return /^\d+$/.test(text) && BigInt(text) > 0n;
  };
  const sameIdentifierSequence = (left, right) => (
    Array.isArray(left)
    && left.length === right.length
    && left.every((entry, index) => String(entry) === String(right[index]))
  );
  const sameIdentifierSet = (left, right) => {
    if (!Array.isArray(left) || left.length !== right.length) return false;
    const leftSet = new Set(left.map(String));
    const rightSet = new Set(right.map(String));
    return leftSet.size === left.length
      && rightSet.size === right.length
      && [...leftSet].every((entry) => rightSet.has(entry));
  };
  const canonical = (candidate, parsed) => {
    if (String(candidate) !== parsed.canonical) throw invalid();
    return parsed;
  };
  const money12 = (candidate, label, options = {}) => canonical(
    candidate,
    authorityMoney12(candidate, label, options),
  );
  const money10 = (candidate, label, options = {}) => canonical(
    candidate,
    authorityMoney10(candidate, label, options),
  );
  const quantity14 = (candidate, label, options = {}) => canonical(
    candidate,
    authorityQuantity(candidate, label, options),
  );
  const expiry = new Date(String(receipt.expires_at || ''));
  const approved = new Date(String(receipt.approved_at || ''));
  const proposerUid = String(proposer.uid || '').toLowerCase();
  const approverUid = String(receipt.approver_uid || '').toLowerCase();
  try {
    const approvalPolicy = substitutionFundingApprovalPolicy(funding.funding_source);
    const approverRole = String(receipt.approver_role || '').toUpperCase();
    const baseAmount = money10(base.authoritative_amount, 'receipt base amount');
    const prospectiveAmount = money10(
      prospective.authoritative_amount,
      'receipt prospective amount',
      { positive: true },
    );
    const selectedQuantity = quantity14(
      prospective.quantity,
      'receipt substitution quantity',
      { positive: true },
    );
    const batchRemaining = quantity14(
      prospective.batch_remaining_quantity,
      'receipt batch remaining quantity',
    );
    quantity14(prospective.remaining_quantity, 'receipt order remaining quantity');
    const unitPrice = money12(
      prospective.unit_price,
      'receipt substitution unit price',
      { positive: true },
    );
    const billableSubtotal = money12(
      prospective.billable_subtotal,
      'receipt substitution subtotal',
    );
    money12(prospective.cumulative_line_total, 'receipt cumulative line total');
    const lockedTpa = money12(
      funding.locked_approved_tpa_amount,
      'receipt locked TPA amount',
    );
    const tpaUsed = money12(funding.tpa_used_amount, 'receipt TPA used amount');
    const patientRequired = money12(
      funding.patient_payment_required_amount,
      'receipt patient-payment amount',
    );
    const patientGross = money12(
      funding.posted_patient_payment_amount,
      'receipt posted patient-payment amount',
    );
    const refunds = money12(
      funding.active_refund_reservation_amount,
      'receipt refund reservation amount',
    );
    const patientNet = money12(
      funding.net_patient_payment_amount,
      'receipt net patient-payment amount',
    );
    const baseAllocated = money12(
      funding.base_allocated_payment_amount,
      'receipt base allocation amount',
    );
    const prospectiveAllocated = money12(
      funding.prospective_allocated_payment_amount,
      'receipt prospective allocation amount',
    );
    const otherAllocated = money12(
      funding.other_allocated_payment_amount,
      'receipt other allocation amount',
    );
    const availablePatient = money12(
      funding.available_patient_payment_amount,
      'receipt available patient-payment amount',
    );
    const combined = money12(
      funding.combined_authority_amount,
      'receipt combined authority amount',
    );
    const headroom = money12(funding.headroom_amount, 'receipt funding headroom');
    const reservationRequired = money12(
      funding.reservation_required_amount,
      'receipt reservation amount',
    );
    const patientPayments = Array.isArray(sourceEvidence.payments)
      ? sourceEvidence.payments
      : null;
    const excludedPayments = Array.isArray(sourceEvidence.excluded_payments)
      ? sourceEvidence.excluded_payments
      : null;
    const refundEvidence = Array.isArray(sourceEvidence.refunds)
      ? sourceEvidence.refunds
      : null;
    const allocationEvidence = Array.isArray(sourceEvidence.allocations)
      ? sourceEvidence.allocations
      : null;
    const tpaDecisions = Array.isArray(sourceEvidence.tpa_decisions)
      ? sourceEvidence.tpa_decisions
      : null;
    if (!patientPayments || !excludedPayments || !refundEvidence
        || !allocationEvidence || !tpaDecisions) throw invalid();

    let evidencedPatientGross = 0n;
    const patientPaymentIds = [];
    for (const paymentValue of patientPayments) {
      const payment = jsonObject(paymentValue);
      if (!exactInt4(payment.payment_id)
          || !PATIENT_PAYMENT_RAILS.has(String(payment.mode || '').toUpperCase())) {
        throw invalid();
      }
      const paymentAmount = money12(
        payment.amount,
        'receipt patient-payment source amount',
        { positive: true },
      );
      const paymentNetAllocated = money12(
        payment.net_allocated_amount,
        'receipt payment allocation amount',
      );
      const paymentBaseAllocated = money12(
        payment.base_allocated_amount,
        'receipt payment base allocation amount',
      );
      const paymentProspectiveAllocated = money12(
        payment.prospective_allocated_amount,
        'receipt payment prospective allocation amount',
      );
      const paymentOtherAllocated = money12(
        payment.other_allocated_amount,
        'receipt payment other allocation amount',
      );
      const paymentTransferCapacity = money12(
        payment.raw_transfer_capacity,
        'receipt payment transfer capacity',
      );
      if (paymentNetAllocated.scaled !== paymentBaseAllocated.scaled
          + paymentProspectiveAllocated.scaled
          + paymentOtherAllocated.scaled
          || paymentOtherAllocated.scaled > paymentAmount.scaled
          || paymentTransferCapacity.scaled
            !== paymentAmount.scaled - paymentOtherAllocated.scaled) throw invalid();
      evidencedPatientGross += paymentAmount.scaled;
      patientPaymentIds.push(String(payment.payment_id));
    }
    checkedMoney12(evidencedPatientGross, 'receipt patient-payment source total');

    const excludedPaymentIds = [];
    for (const paymentValue of excludedPayments) {
      const payment = jsonObject(paymentValue);
      if (!exactInt4(payment.payment_id)
          || PATIENT_PAYMENT_RAILS.has(String(payment.mode || '').toUpperCase())
          || !String(payment.exclusion_reason || '')) throw invalid();
      const excludedNet = money12(
        payment.net_allocated_amount,
        'receipt excluded allocation amount',
      );
      const excludedBase = money12(
        payment.base_allocated_amount,
        'receipt excluded base allocation amount',
      );
      const excludedProspective = money12(
        payment.prospective_allocated_amount,
        'receipt excluded prospective allocation amount',
      );
      const excludedOther = money12(
        payment.other_allocated_amount,
        'receipt excluded other allocation amount',
      );
      money12(payment.amount, 'receipt excluded payment amount', { positive: true });
      if (excludedBase.scaled !== 0n
          || excludedProspective.scaled !== 0n
          || excludedNet.scaled !== excludedOther.scaled) throw invalid();
      excludedPaymentIds.push(String(payment.payment_id));
    }

    let evidencedRefunds = 0n;
    const refundIds = [];
    for (const refundValue of refundEvidence) {
      const refund = jsonObject(refundValue);
      if (!exactInt4(refund.refund_id)
          || String(refund.approval_status || '').toUpperCase() === 'REJECTED') {
        throw invalid();
      }
      evidencedRefunds += money12(
        refund.amount,
        'receipt refund source amount',
        { positive: true },
      ).scaled;
      refundIds.push(String(refund.refund_id));
    }
    checkedMoney12(evidencedRefunds, 'receipt refund source total');

    const patientPaymentIdSet = new Set(patientPaymentIds);
    let evidencedBaseAllocated = 0n;
    let evidencedProspectiveAllocated = 0n;
    let evidencedOtherAllocated = 0n;
    const allocationIds = [];
    for (const allocationValue of allocationEvidence) {
      const allocation = jsonObject(allocationValue);
      if (!exactBigserial(allocation.allocation_id)
          || !exactInt4(allocation.billing_payment_id)
          || !exactInt4(allocation.pharmacy_order_id)
          || !exactInt4(allocation.invoice_id)
          || !exactInt4(allocation.invoice_item_id)
          || !exactInt4(allocation.source_authority_version)
          || !SHA256_PATTERN.test(String(allocation.source_authority_sha256 || ''))
          || !SHA256_PATTERN.test(String(allocation.allocation_command_sha256 || ''))
          || (allocation.base_authority === true
            && allocation.prospective_authority === true)) throw invalid();
      const allocated = money12(
        allocation.allocated_amount,
        'receipt immutable allocation amount',
        { positive: true },
      );
      const reversed = money12(
        allocation.reversed_amount,
        'receipt allocation reversal amount',
      );
      const net = money12(allocation.net_amount, 'receipt net allocation amount');
      if (reversed.scaled > allocated.scaled
          || net.scaled !== allocated.scaled - reversed.scaled) throw invalid();
      if (patientPaymentIdSet.has(String(allocation.billing_payment_id))) {
        if (allocation.base_authority === true) evidencedBaseAllocated += net.scaled;
        else if (allocation.prospective_authority === true) {
          evidencedProspectiveAllocated += net.scaled;
        } else evidencedOtherAllocated += net.scaled;
      } else if (net.scaled > 0n
          && (allocation.base_authority === true
            || allocation.prospective_authority === true)) throw invalid();
      allocationIds.push(String(allocation.allocation_id));
    }
    checkedMoney12(evidencedBaseAllocated, 'receipt evidenced base allocation total');
    checkedMoney12(
      evidencedProspectiveAllocated,
      'receipt evidenced prospective allocation total',
    );
    checkedMoney12(evidencedOtherAllocated, 'receipt evidenced other allocation total');

    const tpaDecisionIds = [];
    let exactTpaDecisionAmount = null;
    for (const decisionValue of tpaDecisions) {
      const decision = jsonObject(decisionValue);
      if (!exactInt4(decision.tpa_decision_id)
          || !exactInt4(decision.invoice_item_id)) throw invalid();
      const decisionAmount = money12(
        decision.approved_amount,
        'receipt TPA decision amount',
      );
      money12(decision.non_payable_amount, 'receipt TPA non-payable amount');
      if (String(decision.tpa_decision_id) === String(funding.tpa_decision_id)) {
        exactTpaDecisionAmount = decisionAmount.scaled;
      }
      tpaDecisionIds.push(String(decision.tpa_decision_id));
    }

    const sourcePaymentIds = [...patientPaymentIds, ...excludedPaymentIds];
    const receiptClaimId = receipt.tpa_claim_id == null
      ? null
      : String(receipt.tpa_claim_id);
    const fundingClaimId = funding.tpa_claim_id == null
      ? null
      : String(funding.tpa_claim_id);
    const fundingDecisionId = funding.tpa_decision_id == null
      ? null
      : String(funding.tpa_decision_id);
    const derivedSource = tpaUsed.scaled > 0n
      ? patientRequired.scaled > 0n ? 'mixed' : 'tpa_claim'
      : 'billing_payment';
    if (receipt.contract !== SUBSTITUTION_FUNDING_APPROVAL_CONTRACT
        || !exactInt4(receipt.approval_id)
        || !exactInt4(receipt.task_id)
        || !exactBigserial(receipt.receipt_id)
        || !SHA256_PATTERN.test(String(receipt.proposal_sha256 || ''))
        || receipt.approval_status !== 'approved'
        || receipt.task_status !== 'completed'
        || Number.isNaN(expiry.getTime())
        || Number.isNaN(approved.getTime())
        || approved.getTime() >= expiry.getTime()
        || !UUID_PATTERN.test(proposerUid)
        || !UUID_PATTERN.test(approverUid)
        || proposerUid === approverUid
        || !SUBSTITUTION_FUNDING_PROPOSER_ROLES.includes(
          String(proposer.role || '').toUpperCase(),
        )
        || !approvalPolicy.permittedRoles.includes(approverRole)
        || String(receipt.task_resource_type || '') !== approvalPolicy.taskResourceType
        || !exactInt4(base.pharmacy_order_id)
        || !exactInt4(base.patient_id)
        || !UUID_PATTERN.test(String(base.patient_uid || ''))
        || !exactInt4(base.facility_id)
        || !exactBigserial(base.facility_grant_id)
        || String(base.facility_grant_id) !== String(proposer.facility_grant_id || '')
        || !DISPENSABLE_ORDER_STATUSES.has(String(base.order_status || '').toUpperCase())
        || !exactInt4(base.order_version)
        || !SHA256_PATTERN.test(String(base.order_items_sha256 || ''))
        || !String(base.payment_mode || '')
        || (base.admission_id != null && !exactInt4(base.admission_id))
        || !exactInt4(base.prescription_id)
        || !exactInt4(base.prescription_revision)
        || !DISPENSABLE_PRESCRIPTION_STATUSES.has(
          String(base.prescription_status || '').toLowerCase(),
        )
        || !exactInt4(base.prescription_line_index, { positive: false })
        || !exactInt4(base.original_catalog_id)
        || !exactInt4(prospective.order_version)
        || BigInt(String(prospective.order_version))
          !== BigInt(String(base.order_version)) + 1n
        || !SHA256_PATTERN.test(String(prospective.order_items_sha256 || ''))
        || !SHA256_PATTERN.test(String(prospective.prospective_fingerprint || ''))
        || sha256(prospectiveTuple) !== prospective.prospective_fingerprint
        || String(prospective.payment_mode || '') !== String(base.payment_mode)
        || !exactInt4(prospective.order_line_index, { positive: false })
        || !exactInt4(prospective.prescription_line_index, { positive: false })
        || String(prospective.prescription_line_index)
          !== String(base.prescription_line_index)
        || !exactInt4(prospective.original_catalog_id)
        || String(prospective.original_catalog_id) !== String(base.original_catalog_id)
        || !exactInt4(prospective.final_catalog_id)
        || String(prospective.final_catalog_id) === String(prospective.original_catalog_id)
        || !exactInt4(prospective.inventory_item_id)
        || !exactInt4(prospective.inventory_batch_id)
        || selectedQuantity.scaled > batchRemaining.scaled
        || halfUpQuantityPrice(
          selectedQuantity,
          unitPrice,
          'receipt substitution subtotal',
        ).scaled !== billableSubtotal.scaled
        || !exactInt4(receipt.invoice_id)
        || !exactInt4(receipt.invoice_item_id)
        || String(funding.invoice_id) !== String(receipt.invoice_id)
        || String(funding.invoice_item_id) !== String(receipt.invoice_item_id)
        || !exactInt4(funding.funding_event_id)
        || funding.funding_source !== derivedSource
        || !String(funding.funding_reference || '')
        || !String(funding.materialized_funding_source || '')
        || !String(funding.materialized_funding_reference || '')
        || !SHA256_PATTERN.test(String(funding.evidence_sha256 || ''))
        || sha256(fundingEvidence) !== funding.evidence_sha256
        || !SHA256_PATTERN.test(String(funding.source_evidence_sha256 || ''))
        || sha256(sourceEvidence) !== funding.source_evidence_sha256
        || sourceEvidence.contract !== 'pharmacy_substitution_funding_sources_v1'
        || receiptClaimId !== fundingClaimId
        || (fundingClaimId == null) !== (fundingDecisionId == null)
        || (fundingDecisionId == null
          ? tpaDecisionIds.length !== 0 || lockedTpa.scaled !== 0n
          : !exactInt4(fundingClaimId)
            || !exactInt4(fundingDecisionId)
            || exactTpaDecisionAmount !== lockedTpa.scaled)
        || String(sourceEvidence.tpa_claim_id ?? '') !== String(funding.tpa_claim_id ?? '')
        || String(sourceEvidence.tpa_decision_id ?? '')
          !== String(funding.tpa_decision_id ?? '')
        || !sameIdentifierSequence(sourceEvidence.tpa_decision_ids, tpaDecisionIds)
        || !sameIdentifierSequence(sourceEvidence.patient_rail_payment_ids, patientPaymentIds)
        || !sameIdentifierSequence(sourceEvidence.excluded_payment_ids, excludedPaymentIds)
        || !sameIdentifierSequence(sourceEvidence.refund_ids, refundIds)
        || !sameIdentifierSequence(sourceEvidence.allocation_ids, allocationIds)
        || !sameIdentifierSet(sourceEvidence.payment_ids, sourcePaymentIds)
        || evidencedPatientGross !== patientGross.scaled
        || evidencedRefunds !== refunds.scaled
        || evidencedBaseAllocated !== baseAllocated.scaled
        || evidencedProspectiveAllocated !== prospectiveAllocated.scaled
        || prospectiveAllocated.scaled !== 0n
        || evidencedOtherAllocated !== otherAllocated.scaled
        || refunds.scaled > patientGross.scaled
        || patientNet.scaled !== patientGross.scaled - refunds.scaled
        || otherAllocated.scaled > patientNet.scaled
        || availablePatient.scaled !== patientNet.scaled - otherAllocated.scaled
        || tpaUsed.scaled > lockedTpa.scaled
        || tpaUsed.scaled > prospectiveAmount.scaled
        || patientRequired.scaled !== prospectiveAmount.scaled - tpaUsed.scaled
        || reservationRequired.scaled !== patientRequired.scaled
        || combined.scaled !== tpaUsed.scaled + availablePatient.scaled
        || combined.scaled < prospectiveAmount.scaled
        || headroom.scaled !== combined.scaled - prospectiveAmount.scaled
        || baseAmount.scaled > NUMERIC_10_2.maxScaled) throw invalid();
  } catch (error) {
    if (error?.code === 'SUBSTITUTION_FUNDING_APPROVAL_RECEIPT_INVALID') throw error;
    throw invalid();
  }
  return receipt;
}
