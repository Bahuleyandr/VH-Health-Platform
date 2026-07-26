import {
  WAIT_STAGE_OWNER_TRANSFER_PATHWAY_KEYS,
  isPathwayOwnerTransferStepSupported,
} from '../../services/pathways/pathwayOwnershipStagePolicy.js';

const DIAGNOSTICS = 'diagnostics_order_to_action';
const INPATIENT = 'inpatient_admission_to_recovery';
const REFERRAL = 'referral_request_to_closure';
const OP = 'op_contact_to_recovery';

test('the governed wait-stage owner-transfer allowlist is diagnostics and inpatient only', () => {
  expect(WAIT_STAGE_OWNER_TRANSFER_PATHWAY_KEYS).toEqual([
    DIAGNOSTICS,
    INPATIENT,
  ]);
});

test.each([DIAGNOSTICS, INPATIENT])(
  '%s supports explicit owner transfer from a live wait stage',
  (pathwayKey) => {
    expect(isPathwayOwnerTransferStepSupported({
      pathwayKey,
      stepKind: 'wait',
    })).toBe(true);
  },
);

test.each([REFERRAL, OP])(
  '%s cannot bypass its domain owner flow from a wait stage',
  (pathwayKey) => {
    expect(isPathwayOwnerTransferStepSupported({
      pathwayKey,
      stepKind: 'wait',
    })).toBe(false);
  },
);

test.each(['task', 'approval'])(
  'a live %s stage remains transferable for every pathway',
  (stepKind) => {
    for (const pathwayKey of [DIAGNOSTICS, INPATIENT, REFERRAL, OP, 'synthetic_pathway']) {
      expect(isPathwayOwnerTransferStepSupported({ pathwayKey, stepKind })).toBe(true);
    }
  },
);

test.each(['automation', 'terminal', null, undefined])(
  '%s is never a generic owner-transfer stage',
  (stepKind) => {
    expect(isPathwayOwnerTransferStepSupported({
      pathwayKey: INPATIENT,
      stepKind,
    })).toBe(false);
  },
);
