import { jest } from '@jest/globals';

import {
  EMERGENCY_PATHWAY_RUNTIME_HANDLERS,
  loadEmergencyPathwayEvidence,
} from '../../services/pathways/emergencyPathwayHandlers.js';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATIENT_UID = '20000000-0000-4000-8000-000000000001';
const OWNER_UID = '30000000-0000-4000-8000-000000000001';
const ACCEPTOR_UID = '40000000-0000-4000-8000-000000000001';
const PATHWAY_ID = '50000000-0000-4000-8000-000000000001';
const HANDOFF_ID = '60000000-0000-4000-8000-000000000001';
const ENCOUNTER_ID = '70000000-0000-4000-8000-000000000001';

function instance() {
  return {
    id: PATHWAY_ID,
    source_episode_type: 'emergency_visit',
    source_episode_id: '73',
  };
}

function evidenceRow(overrides = {}) {
  return {
    id: 73,
    patient_uid: PATIENT_UID,
    encounter_id: ENCOUNTER_ID,
    attending_doctor_uid: OWNER_UID,
    visit_status: 'awaiting_disposition',
    disposition: null,
    disposition_at: null,
    departure_at: null,
    attending_doctor_is_viable: true,
    handoff_id: HANDOFF_ID,
    handoff_status: 'requested',
    handoff_accepted_at: null,
    accepted_by_uid: null,
    intended_recipient_role: 'ICU_NURSE',
    destination: 'icu',
    handoff_task_id: 91,
    handoff_task_kind: 'ed_destination_handoff_review',
    handoff_task_status: 'open',
    handoff_task_legacy_encounter_id: null,
    handoff_task_resource_type: 'care_handoff_instance',
    handoff_task_resource_id: HANDOFF_ID,
    handoff_task_assigned_uid: null,
    handoff_task_assigned_role: 'ICU_NURSE',
    handoff_task_due_at: null,
    handoff_task_sla_instance_id: null,
    handoff_task_sla_semantics: 'none',
    handoff_task_canonical_encounter_id: ENCOUNTER_ID,
    accepter_role: null,
    accepter_is_active: false,
    linked_admission_id: null,
    source_pathway_instance_id: null,
    source_handoff_id: null,
    ...overrides,
  };
}

test('active destination acceptance requires the exact completed role task and active accepter', async () => {
  const tx = { $queryRawUnsafe: jest.fn(async () => [evidenceRow({
    handoff_status: 'accepted',
    handoff_accepted_at: new Date('2026-07-26T10:05:00.000Z'),
    accepted_by_uid: ACCEPTOR_UID,
    handoff_task_status: 'completed',
    accepter_role: 'ICU_NURSE',
    accepter_is_active: true,
  })]) };

  const evidence = await loadEmergencyPathwayEvidence({
    tx,
    tenantId: TENANT_ID,
    instance: instance(),
  });

  expect(evidence).toMatchObject({
    accepted_handoff_valid: true,
    closure_valid: false,
    handoff_id: HANDOFF_ID,
    destination: 'icu',
  });
  await expect(
    EMERGENCY_PATHWAY_RUNTIME_HANDLERS.destinationAcceptance.evaluate({
      loadedEvidence: evidence,
    }),
  ).resolves.toMatchObject({ decision: 'satisfied' });
  const sql = tx.$queryRawUnsafe.mock.calls[0][0];
  expect(sql).toContain("candidate.status IN ('requested', 'accepted')");
  expect(sql).toContain("task.status AS handoff_task_status");
  expect(sql).toContain("UPPER(BTRIM(accepter.role)) AS accepter_role");
});

test.each([
  ['open task', { handoff_task_status: 'open' }],
  ['wrong role', { accepter_role: 'DOCTOR' }],
  ['inactive accepter', { accepter_is_active: false }],
])('%s cannot satisfy destination acceptance', async (_label, overrides) => {
  const tx = { $queryRawUnsafe: jest.fn(async () => [evidenceRow({
    handoff_status: 'accepted',
    handoff_accepted_at: new Date('2026-07-26T10:05:00.000Z'),
    accepted_by_uid: ACCEPTOR_UID,
    handoff_task_status: 'completed',
    accepter_role: 'ICU_NURSE',
    accepter_is_active: true,
    ...overrides,
  })]) };
  const loadedEvidence = await loadEmergencyPathwayEvidence({
    tx,
    tenantId: TENANT_ID,
    instance: instance(),
  });

  await expect(
    EMERGENCY_PATHWAY_RUNTIME_HANDLERS.destinationAcceptance.evaluate({
      loadedEvidence,
    }),
  ).resolves.toMatchObject({ decision: 'blocked' });
});

test('admission closure requires exact pathway and handoff lineage', async () => {
  const tx = { $queryRawUnsafe: jest.fn(async () => [evidenceRow({
    visit_status: 'admitted',
    disposition: 'admitted',
    disposition_at: new Date('2026-07-26T10:06:00.000Z'),
    departure_at: new Date('2026-07-26T10:06:00.000Z'),
    handoff_status: 'accepted',
    handoff_accepted_at: new Date('2026-07-26T10:05:00.000Z'),
    accepted_by_uid: ACCEPTOR_UID,
    handoff_task_status: 'completed',
    accepter_role: 'ICU_NURSE',
    accepter_is_active: true,
    linked_admission_id: 81,
    source_pathway_instance_id: PATHWAY_ID,
    source_handoff_id: HANDOFF_ID,
  })]) };
  const loadedEvidence = await loadEmergencyPathwayEvidence({
    tx,
    tenantId: TENANT_ID,
    instance: instance(),
  });

  expect(loadedEvidence).toMatchObject({
    accepted_handoff_valid: true,
    admission_link_valid: true,
    receiver_closure_valid: true,
    closure_valid: true,
  });
  await expect(
    EMERGENCY_PATHWAY_RUNTIME_HANDLERS.destinationClosure.evaluate({
      loadedEvidence,
    }),
  ).resolves.toMatchObject({ decision: 'satisfied' });
});

test('explicit non-receiver ED closures bypass destination acceptance without faking a handoff', async () => {
  const tx = { $queryRawUnsafe: jest.fn(async () => [evidenceRow({
    visit_status: 'discharged',
    disposition: 'discharged_home',
    disposition_at: new Date('2026-07-26T10:05:00.000Z'),
    departure_at: new Date('2026-07-26T10:05:00.000Z'),
    handoff_id: null,
    handoff_status: null,
    intended_recipient_role: null,
    destination: null,
    handoff_task_id: null,
    handoff_task_status: null,
  })]) };
  const loadedEvidence = await loadEmergencyPathwayEvidence({
    tx,
    tenantId: TENANT_ID,
    instance: instance(),
  });

  expect(loadedEvidence).toMatchObject({
    accepted_handoff_valid: false,
    non_receiver_closure_valid: true,
    closure_valid: true,
  });
  await expect(
    EMERGENCY_PATHWAY_RUNTIME_HANDLERS.destinationAcceptance.evaluate({
      loadedEvidence,
    }),
  ).resolves.toMatchObject({ decision: 'satisfied' });
});
