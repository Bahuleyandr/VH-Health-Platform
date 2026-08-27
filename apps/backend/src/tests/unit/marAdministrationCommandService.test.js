import { jest } from '@jest/globals';

import {
  finaliseMarHttpIdempotencyTx,
  findMarAdministrationCommandReplayTx,
  fingerprintMarAdministrationRequest,
  recordMarAdministrationCommandReceiptTx,
} from '../../services/clinical/marAdministrationCommandService.js';

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
    commandScope: 'mar_administer_scan',
    commandKey: 'mar-command-42',
    requestBodySha256: FINGERPRINT,
    administrationMode: 'online_barcode_scan',
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    id: 7n,
    tenant_id: IDS.tenant,
    medication_administration_id: 42,
    actor_uid: IDS.actor,
    command_scope: 'mar_administer_scan',
    command_key: 'mar-command-42',
    request_body_sha256: FINGERPRINT,
    administration_mode: 'online_barcode_scan',
    response_data: {
      id: 42,
      status: 'administered',
      supply_state: { status: 'matched', consumptions: [{ id: '9007199254740993' }] },
    },
    completed_at: new Date('2026-08-27T09:00:00.000Z'),
    ...overrides,
  };
}

describe('MAR administration command receipts', () => {
  test('fingerprints normalized request values independent of object key order', () => {
    expect(fingerprintMarAdministrationRequest({
      supply_quantity: 1,
      override_reason: null,
      scanned_patient_uid: IDS.actor,
    })).toBe(fingerprintMarAdministrationRequest({
      scanned_patient_uid: IDS.actor,
      override_reason: null,
      supply_quantity: 1,
    }));
  });

  test('returns the immutable committed response for an exact command replay', async () => {
    const tx = { $queryRawUnsafe: jest.fn().mockResolvedValue([receipt()]) };
    const replay = await findMarAdministrationCommandReplayTx(tx, identity());
    expect(replay).toEqual({
      id: 42,
      status: 'administered',
      supply_state: { status: 'matched', consumptions: [{ id: '9007199254740993' }] },
    });
    expect(tx.$queryRawUnsafe.mock.calls[0][0]).not.toContain('FOR SHARE');
  });

  test('fails with 422 when the same command key carries another request body', async () => {
    const tx = { $queryRawUnsafe: jest.fn().mockResolvedValue([receipt()]) };
    await expect(findMarAdministrationCommandReplayTx(tx, identity({
      requestBodySha256: 'b'.repeat(64),
    }))).rejects.toMatchObject({
      statusCode: 422,
      code: 'MAR_ADMINISTRATION_COMMAND_MISMATCH',
    });
  });

  test('records only an administered response and preserves large receipt identifiers on wire', async () => {
    const tx = { $queryRawUnsafe: jest.fn().mockResolvedValue([receipt()]) };
    const response = await recordMarAdministrationCommandReceiptTx(tx, {
      ...identity(),
      responseData: receipt().response_data,
    });
    expect(response.supply_state.consumptions[0].id).toBe('9007199254740993');
    expect(tx.$queryRawUnsafe.mock.calls[0][0]).toContain('ON CONFLICT DO NOTHING');

    await expect(recordMarAdministrationCommandReceiptTx(tx, {
      ...identity(),
      responseData: { id: 42, status: 'scheduled' },
    })).rejects.toMatchObject({
      code: 'MAR_ADMINISTRATION_COMMAND_RESPONSE_INVALID',
      statusCode: 500,
    });
  });

  test('finalizes the HTTP replay envelope inside the clinical transaction', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{
        id: 91,
        status: 'complete',
        response_status: 200,
      }]),
    };
    await finaliseMarHttpIdempotencyTx(tx, {
      claimId: 91,
      tenantId: IDS.tenant,
      actorUid: IDS.actor,
      commandKey: 'mar-command-42',
      requestBodySha256: FINGERPRINT,
      responseData: receipt().response_data,
      requestId: 'request-91',
    });
    const [sql, claimId, tenantId, actorUid, commandKey, fingerprint, body] =
      tx.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain("status = 'complete'");
    expect(sql).toContain("status = 'in_flight'");
    expect([claimId, tenantId, actorUid, commandKey, fingerprint]).toEqual([
      91,
      IDS.tenant,
      IDS.actor,
      'mar-command-42',
      FINGERPRINT,
    ]);
    expect(JSON.parse(body)).toMatchObject({
      success: true,
      message: 'Medication administration recorded',
      requestId: 'request-91',
      data: { id: 42, status: 'administered' },
    });
  });
});
