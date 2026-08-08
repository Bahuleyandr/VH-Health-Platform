import { jest } from '@jest/globals';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATIENT_UID = '20000000-0000-4000-8000-000000000001';
const APPOINTMENT_UID = '30000000-0000-4000-8000-000000000001';
const PATHWAY_ID = '40000000-0000-4000-8000-000000000001';
const TIMELINE_ID = '50000000-0000-4000-8000-000000000001';
const AUDIT_ID = '60000000-0000-4000-8000-000000000001';
const APPOINTMENT_ID = 71;
const PRESCRIPTION_ID = 91;

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: jest.fn(),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  getTenantById: jest.fn(),
  requireTenantId: value => value,
}));

const { __testing__ } = await import(
  '../../services/appointment/opPathwayWorkService.js'
);

function makeTx({ events = [] } = {}) {
  const query = jest.fn(async sql => {
    if (sql.includes('FROM event_outbox AS event')) return events;
    if (sql.includes('WITH RECURSIVE merged_chain')) return [{ uid: PATIENT_UID }];
    if (sql.includes('FROM appointments AS appointment')) {
      return [{
        id: APPOINTMENT_ID,
        uid: APPOINTMENT_UID,
        patient_uid: PATIENT_UID,
      }];
    }
    if (sql.includes('UNION ALL') && sql.includes('FROM e_prescriptions AS resource')) {
      return [{
        resource_type: 'e_prescription',
        resource_id: String(PRESCRIPTION_ID),
      }];
    }
    if (sql.includes('FROM e_prescriptions AS resource')) {
      return [{
        patient_uid: PATIENT_UID,
        occurred_at: new Date('2026-07-23T10:00:00.000Z'),
        status: 'draft',
      }];
    }
    if (sql.includes('FROM clinical_timeline_events')) return [{ id: TIMELINE_ID }];
    if (sql.includes('FROM clinical_audit_events')) return [{ id: AUDIT_ID }];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { tx: { $queryRawUnsafe: query }, query };
}

function projectedPrescription() {
  return {
    resource_type: 'e_prescription',
    id: String(PRESCRIPTION_ID),
    relationship_kind: 'child_action',
    evidence_state: 'open',
    blocking: true,
    owner_uid: null,
    owner_name: null,
    owner_role: null,
    task_id: null,
    handoff_id: null,
    route: 'prescriptions',
  };
}

test('an exact appointment e-prescription without its child event blocks as missing lineage', async () => {
  const { tx, query } = makeTx();
  const result = await __testing__.evaluateChildCompletenessTx(tx, {
    tenantId: TENANT_ID,
    appointment: {
      id: APPOINTMENT_ID,
      uid: APPOINTMENT_UID,
      patient_uid: PATIENT_UID,
    },
    pathwayInstance: { id: PATHWAY_ID },
    projectedItems: [],
  });

  expect(result.configuration).toMatchObject({
    completeness_checked: true,
    completeness_proven: false,
    exact_source_count: 1,
    child_event_count: 0,
    valid_child_event_count: 0,
    missing_source_event_count: 1,
    pending_child_projection_count: 0,
    unsupported_historical_source_types: [],
  });
  expect(result.items).toEqual([
    expect.objectContaining({
      resource_type: 'e_prescription',
      id: String(PRESCRIPTION_ID),
      evidence_state: 'open',
      blocking: true,
      configuration_issue: 'missing_source_event',
      source_evidence_state: 'open',
      route: 'prescriptions',
    }),
  ]);
  const enumerationSql = query.mock.calls
    .map(([sql]) => sql)
    .find(sql => sql.includes('UNION ALL'));
  expect(enumerationSql).toContain("SELECT 'e_prescription'::text");
  expect(enumerationSql).toContain('resource.appointment_id = $2::integer');
  expect(enumerationSql).toContain('resource.patient_uid = $3::uuid');
});

test('a valid exact e-prescription event plus its projection proves completeness normally', async () => {
  const { tx } = makeTx({
    events: [{
      id: '81',
      resource_type: 'e_prescription',
      resource_id: String(PRESCRIPTION_ID),
      payload_patient_uid: PATIENT_UID,
      payload_tenant_id: TENANT_ID,
      created_at: new Date('2026-07-23T10:00:00.000Z'),
    }],
  });
  const result = await __testing__.evaluateChildCompletenessTx(tx, {
    tenantId: TENANT_ID,
    appointment: {
      id: APPOINTMENT_ID,
      uid: APPOINTMENT_UID,
      patient_uid: PATIENT_UID,
    },
    pathwayInstance: { id: PATHWAY_ID },
    projectedItems: [projectedPrescription()],
  });

  expect(result.configuration).toEqual({
    completeness_checked: true,
    completeness_proven: true,
    exact_source_count: 1,
    child_event_count: 1,
    valid_child_event_count: 1,
    missing_source_event_count: 0,
    pending_child_projection_count: 0,
    invalid_child_event_count: 0,
    child_state_mismatch_count: 0,
    unsupported_historical_source_types: [],
    pathway_instance_id: PATHWAY_ID,
  });
  expect(result.items).toEqual([
    expect.objectContaining({
      resource_type: 'e_prescription',
      id: String(PRESCRIPTION_ID),
      evidence_state: 'open',
      source_evidence_state: 'open',
    }),
  ]);
  expect(result.items[0]).not.toHaveProperty('configuration_issue');
});
