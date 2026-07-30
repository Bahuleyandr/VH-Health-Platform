import {
  canonicalTimestamp,
  exactKeys,
  normalizeFacilityId,
  normalizeTenantId,
} from './constants.mjs';
import { readProtectedJson } from './json-files.mjs';

export const ACTIVATION_RECEIPT_FORMAT =
  'vhhealth_continuity_edge_activation_receipt/v1';

const RECEIPT_KEYS = [
  'approvedAt',
  'approvedBy',
  'cD10Countersignature',
  'cD4Countersignature',
  'edgeHostAssetId',
  'facilityId',
  'format',
  'loggingIdentityApproval',
  'outageDrillReceipt',
  'storageReceipt',
  'tenantId',
];

function evidence(value, label) {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length < 3 ||
    /OWNER_INPUT|PLACEHOLDER|TBD/i.test(value)
  ) {
    throw new Error(`${label} is not completed`);
  }
  return value;
}

export function verifyActivationReceipt(receipt, scope) {
  if (
    !exactKeys(receipt, RECEIPT_KEYS) ||
    receipt.format !== ACTIVATION_RECEIPT_FORMAT ||
    normalizeTenantId(receipt.tenantId) !==
      normalizeTenantId(scope.tenantId) ||
    normalizeFacilityId(receipt.facilityId) !==
      normalizeFacilityId(scope.facilityId) ||
    !Array.isArray(receipt.approvedBy) ||
    receipt.approvedBy.length !== 4
  ) {
    throw new Error('ACTIVATION_RECEIPT_INVALID');
  }
  for (const [index, approver] of receipt.approvedBy.entries()) {
    evidence(approver, `approvedBy[${index}]`);
  }
  for (const key of [
    'edgeHostAssetId',
    'storageReceipt',
    'cD4Countersignature',
    'cD10Countersignature',
    'loggingIdentityApproval',
    'outageDrillReceipt',
  ]) {
    evidence(receipt[key], key);
  }
  canonicalTimestamp(receipt.approvedAt, 'approvedAt');
  return { ok: true, receipt };
}

export async function loadAndVerifyActivationReceipt(file, scope) {
  return verifyActivationReceipt(
    await readProtectedJson(file, { label: 'activation receipt' }),
    scope,
  );
}
