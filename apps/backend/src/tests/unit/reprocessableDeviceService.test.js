import { jest } from '@jest/globals';
import {
  LOCK_ORDER,
  admitActualUseTx,
  evaluateOutstandingObligationsTx,
  placeHoldTx,
  registerDeviceTx,
  releaseHoldTx,
  releaseToAvailableTx,
  reserveDeviceTx,
  restoreUnusedCaptureTx,
  returnDeviceTx,
} from '../../services/clinical/reprocessableDeviceService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';

function txReturning(...responses) {
  return {
    $queryRawUnsafe: jest.fn().mockImplementation(() => Promise.resolve(responses.shift())),
  };
}

describe('reprocessable device lifecycle kernel', () => {
  test('pins the complete lock order used by later domain integrations', () => {
    expect(LOCK_ORDER).toEqual([
      'tenant_patient_advisory', 'dialysis_session_or_load', 'ot_issue', 'instrument_set',
      'device', 'usage', 'hold_and_satisfaction', 'dialysis_link', 'append_only_receipts',
    ]);
  });

  test('registers unseen identities with conflict-safe insert and approved scope checks', async () => {
    const tx = txReturning(
      [{
        id: 4, protocol_domain: 'dialysis', protocol_status: 'active', single_use: false,
        category: 'dialyser', manufacturer: 'M', model_name: 'X',
      }],
      [{ id: 7, domain: 'dialysis', category: 'dialyser', version: 0 }],
    );
    await expect(registerDeviceTx(tx, {
      tenantId: TENANT,
      input: {
        domain: 'dialysis', category: 'dialyser', manufacturer: 'M', model_name: 'X',
        manufacturer_serial: 'SER-7', protocol_device_scope_id: 4,
        enrolled_via: 'session_capture', max_cycles_snapshot: 3,
      },
      actor: { uid: USER },
    })).resolves.toMatchObject({ id: 7 });
    expect(tx.$queryRawUnsafe.mock.calls[1][0]).toMatch(/ON CONFLICT DO NOTHING/);
  });

  test('reserves, admits, and returns through the state kernel', async () => {
    const reserveTx = txReturning(
      [{ id: 7, domain: 'dialysis', status: 'available', version: 0, cycle_count: 0 }],
      [{ id: 9, returned_at: null }],
      [{ id: 7, status: 'in_case', version: 1, current_usage_id: 9 }],
    );
    await expect(reserveDeviceTx(reserveTx, {
      tenantId: TENANT, deviceId: 7, expectedVersion: 0, patientUid: USER,
      owner: { dialysis_session_id: 12 }, captureSource: 'staff_app',
      actor: { uid: USER },
    })).resolves.toMatchObject({ device: { status: 'in_case' }, usage: { id: 9 } });

    const admitTx = txReturning(
      [{ id: 7, domain: 'dialysis', status: 'in_case', version: 1, current_usage_id: 9 }],
      [{ id: 9, returned_at: null, actual_use_started_at: null }],
      [],
      [{ id: 9, actual_use_started_at: '2026-09-07T10:00:00.000Z' }],
      [{ id: 7, status: 'in_case', version: 2 }],
    );
    await expect(admitActualUseTx(admitTx, {
      tenantId: TENANT, deviceId: 7, expectedVersion: 1,
    })).resolves.toMatchObject({ id: 9 });

    const returnTx = txReturning(
      [{ id: 7, domain: 'dialysis', status: 'in_case', version: 1, current_usage_id: 9 }],
      [{ id: 9, returned_at: '2026-09-07T11:00:00.000Z' }],
      [],
      [{ id: 7, status: 'awaiting_reprocessing', version: 2, current_usage_id: null }],
    );
    await expect(returnDeviceTx(returnTx, {
      tenantId: TENANT, deviceId: 7, expectedVersion: 1,
      disposition: 'sent_for_reprocessing', actor: { uid: USER },
    })).resolves.toMatchObject({ device: { status: 'awaiting_reprocessing' } });
  });

  test('places a marker-free active hold and increments the device version', async () => {
    const tx = txReturning(
      [{ id: 7, domain: 'dialysis', status: 'available', version: 2 }],
      [{ id: 11, status: 'active', hold_type: 'bloodborne_exposure' }],
      [{ id: 7, status: 'quarantined', version: 3 }],
    );
    await expect(placeHoldTx(tx, {
      tenantId: TENANT,
      deviceId: 7,
      holdType: 'bloodborne_exposure',
      reasonCode: 'exposure_late_result',
      placedVia: 'exposure_handler',
      sourceMarkerRowId: 44,
      expectedVersion: 2,
    })).resolves.toMatchObject({ hold: { id: 11 }, device: { version: 3 } });
    const statements = tx.$queryRawUnsafe.mock.calls.map(([sql]) => sql).join('\n');
    expect(statements).not.toMatch(/hbsag|hcv|hiv|isolation_mixed/i);
  });

  test('releaseHoldTx records accountable approval but never writes available', async () => {
    const tx = txReturning(
      [{ device_id: 7 }],
      [{ id: 7, status: 'quarantined', version: 2 }],
      [{ id: 11, device_id: 7, hold_type: 'bloodborne_exposure', status: 'active' }],
      [{ uid: '00000000-0000-4000-8000-000000000099' }],
      [{ id: 11, status: 'released' }],
      [{ id: 7, status: 'awaiting_reprocessing', version: 3 }],
    );
    await expect(releaseHoldTx(tx, {
      tenantId: TENANT,
      holdId: 11,
      expectedVersion: 2,
      actor: { uid: USER, role: 'ADMIN' },
      approval: {
        approved_by: '00000000-0000-4000-8000-000000000099',
        approved_role: 'INFECTION_CONTROL_OFFICER',
        approved_at: '2026-09-07T10:00:00.000Z',
        adjudication: 'Reviewed under protocol',
        protocol_id: 3,
        requires_processing: true,
      },
    })).resolves.toMatchObject({ hold: { status: 'released' }, device: { status: 'awaiting_reprocessing' } });
    const statements = tx.$queryRawUnsafe.mock.calls.map(([sql]) => sql).join('\n');
    expect(statements).not.toMatch(/status\s*=\s*'available'/);
  });

  test('refuses to attribute an accountable decision to a different clinical actor', async () => {
    const tx = txReturning(
      [{ device_id: 7 }],
      [{ id: 7, status: 'quarantined', version: 2 }],
      [{ id: 11, device_id: 7, hold_type: 'inspection_failed', status: 'active' }],
    );
    await expect(releaseHoldTx(tx, {
      tenantId: TENANT,
      holdId: 11,
      expectedVersion: 2,
      actor: { uid: USER, role: 'OT_INCHARGE' },
      approval: {
        approved_by: '00000000-0000-4000-8000-000000000099',
        approved_role: 'OT_INCHARGE',
        approved_at: '2026-09-07T10:00:00.000Z',
        adjudication: 'Inspection passed',
        requires_processing: false,
      },
    })).rejects.toMatchObject({ code: 'RPD_ACCOUNTABLE_APPROVAL_REQUIRED' });
  });

  test('restores only a sealed unopened capture with no obligations and consumes no cycle', async () => {
    const tx = txReturning(
      [{ id: 7, status: 'in_case', version: 4, cycle_count: 1, current_usage_id: 9, protocol_device_scope_id: 4 }],
      [{ id: 9, returned_at: null, actual_use_started_at: null }],
      [],
      [],
      [{ id: 7, residual_test_pending: false, protocol_device_scope_id: 4 }],
      [{ id: 9, post_use_disposition: 'cancelled_before_use' }],
      [{ id: 7, status: 'available', version: 5, cycle_count: 1 }],
    );
    await expect(restoreUnusedCaptureTx(tx, {
      tenantId: TENANT,
      deviceId: 7,
      expectedVersion: 4,
      packCondition: 'sealed_unopened',
      actor: { uid: USER, role: 'QUALITY_OFFICER' },
    })).resolves.toMatchObject({ device: { status: 'available', cycle_count: 1 } });
  });

  test('settles a held unused capture into quarantine and distinguishes missing pack condition', async () => {
    await expect(restoreUnusedCaptureTx(txReturning(), {
      tenantId: TENANT, deviceId: 7, expectedVersion: 4, actor: { uid: USER },
    })).rejects.toMatchObject({ code: 'RPD_PACK_CONDITION_REQUIRED' });

    const tx = txReturning(
      [{ id: 7, status: 'in_case', version: 4, cycle_count: 1, current_usage_id: 9, protocol_device_scope_id: 4 }],
      [{ id: 9, returned_at: null, actual_use_started_at: null }],
      [{ id: 11 }],
      [{ id: 11, status: 'active', release_requires_processing: true, satisfied_at: null }],
      [{ id: 7, residual_test_pending: false, protocol_device_scope_id: 4 }],
      [{ id: 9, post_use_disposition: 'cancelled_before_use' }],
      [{ id: 7, status: 'quarantined', version: 5 }],
    );
    await expect(restoreUnusedCaptureTx(tx, {
      tenantId: TENANT,
      deviceId: 7,
      expectedVersion: 4,
      packCondition: 'sealed_unopened',
      actor: { uid: USER },
    })).resolves.toMatchObject({
      device: { status: 'quarantined' },
      obligations: ['active_hold:11'],
    });
  });

  test('reports active holds and released-unsatisfied processing independently', async () => {
    const tx = txReturning([
      { id: 1, status: 'active', release_requires_processing: true, satisfied_at: null },
      { id: 2, status: 'released', release_requires_processing: true, satisfied_at: null },
    ], [{
      residual_test_pending: true,
      status: 'awaiting_reprocessing',
      last_processing_event_id: null,
      protocol_device_scope_id: 4,
    }]);
    const obligations = await evaluateOutstandingObligationsTx(tx, {
      tenantId: TENANT, deviceId: 7, protocolId: 3, protocolDeviceScopeId: 4,
    });
    expect(obligations).toHaveLength(3);
    expect(obligations).toEqual([
      'active_hold:1', 'released_hold_processing:2', 'residual_test_pending',
    ]);
  });

  test('prospectiveProcessingAtOrAboveCeilingRefusesBeforeAppend', async () => {
    const counts = [1, 2];
    expect(counts).toHaveLength(2);
    const modes = [undefined, 'prospective'];
    expect(modes).toHaveLength(2);
    const cases = counts.flatMap((cycleCount) => modes.map((recordingMode) => ({ cycleCount, recordingMode })));
    expect(cases).toHaveLength(4);
    for (const { cycleCount, recordingMode } of cases) {
      const tx = txReturning([{ id: 7, domain: 'dialysis', status: 'awaiting_reprocessing',
        version: 0, cycle_count: cycleCount, max_cycles_snapshot: 1 }]);
      const prepareOccurrence = jest.fn();
      await expect(releaseToAvailableTx(tx, { tenantId: TENANT, deviceId: 7, expectedVersion: 0,
        recordingMode, occurrence: { device_usage_id: 9 }, prepareOccurrence,
      })).rejects.toMatchObject({ code: 'RPD_MAX_CYCLES_REACHED' });
      expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
      expect(prepareOccurrence).not.toHaveBeenCalled();
    }
  });

  test('processingRecordingModeCannotSilentlyDefaultUnknownValues', async () => {
    const tx = txReturning();
    await expect(releaseToAvailableTx(tx, { tenantId: TENANT, deviceId: 7, expectedVersion: 0,
      recordingMode: 'unknown', occurrence: {},
    })).rejects.toMatchObject({ code: 'RPD_PROCESSING_RECORDING_MODE_INVALID' });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
