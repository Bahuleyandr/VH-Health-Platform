import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { __testing__ as serviceTesting } from '../../services/downtime/clinicalContinuityDeviceLossService.js';
import { parseClinicalContinuityDeviceLoss } from '../../validators/clinicalContinuityDeviceLossSchemas.js';

const sourcePath = fileURLToPath(new URL(
  '../../services/downtime/clinicalContinuityDeviceLossService.js',
  import.meta.url,
));
const source = readFileSync(sourcePath, 'utf8');

describe('clinical continuity device-loss command', () => {
  test('normalizes exact device and subject identity without accepting aliases', () => {
    expect(parseClinicalContinuityDeviceLoss({
      stable_device_id: '10000000-0000-4000-8000-000000000003',
      affected_staff_uids: [
        '10000000-0000-4000-8000-000000000002',
        '10000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000002',
      ],
      incident_reference: '  SEC-42  ',
      reason: ' Lost in transit ',
    })).toEqual({
      stableDeviceId: '10000000-0000-4000-8000-000000000003',
      affectedStaffUids: [
        '10000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000002',
      ],
      incidentReference: 'SEC-42',
      reason: 'Lost in transit',
    });

    expect(() => parseClinicalContinuityDeviceLoss({
      device_id: 'friendly-name',
      affected_staff_uids: [],
      incident_reference: 'SEC-42',
      reason: 'Lost in transit',
    })).toThrow('unknown fields');
  });

  test('uses strict typed tenant activation with absence failing closed', () => {
    expect(serviceTesting.activationState({
      clinical_continuity: { device_loss_orchestration: 'active' },
    })).toBe('active');
    expect(serviceTesting.activationState({
      clinical_continuity: { device_loss_orchestration: true },
    })).toBe('absent');
    expect(serviceTesting.activationState({ clinical_continuity: {} })).toBe('absent');
    expect(serviceTesting.activationState({})).toBe('absent');
  });

  test('fixes one immutable next-contact order identity before signing', () => {
    const content = serviceTesting.wipeOrderContent({
      tenant_id: '10000000-0000-4000-8000-000000000001',
      id: '10000000-0000-4000-8000-000000000002',
      stable_device_id: '10000000-0000-4000-8000-000000000003',
      wipe_order_id: '10000000-0000-4000-8000-000000000004',
      wipe_issued_at: new Date('2026-08-05T00:00:00.000Z'),
      incident_reference: 'SEC-42',
      reason: 'Lost in transit',
    }, [41], ['10000000-0000-4000-8000-000000000005']);

    expect(content).toMatchObject({
      command: 'governed_wipe_device',
      execute_at: 'next_authenticated_contact',
      order_id: '10000000-0000-4000-8000-000000000004',
      issued_at: '2026-08-05T00:00:00.000Z',
      facility_ids: ['41'],
    });
    expect(Object.isFrozen(content)).toBe(true);
  });
});

describe('device-loss orchestration reuse boundary', () => {
  test('calls the reviewed grant, C-D15, signer, audit, and C-D6 services', () => {
    expect(source).toMatch(/revokeClinicalContinuityFacilityGrant\s*\(/);
    expect(source).toMatch(/revokeContinuityEdgeGrant\s*\(/);
    expect(source).toMatch(/deactivateScimIdentityTx\s*\(/);
    expect(source).toMatch(/revokeScimIdentityTokens\s*\(/);
    expect(source).toMatch(/signClinicalContinuityCanonicalValue\s*\(/);
    expect(source).toMatch(/recordClinicalAuditEvent\s*\(/);
    expect(source).toMatch(/loadClinicalContinuityReconciliationConfigTx\s*\(/);
  });

  test('does not copy C-D15 relational shutdown SQL', () => {
    expect(source).not.toMatch(/\b(?:DELETE FROM|UPDATE)\s+user_active_sessions\b/i);
    expect(source).not.toMatch(/\b(?:DELETE FROM|UPDATE)\s+staff_auth_sessions\b/i);
    expect(source).not.toMatch(/\bUPDATE\s+staff_devices\b/i);
    expect(source).not.toMatch(/\bpin_hash\s*=\s*NULL\b/i);
    expect(source).not.toMatch(/\bbiometric_enabled\s*=\s*false\b/i);
  });
});
