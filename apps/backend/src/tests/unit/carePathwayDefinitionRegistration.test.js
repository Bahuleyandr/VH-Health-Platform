import process from 'node:process';

import { jest } from '@jest/globals';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const CLINICAL_OWNER_UID = '20000000-0000-4000-8000-000000000001';
const OPERATIONAL_OWNER_UID = '30000000-0000-4000-8000-000000000001';
const APPROVER_UID = '40000000-0000-4000-8000-000000000001';
const VISIBILITY_POLICY = 'policy://care-pathways/op-v1';
const CHECKSUM = 'a'.repeat(64);

let queryImplementation;
const query = jest.fn((sql, parameters) => queryImplementation(sql, parameters));
const connect = jest.fn();
const end = jest.fn();

jest.unstable_mockModule('pg', () => ({
  Client: class FakeClient {
    connect = connect;

    end = end;

    query = query;
  },
}));

const {
  assertCarePathwayRegistrationActorRoles,
  assertExistingCarePathwayRegistrationMatch,
  registerCarePathwayDefinition,
} = await import('../../../scripts/lib/register-care-pathway-definition.mjs');

function registrationArgv(...extra) {
  return [
    'node',
    'register-op-pathway-definition.mjs',
    '--tenant-id',
    TENANT_ID,
    '--clinical-owner-uid',
    CLINICAL_OWNER_UID,
    '--operational-owner-uid',
    OPERATIONAL_OWNER_UID,
    '--approver-uid',
    APPROVER_UID,
    '--patient-visibility-policy-ref',
    VISIBILITY_POLICY,
    ...extra,
  ];
}

function actorRows() {
  return [
    { uid: CLINICAL_OWNER_UID, role: 'DOCTOR' },
    { uid: OPERATIONAL_OWNER_UID, role: 'RECEPTIONIST' },
    { uid: APPROVER_UID, role: 'ADMIN' },
  ];
}

function definitionInput() {
  return {
    definition: {
      steps: [{ step_key: 'observe' }],
      triggers: [],
      defaults: {},
    },
    compiled: {
      workflow_key: 'op_contact_to_recovery',
      version: 1,
      checksum: CHECKSUM,
    },
    displayName: 'Outpatient contact to recovery',
    label: 'OP',
  };
}

describe('care pathway definition registration', () => {
  let originalArgv;
  let originalDatabaseUrl;
  let stdoutWrite;

  beforeEach(() => {
    jest.clearAllMocks();
    originalArgv = process.argv;
    originalDatabaseUrl = process.env.CARE_PATHWAY_REGISTRATION_DATABASE_URL;
    process.argv = registrationArgv();
    process.env.CARE_PATHWAY_REGISTRATION_DATABASE_URL =
      'postgresql://postgres@127.0.0.1:55432/vhhealth_test';
    stdoutWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (originalDatabaseUrl === undefined) {
      delete process.env.CARE_PATHWAY_REGISTRATION_DATABASE_URL;
    } else {
      process.env.CARE_PATHWAY_REGISTRATION_DATABASE_URL = originalDatabaseUrl;
    }
    stdoutWrite.mockRestore();
  });

  it('requires the canonical named-clinician role and keeps the other actor fences', () => {
    const actors = new Map(actorRows().map((row) => [row.uid, row.role]));
    expect(() => assertCarePathwayRegistrationActorRoles(actors, {
      clinicalOwnerUid: CLINICAL_OWNER_UID,
      operationalOwnerUid: OPERATIONAL_OWNER_UID,
      approverUid: APPROVER_UID,
    })).not.toThrow();
    expect(() => assertCarePathwayRegistrationActorRoles(new Map([
      ...actors,
      [CLINICAL_OWNER_UID, 'RECEPTIONIST'],
    ]), {
      clinicalOwnerUid: CLINICAL_OWNER_UID,
      operationalOwnerUid: OPERATIONAL_OWNER_UID,
      approverUid: APPROVER_UID,
    })).toThrow(/canonical named-clinician role/i);
    expect(() => assertCarePathwayRegistrationActorRoles(new Map([
      ...actors,
      [OPERATIONAL_OWNER_UID, 'PATIENT'],
    ]), {
      clinicalOwnerUid: CLINICAL_OWNER_UID,
      operationalOwnerUid: OPERATIONAL_OWNER_UID,
      approverUid: APPROVER_UID,
    })).toThrow(/operational owner.*non-patient/i);
    expect(() => assertCarePathwayRegistrationActorRoles(new Map([
      ...actors,
      [APPROVER_UID, 'DOCTOR'],
    ]), {
      clinicalOwnerUid: CLINICAL_OWNER_UID,
      operationalOwnerUid: OPERATIONAL_OWNER_UID,
      approverUid: APPROVER_UID,
    })).toThrow(/ADMIN or SUPER_ADMIN/i);
  });

  it('performs an actor-validated dry run without publishing governance', async () => {
    queryImplementation = async (sql) => {
      if (sql.includes('FROM users')) return { rows: actorRows() };
      if (sql.includes('FROM workflow_definitions AS definition')) return { rows: [] };
      if (sql.includes('FROM workflow_definitions') && sql.includes('is_active = TRUE')) {
        return { rows: [] };
      }
      return { rows: [] };
    };

    await expect(registerCarePathwayDefinition(definitionInput())).resolves.toBeUndefined();

    const output = JSON.parse(stdoutWrite.mock.calls[0][0]);
    expect(output).toMatchObject({
      mode: 'dry_run',
      tenant_id: TENANT_ID,
      pathway_key: 'op_contact_to_recovery',
      definition_version: 1,
      definition_checksum: CHECKSUM,
      patient_visibility_policy_ref: VISIBILITY_POLICY,
    });
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
  });

  it('fails replay when any requested governance input or approval receipt differs', async () => {
    const exactExisting = {
      workflow_definition_id: 81,
      governance_id: '50000000-0000-4000-8000-000000000001',
      clinical_owner_uid: CLINICAL_OWNER_UID,
      operational_owner_uid: OPERATIONAL_OWNER_UID,
      approved_by: APPROVER_UID,
      patient_visibility_policy_ref: VISIBILITY_POLICY,
      approval_receipt_matches: true,
    };
    expect(() => assertExistingCarePathwayRegistrationMatch({
      ...exactExisting,
      operational_owner_uid: TENANT_ID,
      approval_receipt_matches: false,
    }, {
      clinicalOwnerUid: CLINICAL_OWNER_UID,
      operationalOwnerUid: OPERATIONAL_OWNER_UID,
      approverUid: APPROVER_UID,
      visibilityPolicyRef: VISIBILITY_POLICY,
    })).toThrow(/operational_owner_uid, approval_receipt/i);

    queryImplementation = async (sql) => {
      if (sql.includes('FROM users')) return { rows: actorRows() };
      if (sql.includes('FROM workflow_definitions AS definition')) {
        return {
          rows: [{
            ...exactExisting,
            patient_visibility_policy_ref: 'policy://different',
          }],
        };
      }
      return { rows: [] };
    };

    await expect(registerCarePathwayDefinition(definitionInput()))
      .rejects.toThrow(/patient_visibility_policy_ref/i);
    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
  });

  it('reports an existing definition only when its complete governance tuple matches', async () => {
    queryImplementation = async (sql) => {
      if (sql.includes('FROM users')) return { rows: actorRows() };
      if (sql.includes('FROM workflow_definitions AS definition')) {
        return {
          rows: [{
            workflow_definition_id: 81,
            governance_id: '50000000-0000-4000-8000-000000000001',
            clinical_owner_uid: CLINICAL_OWNER_UID,
            operational_owner_uid: OPERATIONAL_OWNER_UID,
            approved_by: APPROVER_UID,
            patient_visibility_policy_ref: VISIBILITY_POLICY,
            approval_receipt_matches: true,
          }],
        };
      }
      return { rows: [] };
    };

    await expect(registerCarePathwayDefinition(definitionInput())).resolves.toBeUndefined();

    expect(JSON.parse(stdoutWrite.mock.calls[0][0])).toEqual({
      mode: 'existing',
      tenant_id: TENANT_ID,
      pathway_key: 'op_contact_to_recovery',
      definition_checksum: CHECKSUM,
      workflow_definition_id: 81,
      governance_id: '50000000-0000-4000-8000-000000000001',
    });
    expect(query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
  });
});
