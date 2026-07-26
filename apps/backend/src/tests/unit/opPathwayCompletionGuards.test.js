import { jest } from '@jest/globals';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATIENT_UID = '20000000-0000-4000-8000-000000000001';
const DOCTOR_UID = '30000000-0000-4000-8000-000000000001';
const APPOINTMENT_UID = '40000000-0000-4000-8000-000000000001';
const PATHWAY_ID = '50000000-0000-4000-8000-000000000001';
const APPOINTMENT_ID = 71;

const listExactOpChildSourcesTxMock = jest.fn();
const loadValidatedOpChildProjectionTxMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: jest.fn(),
}));
jest.unstable_mockModule(
  '../../services/appointment/opChildResourceEventService.js',
  () => ({
    OP_CHILD_RESOURCE_EVENT_TYPE: 'appointment.child_resource_linked',
    listExactOpChildSourcesTx: listExactOpChildSourcesTxMock,
    loadValidatedOpChildProjectionTx: loadValidatedOpChildProjectionTxMock,
  }),
);

const {
  evaluateAppointmentPathwayWorkTx,
  __testing__,
} = await import('../../services/appointment/opPathwayWorkService.js');

function appointment(status = 'SCHEDULED') {
  return {
    id: APPOINTMENT_ID,
    uid: APPOINTMENT_UID,
    tenant_id: TENANT_ID,
    patient_uid: PATIENT_UID,
    doctor_uid: DOCTOR_UID,
    status,
  };
}

beforeEach(() => {
  listExactOpChildSourcesTxMock.mockReset();
  loadValidatedOpChildProjectionTxMock.mockReset();
  listExactOpChildSourcesTxMock.mockResolvedValue([]);
});

test('ACTIVE create-to-immediate-complete fails closed until the exact OP instance is projected', async () => {
  const query = jest.fn(async sql => {
    if (sql.includes('FROM discharge_pending_result_handoffs')) return [];
    if (sql.includes('FROM care_pathway_instances AS pathway')) return [];
    if (sql.includes('FROM event_outbox AS event')) return [];
    if (sql.includes('FROM op_visit_closure_evidence')) return [];
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const result = await evaluateAppointmentPathwayWorkTx({
    tx: { $queryRawUnsafe: query },
    tenantId: TENANT_ID,
    appointment: appointment(),
    mode: 'active',
  });

  expect(result.configuration).toMatchObject({
    pathway_instance_id: null,
    projection_pending: true,
    completeness_proven: true,
  });
  expect(result.visit_completion.allowed).toBe(false);
  expect(result.visit_completion.blockers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'APPOINTMENT_PATHWAY_PROJECTION_PENDING',
      }),
    ]),
  );
});

test('pathway closure blocks an open unowned nonblocking child after visit completion may proceed', async () => {
  const query = jest.fn(async sql => {
    if (sql.includes('FROM discharge_pending_result_handoffs')) return [];
    if (sql.includes('SELECT pathway.id, pathway.clinical_status')) {
      return [{ id: PATHWAY_ID, clinical_status: 'active' }];
    }
    if (sql.includes('FROM care_pathway_resource_references AS reference')) {
      return [{
        resource_type: 'referral',
        resource_id: '91',
        relationship_kind: 'child_action',
        evidence_state: 'open',
        accepted_owner_uid: null,
        task_id: null,
        handoff_id: null,
        metadata: { blocking: false },
        owner_name: null,
        owner_role: null,
      }];
    }
    if (sql.includes('FROM event_outbox AS event')) {
      return [{
        id: '81',
        resource_type: 'referral',
        resource_id: '91',
        payload_patient_uid: PATIENT_UID,
        payload_tenant_id: TENANT_ID,
      }];
    }
    if (sql.includes('FROM op_visit_closure_evidence')) return [];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  listExactOpChildSourcesTxMock.mockResolvedValue([{
    resource_type: 'referral',
    resource_id: '91',
  }]);
  loadValidatedOpChildProjectionTxMock.mockResolvedValue({
    resource_type: 'referral',
    resource_id: '91',
    evidence_state: 'open',
  });

  const result = await evaluateAppointmentPathwayWorkTx({
    tx: { $queryRawUnsafe: query },
    tenantId: TENANT_ID,
    appointment: appointment('COMPLETED'),
    mode: 'active',
  });

  expect(result.configuration.completeness_proven).toBe(true);
  expect(result.visit_completion).toEqual({ allowed: true, blockers: [] });
  expect(result.pathway_closure.allowed).toBe(false);
  expect(result.pathway_closure.blockers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'APPOINTMENT_PATHWAY_WORK_OPEN' }),
    ]),
  );
  expect(__testing__.blockerForItem(result.items[0])).toBeNull();
  expect(__testing__.blockerForItem(result.items[0], { requireAll: true }))
    .toMatchObject({ code: 'APPOINTMENT_PATHWAY_WORK_OPEN' });
});
