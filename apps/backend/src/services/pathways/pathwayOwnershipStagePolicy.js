import { CARE_PATHWAY_KEYS } from './pathwayMode.js';

export const WAIT_STAGE_OWNER_TRANSFER_PATHWAY_KEYS = Object.freeze([
  CARE_PATHWAY_KEYS.DIAGNOSTICS,
  CARE_PATHWAY_KEYS.INPATIENT,
]);

const WAIT_STAGE_OWNER_TRANSFER_PATHWAY_KEY_SET = new Set(
  WAIT_STAGE_OWNER_TRANSFER_PATHWAY_KEYS,
);

export function isPathwayOwnerTransferStepSupported({ pathwayKey, stepKind } = {}) {
  if (stepKind === 'task' || stepKind === 'approval') return true;
  return (
    stepKind === 'wait'
    && WAIT_STAGE_OWNER_TRANSFER_PATHWAY_KEY_SET.has(pathwayKey)
  );
}

export default {
  WAIT_STAGE_OWNER_TRANSFER_PATHWAY_KEYS,
  isPathwayOwnerTransferStepSupported,
};
