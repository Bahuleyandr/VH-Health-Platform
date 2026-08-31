import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { fingerprintMarAdministrationRequest } from '../../services/clinical/marAdministrationCommandService.js';
import { fingerprintMarTransitionRequest } from '../../services/clinical/marTransitionCommandService.js';
import {
  marAdministerIdempotencyBody,
  marAdministerWithScanIdempotencyBody,
  marExceptionClaimIdempotencyBody,
  marExceptionDispositionIdempotencyBody,
  marSupplyReconciliationIdempotencyBody,
  marTransitionIdempotencyBody,
} from '../../routes/clinical/marIdempotencyProjection.js';

const PATIENT_UID = '10000000-0000-4000-8000-000000000001';
const WITNESS_UID = '10000000-0000-4000-8000-000000000002';

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function request(body, params = {}) {
  return { body, params };
}

describe('MAR idempotency request projections', () => {
  test('no-scan administration ignores JSON key order and matches the durable command fingerprint', () => {
    const first = marAdministerIdempotencyBody(request({
      notes: '  identity confirmed at bedside  ',
      witness_uid: WITNESS_UID,
      override_reason: '  Scanner battery unavailable  ',
      supply_override_reason: '  Ward custody evidence pending  ',
      supply_quantity: 1,
    }));
    const reordered = marAdministerIdempotencyBody(request({
      supply_quantity: 1,
      supply_override_reason: 'Ward custody evidence pending',
      override_reason: 'Scanner battery unavailable',
      witness_uid: WITNESS_UID,
      notes: 'identity confirmed at bedside',
    }));

    expect(fingerprint(first)).toBe(fingerprint(reordered));
    expect(fingerprint(first)).toBe(fingerprintMarAdministrationRequest(first));
    expect(fingerprint(marAdministerIdempotencyBody(request({
      ...reordered,
      override_reason: 'A different clinical override',
    })))).not.toBe(fingerprint(first));
  });

  test('scan administration is order-insensitive but every consumed clinical field is identity-bearing', () => {
    const body = {
      scanned_patient_uid: PATIENT_UID,
      scanned_barcode: 'MED03-BATCH-001',
      witness_uid: WITNESS_UID,
      override_reason: null,
      supply_override_reason: null,
      supply_quantity: 1,
    };
    const reordered = {
      supply_quantity: 1,
      override_reason: null,
      scanned_barcode: 'MED03-BATCH-001',
      supply_override_reason: null,
      witness_uid: WITNESS_UID,
      scanned_patient_uid: PATIENT_UID,
    };
    const projected = marAdministerWithScanIdempotencyBody(request(body));

    expect(fingerprint(projected)).toBe(fingerprint(
      marAdministerWithScanIdempotencyBody(request(reordered)),
    ));
    expect(fingerprint(projected)).toBe(fingerprintMarAdministrationRequest(projected));
    for (const [field, value] of [
      ['scanned_patient_uid', WITNESS_UID],
      ['scanned_barcode', 'MED03-BATCH-002'],
      ['witness_uid', PATIENT_UID],
      ['override_reason', 'Late administration approved'],
      ['supply_override_reason', 'Exact custody temporarily unavailable'],
      ['supply_quantity', 2],
    ]) {
      const changed = marAdministerWithScanIdempotencyBody(request({ ...body, [field]: value }));
      expect(fingerprint(changed)).not.toBe(fingerprint(projected));
    }
  });

  test('transition reason is normalized once and remains identity-bearing', () => {
    const first = marTransitionIdempotencyBody(request({
      reason: '  Awaiting prescriber review  ',
      client_metadata: { offline: true },
    }));
    const sameEffect = marTransitionIdempotencyBody(request({
      client_metadata: { offline: false },
      reason: 'Awaiting prescriber review',
    }));

    expect(fingerprint(first)).toBe(fingerprint(sameEffect));
    expect(fingerprint(first)).toBe(fingerprintMarTransitionRequest(first));
    expect(fingerprint(marTransitionIdempotencyBody(request({
      reason: 'Patient declined after counselling',
    })))).not.toBe(fingerprint(first));
  });

  test('exception disposition binds the case, bounded decision, reason, and replacement evidence', () => {
    const first = marExceptionDispositionIdempotencyBody(request({
      disposition: '  REPLACEMENT_ORDERED  ',
      reason: '  Replacement prescribed through CPOE  ',
      replacement_clinical_order_id: '91',
      client_metadata: { offline: true },
    }, { caseId: '73' }));
    const sameEffect = marExceptionDispositionIdempotencyBody(request({
      client_metadata: { offline: false },
      replacement_clinical_order_id: 91,
      reason: 'Replacement prescribed through CPOE',
      disposition: 'replacement_ordered',
    }, { caseId: '73' }));

    expect(first).toEqual({
      exception_case_id: '73',
      disposition: 'replacement_ordered',
      reason: 'Replacement prescribed through CPOE',
      replacement_clinical_order_id: 91,
    });
    expect(fingerprint(first)).toBe(fingerprint(sameEffect));
    for (const changed of [
      request({ ...first, disposition: 'reviewed_no_replacement' }, { caseId: '73' }),
      request({ ...first, reason: 'Different clinical review' }, { caseId: '73' }),
      request({ ...first, replacement_clinical_order_id: 92 }, { caseId: '73' }),
      request({ ...first }, { caseId: '74' }),
    ]) {
      expect(fingerprint(marExceptionDispositionIdempotencyBody(changed)))
        .not.toBe(fingerprint(first));
    }
  });

  test('exception claim identity is the exact case and ignores an empty body', () => {
    const first = marExceptionClaimIdempotencyBody(request({}, { caseId: '73' }));
    const same = marExceptionClaimIdempotencyBody(request({}, { caseId: '73' }));
    const changed = marExceptionClaimIdempotencyBody(request({}, { caseId: '74' }));

    expect(first).toEqual({ exception_case_id: '73' });
    expect(fingerprint(first)).toBe(fingerprint(same));
    expect(fingerprint(first)).not.toBe(fingerprint(changed));
    expect(marExceptionClaimIdempotencyBody(request({}, {
      caseId: '9007199254740993',
    }))).toEqual({ exception_case_id: '9007199254740993' });
  });

  test('supply reconciliation merges duplicate allocations, sorts them, and binds path identity', () => {
    const first = marSupplyReconciliationIdempotencyBody(request({
      allocations: [
        { inventory_allocation_id: '8', quantity: 0.25 },
        { inventory_allocation_id: '7', quantity: 1 },
        { inventory_allocation_id: '8', quantity: 0.25 },
      ],
      client_metadata: { offline: true },
    }, { id: '42', consumptionId: '9001' }));
    const reordered = marSupplyReconciliationIdempotencyBody(request({
      client_metadata: { offline: false },
      allocations: [
        { quantity: 0.5, inventory_allocation_id: '8' },
        { quantity: 1, inventory_allocation_id: '7' },
      ],
    }, { consumptionId: '9001', id: '42' }));

    expect(first).toEqual({
      consumption_id: '9001',
      expected_medication_administration_id: 42,
      allocations: [
        { inventory_allocation_id: '7', quantity: '1.0000' },
        { inventory_allocation_id: '8', quantity: '0.5000' },
      ],
    });
    expect(fingerprint(first)).toBe(fingerprint(reordered));

    for (const changed of [
      request({ allocations: [{ inventory_allocation_id: '7', quantity: 1.25 }] }, {
        id: '42', consumptionId: '9001',
      }),
      request({ allocations: [{ inventory_allocation_id: '7', quantity: 1 }] }, {
        id: '43', consumptionId: '9001',
      }),
      request({ allocations: [{ inventory_allocation_id: '7', quantity: 1 }] }, {
        id: '42', consumptionId: '9002',
      }),
    ]) {
      expect(fingerprint(marSupplyReconciliationIdempotencyBody(changed)))
        .not.toBe(fingerprint(first));
    }
  });

  test('supply reconciliation rejects numeric and overflowing wire identifiers', () => {
    for (const req of [
      request({ allocations: [{ inventory_allocation_id: '7', quantity: 1 }] }, {
        id: '2147483648', consumptionId: '9',
      }),
      request({ allocations: [{ inventory_allocation_id: '7', quantity: 1 }] }, {
        id: '42', consumptionId: '9223372036854775808',
      }),
      request({ allocations: [{ inventory_allocation_id: 7, quantity: 1 }] }, {
        id: '42', consumptionId: '9',
      }),
      request({
        allocations: [{ inventory_allocation_id: '9223372036854775808', quantity: 1 }],
      }, { id: '42', consumptionId: '9' }),
    ]) {
      expect(() => marSupplyReconciliationIdempotencyBody(req)).toThrow(TypeError);
    }
  });

  test('routes install the canonical projector at every MAR command boundary', () => {
    const routes = readFileSync(
      new URL('../../routes/clinical/clinicalRoutes.js', import.meta.url),
      'utf8',
    );
    for (const [scope, projector] of [
      ['mar_administer', 'marAdministerIdempotencyBody'],
      ['mar_administer_scan', 'marAdministerWithScanIdempotencyBody'],
      ['mar_supply_reconcile', 'marSupplyReconciliationIdempotencyBody'],
      ['mar_miss', 'marTransitionIdempotencyBody'],
      ['mar_hold', 'marTransitionIdempotencyBody'],
      ['mar_release_hold', 'marTransitionIdempotencyBody'],
      ['mar_exception_claim', 'marExceptionClaimIdempotencyBody'],
      ['mar_exception_disposition', 'marExceptionDispositionIdempotencyBody'],
    ]) {
      const scopeIndex = routes.indexOf(`scope: '${scope}'`);
      expect(scopeIndex).toBeGreaterThan(-1);
      expect(routes.slice(scopeIndex, scopeIndex + 220))
        .toContain(`requestBodyForIdempotency: ${projector}`);
    }
  });
});
