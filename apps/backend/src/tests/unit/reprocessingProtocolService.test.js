import { jest } from '@jest/globals';
import {
  applyIsolationSettingRevisionTx,
  createIsolationSettingRevisionTx,
  createProtocolDeviceScopeTx,
  createProtocolRevisionTx,
} from '../../services/clinical/reprocessingProtocolService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const baseProtocol = {
  protocol_key: '00000000-0000-4000-8000-000000000003',
  domain: 'dialysis', category: 'dialyser', name: 'Dialyser IFU',
  basis: 'manufacturer_ifu', reference: 'IFU-1', approved_by: USER,
  approved_role: 'INFECTION_CONTROL_OFFICER', approved_at: '2026-09-07T10:00:00.000Z',
  status: 'active', tcv_min_pct: 80, baseline_tcv_required: true,
  mid_life_enrolment_rule: 'refuse', residual_test_required: true,
  integrity_test_required: true, agents: [{
    agent: 'peracetic_acid', min_concentration_pct: 0.2,
    max_concentration_pct: 0.4, min_contact_minutes: 11,
  }],
  reuse_matrix: {
    hbsag: 'no_reuse', hcv: 'no_reuse', hiv: 'no_reuse', isolation_mixed: 'no_reuse',
  },
  surveillance_intervals_days: { hbsag: 90, hcv: 90, hiv: 365 },
  surveillance_overdue_blocks_reuse: true, prion_rule: 'discard', created_by: USER,
};

function txReturning(...responses) {
  return { $queryRawUnsafe: jest.fn().mockImplementation(() => Promise.resolve(responses.shift())) };
}

describe('immutable reprocessing governance revisions', () => {
  test('creates a monotonically numbered immutable protocol revision', async () => {
    const tx = txReturning([{ revision: 1, id: 7 }], [{ id: 8, revision: 2 }]);
    await expect(createProtocolRevisionTx(tx, { tenantId: TENANT, input: {
      ...baseProtocol, supersedes_protocol_id: 7,
    } })).resolves.toMatchObject({ id: 8, revision: 2 });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(tx.$queryRawUnsafe.mock.calls[0][0]).toMatch(/FOR UPDATE/);
    expect(tx.$queryRawUnsafe.mock.calls[1][0]).toMatch(/INSERT INTO reprocessing_protocols/);
    expect(tx.$queryRawUnsafe.mock.calls[1][0]).not.toMatch(/UPDATE reprocessing_protocols/);
  });

  test('creates an immutable device scope only for the same protocol category and IFU', async () => {
    const tx = txReturning([baseProtocol], [{ id: 12, protocol_id: 8 }]);
    await expect(createProtocolDeviceScopeTx(tx, {
      tenantId: TENANT,
      protocolId: 8,
      input: {
        category: 'dialyser', manufacturer: 'M', model_name: 'X',
        ifu_reference: 'IFU-1', nominal_tcv_ml: 100, single_use: false,
        approved_at: '2026-09-07T10:00:00.000Z', created_by: USER,
      },
    })).resolves.toMatchObject({ id: 12, protocol_id: 8 });
    expect(tx.$queryRawUnsafe.mock.calls[1][0]).toMatch(/INSERT INTO reprocessing_protocol_device_scopes/);
  });

  test('creates and applies an exact infection-control-approved isolation revision', async () => {
    const revision = {
      approved_isolation_groups: ['Bay 1', 'Bay 2'],
      isolation_groups: {
        hbsag: 'Bay 1', hcv: 'Bay 2', hiv: 'Bay 2', isolation_mixed: 'Bay 2',
      },
      vocabulary_approved_by: USER,
      vocabulary_approved_role: 'INFECTION_CONTROL_OFFICER',
      vocabulary_approved_at: '2026-09-07T10:00:00.000Z',
      mapping_approved_by: USER,
      mapping_approved_role: 'INFECTION_CONTROL_OFFICER',
      mapping_approved_at: '2026-09-07T10:01:00.000Z',
      created_by: USER,
    };
    const createTx = txReturning([{ revision: 1, id: 4 }], [{ id: 5, revision: 2 }]);
    await expect(createIsolationSettingRevisionTx(createTx, {
      tenantId: TENANT, input: { ...revision, supersedes_revision_id: 4 },
    })).resolves.toMatchObject({ id: 5, revision: 2 });

    const applyTx = txReturning([{ id: 5, ...revision }], [{ tenant_id: TENANT, isolation_revision_id: 5 }]);
    await expect(applyIsolationSettingRevisionTx(applyTx, {
      tenantId: TENANT,
      revisionId: 5,
      actor: { uid: USER, role: 'ADMIN' },
    })).resolves.toMatchObject({ isolation_revision_id: 5 });
    expect(applyTx.$queryRawUnsafe.mock.calls[1][0]).toMatch(/isolation_applied_role/);
  });
});
