import { jest } from '@jest/globals';

import {
  auditClinicalContinuityActionDecision
} from '../../services/downtime/clinicalContinuityActionRegistryService.js';

const ACTOR = '22222222-2222-4222-8222-222222222222';

test('constructs PHI-free audit metadata from a closed value allowlist', async () => {
  const create = jest.fn(async args => args);
  const hostile = {
    actionChecksum: 'a'.repeat(64),
    actionId: 'unknown patient 33333333-3333-4333-8333-333333333333',
    actionSchemaChecksum: 'b'.repeat(64),
    actionSchemaVersion: 1,
    actionVersion: 1,
    clientAppVersion: '1.2.3',
    clinicalText: 'Patient reports chest pain after dose',
    decision: 'deny',
    devicePosture: 'desktop',
    facilityId: 41,
    idempotencyKey: 'idem-patient-33333333',
    patient_uid: '33333333-3333-4333-8333-333333333333',
    policyId: '55555555-5555-4555-8555-555555555555',
    policyVersion: '12',
    reasonCode: 'CONTINUITY_ACTION_UNKNOWN',
    registryChecksum: 'c'.repeat(64),
    registryVersion: '7',
    requestId: '77777777-7777-4777-8777-777777777777',
    resourceUrl: '/api/v1/patients/33333333-3333-4333-8333-333333333333/notes',
    reviewOwner: 'clinical_continuity_governance',
    routeTemplate: '/api/v1/patients/33333333-3333-4333-8333-333333333333/notes'
  };

  await auditClinicalContinuityActionDecision({
    tx: { audit_logs: { create } },
    actorUid: ACTOR,
    actorRole: 'DOCTOR',
    value: hostile
  });

  const data = create.mock.calls[0][0].data;
  expect(data).not.toHaveProperty('tenant_id');
  expect(Object.keys(data.metadata).sort()).toEqual([
    'action_checksum',
    'action_id',
    'action_schema_checksum',
    'action_schema_version',
    'action_version',
    'client_app_version',
    'decision',
    'device_posture',
    'facility_id',
    'policy_id',
    'policy_version',
    'reason_code',
    'registry_checksum',
    'registry_version',
    'request_id',
    'review_owner',
    'route_template'
  ]);
  expect(data.resource_id).toBe('unknown');
  expect(data.metadata.route_template).toBe('unmatched');
  const serialized = JSON.stringify(data);
  expect(serialized).not.toContain(hostile.patient_uid);
  expect(serialized).not.toContain(hostile.idempotencyKey);
  expect(serialized).not.toContain(hostile.clinicalText);
  expect(serialized).not.toContain(hostile.resourceUrl);
});
