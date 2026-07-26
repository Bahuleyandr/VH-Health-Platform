import { jest } from '@jest/globals';

import { ensureEmergencyPatientEncounterTx } from '../../services/ed/edPathwayDomainService.js';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATIENT_UID = '20000000-0000-4000-8000-000000000001';
const OWNER_UID = '30000000-0000-4000-8000-000000000001';
const ENCOUNTER_ID = '40000000-0000-4000-8000-000000000001';

function visit() {
  return {
    id: 73,
    patient_uid: PATIENT_UID,
    encounter_id: ENCOUNTER_ID,
    attending_doctor_uid: OWNER_UID,
    arrival_at: new Date('2026-07-26T10:00:00.000Z'),
  };
}

function encounter(overrides = {}) {
  return {
    id: ENCOUNTER_ID,
    tenant_id: TENANT_ID,
    patient_uid: PATIENT_UID,
    encounter_type: 'er',
    status: 'active',
    appointment_id: null,
    admission_id: null,
    admission_encounter_id: null,
    primary_doctor_uid: OWNER_UID,
    metadata: {
      source: 'ed_pathway_domain_service',
      emergency_visit_id: 73,
    },
    ...overrides,
  };
}

test('materializes the exact ER encounter in the supplied tenant transaction', async () => {
  const tx = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    $queryRawUnsafe: jest.fn().mockResolvedValue([encounter()]),
  };

  await expect(ensureEmergencyPatientEncounterTx(tx, {
    tenantId: TENANT_ID,
    visit: visit(),
    actorUid: OWNER_UID,
  })).resolves.toMatchObject({
    id: ENCOUNTER_ID,
    patient_uid: PATIENT_UID,
    encounter_type: 'er',
  });

  expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO patient_encounters'),
    ENCOUNTER_ID,
    TENANT_ID,
    PATIENT_UID,
    OWNER_UID,
    OWNER_UID,
    visit().arrival_at,
    73,
  );
  expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
    expect.stringContaining('FOR SHARE'),
    TENANT_ID,
    ENCOUNTER_ID,
  );
});

test('fails closed when the canonical encounter belongs to another ED episode', async () => {
  const tx = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    $queryRawUnsafe: jest.fn().mockResolvedValue([
      encounter({ metadata: { emergency_visit_id: 74 } }),
    ]),
  };

  await expect(ensureEmergencyPatientEncounterTx(tx, {
    tenantId: TENANT_ID,
    visit: visit(),
    actorUid: OWNER_UID,
  })).rejects.toMatchObject({
    statusCode: 409,
    code: 'EMERGENCY_ENCOUNTER_BINDING_INVALID',
  });
});
