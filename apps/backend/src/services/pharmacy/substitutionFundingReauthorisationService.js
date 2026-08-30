import { createHash } from 'node:crypto';

import { SECURITY_CONFIG } from '../../config/securityConfig.js';
import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { lockTenantPatientMergeStability } from '../../utils/patientMergeStabilityLock.js';
import { resolveMergedPatientUidSet } from '../clinical/mergedPatientReadUnion.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  lockCounterFundingSubstitutionAuthorityTx,
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
const PATIENT_ADVANCE_RAILS = new Set([
  'CASH',
  'CARD',
  'UPI',
  'NETBANKING',
  'CHEQUE',
  'DD',
  'WALLET',
  'ONLINE',
  'BANK_TRANSFER',
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
  if (fundingSource === 'patient_advance') {
    return Object.freeze({
      taskResourceType: 'pharmacy_patient_advance',
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

async function databaseJsonbSha256(tx, value, label) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT encode(public.digest($1::jsonb::text,'sha256'),'hex') AS sha256`,
    JSON.stringify(value),
  );
  const digest = String(rows[0]?.sha256 || '');
  if (rows.length !== 1 || !SHA256_PATTERN.test(digest)) {
    throw AppError.internal(
      `${label} could not be reduced to the canonical PostgreSQL JSONB digest`,
      'SUBSTITUTION_FUNDING_EVIDENCE_DIGEST_INVALID',
    );
  }
  return digest;
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

function positiveBigintString(value, label) {
  const candidate = String(value ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(candidate)) {
    throw AppError.conflict(
      `${label} is outside the PostgreSQL positive bigint contract`,
      'SUBSTITUTION_FUNDING_AUTHORITY_DRIFT',
    );
  }
  try {
    if (BigInt(candidate) > 9_223_372_036_854_775_807n) throw new RangeError();
  } catch {
    throw AppError.conflict(
      `${label} is outside the PostgreSQL positive bigint contract`,
      'SUBSTITUTION_FUNDING_AUTHORITY_DRIFT',
    );
  }
  return candidate;
}

async function lockSubstitutionFundingApprovalReceiptAdvisoryTx(tx, {
  tenantId,
  approvalReceiptId,
}) {
  const tid = requireTenantId(tenantId);
  const receiptId = positiveBigintString(approvalReceiptId, 'approval_receipt_id');
  await tx.$queryRawUnsafe(
    `SELECT pg_advisory_xact_lock(
       hashtextextended('vh:pharmacy_advance_approval:' || $1::text || ':' || $2::text,0)
     )::text AS lock_acquired`,
    tid,
    receiptId,
  );
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

function substitutionFundingBillingAuthority({ row, base, prospective }) {
  const invoiceSubtotal = authorityMoney12(row.invoice_subtotal, 'invoice subtotal');
  const invoiceCgst = authorityMoney12(row.invoice_cgst_amount, 'invoice CGST amount');
  const invoiceSgst = authorityMoney12(row.invoice_sgst_amount, 'invoice SGST amount');
  const invoiceIgst = authorityMoney12(row.invoice_igst_amount, 'invoice IGST amount');
  const invoiceDiscount = authorityMoney12(
    row.invoice_discount_amount,
    'invoice discount amount',
  );
  const invoiceCredit = authorityMoney12(
    row.invoice_credit_note_amount,
    'invoice credit-note amount',
  );
  const invoiceTotal = authorityMoney12(row.invoice_total_amount, 'invoice total amount');
  const invoicePaid = authorityMoney12(row.invoice_amount_paid, 'invoice paid amount');
  const invoiceDue = authorityMoney12(row.invoice_amount_due, 'invoice due amount');
  const invoiceTax = checkedMoney12(
    invoiceCgst.scaled + invoiceSgst.scaled + invoiceIgst.scaled,
    'invoice tax amount',
  );
  const expectedInvoiceTotal = checkedMoney12(
    invoiceSubtotal.scaled + invoiceTax.scaled - invoiceDiscount.scaled,
    'invoice computed total',
  );
  const expectedInvoiceDue = checkedMoney12(
    expectedInvoiceTotal.scaled - invoiceCredit.scaled - invoicePaid.scaled > 0n
      ? expectedInvoiceTotal.scaled - invoiceCredit.scaled - invoicePaid.scaled
      : 0n,
    'invoice computed due',
  );

  const itemQuantity = authorityMoney10(row.item_quantity, 'invoice item quantity', {
    positive: true,
  });
  const itemUnitPrice = authorityMoney12(row.item_unit_price, 'invoice item unit price', {
    positive: true,
  });
  const itemGstRate = authorityMoney10(row.item_gst_rate, 'invoice item GST rate');
  const itemSubtotal = authorityMoney12(row.item_line_subtotal, 'invoice item subtotal', {
    positive: true,
  });
  const itemCgst = authorityMoney12(row.item_cgst_amount, 'invoice item CGST amount');
  const itemSgst = authorityMoney12(row.item_sgst_amount, 'invoice item SGST amount');
  const itemIgst = authorityMoney12(row.item_igst_amount, 'invoice item IGST amount');
  const itemTotal = authorityMoney12(row.item_line_total, 'invoice item total', {
    positive: true,
  });
  const itemTax = checkedMoney12(
    itemCgst.scaled + itemSgst.scaled + itemIgst.scaled,
    'invoice item tax amount',
  );
  const baseOrderAmount = authorityMoney10(
    base.authoritative_amount,
    'base order authoritative amount',
  );
  if (expectedInvoiceTotal.scaled !== invoiceTotal.scaled
      || expectedInvoiceDue.scaled !== invoiceDue.scaled
      || itemQuantity.canonical !== '1.00'
      || itemUnitPrice.scaled !== baseOrderAmount.scaled
      || itemGstRate.scaled !== 0n
      || itemSubtotal.scaled !== baseOrderAmount.scaled
      || itemTax.scaled !== 0n
      || itemTotal.scaled !== baseOrderAmount.scaled
      || Number(row.item_source_authority_version) !== base.order_version
      || String(row.item_source_authority_sha256) !== base.order_items_sha256
      || row.item_source_ref_active !== true
      || String(row.item_source_ref_type) !== 'pharmacy_order'
      || String(row.item_source_ref_id) !== String(base.pharmacy_order_id)) {
    throw AppError.conflict(
      'The exact draft invoice and pharmacy line no longer match base authority',
      'SUBSTITUTION_FUNDING_INVOICE_AUTHORITY_DRIFT',
    );
  }

  const targetItemAmount = authorityMoney10(
    prospective.authoritative_amount,
    'prospective order authoritative amount',
    { positive: true },
  );
  const prospectiveSubtotal = checkedMoney12(
    invoiceSubtotal.scaled - itemSubtotal.scaled + targetItemAmount.scaled,
    'prospective invoice subtotal',
  );
  const prospectiveCgst = checkedMoney12(
    invoiceCgst.scaled - itemCgst.scaled,
    'prospective invoice CGST amount',
  );
  const prospectiveSgst = checkedMoney12(
    invoiceSgst.scaled - itemSgst.scaled,
    'prospective invoice SGST amount',
  );
  const prospectiveIgst = checkedMoney12(
    invoiceIgst.scaled - itemIgst.scaled,
    'prospective invoice IGST amount',
  );
  const prospectiveTax = checkedMoney12(
    prospectiveCgst.scaled + prospectiveSgst.scaled + prospectiveIgst.scaled,
    'prospective invoice tax amount',
  );
  const prospectiveTotal = checkedMoney12(
    prospectiveSubtotal.scaled + prospectiveTax.scaled - invoiceDiscount.scaled,
    'prospective invoice total',
  );
  const prospectiveDue = checkedMoney12(
    prospectiveTotal.scaled - invoiceCredit.scaled - invoicePaid.scaled > 0n
      ? prospectiveTotal.scaled - invoiceCredit.scaled - invoicePaid.scaled
      : 0n,
    'prospective invoice due',
  );
  const invoiceIdentity = {
    status: String(row.invoice_status),
    invoice_number: row.invoice_number == null ? null : String(row.invoice_number),
    issued_at: row.invoice_issued_at == null
      ? null
      : row.invoice_issued_at instanceof Date
        ? row.invoice_issued_at.toISOString()
        : String(row.invoice_issued_at),
    voided_at: row.invoice_voided_at == null
      ? null
      : row.invoice_voided_at instanceof Date
        ? row.invoice_voided_at.toISOString()
        : String(row.invoice_voided_at),
  };
  return Object.freeze({
    contract: 'pharmacy_substitution_funding_billing_v1',
    invoice_id: Number(row.invoice_id),
    invoice_item_id: Number(row.invoice_item_id),
    base: Object.freeze({
      invoice: Object.freeze({
        ...invoiceIdentity,
        subtotal: invoiceSubtotal.canonical,
        cgst_amount: invoiceCgst.canonical,
        sgst_amount: invoiceSgst.canonical,
        igst_amount: invoiceIgst.canonical,
        tax_amount: invoiceTax.canonical,
        discount_amount: invoiceDiscount.canonical,
        credit_note_amount: invoiceCredit.canonical,
        total_amount: invoiceTotal.canonical,
        amount_paid: invoicePaid.canonical,
        amount_due: invoiceDue.canonical,
      }),
      item: Object.freeze({
        quantity: itemQuantity.canonical,
        unit_price: itemUnitPrice.canonical,
        gst_rate: itemGstRate.canonical,
        line_subtotal: itemSubtotal.canonical,
        cgst_amount: itemCgst.canonical,
        sgst_amount: itemSgst.canonical,
        igst_amount: itemIgst.canonical,
        tax_amount: itemTax.canonical,
        line_total: itemTotal.canonical,
        source_ref_type: String(row.item_source_ref_type),
        source_ref_id: String(row.item_source_ref_id),
        source_ref_active: true,
        source_authority_version: base.order_version,
        source_authority_sha256: base.order_items_sha256,
      }),
    }),
    prospective: Object.freeze({
      invoice: Object.freeze({
        ...invoiceIdentity,
        subtotal: prospectiveSubtotal.canonical,
        cgst_amount: prospectiveCgst.canonical,
        sgst_amount: prospectiveSgst.canonical,
        igst_amount: prospectiveIgst.canonical,
        tax_amount: prospectiveTax.canonical,
        discount_amount: invoiceDiscount.canonical,
        credit_note_amount: invoiceCredit.canonical,
        total_amount: prospectiveTotal.canonical,
        amount_paid: invoicePaid.canonical,
        amount_due: prospectiveDue.canonical,
      }),
      item: Object.freeze({
        quantity: '1.00',
        unit_price: targetItemAmount.canonical,
        gst_rate: '0.00',
        line_subtotal: targetItemAmount.canonical,
        cgst_amount: '0.00',
        sgst_amount: '0.00',
        igst_amount: '0.00',
        tax_amount: '0.00',
        line_total: targetItemAmount.canonical,
        source_ref_type: String(row.item_source_ref_type),
        source_ref_id: String(row.item_source_ref_id),
        source_ref_active: true,
        source_authority_version: prospective.order_version,
        source_authority_sha256: prospective.order_items_sha256,
      }),
    }),
  });
}

async function resolveSubstitutionFundingPatientFamilyTx(tx, {
  tenantId,
  patientUid,
}) {
  const canonicalPatientUid = requireUuid(patientUid, 'patient_uid');
  const resolved = await resolveMergedPatientUidSet(tx, {
    tenantId,
    patientUid: canonicalPatientUid,
    maxDepth: 32,
  });
  const patientUids = [
    canonicalPatientUid,
    ...[...new Set(resolved.map((uid) => requireUuid(uid, 'merged patient uid')))]
      .filter((uid) => uid !== canonicalPatientUid)
      .sort(),
  ];
  const rows = await tx.$queryRawUnsafe(
    `SELECT uid::text AS uid,merged_into_uid::text AS merged_into_uid,role
       FROM users
      WHERE tenant_id=$1::uuid AND uid=ANY($2::uuid[])
      ORDER BY uid
      FOR KEY SHARE`,
    tenantId,
    patientUids,
  );
  const truncatedPredecessors = await tx.$queryRawUnsafe(
    `SELECT uid::text AS uid
       FROM users
      WHERE tenant_id=$1::uuid
        AND merged_into_uid=ANY($2::uuid[])
        AND NOT (uid=ANY($2::uuid[]))
      ORDER BY uid
      LIMIT 1
      FOR KEY SHARE`,
    tenantId,
    patientUids,
  );
  const byUid = new Map(rows.map((row) => [
    String(row.uid).toLowerCase(),
    {
      role: String(row.role || '').toUpperCase(),
      mergedIntoUid: row.merged_into_uid == null
        ? null : String(row.merged_into_uid).toLowerCase(),
    },
  ]));
  if (rows.length !== patientUids.length
      || truncatedPredecessors.length !== 0
      || byUid.get(canonicalPatientUid)?.role !== 'PATIENT'
      || byUid.get(canonicalPatientUid)?.mergedIntoUid != null
      || [...byUid.values()].some((row) => row.role !== 'PATIENT')) {
    throw AppError.conflict(
      'Substitution funding patient history does not resolve to one tenant survivor',
      'SUBSTITUTION_FUNDING_PATIENT_MERGE_CHAIN_INVALID',
    );
  }
  for (const storedUid of patientUids) {
    const seen = new Set();
    let cursor = storedUid;
    while (cursor !== canonicalPatientUid) {
      if (seen.has(cursor) || !byUid.has(cursor)) {
        throw AppError.conflict(
          'Substitution funding patient merge history is cyclic or ambiguous',
          'SUBSTITUTION_FUNDING_PATIENT_MERGE_CHAIN_INVALID',
        );
      }
      seen.add(cursor);
      const successor = byUid.get(cursor).mergedIntoUid;
      if (!successor) {
        throw AppError.conflict(
          'Substitution funding patient history has more than one terminal identity',
          'SUBSTITUTION_FUNDING_PATIENT_MERGE_CHAIN_INVALID',
        );
      }
      cursor = successor;
    }
  }
  return Object.freeze(patientUids);
}

async function resolveLiveFundingCapacityTx(tx, {
  tenantId,
  authority,
  funding,
  fundingPatientUids,
  fundingApprovalReceiptId = null,
}) {
  if (!Array.isArray(fundingPatientUids)
      || fundingPatientUids[0] !== authority.patient_uid
      || new Set(fundingPatientUids).size !== fundingPatientUids.length) {
    throw AppError.internal(
      'Substitution funding patient family preflight is unavailable',
      'SUBSTITUTION_FUNDING_LOCK_ORDER_INVALID',
    );
  }
  let approvedTpaAmount = checkedMoney12(0n, 'approved TPA amount');
  let tpaDecisionId = null;
  let tpaClaimId = null;
  let tpaClaimPatientUid = null;
  let tpaDecisionEvidence = [];
  if (authority.tpa_mode) {
    const claims = await tx.$queryRawUnsafe(
      `SELECT claim.id,claim.patient_uid::text,claim.status,claim.approved_amount
         FROM tpa_claims claim
        WHERE claim.tenant_id=$1::uuid AND claim.id=$2::int
          AND claim.invoice_id=$3::int AND claim.patient_uid=ANY($4::uuid[])
          AND claim.admission_id IS NOT DISTINCT FROM $5::int
          AND claim.status IN ('approved','partially_approved','paid')
        LIMIT 2
        FOR UPDATE`,
      tenantId,
      funding.fundingTpaClaimId,
      funding.invoiceId,
      fundingPatientUids,
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
    tpaClaimPatientUid = requireUuid(claims[0].patient_uid, 'TPA claim patient_uid');
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
  } else if (!['billing_payment', 'patient_advance'].includes(
    String(funding.fundingSource || '').toLowerCase(),
  )) {
    throw AppError.conflict(
      'A self-pay substitution must resolve to an exact patient funding line',
      'SUBSTITUTION_FUNDING_ADVANCE_AUTHORITY_STALE',
    );
  }

  const prospectiveAmount = authorityMoney10(
    authority.prospective_authoritative_amount,
    'prospective authoritative amount',
    { positive: true },
  );
  const tpaUsedScaled = approvedTpaAmount.scaled > prospectiveAmount.scaled
    ? prospectiveAmount.scaled
    : approvedTpaAmount.scaled;
  const patientAmountRequiredScaled = prospectiveAmount.scaled - tpaUsedScaled;
  const approvalReceiptId = fundingApprovalReceiptId == null
    ? null
    : positiveBigintString(fundingApprovalReceiptId, 'approval_receipt_id');
  const admissionStartedAt = authority.admission_id == null
    ? null
    : new Date(authority.admission_started_at);
  if ((authority.admission_id == null
        && (authority.admission_patient_uid != null || authority.admission_started_at != null))
      || (authority.admission_id != null
        && (!fundingPatientUids.includes(requireUuid(
          authority.admission_patient_uid,
          'funding admission patient_uid',
        ))
          || Number.isNaN(admissionStartedAt.getTime())))) {
    throw AppError.conflict(
      'The funding admission does not resolve to exact patient and time authority',
      'SUBSTITUTION_FUNDING_ADMISSION_AUTHORITY_STALE',
    );
  }

  const advances = patientAmountRequiredScaled > 0n
    ? await tx.$queryRawUnsafe(
      `SELECT advance.id,advance.patient_uid::text,advance.admission_id,
              advance.amount,advance.balance,UPPER(BTRIM(advance.mode)) AS mode,
              advance.reference,advance.collected_at,advance.status
         FROM billing_advances advance
        WHERE advance.tenant_id=$1::uuid AND advance.patient_uid=ANY($2::uuid[])
          AND advance.status='ACTIVE'
          AND (
            ($3::int IS NULL AND advance.admission_id IS NULL)
            OR
            ($3::int IS NOT NULL AND (
              advance.admission_id=$3::int
              OR (advance.admission_id IS NULL
                AND advance.collected_at<=$4::timestamptz)
            ))
          )
          AND UPPER(BTRIM(advance.mode))=ANY($5::text[])
        ORDER BY advance.id
        FOR UPDATE OF advance`,
      tenantId,
      fundingPatientUids,
      authority.admission_id,
      admissionStartedAt?.toISOString() || null,
      [...PATIENT_ADVANCE_RAILS].sort(),
    )
    : [];
  const advanceIds = advances.map((advance) => Number(advance.id));
  const settlements = advanceIds.length
    ? await tx.$queryRawUnsafe(
      `SELECT settlement.id,settlement.advance_id,settlement.invoice_id,
              settlement.amount,settlement.settled_by::text,settlement.settled_at,
              settlement.pharmacy_advance_allocation_id::text,
              settlement.pharmacy_advance_allocation_evidence_sha256,
              settlement.pharmacy_advance_conversion_command_sha256,
              settlement.pharmacy_advance_conversion_evidence_sha256
         FROM billing_advance_settlements settlement
        WHERE settlement.tenant_id=$1::uuid
          AND settlement.advance_id=ANY($2::int[])
        ORDER BY settlement.advance_id,settlement.id
        FOR UPDATE OF settlement`,
      tenantId,
      advanceIds,
    )
    : [];
  const refunds = advanceIds.length
    ? await tx.$queryRawUnsafe(
      `SELECT refund.id,refund.advance_id,refund.amount,refund.mode,refund.reference,
              refund.approval_status,
              refund.raised_at,refund.approved_at,refund.paid_at
         FROM billing_refunds refund
        WHERE refund.tenant_id=$1::uuid
          AND refund.advance_id=ANY($2::int[])
          AND refund.approval_status<>'REJECTED'
        ORDER BY refund.advance_id,refund.id
        FOR UPDATE OF refund`,
      tenantId,
      advanceIds,
    )
    : [];
  const allocations = advanceIds.length
    ? await tx.$queryRawUnsafe(
      `SELECT allocation.id::text AS allocation_id,allocation.billing_advance_id,
              allocation.pharmacy_order_id,allocation.invoice_id,
              allocation.invoice_item_id,allocation.source_authority_version,
              allocation.source_authority_sha256,allocation.allocated_amount,
              allocation.allocation_command_sha256,allocation.funding_task_id,
              allocation.funding_approval_receipt_id::text,
              allocation.allocated_by::text,allocation.allocated_at,
              allocation.evidence_sha256
         FROM pharmacy_advance_allocations allocation
        WHERE allocation.tenant_id=$1::uuid
          AND allocation.billing_advance_id=ANY($2::int[])
        ORDER BY allocation.billing_advance_id,allocation.id
        FOR UPDATE OF allocation`,
      tenantId,
      advanceIds,
    )
    : [];
  const allocationIds = allocations.map((allocation) => String(allocation.allocation_id));
  const reversals = allocationIds.length
    ? await tx.$queryRawUnsafe(
      `SELECT reversal.id::text AS reversal_id,reversal.allocation_id::text,
              reversal.reversed_amount,reversal.reversal_command_sha256,
              reversal.reason,reversal.billing_advance_settlement_id,
              reversal.reversed_by::text,reversal.reversed_at,
              reversal.evidence_sha256
         FROM pharmacy_advance_allocation_reversals reversal
        WHERE reversal.tenant_id=$1::uuid
          AND reversal.allocation_id=ANY($2::bigint[])
        ORDER BY reversal.allocation_id,reversal.id
        FOR UPDATE OF reversal`,
      tenantId,
      allocationIds,
    )
    : [];

  const settlementsByAdvance = new Map(advanceIds.map((id) => [id, []]));
  for (const settlement of settlements) {
    settlementsByAdvance.get(Number(settlement.advance_id))?.push(settlement);
  }
  const refundsByAdvance = new Map(advanceIds.map((id) => [id, []]));
  for (const refund of refunds) refundsByAdvance.get(Number(refund.advance_id))?.push(refund);
  const reversalsByAllocation = new Map();
  for (const reversal of reversals) {
    const bucket = reversalsByAllocation.get(String(reversal.allocation_id)) || [];
    bucket.push(reversal);
    reversalsByAllocation.set(String(reversal.allocation_id), bucket);
  }
  const allocationsByAdvance = new Map(advanceIds.map((id) => [id, []]));
  const allocationEvidence = [];
  const reversalEvidence = [];
  for (const allocation of allocations) {
    const allocated = authorityMoney12(
      allocation.allocated_amount,
      'advance allocation amount',
      { positive: true },
    );
    const rowReversals = reversalsByAllocation.get(String(allocation.allocation_id)) || [];
    const reversedScaled = rowReversals.reduce((sum, reversal) => (
      sum + authorityMoney12(reversal.reversed_amount, 'advance reversal amount', {
        positive: true,
      }).scaled
    ), 0n);
    if (reversedScaled > allocated.scaled) {
      throw AppError.conflict(
        'Advance reversal evidence exceeds its immutable allocation',
        'SUBSTITUTION_FUNDING_ADVANCE_AUTHORITY_STALE',
      );
    }
    const internal = Object.freeze({
      allocationId: String(allocation.allocation_id),
      advanceId: Number(allocation.billing_advance_id),
      allocatedScaled: allocated.scaled,
      reversedScaled,
      netScaled: allocated.scaled - reversedScaled,
      approvalReceiptId: String(allocation.funding_approval_receipt_id),
    });
    allocationsByAdvance.get(internal.advanceId)?.push(internal);
    if (approvalReceiptId !== internal.approvalReceiptId) {
      allocationEvidence.push(Object.freeze({
        allocation_id: internal.allocationId,
        billing_advance_id: internal.advanceId,
        pharmacy_order_id: Number(allocation.pharmacy_order_id),
        invoice_id: Number(allocation.invoice_id),
        invoice_item_id: Number(allocation.invoice_item_id),
        source_authority_version: Number(allocation.source_authority_version),
        source_authority_sha256: String(allocation.source_authority_sha256),
        allocated_amount: allocated.canonical,
        reversed_amount: canonicalScaledDecimal(reversedScaled, NUMERIC_12_2),
        net_amount: canonicalScaledDecimal(internal.netScaled, NUMERIC_12_2),
        allocation_command_sha256: String(allocation.allocation_command_sha256),
        funding_task_id: Number(allocation.funding_task_id),
        funding_approval_receipt_id: internal.approvalReceiptId,
        evidence_sha256: String(allocation.evidence_sha256),
        allocated_by: String(allocation.allocated_by),
        allocated_at: allocation.allocated_at instanceof Date
          ? allocation.allocated_at.toISOString()
          : String(allocation.allocated_at),
      }));
      for (const reversal of rowReversals) {
        reversalEvidence.push(Object.freeze({
          reversal_id: String(reversal.reversal_id),
          allocation_id: internal.allocationId,
          reversed_amount: authorityMoney12(
            reversal.reversed_amount,
            'advance reversal amount',
            { positive: true },
          ).canonical,
          reversal_command_sha256: String(reversal.reversal_command_sha256),
          reason: String(reversal.reason),
          billing_advance_settlement_id: reversal.billing_advance_settlement_id == null
            ? null
            : Number(reversal.billing_advance_settlement_id),
          evidence_sha256: String(reversal.evidence_sha256),
          reversed_by: String(reversal.reversed_by),
          reversed_at: reversal.reversed_at instanceof Date
            ? reversal.reversed_at.toISOString()
            : String(reversal.reversed_at),
        }));
      }
    }
  }

  const advancePlans = [];
  let originalAmountScaled = 0n;
  let currentBalanceScaled = 0n;
  let settlementTotalScaled = 0n;
  let refundReservationScaled = 0n;
  let otherAllocationScaled = 0n;
  for (const advance of advances) {
    const advanceId = Number(advance.id);
    const amount = authorityMoney12(advance.amount, 'advance original amount', { positive: true });
    const balance = authorityMoney12(advance.balance, 'advance current balance');
    const mode = String(advance.mode || '').toUpperCase();
    if (!PATIENT_ADVANCE_RAILS.has(mode) || balance.scaled > amount.scaled) {
      throw AppError.conflict(
        'Patient advance authority is not an eligible live funding rail',
        'SUBSTITUTION_FUNDING_ADVANCE_AUTHORITY_STALE',
      );
    }
    const advanceSettlements = settlementsByAdvance.get(advanceId) || [];
    const advanceRefunds = refundsByAdvance.get(advanceId) || [];
    const advanceAllocations = allocationsByAdvance.get(advanceId) || [];
    const settledScaled = advanceSettlements.reduce((sum, settlement) => (
      sum + authorityMoney12(settlement.amount, 'advance settlement amount', {
        positive: true,
      }).scaled
    ), 0n);
    const refundedScaled = advanceRefunds.reduce((sum, refund) => (
      sum + authorityMoney12(refund.amount, 'advance refund reservation', {
        positive: true,
      }).scaled
    ), 0n);
    const ownAllocationScaled = advanceAllocations.reduce((sum, allocation) => (
      sum + (approvalReceiptId === allocation.approvalReceiptId ? allocation.netScaled : 0n)
    ), 0n);
    const otherLiveScaled = advanceAllocations.reduce((sum, allocation) => (
      sum + (approvalReceiptId === allocation.approvalReceiptId ? 0n : allocation.netScaled)
    ), 0n);
    if (settledScaled + refundedScaled > amount.scaled
        || otherLiveScaled + ownAllocationScaled > balance.scaled
        || settledScaled + refundedScaled + otherLiveScaled + ownAllocationScaled
          > amount.scaled) {
      throw AppError.conflict(
        'Advance settlements, refunds, and live reservations exceed canonical capacity',
        'SUBSTITUTION_FUNDING_ADVANCE_AUTHORITY_STALE',
      );
    }
    const grossAvailableScaled = balance.scaled < amount.scaled - settledScaled - refundedScaled
      ? balance.scaled
      : amount.scaled - settledScaled - refundedScaled;
    const availableBeforeOwnScaled = grossAvailableScaled - otherLiveScaled;
    if (availableBeforeOwnScaled < 0n || ownAllocationScaled > availableBeforeOwnScaled) {
      throw AppError.conflict(
        'The approval reservation no longer fits the exact live advance capacity',
        'SUBSTITUTION_FUNDING_ADVANCE_AUTHORITY_STALE',
      );
    }
    originalAmountScaled += amount.scaled;
    currentBalanceScaled += balance.scaled;
    settlementTotalScaled += settledScaled;
    refundReservationScaled += refundedScaled;
    otherAllocationScaled += otherLiveScaled;
    advancePlans.push({
      advanceId,
      patientUid: requireUuid(advance.patient_uid, 'billing advance patient_uid'),
      amountScaled: amount.scaled,
      balanceScaled: balance.scaled,
      settledScaled,
      refundScaled: refundedScaled,
      otherLiveScaled,
      ownAllocationScaled,
      availableScaled: availableBeforeOwnScaled,
      mode,
      reference: advance.reference || null,
      admissionId: advance.admission_id == null ? null : Number(advance.admission_id),
      collectedAt: advance.collected_at == null
        ? null
        : advance.collected_at instanceof Date
          ? advance.collected_at.toISOString()
          : String(advance.collected_at),
    });
  }
  for (const [scaled, label] of [
    [originalAmountScaled, 'patient advance original total'],
    [currentBalanceScaled, 'patient advance balance total'],
    [settlementTotalScaled, 'patient advance settlement total'],
    [refundReservationScaled, 'patient advance refund total'],
    [otherAllocationScaled, 'other patient advance reservation total'],
  ]) checkedMoney12(scaled, label);

  const orderedPlans = [...advancePlans].sort((left, right) => {
    const leftTime = left.collectedAt == null ? Number.NaN : Date.parse(left.collectedAt);
    const rightTime = right.collectedAt == null ? Number.NaN : Date.parse(right.collectedAt);
    const normalizedLeft = Number.isNaN(leftTime) ? Number.MAX_SAFE_INTEGER : leftTime;
    const normalizedRight = Number.isNaN(rightTime) ? Number.MAX_SAFE_INTEGER : rightTime;
    return normalizedLeft - normalizedRight || left.advanceId - right.advanceId;
  });
  let remainingReservationScaled = patientAmountRequiredScaled;
  const reservations = [];
  for (const plan of orderedPlans) {
    const selectedScaled = plan.availableScaled < remainingReservationScaled
      ? plan.availableScaled
      : remainingReservationScaled;
    plan.selectedScaled = selectedScaled;
    if (selectedScaled > 0n) {
      reservations.push(Object.freeze({
        advanceId: plan.advanceId,
        patientUid: plan.patientUid,
        amountScaled: selectedScaled,
      }));
      remainingReservationScaled -= selectedScaled;
    }
  }
  const availableForOrderScaled = advancePlans.reduce(
    (sum, plan) => sum + plan.availableScaled,
    0n,
  );
  checkedMoney12(availableForOrderScaled, 'available patient advance total');
  if (remainingReservationScaled !== 0n) {
    throw AppError.conflict(
      'Live TPA headroom and patient advance capacity do not cover the substitution',
      'SUBSTITUTION_FUNDING_CAPACITY_INSUFFICIENT',
      {
        prospective_authoritative_amount: prospectiveAmount.canonical,
        tpa_used_amount: canonicalScaledDecimal(tpaUsedScaled, NUMERIC_12_2),
        available_patient_advance_amount: canonicalScaledDecimal(
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
    : 'patient_advance';
  const selectedAdvanceIds = reservations
    .map((reservation) => reservation.advanceId)
    .sort((left, right) => left - right);
  const fundingReference = [
    tpaUsedScaled > 0n ? `tpa:${tpaClaimId}:decision:${tpaDecisionId}` : null,
    patientAmountRequiredScaled > 0n
      ? `patient-advances:${selectedAdvanceIds.join(',')}`
      : null,
  ].filter(Boolean).join(';');
  const settlementEvidence = settlements.map((settlement) => Object.freeze({
    settlement_id: Number(settlement.id),
    billing_advance_id: Number(settlement.advance_id),
    invoice_id: Number(settlement.invoice_id),
    amount: authorityMoney12(settlement.amount, 'advance settlement amount', {
      positive: true,
    }).canonical,
    settled_by: String(settlement.settled_by),
    settled_at: settlement.settled_at instanceof Date
      ? settlement.settled_at.toISOString()
      : String(settlement.settled_at),
    pharmacy_advance_allocation_id: settlement.pharmacy_advance_allocation_id || null,
    pharmacy_advance_allocation_evidence_sha256:
      settlement.pharmacy_advance_allocation_evidence_sha256 || null,
    pharmacy_advance_conversion_command_sha256:
      settlement.pharmacy_advance_conversion_command_sha256 || null,
    pharmacy_advance_conversion_evidence_sha256:
      settlement.pharmacy_advance_conversion_evidence_sha256 || null,
  }));
  const refundEvidence = refunds.map((refund) => Object.freeze({
    refund_id: Number(refund.id),
    billing_advance_id: Number(refund.advance_id),
    amount: authorityMoney12(refund.amount, 'advance refund reservation', {
      positive: true,
    }).canonical,
    mode: String(refund.mode || '').toUpperCase(),
    reference: refund.reference || null,
    approval_status: String(refund.approval_status),
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
  const sourceEvidence = {
    contract: 'pharmacy_substitution_advance_sources_v1',
    funding_patient_uid: authority.patient_uid,
    patient_uid_family: fundingPatientUids,
    funding_admission_id: authority.admission_id,
    funding_admission_patient_uid: authority.admission_patient_uid,
    funding_admission_started_at: admissionStartedAt?.toISOString() || null,
    tpa_claim_id: tpaClaimId,
    tpa_claim_patient_uid: tpaClaimPatientUid,
    tpa_decision_id: tpaDecisionId,
    tpa_decision_ids: tpaDecisionEvidence.map((decision) => decision.tpa_decision_id),
    advance_ids: advancePlans.map((advance) => advance.advanceId),
    selected_advance_ids: selectedAdvanceIds,
    settlement_ids: settlementEvidence.map((settlement) => settlement.settlement_id),
    refund_ids: refundEvidence.map((refund) => refund.refund_id),
    allocation_ids: allocationEvidence.map((allocation) => allocation.allocation_id),
    reversal_ids: reversalEvidence.map((reversal) => reversal.reversal_id),
    advances: advancePlans.map((advance) => Object.freeze({
      billing_advance_id: advance.advanceId,
      stored_patient_uid: advance.patientUid,
      admission_id: advance.admissionId,
      amount: canonicalScaledDecimal(advance.amountScaled, NUMERIC_12_2),
      balance: canonicalScaledDecimal(advance.balanceScaled, NUMERIC_12_2),
      mode: advance.mode,
      reference: advance.reference,
      collected_at: advance.collectedAt,
      settled_amount: canonicalScaledDecimal(advance.settledScaled, NUMERIC_12_2),
      active_refund_reservation_amount: canonicalScaledDecimal(
        advance.refundScaled,
        NUMERIC_12_2,
      ),
      live_allocation_amount: canonicalScaledDecimal(
        advance.otherLiveScaled,
        NUMERIC_12_2,
      ),
      available_amount: canonicalScaledDecimal(advance.availableScaled, NUMERIC_12_2),
      selected_reservation_amount: canonicalScaledDecimal(
        advance.selectedScaled || 0n,
        NUMERIC_12_2,
      ),
    })),
    settlements: settlementEvidence,
    refunds: refundEvidence,
    allocations: allocationEvidence,
    reversals: reversalEvidence,
    tpa_decisions: tpaDecisionEvidence,
  };
  const sourceEvidenceSha256 = await databaseJsonbSha256(
    tx,
    sourceEvidence,
    'Substitution funding source evidence',
  );
  const evidence = {
    contract: 'pharmacy_substitution_advance_capacity_v1',
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
    patient_advance_original_amount: canonicalScaledDecimal(
      originalAmountScaled,
      NUMERIC_12_2,
    ),
    patient_advance_balance_amount: canonicalScaledDecimal(
      currentBalanceScaled,
      NUMERIC_12_2,
    ),
    advance_settlement_amount: canonicalScaledDecimal(
      settlementTotalScaled,
      NUMERIC_12_2,
    ),
    active_refund_reservation_amount: canonicalScaledDecimal(
      refundReservationScaled,
      NUMERIC_12_2,
    ),
    live_advance_allocation_amount: canonicalScaledDecimal(
      otherAllocationScaled,
      NUMERIC_12_2,
    ),
    available_patient_advance_amount: canonicalScaledDecimal(
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
    source_evidence_sha256: sourceEvidenceSha256,
    source_evidence: sourceEvidence,
  };
  const evidenceSha256 = await databaseJsonbSha256(
    tx,
    evidence,
    'Substitution funding evidence',
  );
  return Object.freeze({
    evidence: Object.freeze({ ...evidence, evidence_sha256: evidenceSha256 }),
    reservationPlan: Object.freeze({
      patientAmountRequiredScaled,
      tpaUsedScaled,
      lockedApprovedTpaAmountScaled: approvedTpaAmount.scaled,
      originalAmountScaled,
      currentBalanceScaled,
      settlementTotalScaled,
      refundReservationScaled,
      otherAllocationScaled,
      availableForOrderScaled,
      prospectiveAmountScaled: prospectiveAmount.scaled,
      tpaDecisionId,
      tpaClaimId,
      advances: Object.freeze(advancePlans),
      reservations: Object.freeze(reservations),
    }),
  });
}

async function resolveSubstitutionFundingPatientPreflightTx(tx, {
  tenantId,
  orderId,
}) {
  const tid = requireTenantId(tenantId);
  const exactOrderId = positiveInt4(orderId, 'pharmacy_order_id');
  const preflight = await tx.$queryRawUnsafe(
    `SELECT pharmacy_order.facility_id,pharmacy_order.uid::text AS order_patient_uid,
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
  const patientUids = await resolveSubstitutionFundingPatientFamilyTx(tx, {
    tenantId: tid,
    patientUid,
  });
  const orderPatientUid = preflight[0].order_patient_uid == null
    ? null : requireUuid(preflight[0].order_patient_uid, 'pharmacy order patient uid');
  if (orderPatientUid != null && !patientUids.includes(orderPatientUid)) {
    throw AppError.conflict(
      'The pharmacy order patient provenance is outside the canonical merge family',
      'SUBSTITUTION_FUNDING_PATIENT_MERGE_CHAIN_INVALID',
    );
  }
  return Object.freeze({
    tenantId: tid,
    orderId: exactOrderId,
    patientUid,
    patientUids,
    orderPatientUid,
    facilityId: positiveInt4(preflight[0].facility_id, 'facility_id'),
  });
}

function assertSubstitutionFundingPatientPreflight(preflight, {
  tenantId,
  orderId,
}) {
  if (preflight?.tenantId !== tenantId
      || preflight?.orderId !== orderId
      || !Array.isArray(preflight.patientUids)
      || preflight.patientUids[0] !== preflight.patientUid
      || (preflight.orderPatientUid != null
        && !preflight.patientUids.includes(preflight.orderPatientUid))) {
    throw AppError.internal(
      'Substitution funding patient preflight is bound to a different authority tuple',
      'SUBSTITUTION_FUNDING_LOCK_ORDER_INVALID',
    );
  }
  return preflight;
}

async function lockSubstitutionFundingCanonicalAuthorityTx(tx, {
  tenantId,
  orderId,
  mergeStabilityHeld = false,
  patientAuthorityPreflight = null,
}) {
  const tid = requireTenantId(tenantId);
  const exactOrderId = positiveInt4(orderId, 'pharmacy_order_id');
  if (!mergeStabilityHeld) await lockTenantPatientMergeStability(tx, tid);
  const preflight = patientAuthorityPreflight
    || await resolveSubstitutionFundingPatientPreflightTx(tx, {
      tenantId: tid,
      orderId: exactOrderId,
    });
  assertSubstitutionFundingPatientPreflight(preflight, {
    tenantId: tid,
    orderId: exactOrderId,
  });
  const { patientUid } = preflight;
  await lockPharmacyFundingAuthorityTx(tx, { tenantId: tid, patientUid });
  return preflight;
}

async function lockSubstitutionFundingOrderAuthorityTx(tx, {
  tenantId,
  orderId,
  patientAuthorityPreflight,
}) {
  const tid = requireTenantId(tenantId);
  const exactOrderId = positiveInt4(orderId, 'pharmacy_order_id');
  const preflight = assertSubstitutionFundingPatientPreflight(
    patientAuthorityPreflight,
    { tenantId: tid, orderId: exactOrderId },
  );
  await tx.$queryRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtextextended($1::text,753))::text AS lock_acquired`,
    `vh:substitution-funding:order:${tid}:${exactOrderId}`,
  );
  return Object.freeze({
    ...preflight,
  });
}

async function lockSubstitutionFundingPatientAuthorityTx(tx, {
  tenantId,
  orderId,
}) {
  const preflight = await lockSubstitutionFundingCanonicalAuthorityTx(tx, {
    tenantId,
    orderId,
  });
  return lockSubstitutionFundingOrderAuthorityTx(tx, {
    tenantId,
    orderId,
    patientAuthorityPreflight: preflight,
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
            pharmacy_order.uid::text AS order_patient_uid,
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
        AND (pharmacy_order.uid IS NULL OR pharmacy_order.uid=ANY($5::uuid[]))
      LIMIT 2
      FOR UPDATE OF pharmacy_order,patient`,
    fundingLock.tenantId,
    fundingLock.orderId,
    fundingLock.facilityId,
    fundingLock.patientUid,
    fundingLock.patientUids,
  );
  const lockedOrderPatientUid = orders[0]?.order_patient_uid == null
    ? null : String(orders[0].order_patient_uid).toLowerCase();
  if (orders.length !== 1
      || lockedOrderPatientUid !== fundingLock.orderPatientUid) {
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
  fundingAuthorityLease: suppliedFundingAuthorityLease = null,
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
  const substitutionFundingAuthorityLease = suppliedFundingAuthorityLease
    || await lockCounterFundingSubstitutionAuthorityTx(tx, {
      tenantId: tid,
      orderId: exactOrderId,
      patientUid: fundingLock.patientUid,
    });
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
    items_list: orderItems,
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
    items_list: projection.order_items,
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
    substitutionFundingAuthorityLease,
  });
  const invoiceRows = await tx.$queryRawUnsafe(
    `SELECT invoice.id AS invoice_id,
            invoice.status AS invoice_status,invoice.patient_uid::text,
            invoice.admission_id,invoice.invoice_number,
            invoice.subtotal AS invoice_subtotal,
            invoice.cgst_amount AS invoice_cgst_amount,
            invoice.sgst_amount AS invoice_sgst_amount,
            invoice.igst_amount AS invoice_igst_amount,
            invoice.discount_amount AS invoice_discount_amount,
            invoice.credit_note_amount AS invoice_credit_note_amount,
            invoice.total_amount AS invoice_total_amount,
            invoice.amount_paid AS invoice_amount_paid,
            invoice.amount_due AS invoice_amount_due,
            invoice.issued_at AS invoice_issued_at,
            invoice.voided_at AS invoice_voided_at
       FROM billing_invoices invoice
      WHERE invoice.tenant_id=$1::uuid AND invoice.id=$2::int
      LIMIT 2
      FOR UPDATE`,
    tid,
    funding.invoiceId,
  );
  const itemRows = await tx.$queryRawUnsafe(
    `SELECT item.id AS invoice_item_id,
            item.quantity AS item_quantity,item.unit_price AS item_unit_price,
            item.gst_rate AS item_gst_rate,
            item.line_subtotal AS item_line_subtotal,
            item.cgst_amount AS item_cgst_amount,
            item.sgst_amount AS item_sgst_amount,
            item.igst_amount AS item_igst_amount,
            item.line_total AS item_line_total,
            item.source_ref_type AS item_source_ref_type,
            item.source_ref_id AS item_source_ref_id,
            item.source_authority_version AS item_source_authority_version,
            item.source_authority_sha256 AS item_source_authority_sha256,
            item.source_ref_active AS item_source_ref_active
       FROM billing_invoice_items item
      WHERE item.tenant_id=$1::uuid AND item.id=$2::int AND item.invoice_id=$3::int
        AND item.source_ref_type='pharmacy_order' AND item.source_ref_id=$4::bigint
      LIMIT 2
      FOR UPDATE`,
    tid,
    funding.invoiceItemId,
    funding.invoiceId,
    exactOrderId,
  );
  const invoiceAuthority = invoiceRows.length === 1 && itemRows.length === 1
    ? { ...invoiceRows[0], ...itemRows[0] }
    : null;
  const billing = invoiceAuthority
    ? substitutionFundingBillingAuthority({ row: invoiceAuthority, base, prospective })
    : null;
  if (invoiceRows.length !== 1 || itemRows.length !== 1
      || invoiceAuthority.invoice_status !== 'DRAFT'
      || invoiceAuthority.invoice_number != null
      || invoiceAuthority.invoice_issued_at != null
      || invoiceAuthority.invoice_voided_at != null
      || billing.base.invoice.amount_paid !== '0.00'
      || billing.base.invoice.credit_note_amount !== '0.00'
      || invoiceAuthority.item_source_ref_active !== true
      || String(invoiceAuthority.patient_uid) !== patientUid
      || (invoiceAuthority.admission_id == null ? null : Number(invoiceAuthority.admission_id))
        !== base.admission_id
      || Number(invoiceAuthority.item_source_authority_version) !== baseOrderVersion
      || String(invoiceAuthority.item_source_authority_sha256) !== baseOrderItemsSha256) {
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
  const admissionRows = base.admission_id == null
    ? []
    : await tx.$queryRawUnsafe(
      `SELECT admission.id,admission.patient_uid::text,
              COALESCE(admission.admitted_at,admission.created_at) AS admission_started_at
         FROM admissions admission
        WHERE admission.tenant_id=$1::uuid AND admission.id=$2::int
          AND admission.patient_uid=ANY($3::uuid[])
        LIMIT 2
        FOR UPDATE`,
      tid,
      base.admission_id,
      fundingLock.patientUids,
    );
  const admissionStarted = admissionRows[0]?.admission_started_at == null
    ? null
    : new Date(admissionRows[0].admission_started_at);
  const admissionStartedAt = admissionStarted && !Number.isNaN(admissionStarted.getTime())
    ? admissionStarted.toISOString()
    : null;
  if (base.admission_id != null
      && (admissionRows.length !== 1
        || !admissionStartedAt
        || Number.isNaN(new Date(admissionStartedAt).getTime()))) {
    throw AppError.conflict(
      'The pharmacy funding admission no longer has exact patient and time authority',
      'SUBSTITUTION_FUNDING_ADMISSION_AUTHORITY_STALE',
    );
  }
  const paymentRows = await tx.$queryRawUnsafe(
    `SELECT id
       FROM billing_payments
      WHERE tenant_id=$1::uuid AND invoice_id=$2::int
      ORDER BY id
      FOR UPDATE`,
    tid,
    funding.invoiceId,
  );
  const refundRows = await tx.$queryRawUnsafe(
    `SELECT id
       FROM billing_refunds
      WHERE tenant_id=$1::uuid AND invoice_id=$2::int
      ORDER BY id
      FOR UPDATE`,
    tid,
    funding.invoiceId,
  );
  const settlementRows = await tx.$queryRawUnsafe(
    `SELECT id
       FROM billing_advance_settlements
      WHERE tenant_id=$1::uuid AND invoice_id=$2::int
      ORDER BY id
      FOR UPDATE`,
    tid,
    funding.invoiceId,
  );
  if (paymentRows.length || refundRows.length || settlementRows.length) {
    throw AppError.conflict(
      'Substitution funding cannot reserve an invoice with payment, refund, or advance-settlement history',
      'SUBSTITUTION_FUNDING_INVOICE_FINANCE_LIFECYCLE_STARTED',
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
      admission_patient_uid: admissionRows[0]?.patient_uid == null
        ? null
        : requireUuid(admissionRows[0].patient_uid, 'funding admission patient_uid'),
      admission_started_at: admissionStartedAt,
      base_order_version: baseOrderVersion,
      base_order_items_sha256: baseOrderItemsSha256,
      prospective_order_version: prospective.order_version,
      prospective_order_items_sha256: prospective.order_items_sha256,
      prospective_authoritative_amount: prospective.authoritative_amount,
      tpa_mode: TPA_PAYMENT_MODES.has(paymentMode),
    },
    funding,
    fundingPatientUids: fundingLock.patientUids,
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
    billing,
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
    billing: authority.billing,
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
            ('pharmacy_tpa_line_decision','pharmacy_posted_payment',
             'pharmacy_patient_advance')
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
    await lockTenantPatientMergeStability(tx, tid);
    const patientAuthorityPreflight = await resolveSubstitutionFundingPatientPreflightTx(tx, {
      tenantId: tid,
      orderId,
    });
    await lockSubstitutionFundingCanonicalAuthorityTx(tx, {
      tenantId: tid,
      orderId,
      mergeStabilityHeld: true,
      patientAuthorityPreflight,
    });
    const fundingLock = await lockSubstitutionFundingOrderAuthorityTx(tx, {
      tenantId: tid,
      orderId,
      patientAuthorityPreflight,
    });
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
      const existingApprovalId = positiveInt4(existing[0].id, 'approval_id');
      if (existing[0].is_expired) {
        const expiredLocked = await lockSubstitutionFundingApprovalTaskTx(tx, {
          tenantId: tid,
          approvalId: existingApprovalId,
        });
        assertProposalReplay(expiredLocked.approval, {
          requestSha256,
          proposerUid: uid,
        });
        if (expiredLocked.approval.status === 'pending') {
          await expireSubstitutionFundingProposalTx(tx, {
            tenantId: tid,
            approvalId: Number(expiredLocked.approval.id),
            taskId: Number(expiredLocked.task.id),
            proposalSha256: expiredLocked.metadata.proposal_sha256,
          });
        }
        return EXPIRED_APPROVAL_RESULT;
      }
      if (existing[0].status !== 'pending') return replaySnapshot;
      const replayFundingAuthorityLease = await lockCounterFundingSubstitutionAuthorityTx(tx, {
        tenantId: tid,
        orderId,
        patientUid: fundingLock.patientUid,
        substitutionFundingGovernanceApprovalId: existingApprovalId,
      });
      const locked = await lockSubstitutionFundingApprovalTaskTx(tx, {
        tenantId: tid,
        approvalId: existingApprovalId,
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
        fundingLock,
        fundingAuthorityLease: replayFundingAuthorityLease,
      });
      if (replayAuthority.proposal_sha256 !== locked.metadata.proposal_sha256
          || stableJson(replayAuthority.base) !== stableJson(locked.metadata.authority?.base)
          || stableJson(replayAuthority.prospective)
            !== stableJson(locked.metadata.authority?.prospective)
          || stableJson(replayAuthority.billing)
            !== stableJson(locked.metadata.authority?.billing)
          || stableJson(replayAuthority.funding)
            !== stableJson(locked.metadata.authority?.funding)) {
        throw AppError.conflict(
          'The pending substitution funding proposal drifted before replay',
          'SUBSTITUTION_FUNDING_AUTHORITY_DRIFT',
        );
      }
      return lockedSnapshot;
    }
    await closeExpiredSubstitutionFundingTasksTx(tx, {
      tenantId: tid,
      orderId: fundingLock.orderId,
    });
    const activeTasks = await tx.$queryRawUnsafe(
      `SELECT id,status,metadata
         FROM tasks
        WHERE tenant_id=$1::uuid
          AND related_resource_type IN
            ('pharmacy_tpa_line_decision','pharmacy_posted_payment',
             'pharmacy_patient_advance')
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
      'Review the locked prospective order amount and exact live TPA or patient-advance headroom. This task does not move stock or mutate billing.',
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
      facility_id: authority.base.facility_id,
      invoice_id: authority.invoice_id,
      invoice_item_id: authority.invoice_item_id,
      tpa_claim_id: authority.tpa_claim_id,
      selector: normalizedSelector,
      authority: {
        base: authority.base,
        prospective: authority.prospective,
        billing: authority.billing,
        funding: authority.funding,
      },
      permitted_approver_roles: authority.permitted_approver_roles,
    };
    const approvals = await tx.$queryRawUnsafe(
      `INSERT INTO approvals
        (tenant_id,approval_kind,subject_resource_type,subject_resource_id,
         required_approvers,required_role,status,expires_at,created_by,task_id,
         materialization_key,metadata)
       VALUES ($1::uuid,$2,'pharmacy_substitution_funding_proposal',$3,
               1,$4,'pending',NOW()+($5::int*INTERVAL '1 minute'),$6::uuid,
               $7::int,$8,$9::jsonb)
       RETURNING id,status,created_by,expires_at,metadata`,
      tid,
      SUBSTITUTION_FUNDING_APPROVAL_KIND,
      authority.proposal_sha256,
      authority.task_assigned_role,
      ttlMinutes,
      uid,
      Number(task.id),
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
  const proposerUid = String(metadata.proposer_uid || '').toLowerCase();
  const valid = approval
    && task
    && approval.approval_kind === SUBSTITUTION_FUNDING_APPROVAL_KIND
    && approval.subject_resource_type === 'pharmacy_substitution_funding_proposal'
    && approval.subject_resource_id === metadata.proposal_sha256
    && metadata.contract === SUBSTITUTION_FUNDING_APPROVAL_CONTRACT
    && metadata.stage === SUBSTITUTION_FUNDING_TASK_STAGE
    && UUID_PATTERN.test(proposerUid)
    && String(approval.created_by || '').toLowerCase() === proposerUid
    && approval.workflow_run_id == null
    && approval.workflow_step_id == null
    && Number(approval.task_id) === expectedTaskId
    && Number(task.id) === expectedTaskId
    && task.workflow_run_id == null
    && String(task.created_by || '').toLowerCase() === proposerUid
    && task.related_resource_type === metadata.task_resource_type
    && task.related_resource_id === String(metadata.pharmacy_order_id)
    && taskMetadata.contract === SUBSTITUTION_FUNDING_TASK_CONTRACT
    && taskMetadata.stage === SUBSTITUTION_FUNDING_TASK_STAGE
    && String(taskMetadata.proposer_uid || '').toLowerCase() === proposerUid
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
    && Number(receipt.facility_id) === Number(metadata.facility_id)
    && Number(receipt.invoice_id) === Number(metadata.invoice_id)
    && Number(receipt.invoice_item_id) === Number(metadata.invoice_item_id)
    && (receipt.tpa_claim_id == null ? null : Number(receipt.tpa_claim_id))
      === (metadata.tpa_claim_id == null ? null : Number(metadata.tpa_claim_id))
    && receipt.approval_receipt_id == null
    && Number(receipt.governance_approval_id) === Number(approval.id)
    && receipt.proposal_sha256 === metadata.proposal_sha256
    && String(receipt.proposer_uid || '').toLowerCase()
      === String(approval.created_by || '').toLowerCase()
    && String(receipt.proposer_uid || '').toLowerCase()
      === String(metadata.proposer_uid || '').toLowerCase()
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
    await lockTenantPatientMergeStability(tx, tid);
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
        || Number(preflightMetadata.pharmacy_order_id) !== exactOrderId
        || String(preflight.created_by || '').toLowerCase()
          !== String(preflightMetadata.proposer_uid || '').toLowerCase()) {
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
    const patientAuthorityPreflight = await resolveSubstitutionFundingPatientPreflightTx(tx, {
      tenantId: tid,
      orderId: exactOrderId,
    });
    await lockSubstitutionFundingCanonicalAuthorityTx(tx, {
      tenantId: tid,
      orderId: exactOrderId,
      mergeStabilityHeld: true,
      patientAuthorityPreflight,
    });
    const fundingLock = await lockSubstitutionFundingOrderAuthorityTx(tx, {
      tenantId: tid,
      orderId: exactOrderId,
      patientAuthorityPreflight,
    });
    const requestSha256 = approvalRequestSha256({
      approvalId: exactApprovalId,
      proposalSha256: preflightMetadata.proposal_sha256,
      approverUid: approverUidNormalized,
    });
    const receiptRows = await tx.$queryRawUnsafe(
      `SELECT id::text AS id,command_key_sha256,command_type,task_id,
              task_resource_type,task_resource_id,pharmacy_order_id,
              facility_id,invoice_id,invoice_item_id,tpa_claim_id,approval_receipt_id,
              governance_approval_id,proposal_sha256,proposer_uid::text,
              approved_patient_amount,request_sha256,status,response_body,
              created_by,created_at,completed_at
         FROM pharmacy_funding_commands
        WHERE tenant_id=$1::uuid AND command_key_sha256=$2
        LIMIT 2
        FOR UPDATE`,
      tid,
      commandKeySha256,
    );
    if (receiptRows.length > 1) {
      throw AppError.conflict(
        'The substitution funding command receipt is ambiguous',
        'SUBSTITUTION_FUNDING_APPROVAL_RECEIPT_INVALID',
      );
    }
    if (preflight.is_expired && receiptRows.length === 0) {
      const locked = await lockSubstitutionFundingApprovalTaskTx(tx, {
        tenantId: tid,
        approvalId: exactApprovalId,
      });
      if (locked.approval.status === 'pending'
          && (ACTIVE_TASK_STATUSES.has(locked.task.status)
            || locked.task.status === 'cancelled')) {
        await expireSubstitutionFundingProposalTx(tx, {
          tenantId: tid,
          approvalId: exactApprovalId,
          taskId: Number(locked.task.id),
          proposalSha256: locked.metadata.proposal_sha256,
        });
        return EXPIRED_APPROVAL_RESULT;
      }
      throw AppError.conflict(
        'The substitution funding proposal has expired',
        'SUBSTITUTION_FUNDING_APPROVAL_EXPIRED',
      );
    }
    const commandWasExisting = receiptRows.length === 1;
    let command = receiptRows[0] || null;
    if (!command) {
      const claimed = await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_funding_commands
          (tenant_id,command_key_sha256,command_type,task_id,task_resource_type,
           task_resource_id,pharmacy_order_id,facility_id,invoice_id,
           invoice_item_id,tpa_claim_id,
           governance_approval_id,proposal_sha256,proposer_uid,
           request_sha256,created_by)
         VALUES ($1::uuid,$2,'SUBSTITUTION_FUNDING_APPROVAL',$3::int,$4,$5,
                 $6::int,$7::int,$8::int,$9::int,$10::int,$11::int,$12,
                 $13::uuid,$14,$15::uuid)
         RETURNING id::text AS id,command_key_sha256,command_type,task_id,
                   task_resource_type,task_resource_id,pharmacy_order_id,
                   facility_id,invoice_id,invoice_item_id,tpa_claim_id,
                   approval_receipt_id,
                   governance_approval_id,proposal_sha256,proposer_uid::text,
                   approved_patient_amount,request_sha256,status,response_body,
                   created_by,created_at,completed_at`,
        tid,
        commandKeySha256,
        positiveInt4(preflightMetadata.task_id, 'substitution funding task id'),
        preflightMetadata.task_resource_type,
        String(exactOrderId),
        exactOrderId,
        positiveInt4(preflightMetadata.facility_id, 'facility_id'),
        positiveInt4(preflightMetadata.invoice_id, 'invoice_id'),
        positiveInt4(preflightMetadata.invoice_item_id, 'invoice_item_id'),
        preflightMetadata.tpa_claim_id == null
          ? null
          : positiveInt4(preflightMetadata.tpa_claim_id, 'tpa_claim_id'),
        exactApprovalId,
        preflightMetadata.proposal_sha256,
        requireUuid(preflight.created_by, 'proposer_uid'),
        requestSha256,
        approverUidNormalized,
      );
      command = claimed[0] || null;
      if (!command) {
        throw AppError.conflict(
          'The immutable funding approval receipt could not be claimed',
          'SUBSTITUTION_FUNDING_APPROVAL_STATE_CONFLICT',
        );
      }
    }
    await lockSubstitutionFundingApprovalReceiptAdvisoryTx(tx, {
      tenantId: tid,
      approvalReceiptId: command.id,
    });
    const fundingAuthorityLease = commandWasExisting
      ? null
      : await lockCounterFundingSubstitutionAuthorityTx(tx, {
        tenantId: tid,
        orderId: exactOrderId,
        patientUid: fundingLock.patientUid,
        substitutionFundingApprovalReceiptId: command.id,
      });
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
    const lockedRequestSha256 = approvalRequestSha256({
      approvalId: exactApprovalId,
      proposalSha256: metadata.proposal_sha256,
      approverUid: approver.uid,
    });
    if (lockedRequestSha256 !== requestSha256) {
      throw AppError.unprocessable(
        'The immutable funding command is bound to a different approval actor',
        'SUBSTITUTION_FUNDING_APPROVAL_COMMAND_MISMATCH',
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
    if (!commandWasExisting
        && (command.status !== 'IN_PROGRESS'
          || command.response_body != null
          || command.approved_patient_amount != null
          || command.completed_at != null)) {
      throw AppError.conflict(
        'The claimed funding approval receipt is not an empty in-progress command',
        'SUBSTITUTION_FUNDING_APPROVAL_RECEIPT_INVALID',
      );
    }
    if (commandWasExisting
        && (approval.status !== 'approved'
          || String(approval.decided_by || '').toLowerCase() !== approver.uid
          || task.status !== 'completed')) {
      throw AppError.conflict(
        'The approval receipt disagrees with the task or approval state',
        'SUBSTITUTION_FUNDING_APPROVAL_RECEIPT_INVALID',
      );
    }
    if (!commandWasExisting
        && (approval.status !== 'pending' || !ACTIVE_TASK_STATUSES.has(task.status))) {
      throw AppError.conflict(
        'The substitution funding proposal is no longer pending',
        'SUBSTITUTION_FUNDING_APPROVAL_NOT_PENDING',
      );
    }
    if (!commandWasExisting && approval.is_expired) {
      throw AppError.conflict(
        'The substitution funding proposal has expired',
        'SUBSTITUTION_FUNDING_APPROVAL_EXPIRED',
      );
    }
    if (commandWasExisting) return completeReceiptResponse(command);
    const authority = await resolveSubstitutionFundingAuthorityTx(tx, {
      tenantId: tid,
      orderId: exactOrderId,
      selector: metadata.selector,
      proposerUid: metadata.proposer_uid,
      fundingLock,
      fundingAuthorityLease,
    });
    if (authority.proposal_sha256 !== metadata.proposal_sha256
        || authority.proposal_sha256 !== approval.subject_resource_id
        || stableJson(authority.base) !== stableJson(metadata.authority?.base)
        || stableJson(authority.prospective) !== stableJson(metadata.authority?.prospective)
        || stableJson(authority.billing) !== stableJson(metadata.authority?.billing)
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
    const advanceReservations = await reserveSubstitutionFundingAdvanceCapacityTx(tx, {
      tenantId: tid,
      approvalId: exactApprovalId,
      receiptId: command.id,
      taskId: Number(task.id),
      authority,
      approverUid: approver.uid,
    });
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
           allocation_ids: advanceReservations.allocation_ids,
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
      billing: authority.billing,
      funding: authority.funding,
      advance_reservations: advanceReservations,
    };
    const validatedResponse = approvedSubstitutionFundingReceiptContract(response);
    const completedReceipts = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_funding_commands
          SET status='COMPLETE',response_body=$3::jsonb
        WHERE tenant_id=$1::uuid AND command_key_sha256=$2
          AND status='IN_PROGRESS'
        RETURNING id::text AS id,status,response_body,approved_patient_amount,
                  completed_at`,
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
    return approvedSubstitutionFundingReceiptContract(
      completedReceipts[0].response_body,
    );
  });
  if (result === EXPIRED_APPROVAL_RESULT) {
    throw AppError.conflict(
      'The substitution funding proposal has expired',
      'SUBSTITUTION_FUNDING_APPROVAL_EXPIRED',
    );
  }
  return result;
}

async function reserveSubstitutionFundingAdvanceCapacityTx(tx, {
  tenantId,
  approvalId,
  receiptId,
  taskId,
  authority,
  approverUid,
}) {
  const plan = authority.funding_reservation_plan;
  if (!plan || typeof plan !== 'object'
      || typeof plan.patientAmountRequiredScaled !== 'bigint'
      || !Array.isArray(plan.reservations)
      || !Array.isArray(plan.advances)) {
    throw AppError.internal(
      'Live substitution funding advance reservation plan is unavailable',
      'SUBSTITUTION_FUNDING_RESERVATION_PLAN_INVALID',
    );
  }
  const exactReceiptId = positiveBigintString(receiptId, 'approval_receipt_id');
  const exactTaskId = positiveInt4(taskId, 'funding_task_id');
  const exactApproverUid = requireUuid(approverUid, 'approver_uid');
  const reservations = [...plan.reservations].sort(
    (left, right) => Number(left.advanceId) - Number(right.advanceId),
  );
  const seenAdvanceIds = new Set();
  const reservationTotalScaled = reservations.reduce((sum, reservation) => {
    const advanceId = positiveInt4(reservation.advanceId, 'billing_advance_id');
    if (seenAdvanceIds.has(advanceId)
        || typeof reservation.amountScaled !== 'bigint'
        || reservation.amountScaled <= 0n) {
      throw AppError.internal(
        'The advance reservation plan is duplicated or non-positive',
        'SUBSTITUTION_FUNDING_RESERVATION_PLAN_INVALID',
      );
    }
    seenAdvanceIds.add(advanceId);
    return sum + reservation.amountScaled;
  }, 0n);
  checkedMoney12(reservationTotalScaled, 'advance reservation total');
  if (reservationTotalScaled !== plan.patientAmountRequiredScaled) {
    throw AppError.conflict(
      'The exact patient advance reservations do not cover the approved patient amount',
      'SUBSTITUTION_FUNDING_CAPACITY_INSUFFICIENT',
    );
  }

  const allocations = [];
  for (const reservation of reservations) {
    const advanceId = positiveInt4(reservation.advanceId, 'billing_advance_id');
    const advancePatientUid = requireUuid(
      reservation.patientUid,
      'billing_advance_patient_uid',
    );
    const allocationAmount = checkedMoney12(
      reservation.amountScaled,
      'substitution funding advance allocation amount',
    );
    const allocationCommandSha256 = sha256({
      contract: 'pharmacy_advance_allocation_v1',
      command: 'reserve',
      tenant_id: tenantId,
      governance_approval_id: approvalId,
      approval_receipt_id: exactReceiptId,
      funding_task_id: exactTaskId,
      proposal_sha256: authority.proposal_sha256,
      billing_advance_id: advanceId,
      billing_advance_patient_uid: advancePatientUid,
      billing_advance_terminal_patient_uid: authority.base.patient_uid,
      allocated_amount: allocationAmount.canonical,
      pharmacy_order_id: authority.base.pharmacy_order_id,
      invoice_id: authority.invoice_id,
      invoice_item_id: authority.invoice_item_id,
      source_authority_version: authority.base.order_version,
      source_authority_sha256: authority.base.order_items_sha256,
    });
    const allocationEvidence = {
      contract: 'pharmacy_advance_allocation_v1',
      governance_approval_id: approvalId,
      approval_receipt_id: exactReceiptId,
      funding_task_id: exactTaskId,
      proposal_sha256: authority.proposal_sha256,
      proposer_uid: authority.proposer.uid,
      approver_uid: exactApproverUid,
      pharmacy_order_id: authority.base.pharmacy_order_id,
      invoice_id: authority.invoice_id,
      invoice_item_id: authority.invoice_item_id,
      patient_uid: authority.base.patient_uid,
      admission_id: authority.base.admission_id,
      billing_advance_id: advanceId,
      billing_advance_patient_uid: advancePatientUid,
      billing_advance_terminal_patient_uid: authority.base.patient_uid,
      allocated_amount: allocationAmount.canonical,
      allocation_command_sha256: allocationCommandSha256,
      source_evidence_sha256: authority.funding.source_evidence_sha256,
      base: {
        order_version: authority.base.order_version,
        order_items_sha256: authority.base.order_items_sha256,
      },
      prospective: {
        order_version: authority.prospective.order_version,
        order_items_sha256: authority.prospective.order_items_sha256,
        authoritative_amount: authority.prospective.authoritative_amount,
      },
    };
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO pharmacy_advance_allocations
        (tenant_id,pharmacy_order_id,invoice_id,invoice_item_id,
         billing_advance_id,source_authority_version,source_authority_sha256,
         allocated_amount,allocation_command_sha256,funding_task_id,
         funding_approval_receipt_id,allocated_by,evidence)
       VALUES ($1::uuid,$2::int,$3::int,$4::int,$5::int,$6::int,$7,
               $8::numeric,$9,$10::int,$11::bigint,$12::uuid,$13::jsonb)
       RETURNING id::text AS allocation_id,billing_advance_id,allocated_amount,
                 source_authority_version,source_authority_sha256,
                 allocation_command_sha256,funding_task_id,
                 funding_approval_receipt_id::text,allocated_by::text,
                 allocated_at,evidence,evidence_sha256`,
      tenantId,
      authority.base.pharmacy_order_id,
      authority.invoice_id,
      authority.invoice_item_id,
      advanceId,
      authority.base.order_version,
      authority.base.order_items_sha256,
      allocationAmount.canonical,
      allocationCommandSha256,
      exactTaskId,
      exactReceiptId,
      exactApproverUid,
      JSON.stringify(allocationEvidence),
    );
    const row = rows[0];
    if (rows.length !== 1
        || Number(row.billing_advance_id) !== advanceId
        || Number(row.source_authority_version) !== authority.base.order_version
        || String(row.source_authority_sha256) !== authority.base.order_items_sha256
        || String(row.allocation_command_sha256) !== allocationCommandSha256
        || Number(row.funding_task_id) !== exactTaskId
        || String(row.funding_approval_receipt_id) !== exactReceiptId
        || String(row.allocated_by).toLowerCase() !== exactApproverUid
        || authorityMoney12(
          row.allocated_amount,
          'persisted advance allocation amount',
          { positive: true },
        ).scaled !== reservation.amountScaled
        || stableJson(jsonObject(row.evidence)) !== stableJson(allocationEvidence)
        || !SHA256_PATTERN.test(String(row.evidence_sha256 || ''))) {
      throw AppError.conflict(
        'The patient advance reservation receipt does not match the approved tuple',
        'SUBSTITUTION_FUNDING_ALLOCATION_CONFLICT',
      );
    }
    allocations.push(Object.freeze({
      allocation_id: positiveBigintString(row.allocation_id, 'allocation_id'),
      billing_advance_id: advanceId,
      billing_advance_patient_uid: advancePatientUid,
      billing_advance_terminal_patient_uid: authority.base.patient_uid,
      allocated_amount: allocationAmount.canonical,
      allocation_command_sha256: allocationCommandSha256,
      allocation_evidence_sha256: String(row.evidence_sha256),
      source_authority_version: authority.base.order_version,
      source_authority_sha256: authority.base.order_items_sha256,
      allocated_by: exactApproverUid,
      allocated_at: row.allocated_at instanceof Date
        ? row.allocated_at.toISOString()
        : String(row.allocated_at),
    }));
  }
  return Object.freeze({
    required_amount: canonicalScaledDecimal(
      plan.patientAmountRequiredScaled,
      NUMERIC_12_2,
    ),
    allocation_ids: Object.freeze(allocations.map((row) => row.allocation_id)),
    allocations: Object.freeze(allocations),
    source_evidence_sha256: authority.funding.source_evidence_sha256,
  });
}

export async function consumeApprovedSubstitutionFundingReauthorisationTx() {
  throw AppError.conflict(
    'Substitution funding consumption is not wired to the immutable final-dispense mutation receipt',
    'SUBSTITUTION_FUNDING_ORDER_MUTATION_UNWIRED',
  );
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
  const billing = jsonObject(receipt.billing);
  const billingBase = jsonObject(billing.base);
  const billingProspective = jsonObject(billing.prospective);
  const billingBaseInvoice = jsonObject(billingBase.invoice);
  const billingBaseItem = jsonObject(billingBase.item);
  const billingProspectiveInvoice = jsonObject(billingProspective.invoice);
  const billingProspectiveItem = jsonObject(billingProspective.item);
  const funding = jsonObject(receipt.funding);
  const sourceEvidence = jsonObject(funding.source_evidence);
  const reservationEvidence = jsonObject(receipt.advance_reservations);
  const prospectiveTuple = { ...prospective };
  delete prospectiveTuple.prospective_fingerprint;
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
    return /^\d+$/.test(text) && BigInt(text) > 0n
      && BigInt(text) <= 9_223_372_036_854_775_807n;
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
  const exactSequence = (left, right) => Array.isArray(left)
    && left.length === right.length
    && left.every((entry, index) => String(entry) === String(right[index]));

  try {
    const expiry = new Date(String(receipt.expires_at || ''));
    const approved = new Date(String(receipt.approved_at || ''));
    const proposerUid = String(proposer.uid || '').toLowerCase();
    const approverUid = String(receipt.approver_uid || '').toLowerCase();
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

    const baseInvoiceSubtotal = money12(
      billingBaseInvoice.subtotal,
      'receipt base invoice subtotal',
    );
    const baseInvoiceCgst = money12(
      billingBaseInvoice.cgst_amount,
      'receipt base invoice CGST amount',
    );
    const baseInvoiceSgst = money12(
      billingBaseInvoice.sgst_amount,
      'receipt base invoice SGST amount',
    );
    const baseInvoiceIgst = money12(
      billingBaseInvoice.igst_amount,
      'receipt base invoice IGST amount',
    );
    const baseInvoiceTax = money12(
      billingBaseInvoice.tax_amount,
      'receipt base invoice tax amount',
    );
    const baseInvoiceDiscount = money12(
      billingBaseInvoice.discount_amount,
      'receipt base invoice discount amount',
    );
    const baseInvoiceCredit = money12(
      billingBaseInvoice.credit_note_amount,
      'receipt base invoice credit amount',
    );
    const baseInvoiceTotal = money12(
      billingBaseInvoice.total_amount,
      'receipt base invoice total',
    );
    const baseInvoicePaid = money12(
      billingBaseInvoice.amount_paid,
      'receipt base invoice paid amount',
    );
    const baseInvoiceDue = money12(
      billingBaseInvoice.amount_due,
      'receipt base invoice due amount',
    );
    const baseItemQuantity = money10(
      billingBaseItem.quantity,
      'receipt base invoice item quantity',
      { positive: true },
    );
    const baseItemUnitPrice = money12(
      billingBaseItem.unit_price,
      'receipt base invoice item unit price',
      { positive: true },
    );
    const baseItemGstRate = money10(
      billingBaseItem.gst_rate,
      'receipt base invoice item GST rate',
    );
    const baseItemSubtotal = money12(
      billingBaseItem.line_subtotal,
      'receipt base invoice item subtotal',
      { positive: true },
    );
    const baseItemCgst = money12(
      billingBaseItem.cgst_amount,
      'receipt base invoice item CGST amount',
    );
    const baseItemSgst = money12(
      billingBaseItem.sgst_amount,
      'receipt base invoice item SGST amount',
    );
    const baseItemIgst = money12(
      billingBaseItem.igst_amount,
      'receipt base invoice item IGST amount',
    );
    const baseItemTax = money12(
      billingBaseItem.tax_amount,
      'receipt base invoice item tax amount',
    );
    const baseItemTotal = money12(
      billingBaseItem.line_total,
      'receipt base invoice item total',
      { positive: true },
    );

    const targetInvoiceSubtotal = money12(
      billingProspectiveInvoice.subtotal,
      'receipt prospective invoice subtotal',
    );
    const targetInvoiceCgst = money12(
      billingProspectiveInvoice.cgst_amount,
      'receipt prospective invoice CGST amount',
    );
    const targetInvoiceSgst = money12(
      billingProspectiveInvoice.sgst_amount,
      'receipt prospective invoice SGST amount',
    );
    const targetInvoiceIgst = money12(
      billingProspectiveInvoice.igst_amount,
      'receipt prospective invoice IGST amount',
    );
    const targetInvoiceTax = money12(
      billingProspectiveInvoice.tax_amount,
      'receipt prospective invoice tax amount',
    );
    const targetInvoiceDiscount = money12(
      billingProspectiveInvoice.discount_amount,
      'receipt prospective invoice discount amount',
    );
    const targetInvoiceCredit = money12(
      billingProspectiveInvoice.credit_note_amount,
      'receipt prospective invoice credit amount',
    );
    const targetInvoiceTotal = money12(
      billingProspectiveInvoice.total_amount,
      'receipt prospective invoice total',
    );
    const targetInvoicePaid = money12(
      billingProspectiveInvoice.amount_paid,
      'receipt prospective invoice paid amount',
    );
    const targetInvoiceDue = money12(
      billingProspectiveInvoice.amount_due,
      'receipt prospective invoice due amount',
    );
    const targetItemQuantity = money10(
      billingProspectiveItem.quantity,
      'receipt prospective invoice item quantity',
      { positive: true },
    );
    const targetItemUnitPrice = money12(
      billingProspectiveItem.unit_price,
      'receipt prospective invoice item unit price',
      { positive: true },
    );
    const targetItemGstRate = money10(
      billingProspectiveItem.gst_rate,
      'receipt prospective invoice item GST rate',
    );
    const targetItemSubtotal = money12(
      billingProspectiveItem.line_subtotal,
      'receipt prospective invoice item subtotal',
      { positive: true },
    );
    const targetItemCgst = money12(
      billingProspectiveItem.cgst_amount,
      'receipt prospective invoice item CGST amount',
    );
    const targetItemSgst = money12(
      billingProspectiveItem.sgst_amount,
      'receipt prospective invoice item SGST amount',
    );
    const targetItemIgst = money12(
      billingProspectiveItem.igst_amount,
      'receipt prospective invoice item IGST amount',
    );
    const targetItemTax = money12(
      billingProspectiveItem.tax_amount,
      'receipt prospective invoice item tax amount',
    );
    const targetItemTotal = money12(
      billingProspectiveItem.line_total,
      'receipt prospective invoice item total',
      { positive: true },
    );

    const lockedTpa = money12(
      funding.locked_approved_tpa_amount,
      'receipt locked TPA amount',
    );
    const tpaUsed = money12(funding.tpa_used_amount, 'receipt TPA used amount');
    const patientRequired = money12(
      funding.patient_payment_required_amount,
      'receipt patient advance amount',
    );
    const originalAmount = money12(
      funding.patient_advance_original_amount,
      'receipt patient advance original amount',
    );
    const currentBalance = money12(
      funding.patient_advance_balance_amount,
      'receipt patient advance balance amount',
    );
    const settlementTotal = money12(
      funding.advance_settlement_amount,
      'receipt advance settlement amount',
    );
    const refundTotal = money12(
      funding.active_refund_reservation_amount,
      'receipt advance refund reservation amount',
    );
    const liveAllocationTotal = money12(
      funding.live_advance_allocation_amount,
      'receipt live advance allocation amount',
    );
    const availablePatient = money12(
      funding.available_patient_advance_amount,
      'receipt available patient advance amount',
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

    const advances = Array.isArray(sourceEvidence.advances)
      ? sourceEvidence.advances : null;
    const settlements = Array.isArray(sourceEvidence.settlements)
      ? sourceEvidence.settlements : null;
    const refunds = Array.isArray(sourceEvidence.refunds)
      ? sourceEvidence.refunds : null;
    const priorAllocations = Array.isArray(sourceEvidence.allocations)
      ? sourceEvidence.allocations : null;
    const reversals = Array.isArray(sourceEvidence.reversals)
      ? sourceEvidence.reversals : null;
    const tpaDecisions = Array.isArray(sourceEvidence.tpa_decisions)
      ? sourceEvidence.tpa_decisions : null;
    const approvedAllocations = Array.isArray(reservationEvidence.allocations)
      ? reservationEvidence.allocations : null;
    const patientUidFamily = Array.isArray(sourceEvidence.patient_uid_family)
      ? sourceEvidence.patient_uid_family.map((uid) => String(uid).toLowerCase())
      : null;
    if (!advances || !settlements || !refunds || !priorAllocations
        || !reversals || !tpaDecisions || !approvedAllocations
        || !patientUidFamily
        || !Array.isArray(reservationEvidence.allocation_ids)) throw invalid();
    const fundingPatientUid = String(sourceEvidence.funding_patient_uid || '').toLowerCase();
    if (!UUID_PATTERN.test(fundingPatientUid)
        || patientUidFamily[0] !== fundingPatientUid
        || new Set(patientUidFamily).size !== patientUidFamily.length
        || patientUidFamily.some((uid) => !UUID_PATTERN.test(uid))
        || !exactSequence(
          patientUidFamily.slice(1),
          [...patientUidFamily.slice(1)].sort(),
        )) throw invalid();
    const fundingAdmissionId = sourceEvidence.funding_admission_id == null
      ? null : sourceEvidence.funding_admission_id;
    const fundingAdmissionPatientUid = sourceEvidence.funding_admission_patient_uid == null
      ? null : String(sourceEvidence.funding_admission_patient_uid).toLowerCase();
    const fundingAdmissionStartedAt = sourceEvidence.funding_admission_started_at == null
      ? null : new Date(sourceEvidence.funding_admission_started_at);
    if (base.admission_id == null
      ? fundingAdmissionId != null
        || fundingAdmissionPatientUid != null
        || fundingAdmissionStartedAt != null
      : !exactInt4(fundingAdmissionId)
        || String(fundingAdmissionId) !== String(base.admission_id)
        || !patientUidFamily.includes(fundingAdmissionPatientUid)
        || !(fundingAdmissionStartedAt instanceof Date)
        || Number.isNaN(fundingAdmissionStartedAt.getTime())
        || fundingAdmissionStartedAt.toISOString()
          !== String(sourceEvidence.funding_admission_started_at)) throw invalid();

    const advanceIds = [];
    const advancePatientUidById = new Map();
    const selectedAdvanceIds = [];
    let evidencedOriginal = 0n;
    let evidencedBalance = 0n;
    let evidencedSettlements = 0n;
    let evidencedRefunds = 0n;
    let evidencedLiveAllocations = 0n;
    let evidencedAvailable = 0n;
    let evidencedSelected = 0n;
    for (const value of advances) {
      const advance = jsonObject(value);
      const storedPatientUid = String(advance.stored_patient_uid || '').toLowerCase();
      const advanceAdmissionId = advance.admission_id == null ? null : advance.admission_id;
      const collectedAt = advance.collected_at == null ? null : new Date(advance.collected_at);
      if (!exactInt4(advance.billing_advance_id)
          || advanceIds.includes(String(advance.billing_advance_id))
          || (advanceIds.length > 0
            && Number(advanceIds[advanceIds.length - 1]) >= Number(advance.billing_advance_id))
          || !patientUidFamily.includes(storedPatientUid)
          || (advanceAdmissionId != null && !exactInt4(advanceAdmissionId))
          || (collectedAt != null
            && (Number.isNaN(collectedAt.getTime())
              || collectedAt.toISOString() !== String(advance.collected_at)))
          || (base.admission_id == null
            ? advanceAdmissionId != null
            : advanceAdmissionId == null
              ? collectedAt == null
                || collectedAt.getTime() > fundingAdmissionStartedAt.getTime()
              : String(advanceAdmissionId) !== String(base.admission_id))
          || !PATIENT_ADVANCE_RAILS.has(String(advance.mode || '').toUpperCase())) {
        throw invalid();
      }
      const amount = money12(
        advance.amount,
        'receipt advance original amount',
        { positive: true },
      );
      const balance = money12(advance.balance, 'receipt advance balance amount');
      const settled = money12(
        advance.settled_amount,
        'receipt advance settled amount',
      );
      const refunded = money12(
        advance.active_refund_reservation_amount,
        'receipt advance refund amount',
      );
      const live = money12(
        advance.live_allocation_amount,
        'receipt advance live allocation amount',
      );
      const available = money12(
        advance.available_amount,
        'receipt advance available amount',
      );
      const selected = money12(
        advance.selected_reservation_amount,
        'receipt selected advance amount',
      );
      const grossAvailable = balance.scaled < amount.scaled - settled.scaled - refunded.scaled
        ? balance.scaled
        : amount.scaled - settled.scaled - refunded.scaled;
      if (balance.scaled > amount.scaled
          || settled.scaled + refunded.scaled > amount.scaled
          || live.scaled > grossAvailable
          || available.scaled !== grossAvailable - live.scaled
          || selected.scaled > available.scaled) throw invalid();
      advanceIds.push(String(advance.billing_advance_id));
      advancePatientUidById.set(String(advance.billing_advance_id), storedPatientUid);
      if (selected.scaled > 0n) selectedAdvanceIds.push(String(advance.billing_advance_id));
      evidencedOriginal += amount.scaled;
      evidencedBalance += balance.scaled;
      evidencedSettlements += settled.scaled;
      evidencedRefunds += refunded.scaled;
      evidencedLiveAllocations += live.scaled;
      evidencedAvailable += available.scaled;
      evidencedSelected += selected.scaled;
    }
    for (const total of [
      evidencedOriginal,
      evidencedBalance,
      evidencedSettlements,
      evidencedRefunds,
      evidencedLiveAllocations,
      evidencedAvailable,
      evidencedSelected,
    ]) checkedMoney12(total, 'receipt advance evidence total');

    const settlementIds = settlements.map((value) => {
      const settlement = jsonObject(value);
      money12(settlement.amount, 'receipt settlement source amount', { positive: true });
      if (!exactInt4(settlement.settlement_id)
          || !exactInt4(settlement.billing_advance_id)
          || !advanceIds.includes(String(settlement.billing_advance_id))) throw invalid();
      return String(settlement.settlement_id);
    });
    const refundIds = refunds.map((value) => {
      const refund = jsonObject(value);
      money12(refund.amount, 'receipt refund source amount', { positive: true });
      if (!exactInt4(refund.refund_id)
          || !exactInt4(refund.billing_advance_id)
          || !advanceIds.includes(String(refund.billing_advance_id))
          || String(refund.approval_status || '') === 'REJECTED') {
        throw invalid();
      }
      return String(refund.refund_id);
    });
    const priorAllocationIds = priorAllocations.map((value) => {
      const allocation = jsonObject(value);
      const allocated = money12(
        allocation.allocated_amount,
        'receipt prior advance allocation amount',
        { positive: true },
      );
      const reversed = money12(
        allocation.reversed_amount,
        'receipt prior advance reversal amount',
      );
      const net = money12(allocation.net_amount, 'receipt prior advance net amount');
      if (!exactBigserial(allocation.allocation_id)
          || !exactInt4(allocation.billing_advance_id)
          || !advanceIds.includes(String(allocation.billing_advance_id))
          || reversed.scaled > allocated.scaled
          || net.scaled !== allocated.scaled - reversed.scaled
          || !SHA256_PATTERN.test(String(allocation.evidence_sha256 || ''))) throw invalid();
      return String(allocation.allocation_id);
    });
    const reversalIds = reversals.map((value) => {
      const reversal = jsonObject(value);
      money12(reversal.reversed_amount, 'receipt advance reversal amount', { positive: true });
      if (!exactBigserial(reversal.reversal_id)
          || !exactBigserial(reversal.allocation_id)
          || !SHA256_PATTERN.test(String(reversal.reversal_command_sha256 || ''))
          || !SHA256_PATTERN.test(String(reversal.evidence_sha256 || ''))) throw invalid();
      return String(reversal.reversal_id);
    });

    const tpaDecisionIds = [];
    let exactTpaDecisionAmount = null;
    for (const value of tpaDecisions) {
      const decision = jsonObject(value);
      if (!exactInt4(decision.tpa_decision_id)
          || !exactInt4(decision.invoice_item_id)) throw invalid();
      const amount = money12(decision.approved_amount, 'receipt TPA decision amount');
      money12(decision.non_payable_amount, 'receipt TPA non-payable amount');
      if (String(decision.tpa_decision_id) === String(funding.tpa_decision_id)) {
        exactTpaDecisionAmount = amount.scaled;
      }
      tpaDecisionIds.push(String(decision.tpa_decision_id));
    }

    const approvedAllocationIds = [];
    const approvedAdvanceIds = [];
    let approvedAllocationTotal = 0n;
    for (const value of approvedAllocations) {
      const allocation = jsonObject(value);
      if (!exactBigserial(allocation.allocation_id)
          || !exactInt4(allocation.billing_advance_id)
          || approvedAllocationIds.includes(String(allocation.allocation_id))
          || approvedAdvanceIds.includes(String(allocation.billing_advance_id))
          || (approvedAdvanceIds.length > 0
            && Number(approvedAdvanceIds[approvedAdvanceIds.length - 1])
              >= Number(allocation.billing_advance_id))
          || !selectedAdvanceIds.includes(String(allocation.billing_advance_id))
          || String(allocation.billing_advance_patient_uid || '').toLowerCase()
            !== advancePatientUidById.get(String(allocation.billing_advance_id))
          || String(allocation.billing_advance_terminal_patient_uid || '').toLowerCase()
            !== fundingPatientUid
          || !SHA256_PATTERN.test(String(allocation.allocation_command_sha256 || ''))
          || !SHA256_PATTERN.test(String(allocation.allocation_evidence_sha256 || ''))
          || Number(allocation.source_authority_version) !== Number(base.order_version)
          || String(allocation.source_authority_sha256) !== base.order_items_sha256
          || String(allocation.allocated_by || '').toLowerCase() !== approverUid) {
        throw invalid();
      }
      approvedAllocationTotal += money12(
        allocation.allocated_amount,
        'receipt approved advance allocation amount',
        { positive: true },
      ).scaled;
      approvedAllocationIds.push(String(allocation.allocation_id));
      approvedAdvanceIds.push(String(allocation.billing_advance_id));
    }
    checkedMoney12(approvedAllocationTotal, 'receipt approved allocation total');
    const reservationEvidenceRequired = money12(
      reservationEvidence.required_amount,
      'receipt advance reservation required amount',
    );

    const receiptClaimId = receipt.tpa_claim_id == null
      ? null : String(receipt.tpa_claim_id);
    const fundingClaimId = funding.tpa_claim_id == null
      ? null : String(funding.tpa_claim_id);
    const fundingDecisionId = funding.tpa_decision_id == null
      ? null : String(funding.tpa_decision_id);
    const derivedSource = tpaUsed.scaled > 0n
      ? patientRequired.scaled > 0n ? 'mixed' : 'tpa_claim'
      : 'patient_advance';

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
        || String(base.patient_uid).toLowerCase() !== fundingPatientUid
        || !exactInt4(base.facility_id)
        || !exactBigserial(base.facility_grant_id)
        || String(base.facility_grant_id) !== String(proposer.facility_grant_id || '')
        || !DISPENSABLE_ORDER_STATUSES.has(String(base.order_status || '').toUpperCase())
        || !exactInt4(base.order_version)
        || !Array.isArray(base.items_list)
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
        || !Array.isArray(prospective.items_list)
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
        || billing.contract !== 'pharmacy_substitution_funding_billing_v1'
        || String(billing.invoice_id) !== String(receipt.invoice_id)
        || String(billing.invoice_item_id) !== String(receipt.invoice_item_id)
        || billingBaseInvoice.status !== 'DRAFT'
        || billingBaseInvoice.invoice_number != null
        || billingBaseInvoice.issued_at != null
        || billingBaseInvoice.voided_at != null
        || baseInvoiceTax.scaled
          !== baseInvoiceCgst.scaled + baseInvoiceSgst.scaled + baseInvoiceIgst.scaled
        || baseInvoiceTotal.scaled
          !== baseInvoiceSubtotal.scaled + baseInvoiceTax.scaled - baseInvoiceDiscount.scaled
        || baseInvoiceDue.scaled !== (baseInvoiceTotal.scaled
          - baseInvoiceCredit.scaled - baseInvoicePaid.scaled > 0n
          ? baseInvoiceTotal.scaled - baseInvoiceCredit.scaled - baseInvoicePaid.scaled
          : 0n)
        || baseInvoicePaid.scaled !== 0n
        || baseInvoiceCredit.scaled !== 0n
        || baseItemQuantity.canonical !== '1.00'
        || baseItemUnitPrice.scaled !== baseAmount.scaled
        || baseItemGstRate.scaled !== 0n
        || baseItemSubtotal.scaled !== baseAmount.scaled
        || baseItemTax.scaled !== baseItemCgst.scaled
          + baseItemSgst.scaled + baseItemIgst.scaled
        || baseItemTax.scaled !== 0n
        || baseItemTotal.scaled !== baseAmount.scaled
        || billingBaseItem.source_ref_type !== 'pharmacy_order'
        || String(billingBaseItem.source_ref_id) !== String(base.pharmacy_order_id)
        || billingBaseItem.source_ref_active !== true
        || Number(billingBaseItem.source_authority_version) !== Number(base.order_version)
        || billingBaseItem.source_authority_sha256 !== base.order_items_sha256
        || billingProspectiveInvoice.status !== 'DRAFT'
        || billingProspectiveInvoice.invoice_number != null
        || billingProspectiveInvoice.issued_at != null
        || billingProspectiveInvoice.voided_at != null
        || targetInvoiceTax.scaled
          !== targetInvoiceCgst.scaled + targetInvoiceSgst.scaled + targetInvoiceIgst.scaled
        || targetInvoiceSubtotal.scaled
          !== baseInvoiceSubtotal.scaled - baseItemSubtotal.scaled + prospectiveAmount.scaled
        || targetInvoiceCgst.scaled !== baseInvoiceCgst.scaled - baseItemCgst.scaled
        || targetInvoiceSgst.scaled !== baseInvoiceSgst.scaled - baseItemSgst.scaled
        || targetInvoiceIgst.scaled !== baseInvoiceIgst.scaled - baseItemIgst.scaled
        || targetInvoiceDiscount.scaled !== baseInvoiceDiscount.scaled
        || targetInvoiceCredit.scaled !== baseInvoiceCredit.scaled
        || targetInvoicePaid.scaled !== baseInvoicePaid.scaled
        || targetInvoiceTotal.scaled
          !== targetInvoiceSubtotal.scaled + targetInvoiceTax.scaled
            - targetInvoiceDiscount.scaled
        || targetInvoiceDue.scaled !== (targetInvoiceTotal.scaled
          - targetInvoiceCredit.scaled - targetInvoicePaid.scaled > 0n
          ? targetInvoiceTotal.scaled - targetInvoiceCredit.scaled
            - targetInvoicePaid.scaled
          : 0n)
        || targetItemQuantity.canonical !== '1.00'
        || targetItemUnitPrice.scaled !== prospectiveAmount.scaled
        || targetItemGstRate.scaled !== 0n
        || targetItemSubtotal.scaled !== prospectiveAmount.scaled
        || targetItemTax.scaled !== targetItemCgst.scaled
          + targetItemSgst.scaled + targetItemIgst.scaled
        || targetItemTax.scaled !== 0n
        || targetItemTotal.scaled !== prospectiveAmount.scaled
        || billingProspectiveItem.source_ref_type !== 'pharmacy_order'
        || String(billingProspectiveItem.source_ref_id) !== String(base.pharmacy_order_id)
        || billingProspectiveItem.source_ref_active !== true
        || Number(billingProspectiveItem.source_authority_version)
          !== Number(prospective.order_version)
        || billingProspectiveItem.source_authority_sha256
          !== prospective.order_items_sha256
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
        || !SHA256_PATTERN.test(String(funding.source_evidence_sha256 || ''))
        || sourceEvidence.contract !== 'pharmacy_substitution_advance_sources_v1'
        || (fundingClaimId == null
          ? sourceEvidence.tpa_claim_patient_uid != null
          : !UUID_PATTERN.test(String(sourceEvidence.tpa_claim_patient_uid || ''))
            || !patientUidFamily.includes(
              String(sourceEvidence.tpa_claim_patient_uid).toLowerCase(),
            ))
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
        || !exactSequence(sourceEvidence.tpa_decision_ids, tpaDecisionIds)
        || !exactSequence(sourceEvidence.advance_ids, advanceIds)
        || !exactSequence(sourceEvidence.selected_advance_ids, selectedAdvanceIds)
        || !exactSequence(sourceEvidence.settlement_ids, settlementIds)
        || !exactSequence(sourceEvidence.refund_ids, refundIds)
        || !exactSequence(sourceEvidence.allocation_ids, priorAllocationIds)
        || !exactSequence(sourceEvidence.reversal_ids, reversalIds)
        || evidencedOriginal !== originalAmount.scaled
        || evidencedBalance !== currentBalance.scaled
        || evidencedSettlements !== settlementTotal.scaled
        || evidencedRefunds !== refundTotal.scaled
        || evidencedLiveAllocations !== liveAllocationTotal.scaled
        || evidencedAvailable !== availablePatient.scaled
        || evidencedSelected !== patientRequired.scaled
        || reservationRequired.scaled !== patientRequired.scaled
        || reservationEvidenceRequired.scaled !== patientRequired.scaled
        || approvedAllocationTotal !== patientRequired.scaled
        || !exactSequence(
          reservationEvidence.allocation_ids,
          approvedAllocationIds,
        )
        || !exactSequence(selectedAdvanceIds, approvedAdvanceIds)
        || String(reservationEvidence.source_evidence_sha256)
          !== String(funding.source_evidence_sha256)
        || tpaUsed.scaled > lockedTpa.scaled
        || tpaUsed.scaled > prospectiveAmount.scaled
        || patientRequired.scaled !== prospectiveAmount.scaled - tpaUsed.scaled
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
