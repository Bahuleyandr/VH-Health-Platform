import {
  projectDeviceHistoryForOperationalRole,
  projectHoldForOperationalRole,
  projectReuseRestrictionForRole,
  projectUsageForRole,
} from '../../services/clinical/reprocessableDeviceProjection.js';

const poison = 'hcv reactive 2026-09-07';

describe('reprocessable device projection canary pieces', () => {
  test('removes protected evidence by value from operational usage and restriction projections', () => {
    const screen = {
      contract_version: 2,
      status: 'restricted',
      asOf: '2026-09-07T10:00:00.000Z',
      evidence: 'marker',
      evidence_dated_on: '2026-09-07',
      reasons: [poison],
      markers: [{ marker: 'hcv', result: 'reactive', tested_on: '2026-09-07' }],
      isolation_class: 'hcv',
    };
    const usage = projectUsageForRole({
      id: 4, patient_uid: 'patient', reuse_screen: screen, post_use_screen: screen,
      metadata: { narrative: poison },
    }, 'QUALITY_OFFICER');
    const restriction = projectReuseRestrictionForRole(screen, 'QUALITY_OFFICER');
    expect(JSON.stringify({ usage, restriction })).not.toMatch(/hcv|reactive/i);
    expect(usage.reuse_screen.reasons).toEqual([]);
    expect(usage.reuse_screen.isolation_class).toBeNull();
    expect(restriction.reasons).toEqual([]);
  });

  test('projects operational holds through an allow-list', () => {
    const projected = projectHoldForOperationalRole({
      id: 8,
      device_id: 7,
      operational_type: 'specialist_contamination_hold',
      reason_code: 'manual_ic',
      status: 'active',
      pending_return: false,
      processing_required: true,
      created_at: '2026-09-07T10:00:00.000Z',
      note: poison,
      release_adjudication: poison,
      source_marker_row_id: 44,
      release_evidence: { narrative: poison },
      patient_uid: 'patient',
      metadata: { narrative: poison },
    });
    expect(Object.keys(projected)).toHaveLength(8);
    expect(projected).toEqual({
      id: 8,
      device_id: 7,
      operational_type: 'specialist_contamination_hold',
      reason_code: 'manual_ic',
      status: 'active',
      pending_return: false,
      processing_required: true,
      created_at: '2026-09-07T10:00:00.000Z',
    });
    expect(JSON.stringify(projected)).not.toMatch(/hcv|reactive/i);
  });

  test('keeps operational history marker-free while protected evidence remains outside it', () => {
    const history = projectDeviceHistoryForOperationalRole({
      device: { id: 7, device_tag: 'RD00000007', status: 'quarantined' },
      usages: [],
      holds: [{ id: 8, device_id: 7, status: 'active', note: poison }],
      events: [{
        id: 9, device_id: 7, kind: 'chemical_reprocessing', cycle_type: 'chemical',
        initial_outcome: 'held', recorded_at: '2026-09-07T10:00:00.000Z',
        metadata: { narrative: poison },
      }],
    }, 'QUALITY_OFFICER');
    expect(history.events).toHaveLength(1);
    expect(JSON.stringify(history)).not.toMatch(/hcv|reactive/i);
  });
});
