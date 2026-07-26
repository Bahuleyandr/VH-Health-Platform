import { jest } from '@jest/globals';

const executePathwayCommand = jest.fn();
const startCarePathwayInstance = jest.fn();
const resolvePathwayModeTx = jest.fn();
const ensureEmergencyPatientEncounterTx = jest.fn();

jest.unstable_mockModule('../../services/ed/edPathwayDomainService.js', () => ({
  ensureEmergencyPatientEncounterTx,
}));
jest.unstable_mockModule('../../services/pathways/pathwayExecutorService.js', () => ({
  executePathwayCommand,
  startCarePathwayInstance,
}));
jest.unstable_mockModule('../../services/pathways/pathwayRuntimePersistence.js', () => ({
  resolvePathwayModeTx,
}));

const {
  EMERGENCY_PATHWAY_EVENT_TYPES,
  projectEmergencyPathwayEvent,
} = await import('../../services/pathways/emergencyPathwayProjector.js');

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATIENT_UID = '20000000-0000-4000-8000-000000000001';
const OWNER_UID = '30000000-0000-4000-8000-000000000001';
const ENCOUNTER_ID = '40000000-0000-4000-8000-000000000001';
const PATHWAY_ID = '50000000-0000-4000-8000-000000000001';

function event(overrides = {}) {
  return {
    id: '91',
    event_type: 'emergency.visit.created',
    aggregate_type: 'emergency_visit',
    aggregate_id: '73',
    patient_uid: PATIENT_UID,
    payload: {
      emergency_visit_id: 73,
      patient_uid: PATIENT_UID,
      visit_number: 'ED-2026-73',
    },
    created_at: new Date('2026-07-26T10:00:00.000Z'),
    ...overrides,
  };
}

function visit() {
  return {
    id: 73,
    patient_uid: PATIENT_UID,
    encounter_id: ENCOUNTER_ID,
    attending_doctor_uid: OWNER_UID,
    status: 'arriving',
    disposition: null,
    created_at: new Date('2026-07-26T10:00:00.000Z'),
    updated_at: new Date('2026-07-26T10:00:00.000Z'),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resolvePathwayModeTx.mockResolvedValue('shadow');
  startCarePathwayInstance.mockResolvedValue({
    id: PATHWAY_ID,
    replayed: false,
  });
  executePathwayCommand.mockResolvedValue({ replayed: false });
  ensureEmergencyPatientEncounterTx.mockResolvedValue({});
});

test('registers the three canonical ED source events', () => {
  expect(EMERGENCY_PATHWAY_EVENT_TYPES).toEqual([
    'emergency.visit.created',
    'emergency.visit.transitioned',
    'emergency.visit.destination_closed',
  ]);
});

test('off mode is behaviorally unchanged and performs no source read or projection', async () => {
  resolvePathwayModeTx.mockResolvedValue('off');
  const tx = { $queryRawUnsafe: jest.fn() };

  await expect(projectEmergencyPathwayEvent({
    tx,
    consumerKey: 'care_pathway_projector',
    generation: 5,
    tenantId: TENANT_ID,
    event: event(),
  })).resolves.toEqual({
    consumer_key: 'care_pathway_projector',
    generation: 5,
    event_type: 'emergency.visit.created',
    pathway_key: 'emergency_arrival_to_aftercare',
    pathway_mode: 'off',
    emergency_visit_id: null,
    emergency_visit_status: null,
    effects_suppressed: true,
  });
  expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  expect(startCarePathwayInstance).not.toHaveBeenCalled();
  expect(executePathwayCommand).not.toHaveBeenCalled();
});

test('shadow mode starts the exact V5 ED pathway and executes the source event', async () => {
  const tx = {
    $queryRawUnsafe: jest.fn()
      .mockResolvedValueOnce([visit()])
      .mockResolvedValueOnce([{ id: 81 }]),
  };

  const result = await projectEmergencyPathwayEvent({
    tx,
    consumerKey: 'care_pathway_projector',
    generation: 5,
    tenantId: TENANT_ID,
    event: event(),
  });

  expect(result).toMatchObject({
    pathway_mode: 'shadow',
    emergency_visit_id: 73,
    emergency_visit_status: 'arriving',
    effects_suppressed: true,
    pathway_instance_id: PATHWAY_ID,
    pathway_replayed: false,
    command_replayed: false,
  });
  expect(startCarePathwayInstance).toHaveBeenCalledWith(expect.objectContaining({
    tenantId: TENANT_ID,
    workflowDefinitionId: 81,
    patientUid: PATIENT_UID,
    encounterId: ENCOUNTER_ID,
    pathwayKey: 'emergency_arrival_to_aftercare',
    sourceEpisodeType: 'emergency_visit',
    sourceEpisodeId: '73',
    owningClinicianUid: OWNER_UID,
    accountableRole: 'DOCTOR',
    idempotencyKey: 'emergency:73:start',
    tx,
  }));
  expect(ensureEmergencyPatientEncounterTx).toHaveBeenCalledWith(tx, {
    tenantId: TENANT_ID,
    visit: visit(),
    actorUid: OWNER_UID,
  });
  expect(executePathwayCommand).toHaveBeenCalledWith(expect.objectContaining({
    tenantId: TENANT_ID,
    pathwayInstanceId: PATHWAY_ID,
    idempotencyKey: 'emergency:73:event:91',
    tx,
  }));
});

test('active mode fails closed without a reconciliation activation capability', async () => {
  resolvePathwayModeTx.mockResolvedValue('active');
  const tx = { $queryRawUnsafe: jest.fn() };

  await expect(projectEmergencyPathwayEvent({
    tx,
    consumerKey: 'care_pathway_projector',
    generation: 5,
    tenantId: TENANT_ID,
    event: event(),
  })).rejects.toMatchObject({
    statusCode: 409,
    code: 'EMERGENCY_PATHWAY_ACTIVATION_EVIDENCE_REQUIRED',
  });
  expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
});

test('rejects an event whose aggregate and payload visit identities disagree', async () => {
  const tx = { $queryRawUnsafe: jest.fn() };

  await expect(projectEmergencyPathwayEvent({
    tx,
    consumerKey: 'care_pathway_projector',
    generation: 5,
    tenantId: TENANT_ID,
    event: event({
      payload: { emergency_visit_id: 74, patient_uid: PATIENT_UID },
    }),
  })).rejects.toMatchObject({
    statusCode: 409,
    code: 'EMERGENCY_PROJECTOR_EVENT_IDENTITY_INVALID',
  });
  expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
});
