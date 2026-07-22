// Unit regression for finding H' D56.
//
// `clinical_order_set_items.payload` carries a JSONB blob per order-
// set item. The chest-pain bundle's ECG item used to seed with
// `kind: 'lab'`, which routed it through the lab worklist instead of
// the cardiology/ECG queue — `listLabWorklist` filters on
// `UPPER(test_type) IN (...lab types...)` and excludes anything tagged
// CARDIOLOGY/RADIOLOGY/etc., but if the order set never stamps a
// `test_type` the resulting investigation defaulted to 'LAB' and
// surfaced on the lab tech's queue. The lab tech then had no idea
// what to do with an "ECG" lab order.
//
// The fix is in `orderRequestFromItem`: when an item is `kind: 'lab'`
// (or any kind that maps to `order_type: 'investigation'`) and the
// caller didn't explicitly stamp `test_type`, we infer one from the
// payload's test_name / test_code / modality fields:
//   * ECG / EKG / 12-lead / TMT / echo / holter / angiogram / cath →
//     CARDIOLOGY
//   * X-ray / CXR / CT / MRI / ultrasound / mammogram / fluoroscopy →
//     RADIOLOGY
//   * PFT / spirometry / DLCO / ABG → PULMONARY
//   * OGD / colonoscopy / bronchoscopy → ENDOSCOPY
//
// Explicit `test_type` always wins. No match leaves `test_type` unset
// so the existing default ('LAB') applies. Finding `1c47996c`.

import { jest } from '@jest/globals';

const queryRawMock = jest.fn();
const executeRawMock = jest.fn();
const txMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawMock,
  $executeRawUnsafe: executeRawMock,
  $transaction: txMock,
  clinical_order_sets: { findUnique: jest.fn() },
  clinical_order_set_items: { findMany: jest.fn() },
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  circuitBreakerStatus: jest.fn(() => ({ open: false, consecutiveFailures: 0 })),
  default: __prismaDefaultMock,
  isTenantTransactionClient: () => true,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const orderEntryServiceModule = await import('../../services/emr/orderEntryService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

describe('order set item routing — test_type inference (H D56)', () => {
  beforeEach(() => {
    queryRawMock.mockReset();
    executeRawMock.mockReset();
    executeRawMock.mockResolvedValue(1);
  });

  it('stamps CARDIOLOGY on a lab-kind ECG item from the chest-pain bundle', () => {
    const set = orderEntryServiceModule.__test_orderRequestFromItem({
      kind: 'lab',
      payload: { test_name: 'ECG 12-lead', urgency: 'stat' },
    }, 'Chest Pain ED');
    expect(set.order_type).toBe('investigation');
    expect(set.details.test_type).toBe('CARDIOLOGY');
    // Priority pass-through unchanged.
    expect(set.priority).toBe('stat');
  });

  it('stamps RADIOLOGY for X-ray and CT items', () => {
    const xray = orderEntryServiceModule.__test_orderRequestFromItem({
      kind: 'lab',
      payload: { test_name: 'Chest X-ray PA view' },
    }, 'Chest Pain ED');
    expect(xray.details.test_type).toBe('RADIOLOGY');

    const ct = orderEntryServiceModule.__test_orderRequestFromItem({
      kind: 'radiology',
      payload: { test_code: 'CT_HEAD' },
    }, 'Head trauma');
    expect(ct.details.test_type).toBe('RADIOLOGY');
  });

  it('stamps CARDIOLOGY for echo and angiography', () => {
    const echo = orderEntryServiceModule.__test_orderRequestFromItem({
      kind: 'lab',
      payload: { test_name: '2D Echocardiogram' },
    }, 'Chest Pain ED');
    expect(echo.details.test_type).toBe('CARDIOLOGY');

    const angio = orderEntryServiceModule.__test_orderRequestFromItem({
      kind: 'lab',
      payload: { test_name: 'Coronary angiography' },
    }, 'ACS');
    expect(angio.details.test_type).toBe('CARDIOLOGY');
  });

  it('stamps PULMONARY for PFT/ABG items', () => {
    const pft = orderEntryServiceModule.__test_orderRequestFromItem({
      kind: 'lab',
      payload: { test_name: 'PFT with DLCO' },
    }, 'COPD evaluation');
    expect(pft.details.test_type).toBe('PULMONARY');

    const abg = orderEntryServiceModule.__test_orderRequestFromItem({
      kind: 'lab',
      payload: { test_name: 'Arterial Blood Gas' },
    }, 'Resp distress');
    expect(abg.details.test_type).toBe('PULMONARY');
  });

  it('stamps ENDOSCOPY for OGD/colonoscopy', () => {
    const ogd = orderEntryServiceModule.__test_orderRequestFromItem({
      kind: 'lab',
      payload: { test_name: 'OGD with biopsy' },
    }, 'GI bleed');
    expect(ogd.details.test_type).toBe('ENDOSCOPY');
  });

  it('LEAVES test_type alone when caller already supplied one (explicit wins)', () => {
    const explicit = orderEntryServiceModule.__test_orderRequestFromItem({
      kind: 'lab',
      payload: { test_name: 'ECG', test_type: 'CUSTOM_CARDIAC' },
    }, 'Chest Pain ED');
    expect(explicit.details.test_type).toBe('CUSTOM_CARDIAC');
  });

  it('LEAVES test_type unset when no pattern matches — caller defaults to LAB', () => {
    const cbc = orderEntryServiceModule.__test_orderRequestFromItem({
      kind: 'lab',
      payload: { test_name: 'Complete Blood Count', test_code: 'CBC' },
    }, 'Chest Pain ED');
    expect(cbc.details.test_type).toBeUndefined();
  });

  it('does not stamp test_type on non-investigation orders (meds, diet, nursing)', () => {
    const med = orderEntryServiceModule.__test_orderRequestFromItem({
      kind: 'med',
      payload: { drug: 'Aspirin', dose: '325mg', frequency: 'STAT' },
    }, 'Chest Pain ED');
    expect(med.order_type).toBe('medication');
    expect(med.details.test_type).toBeUndefined();
  });
});
