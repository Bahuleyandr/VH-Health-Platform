import { jest } from '@jest/globals';

import {
  findMarTransitionCommandReplayTx,
  fingerprintMarTransitionRequest,
  recordMarTransitionCommandReceiptTx,
} from '../../services/clinical/marTransitionCommandService.js';

const IDS = Object.freeze({
  actor: '10000000-0000-4000-8000-000000000001',
  tenant: '10000000-0000-4000-8000-000000000002',
});
const FINGERPRINT = 'a'.repeat(64);

function identity(overrides = {}) {
  return {
    tenantId: IDS.tenant,
    medicationAdministrationId: 42,
    actorUid: IDS.actor,
    commandScope: 'mar_hold',
    transitionAction: 'held',
    commandKey: 'mar-hold-42',
    requestBodySha256: FINGERPRINT,
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    id: 7n,
    tenant_id: IDS.tenant,
    medication_administration_id: 42,
    actor_uid: IDS.actor,
    command_scope: 'mar_hold',
    transition_action: 'held',
    command_key: 'mar-hold-42',
    request_body_sha256: FINGERPRINT,
    response_data: {
      id: 42,
      status: 'held',
      held_by: IDS.actor,
      hold_reason: 'Awaiting prescriber review',
    },
    completed_at: new Date('2026-08-27T10:00:00.000Z'),
    ...overrides,
  };
}

describe('MAR transition command receipts', () => {
  test('fingerprints normalized reasons independent of object key order', () => {
    expect(fingerprintMarTransitionRequest({ reason: 'NPO', detail: null }))
      .toBe(fingerprintMarTransitionRequest({ detail: null, reason: 'NPO' }));
  });

  test('returns the immutable committed response for an exact replay', async () => {
    const tx = { $queryRawUnsafe: jest.fn().mockResolvedValue([receipt()]) };
    await expect(findMarTransitionCommandReplayTx(tx, identity())).resolves.toEqual(
      receipt().response_data,
    );
  });

  test('rejects a command key rebound to another reason fingerprint', async () => {
    const tx = { $queryRawUnsafe: jest.fn().mockResolvedValue([receipt()]) };
    await expect(findMarTransitionCommandReplayTx(tx, identity({
      requestBodySha256: 'b'.repeat(64),
    }))).rejects.toMatchObject({
      statusCode: 422,
      code: 'MAR_TRANSITION_COMMAND_MISMATCH',
    });
  });

  test('rejects mismatched scope and transition action before querying', async () => {
    const tx = { $queryRawUnsafe: jest.fn() };
    await expect(findMarTransitionCommandReplayTx(tx, identity({
      commandScope: 'mar_miss',
    }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'MAR_TRANSITION_COMMAND_INVALID',
    });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('records only a response matching the target transition', async () => {
    const tx = { $queryRawUnsafe: jest.fn().mockResolvedValue([receipt()]) };
    await expect(recordMarTransitionCommandReceiptTx(tx, {
      ...identity(),
      responseData: receipt().response_data,
    })).resolves.toMatchObject({ id: 42, status: 'held' });
    expect(tx.$queryRawUnsafe.mock.calls[0][0]).toContain('ON CONFLICT DO NOTHING');

    await expect(recordMarTransitionCommandReceiptTx(tx, {
      ...identity(),
      responseData: { id: 42, status: 'missed' },
    })).rejects.toMatchObject({
      statusCode: 500,
      code: 'MAR_TRANSITION_COMMAND_RESPONSE_INVALID',
    });
  });
});
