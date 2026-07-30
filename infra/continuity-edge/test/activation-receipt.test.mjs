import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyActivationReceipt } from '../lib/activation-receipt.mjs';
import { loadEdgeConfig } from '../lib/config.mjs';
import { FACILITY_ID, TENANT_ID } from './helpers/fixture.mjs';

const completed = {
  format: 'vhhealth_continuity_edge_activation_receipt/v1',
  tenantId: TENANT_ID,
  facilityId: FACILITY_ID,
  edgeHostAssetId: 'asset-edge-vhc-01',
  storageReceipt: 'H1-RWX-2026-07-30',
  cD4Countersignature: 'CD4-SECURITY-2026-07-30',
  cD10Countersignature: 'CD10-PRIVACY-2026-07-30',
  loggingIdentityApproval: 'EDGE-LOG-GRANT-2026-07-30',
  outageDrillReceipt: 'EDGE-DRILL-2026-07-30',
  approvedBy: [
    'clinical-owner',
    'privacy-owner',
    'security-owner',
    'infra-owner',
  ],
  approvedAt: '2026-07-30T00:00:00.000Z',
};

test('accepts only the exact completed activation receipt for this audience', () => {
  assert.equal(
    verifyActivationReceipt(completed, {
      tenantId: TENANT_ID,
      facilityId: FACILITY_ID,
    }).ok,
    true,
  );
});

test('rejects placeholders, missing countersignatures, and audience drift', () => {
  for (const mutation of [
    { edgeHostAssetId: 'OWNER_INPUT' },
    { cD4Countersignature: '' },
    { facilityId: FACILITY_ID + 1 },
  ]) {
    assert.throws(
      () =>
        verifyActivationReceipt(
          { ...completed, ...mutation },
          { tenantId: TENANT_ID, facilityId: FACILITY_ID },
        ),
      /ACTIVATION_RECEIPT_INVALID|is not completed/,
    );
  }
});

test('every edge command remains held when direct execution bypasses systemd', () => {
  assert.throws(
    () => loadEdgeConfig({ VHEDGE_ACTIVATION_APPROVED: 'false' }),
    /VHEDGE_ACTIVATION_APPROVED must be exactly true/,
  );
});
