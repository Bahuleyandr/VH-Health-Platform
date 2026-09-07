import { jest } from '@jest/globals';
import {
  evaluateOutstandingObligationsTx,
  releaseHoldTx,
} from '../services/clinical/reprocessableDeviceService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';

describe('erroneous hold release keeps processing obligation', () => {
  test('releasing one hold cannot authorise availability while independent obligations remain', async () => {
    const releaseResponses = [
      [{ id: 11, device_id: 7, hold_type: 'sterilization_failed', status: 'active' }],
      [{ id: 7, status: 'quarantined', version: 2 }],
      [{ id: 11, status: 'released' }],
      [{ id: 7, status: 'awaiting_reprocessing', version: 3 }],
    ];
    const releaseTx = {
      $queryRawUnsafe: jest.fn().mockImplementation(() => Promise.resolve(releaseResponses.shift())),
    };
    await releaseHoldTx(releaseTx, {
      tenantId: TENANT,
      holdId: 11,
      expectedVersion: 2,
      actor: { uid: USER, role: 'QUALITY_OFFICER' },
      approval: {
        approved_by: USER,
        approved_role: 'QUALITY_OFFICER',
        approved_at: '2026-09-07T10:00:00.000Z',
        adjudication: 'Original hold was erroneous',
        protocol_id: 3,
        requires_processing: false,
      },
    });

    const obligationsTx = {
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([{ id: 12, status: 'active', release_requires_processing: true, satisfied_at: null }])
        .mockResolvedValueOnce({
          residual_test_pending: true,
          status: 'awaiting_reprocessing',
          last_processing_event_id: null,
          protocol_device_scope_id: 4,
        }),
    };
    const obligations = await evaluateOutstandingObligationsTx(obligationsTx, {
      tenantId: TENANT, deviceId: 7, protocolId: 3, protocolDeviceScopeId: 4,
    });
    expect(obligations).toHaveLength(2);
    expect(obligations).toEqual(['active_hold:12', 'residual_test_pending']);
    expect(releaseTx.$queryRawUnsafe.mock.calls.map(([sql]) => sql).join('\n'))
      .not.toMatch(/status\s*=\s*'available'/);
  });
});
