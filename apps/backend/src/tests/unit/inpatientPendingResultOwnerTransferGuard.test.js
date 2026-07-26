import { readFileSync } from 'node:fs';

import { jest } from '@jest/globals';

import {
  assertInpatientPendingResultOwnerTransferAllowedTx,
} from '../../services/emr/inpatientPendingResultOwnerTransferGuard.js';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATIENT_UID = '20000000-0000-4000-8000-000000000001';

function inpatientPathway(overrides = {}) {
  return {
    pathway_key: 'inpatient_admission_to_recovery',
    source_episode_type: 'admission',
    source_episode_id: '17',
    patient_uid: PATIENT_UID,
    ...overrides,
  };
}

test.each([
  ['declined outcome', { outcome: 'declined' }],
  ['cancelled outcome', { outcome: 'cancelled' }],
  [
    'non-inpatient pathway',
    {
      outcome: 'accepted',
      pathwayInstance: inpatientPathway({ pathway_key: 'op_consult_to_closure' }),
    },
  ],
])('%s bypasses the inpatient post-discharge guard', async (_label, overrides) => {
  const tx = { $queryRawUnsafe: jest.fn() };
  await expect(assertInpatientPendingResultOwnerTransferAllowedTx({
    tx,
    tenantId: TENANT_ID,
    pathwayInstance: inpatientPathway(),
    outcome: 'accepted',
    ...overrides,
  })).resolves.toEqual({ applicable: false });
  expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
});

test.each([
  ['requested', 'admitted'],
  ['accepted', 'admitted'],
  ['requested', 'transferred'],
  ['accepted', 'transferred'],
])(
  'a new %s owner transfer mutation is permitted on an active %s admission',
  async (outcome, status) => {
    const query = jest.fn(async () => [{
      status,
      has_live_pending_result_ownership: true,
    }]);
    await expect(assertInpatientPendingResultOwnerTransferAllowedTx({
      tx: { $queryRawUnsafe: query },
      tenantId: TENANT_ID,
      pathwayInstance: inpatientPathway(),
      outcome,
    })).resolves.toEqual({
      applicable: true,
      admission_status: status,
      has_live_pending_result_ownership: true,
    });
    const [sql, tenantId, admissionId, patientUid] = query.mock.calls[0];
    expect(sql).toContain("handoff.handoff_state IN ('pending', 'result_available')");
    expect(sql).toContain('FOR SHARE OF admission');
    expect([tenantId, admissionId, patientUid]).toEqual([
      TENANT_ID,
      17,
      PATIENT_UID,
    ]);
  },
);

test.each([
  ['requested', 'discharged'],
  ['accepted', 'discharged'],
  ['requested', 'lama'],
  ['accepted', 'lama'],
  ['requested', 'expired'],
  ['accepted', 'expired'],
  ['requested', 'cancelled'],
  ['accepted', 'cancelled'],
])(
  'a new %s mutation is rejected on a terminal %s admission with live pending-result ownership',
  async (outcome, status) => {
    const tx = {
      $queryRawUnsafe: jest.fn(async () => [{
        status,
        has_live_pending_result_ownership: true,
      }]),
    };
    await expect(assertInpatientPendingResultOwnerTransferAllowedTx({
      tx,
      tenantId: TENANT_ID,
      pathwayInstance: inpatientPathway(),
      outcome,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'INPATIENT_POST_DISCHARGE_OWNER_TRANSFER_UNSUPPORTED',
    });
  },
);

test('a terminal admission without outstanding ownership can transfer normally', async () => {
  const tx = {
    $queryRawUnsafe: jest.fn(async () => [{
      status: 'discharged',
      has_live_pending_result_ownership: false,
    }]),
  };
  await expect(assertInpatientPendingResultOwnerTransferAllowedTx({
    tx,
    tenantId: TENANT_ID,
    pathwayInstance: inpatientPathway(),
    outcome: 'accepted',
  })).resolves.toMatchObject({
    applicable: true,
    admission_status: 'discharged',
    has_live_pending_result_ownership: false,
  });
});

test('the ownership service preserves request replay before guarding a new request', () => {
  const source = readFileSync(
    new URL('../../services/pathways/pathwayOwnershipService.js', import.meta.url),
    'utf8',
  );
  const requestStart = source.indexOf('export async function requestCarePathwayOwnerTransfer({');
  const requestEnd = source.indexOf('async function transitionTransfer({');
  const requestSource = source.slice(requestStart, requestEnd);
  const replayIndex = requestSource.indexOf('if (replayEvents) {');
  const guardIndex = requestSource.indexOf(
    'await assertInpatientPendingResultOwnerTransferAllowedTx({',
  );
  const liveStageIndex = requestSource.indexOf('const step = requireLiveOwnershipStep(runtime)');
  const taskCreateIndex = requestSource.indexOf(
    'const task = await createCoveringTransferReviewTaskTx({',
  );
  expect(requestStart).toBeGreaterThan(-1);
  expect(requestEnd).toBeGreaterThan(requestStart);
  expect(replayIndex).toBeGreaterThan(-1);
  expect(guardIndex).toBeGreaterThan(replayIndex);
  expect(liveStageIndex).toBeGreaterThan(guardIndex);
  expect(taskCreateIndex).toBeGreaterThan(guardIndex);
});

test('the ownership service preserves acceptance replay before guarding new acceptance', () => {
  const source = readFileSync(
    new URL('../../services/pathways/pathwayOwnershipService.js', import.meta.url),
    'utf8',
  );
  const transitionStart = source.indexOf('async function transitionTransfer({');
  const transitionSource = source.slice(transitionStart);
  const replayIndex = transitionSource.indexOf('if (replayEvents) {');
  const bindingIndex = transitionSource.indexOf('const step = assertTransferBinding(');
  const requestedIndex = transitionSource.indexOf("if (handoff.status !== 'requested')");
  const guardIndex = transitionSource.indexOf(
    'await assertInpatientPendingResultOwnerTransferAllowedTx({',
  );
  const ownerCasIndex = transitionSource.indexOf('await assignPathwayOwnerCasTx({', guardIndex);
  expect(transitionStart).toBeGreaterThan(-1);
  expect(replayIndex).toBeGreaterThan(-1);
  expect(guardIndex).toBeGreaterThan(replayIndex);
  expect(bindingIndex).toBeGreaterThan(guardIndex);
  expect(requestedIndex).toBeGreaterThan(bindingIndex);
  expect(ownerCasIndex).toBeGreaterThan(guardIndex);
});
