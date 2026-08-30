import {
  approvedSubstitutionFundingReceiptContract,
  normalizeSubstitutionFundingSelector,
  substitutionFundingNumericTesting,
  substitutionFundingApprovalCommandKey,
  substitutionFundingMaterializationKey,
  substitutionFundingReauthorisationEvidenceSnapshot,
  SUBSTITUTION_FUNDING_APPROVER_ROLES,
  SUBSTITUTION_FUNDING_PAYMENT_APPROVER_ROLES,
  SUBSTITUTION_FUNDING_PROPOSER_ROLES,
  SUBSTITUTION_FUNDING_TPA_APPROVER_ROLES,
} from '../../services/pharmacy/substitutionFundingReauthorisationService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '00000000-0000-4000-8000-000000000002';
const PROPOSER = '11111111-1111-4111-8111-111111111111';
const OTHER_PROPOSER = '22222222-2222-4222-8222-222222222222';

function expectErrorCode(callback, code) {
  try {
    callback();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code}`);
}

test('exports only the canonical proposer and source-specific finance role sets', () => {
  expect(SUBSTITUTION_FUNDING_PROPOSER_ROLES).toEqual([
    'PHARMACY_STAFF', 'PHARMACY_INCHARGE',
  ]);
  expect(SUBSTITUTION_FUNDING_TPA_APPROVER_ROLES).toEqual([
    'INSURANCE_COORDINATOR', 'CLAIMS_MANAGER', 'FINANCE_INCHARGE',
  ]);
  expect(SUBSTITUTION_FUNDING_PAYMENT_APPROVER_ROLES).toEqual([
    'FINANCE_INCHARGE', 'BILLING_INCHARGE',
  ]);
  expect(SUBSTITUTION_FUNDING_APPROVER_ROLES).toEqual([
    'INSURANCE_COORDINATOR', 'CLAIMS_MANAGER', 'FINANCE_INCHARGE', 'BILLING_INCHARGE',
  ]);
  expect(SUBSTITUTION_FUNDING_APPROVER_ROLES).not.toContain('ADMIN');
  expect(SUBSTITUTION_FUNDING_APPROVER_ROLES).not.toContain('SUPER_ADMIN');
});

test('normalizes the selector while rejecting every authority-bearing extra field', () => {
  expect(normalizeSubstitutionFundingSelector({
    order_line_index: '0',
    final_catalog_id: '51',
    inventory_item_id: 61,
    inventory_batch_id: 71,
    quantity: '2.5000',
  })).toEqual({
    order_line_index: 0,
    final_catalog_id: 51,
    inventory_item_id: 61,
    inventory_batch_id: 71,
    quantity: '2.5000',
  });

  for (const extra of [
    'patient_uid', 'facility_id', 'prescription_id', 'unit_price', 'payment_mode',
    'invoice_item_id', 'tpa_claim_id', 'approver_uid',
  ]) {
    expectErrorCode(() => normalizeSubstitutionFundingSelector({
      order_line_index: 0,
      final_catalog_id: 51,
      inventory_item_id: 61,
      inventory_batch_id: 71,
      quantity: 1,
      [extra]: 'caller-selected',
    }), 'SUBSTITUTION_FUNDING_CALLER_AUTHORITY_FORBIDDEN');
  }
});

test('uses exact scaled decimals, schema bounds and half-up minor-unit projection', () => {
  expect(substitutionFundingNumericTesting.canonicalQuantity('2.5')).toBe('2.5000');
  expect(substitutionFundingNumericTesting.canonicalMoney12('9999999999.99')).toBe(
    '9999999999.99',
  );
  expect(substitutionFundingNumericTesting.canonicalMoney10('99999999.99')).toBe(
    '99999999.99',
  );
  expect(substitutionFundingNumericTesting.projectedSubtotal('0.5000', '0.01')).toBe(
    '0.01',
  );
  expect(substitutionFundingNumericTesting.projectedSubtotal('0.4999', '0.01')).toBe(
    '0.00',
  );
  for (const invalid of ['1.00001', '1e2', '-1', '10000000000.00']) {
    expectErrorCode(
      () => substitutionFundingNumericTesting.canonicalMoney12(invalid),
      'SUBSTITUTION_FUNDING_AUTHORITY_DRIFT',
    );
  }
  expectErrorCode(
    () => substitutionFundingNumericTesting.canonicalMoney10('100000000.00'),
    'SUBSTITUTION_FUNDING_AUTHORITY_DRIFT',
  );
});

test('materialization and command keys are deterministic and tenant/actor scoped', () => {
  const input = {
    tenantId: TENANT,
    proposerUid: PROPOSER,
    idempotencyKey: 'proposal-1',
  };
  expect(substitutionFundingMaterializationKey(input)).toBe(
    substitutionFundingMaterializationKey({ ...input }),
  );
  expect(substitutionFundingMaterializationKey(input)).not.toBe(
    substitutionFundingMaterializationKey({ ...input, tenantId: OTHER_TENANT }),
  );
  expect(substitutionFundingMaterializationKey(input)).not.toBe(
    substitutionFundingMaterializationKey({ ...input, proposerUid: OTHER_PROPOSER }),
  );
  expect(substitutionFundingApprovalCommandKey({ tenantId: TENANT, approvalId: 73 })).toBe(
    substitutionFundingApprovalCommandKey({ tenantId: TENANT, approvalId: 73 }),
  );
  expect(substitutionFundingApprovalCommandKey({ tenantId: TENANT, approvalId: 73 })).not.toBe(
    substitutionFundingApprovalCommandKey({ tenantId: TENANT, approvalId: 74 }),
  );
});

test('does not accept caller-forged approved receipts or opaque consumption evidence', () => {
  expectErrorCode(() => approvedSubstitutionFundingReceiptContract({
    approval_id: 73,
    approval_status: 'approved',
  }), 'SUBSTITUTION_FUNDING_APPROVAL_RECEIPT_INVALID');
  expectErrorCode(() => substitutionFundingReauthorisationEvidenceSnapshot({
    snapshot: { approval_id: 73 },
  }), 'SUBSTITUTION_FUNDING_EVIDENCE_INVALID');
});
