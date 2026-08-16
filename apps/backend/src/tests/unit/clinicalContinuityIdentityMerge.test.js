import { jest } from '@jest/globals';

const IDS = Object.freeze({
  tenant: '30000000-0000-4000-8000-000000000001',
  incident: '30000000-0000-4000-8000-000000000002',
  packet: '30000000-0000-4000-8000-000000000003',
  paper: '30000000-0000-4000-8000-000000000004',
  temporary: '30000000-0000-4000-8000-000000000005',
  patient: '30000000-0000-4000-8000-000000000006',
  requester: '30000000-0000-4000-8000-000000000007',
  approver: '30000000-0000-4000-8000-000000000008',
  nonClinical: '30000000-0000-4000-8000-000000000009',
  safetyLead: '30000000-0000-4000-8000-000000000010',
});

let mergeState;

const tx = {
  $executeRawUnsafe: jest.fn(async (sql) => {
    if (sql.includes('UPDATE clinical_continuity_temporary_identities')) {
      if (sql.includes("identity_status = 'proposed'")) mergeState.identityStatus = 'proposed';
      if (sql.includes("identity_status = 'matched'")) {
        mergeState.identityStatus = 'matched';
        mergeState.matchedPatientUid = IDS.patient;
      }
    }
    return 1;
  }),
  $queryRawUnsafe: jest.fn(async (sql, ...params) => {
    if (sql.includes('FROM clinical_continuity_temporary_identities AS temp')
      && sql.includes('linked_paper_item_id')) {
      return [{
        id: IDS.temporary,
        identity_status: mergeState.identityStatus,
        lifecycle_state: 'reconciling',
        linked_paper_item_id: IDS.paper,
        target_patient_uid: IDS.patient,
      }];
    }
    if (sql.includes('INSERT INTO patient_merge_requests')) {
      mergeState.request = {
        id: 71,
        requested_by: IDS.requester,
        requester_role: 'MEDICAL_RECORDS',
        primary_uid: IDS.patient,
        status: 'requested',
        continuity_disposition: 'proposed',
        continuity_incident_id: IDS.incident,
        continuity_temporary_identity_id: IDS.temporary,
      };
      return [mergeState.request];
    }
    if (sql.includes('INSERT INTO clinical_continuity_patient_merge_decisions')) {
      const decision = sql.includes("'proposed'")
        ? 'proposed'
        : sql.includes("'approved'")
          ? 'approved'
          : 'executed';
      mergeState.decisions.push(decision);
      return [{ id: `decision-${decision}`, decision }];
    }
    if (sql.includes('FROM patient_merge_requests AS request')
      && sql.includes('clinical_safety_lead_uid')) {
      return [{
        ...mergeState.request,
        lifecycle_state: 'reconciling',
        clinical_safety_lead_uid: IDS.safetyLead,
      }];
    }
    if (sql.includes('AS treating_doctor')) {
      return [{ treating_doctor: mergeState.treatingDoctor }];
    }
    if (sql.includes('UPDATE patient_merge_requests') && sql.includes("continuity_disposition = 'executed'")) {
      mergeState.request = {
        ...mergeState.request,
        status: 'executed',
        continuity_disposition: 'executed',
        execution_summary: JSON.parse(params[1]),
      };
      return [mergeState.request];
    }
    if (sql.includes('UPDATE patient_merge_requests') && sql.includes("continuity_disposition = 'approved'")) {
      mergeState.request = {
        ...mergeState.request,
        status: 'approved',
        continuity_disposition: 'approved',
        approver_uid: params[0],
        approver_role: params[1],
      };
      return [mergeState.request];
    }
    if (sql.includes('FROM patient_merge_requests AS request')
      && sql.includes('temp.identity_status')) {
      return [{
        ...mergeState.request,
        identity_status: mergeState.identityStatus,
        matched_patient_uid: mergeState.matchedPatientUid,
        lifecycle_state: 'reconciling',
        target_patient_uid: IDS.patient,
      }];
    }
    throw new Error(`Unexpected continuity merge SQL: ${sql.slice(0, 120)}`);
  }),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: jest.fn(async (_tenantId, callback) => callback(tx)),
}));
jest.unstable_mockModule('../../services/patient/patientIdentifierService.js', () => ({
  reassignIdentifiersForMerge: jest.fn(),
}));
const recordClinicalAuditEvent = jest.fn(async () => ({ id: 'audit' }));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  cancelWorkflowSla: jest.fn(),
  recordClinicalAuditEvent,
}));

const {
  approveContinuityMerge,
  executeContinuityMerge,
  requestContinuityMerge,
} = await import('../../services/patient/patientMergeService.js');

function propose() {
  return requestContinuityMerge({
    tenantId: IDS.tenant,
    facilityId: 17,
    incidentId: IDS.incident,
    packetId: IDS.packet,
    paperItemRowId: IDS.paper,
    temporaryIdentityId: IDS.temporary,
    targetPatientUid: IDS.patient,
    requestedBy: IDS.requester,
    requesterRole: 'MEDICAL_RECORDS',
  });
}

describe('C5.2 temporary identity two-key merge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mergeState = {
      identityStatus: 'unresolved',
      matchedPatientUid: null,
      request: null,
      decisions: [],
      treatingDoctor: true,
    };
  });

  test('proposes, requires a distinct clinical coapprover, and executes an alias without history rewrite', async () => {
    const proposed = await propose();
    expect(proposed.merge_request).toMatchObject({
      status: 'requested',
      continuity_disposition: 'proposed',
    });
    expect(mergeState.identityStatus).toBe('proposed');

    await expect(approveContinuityMerge({
      tenantId: IDS.tenant,
      facilityId: 17,
      id: 71,
      approvedBy: IDS.requester,
      approverRole: 'DOCTOR',
    })).rejects.toMatchObject({ code: 'CONTINUITY_MERGE_ACTOR_SEPARATION_REQUIRED' });
    expect(mergeState.request.status).toBe('requested');

    const approved = await approveContinuityMerge({
      tenantId: IDS.tenant,
      facilityId: 17,
      id: 71,
      approvedBy: IDS.approver,
      approverRole: 'DOCTOR',
    });
    expect(approved.merge_request).toMatchObject({
      status: 'approved',
      approver_uid: IDS.approver,
    });

    const executed = await executeContinuityMerge({
      tenantId: IDS.tenant,
      facilityId: 17,
      id: 71,
      executedBy: IDS.requester,
      executorRole: 'MEDICAL_RECORDS',
    });
    expect(executed.merge_request.execution_summary).toEqual({
      continuity_identity_alias: true,
      historical_rows_rewritten: 0,
      target_patient_uid: IDS.patient,
      temporary_identity_id: IDS.temporary,
    });
    expect(mergeState).toMatchObject({
      identityStatus: 'matched',
      matchedPatientUid: IDS.patient,
      decisions: ['proposed', 'approved', 'executed'],
    });
    expect(recordClinicalAuditEvent).toHaveBeenCalledTimes(3);
  });

  test('denies a non-clinical second key even when the actor is distinct', async () => {
    await propose();
    await expect(approveContinuityMerge({
      tenantId: IDS.tenant,
      facilityId: 17,
      id: 71,
      approvedBy: IDS.nonClinical,
      approverRole: 'MEDICAL_RECORDS',
    })).rejects.toMatchObject({ code: 'CONTINUITY_MERGE_APPROVER_ROLE_DENIED' });
    expect(mergeState.request.status).toBe('requested');
  });

  test('denies a doctor without a current treatment relationship', async () => {
    await propose();
    mergeState.treatingDoctor = false;
    await expect(approveContinuityMerge({
      tenantId: IDS.tenant,
      facilityId: 17,
      id: 71,
      approvedBy: IDS.approver,
      approverRole: 'DOCTOR',
    })).rejects.toMatchObject({ code: 'CONTINUITY_MERGE_TREATING_DOCTOR_REQUIRED' });
    expect(mergeState.request.status).toBe('requested');
  });

  test('accepts the configured clinical safety lead without inventing a treating relationship', async () => {
    await propose();
    mergeState.treatingDoctor = false;
    const approved = await approveContinuityMerge({
      tenantId: IDS.tenant,
      facilityId: 17,
      id: 71,
      approvedBy: IDS.safetyLead,
      approverRole: 'QUALITY_OFFICER',
    });
    expect(approved.merge_request).toMatchObject({
      status: 'approved',
      approver_uid: IDS.safetyLead,
      approver_role: 'role:clinical_safety_lead',
    });
  });
});
