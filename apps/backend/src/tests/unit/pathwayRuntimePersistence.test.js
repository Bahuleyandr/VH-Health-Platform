import { jest } from '@jest/globals';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PATIENT = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';
const ENCOUNTER = '44444444-4444-4444-8444-444444444444';
const TX = { $queryRawUnsafe: jest.fn() };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  isTenantTransactionClient: (value) => value === TX,
}));

const {
  acquirePathwayStartLocksTx,
  assertPathwayPatientContextTx,
  assertPathwayReplayDefinitionPinTx,
  assertPathwayTenantScopeTx,
  getPathwayTransitionLedgerStateTx,
  loadGovernedPathwayDefinitionTx,
  preflightPathwaySlaRulesTx,
} = await import('../../services/pathways/pathwayRuntimePersistence.js');

beforeEach(() => {
  TX.$queryRawUnsafe.mockReset();
});

it('requires the exact branded transaction capability', async () => {
  await expect(assertPathwayTenantScopeTx({
    tx: { $queryRawUnsafe: jest.fn() },
    tenantId: TENANT,
  })).rejects.toMatchObject({ code: 'PATHWAY_RUNTIME_TX_REQUIRED' });
});

it('uses integer-returning advisory lock wrappers in sorted order', async () => {
  TX.$queryRawUnsafe.mockResolvedValue([{ lock_count: 1 }]);
  await acquirePathwayStartLocksTx({
    tx: TX,
    tenantId: TENANT,
    workflowDefinitionId: 11,
    pathwayKey: 'synthetic_pathway',
    sourceEpisodeType: 'synthetic_episode',
    sourceEpisodeId: 'episode-1',
    idempotencyKey: 'start_key_1',
  });
  expect(TX.$queryRawUnsafe).toHaveBeenCalledTimes(3);
  for (const call of TX.$queryRawUnsafe.mock.calls) {
    expect(call[0]).toContain('COUNT(*)::integer AS lock_count');
  }
  const keys = TX.$queryRawUnsafe.mock.calls.map((call) => call[1]);
  expect(keys).toEqual([...keys].sort());
  expect(keys[0]).toBe(`${TENANT}:care_pathway:definition:11`);
});

it('acquires the complete nested-start lock set fail-fast in one database call', async () => {
  TX.$queryRawUnsafe.mockResolvedValue([{ fence_result: '' }]);
  await acquirePathwayStartLocksTx({
    tx: TX,
    tenantId: TENANT,
    workflowDefinitionId: 11,
    pathwayKey: 'synthetic_pathway',
    sourceEpisodeType: 'synthetic_episode',
    sourceEpisodeId: 'episode-1',
    idempotencyKey: 'start_key_1',
    waitForLocks: false,
  });
  expect(TX.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  expect(TX.$queryRawUnsafe.mock.calls[0][0]).toContain('care_pathway_acquire_serialization_fences');
  expect(TX.$queryRawUnsafe.mock.calls[0][0]).toContain('::text AS fence_result');
  expect(TX.$queryRawUnsafe.mock.calls[0][1]).toEqual([
    `${TENANT}:care_pathway:definition:11`,
    `${TENANT}:care_pathway:episode:synthetic_pathway:synthetic_episode:episode-1`,
    `${TENANT}:care_pathway:start:start_key_1`,
  ]);
  expect(TX.$queryRawUnsafe.mock.calls[0][2]).toBe(false);
});

it('maps a busy nested-start fence to an explicit retryable conflict', async () => {
  TX.$queryRawUnsafe.mockRejectedValue(Object.assign(new Error('serialization failure'), {
    code: 'P2010',
    meta: {
      driverAdapterError: {
        cause: { originalCode: '40001' },
      },
    },
  }));
  await expect(acquirePathwayStartLocksTx({
    tx: TX,
    tenantId: TENANT,
    workflowDefinitionId: 11,
    pathwayKey: 'synthetic_pathway',
    sourceEpisodeType: 'synthetic_episode',
    sourceEpisodeId: 'episode-1',
    idempotencyKey: 'start_key_1',
    waitForLocks: false,
  })).rejects.toMatchObject({
    statusCode: 409,
    code: 'PATHWAY_START_SERIALIZATION_BUSY',
  });
});

it('loads a normalized transition count and sequence for action mutation guards', async () => {
  TX.$queryRawUnsafe.mockResolvedValueOnce([{ event_count: 7, max_sequence: 9 }]);
  await expect(getPathwayTransitionLedgerStateTx({
    tx: TX,
    tenantId: TENANT,
    pathwayInstanceId: ENCOUNTER,
  })).resolves.toEqual({ eventCount: 7, maxSequence: 9 });
  expect(TX.$queryRawUnsafe.mock.calls[0][0]).toContain('MAX(sequence_number)');
});

it('validates patient role, encounter ownership and a non-patient owner under share locks', async () => {
  TX.$queryRawUnsafe
    .mockResolvedValueOnce([{ uid: PATIENT }])
    .mockResolvedValueOnce([{ id: ENCOUNTER }])
    .mockResolvedValueOnce([{ uid: OWNER }]);
  await expect(assertPathwayPatientContextTx({
    tx: TX,
    tenantId: TENANT,
    patientUid: PATIENT,
    encounterId: ENCOUNTER,
    owningClinicianUid: OWNER,
  })).resolves.toBeUndefined();
  expect(TX.$queryRawUnsafe.mock.calls.every((call) => call[0].includes('FOR SHARE'))).toBe(true);
});

it.each([
  ['non-patient subject', [[], [{ id: ENCOUNTER }], [{ uid: OWNER }]], 'PATHWAY_PATIENT_CONTEXT_INVALID'],
  ['wrong encounter patient', [[{ uid: PATIENT }], [], [{ uid: OWNER }]], 'PATHWAY_PATIENT_CONTEXT_INVALID'],
  ['patient used as owner', [[{ uid: PATIENT }], [],], 'PATHWAY_OWNER_CONTEXT_INVALID'],
])('rejects an invalid %s context', async (_label, responses, code) => {
  for (const response of responses) TX.$queryRawUnsafe.mockResolvedValueOnce(response);
  await expect(assertPathwayPatientContextTx({
    tx: TX,
    tenantId: TENANT,
    patientUid: PATIENT,
    encounterId: _label === 'wrong encounter patient' ? ENCOUNTER : null,
    owningClinicianUid: _label === 'patient used as owner' ? OWNER : null,
  })).rejects.toMatchObject({ code });
});

function governedRow(overrides = {}) {
  return {
    id: 11,
    tenant_id: TENANT,
    workflow_key: 'synthetic_pathway',
    version: 1,
    steps: [],
    triggers: [],
    defaults: {},
    is_active: true,
    governance_id: '55555555-5555-4555-8555-555555555555',
    governance_status: 'approved',
    definition_checksum: 'a'.repeat(64),
    governance_approved_by: OWNER,
    governance_approved_at: '2026-07-19T10:05:00.000Z',
    approval_status: 'approved',
    approval_kind: 'care_pathway_definition_governance',
    approval_subject_resource_type: 'care_pathway_definition',
    approval_subject_resource_id: '11',
    approval_required_approvers: 1,
    approval_approved_by: [{ uid: OWNER }],
    approval_decided_by: OWNER,
    approval_decided_at: '2026-07-19T10:00:00.000Z',
    approval_metadata: {
      care_pathway_definition_governance: { definition_checksum: 'a'.repeat(64) },
    },
    ...overrides,
  };
}

it.each([
  ['pending approval', { approval_status: 'pending' }],
  ['rejected approval', { approval_status: 'rejected' }],
  ['wrong subject type', { approval_subject_resource_type: 'workflow_run' }],
  ['wrong subject id', { approval_subject_resource_id: '12' }],
  ['different deciding actor', { approval_decided_by: PATIENT }],
  ['duplicate-only quorum', {
    approval_required_approvers: 2,
    approval_approved_by: [{ uid: OWNER }, { uid: ` ${OWNER.toUpperCase()} ` }],
  }],
  ['blank approver entry', {
    approval_approved_by: [{ uid: OWNER }, { uid: ' ' }],
  }],
])('fails closed on %s governance evidence', async (_label, override) => {
  TX.$queryRawUnsafe.mockResolvedValueOnce([governedRow(override)]);
  await expect(loadGovernedPathwayDefinitionTx({
    tx: TX,
    tenantId: TENANT,
    workflowDefinitionId: 11,
  })).rejects.toMatchObject({ code: 'PATHWAY_GOVERNANCE_APPROVAL_INVALID' });
});

it('accepts coherent approved definition governance evidence', async () => {
  TX.$queryRawUnsafe.mockResolvedValueOnce([governedRow()]);
  await expect(loadGovernedPathwayDefinitionTx({
    tx: TX,
    tenantId: TENANT,
    workflowDefinitionId: 11,
  })).resolves.toMatchObject({ id: 11, governance_status: 'approved' });
  expect(TX.$queryRawUnsafe.mock.calls[0][0]).not.toContain('FOR SHARE OF d, g, a');
});

it.each([
  ['missing checksum receipt', {}],
  ['non-string checksum receipt', {
    care_pathway_definition_governance: { definition_checksum: 123 },
  }],
  ['whitespace-modified checksum receipt', {
    care_pathway_definition_governance: { definition_checksum: ` ${'a'.repeat(64)}` },
  }],
])('fails closed on %s', async (_label, approvalMetadata) => {
  TX.$queryRawUnsafe.mockResolvedValueOnce([governedRow({
    approval_metadata: approvalMetadata,
  })]);
  await expect(loadGovernedPathwayDefinitionTx({
    tx: TX,
    tenantId: TENANT,
    workflowDefinitionId: 11,
  })).rejects.toMatchObject({ code: 'PATHWAY_GOVERNANCE_APPROVAL_INVALID' });
});

it('verifies replay event, run, instance, governance and approval checksum pins without compiling', async () => {
  TX.$queryRawUnsafe.mockResolvedValueOnce([{
    instance_id: ENCOUNTER,
    instance_tenant_id: TENANT,
    instance_workflow_run_id: 77,
    instance_workflow_definition_id: 11,
    instance_definition_governance_id: '55555555-5555-4555-8555-555555555555',
    instance_definition_checksum: 'a'.repeat(64),
    run_id: 77,
    run_tenant_id: TENANT,
    run_workflow_definition_id: 11,
    run_workflow_key: 'synthetic_pathway',
    run_workflow_version: 1,
    run_pathway_governance_id: '55555555-5555-4555-8555-555555555555',
    run_pathway_definition_checksum: 'a'.repeat(64),
    definition_id: 11,
    definition_workflow_key: 'synthetic_pathway',
    definition_version: 1,
    ...governedRow(),
  }]);
  await expect(assertPathwayReplayDefinitionPinTx({
    tx: TX,
    tenantId: TENANT,
    pathwayInstanceId: ENCOUNTER,
    events: [{
      tenant_id: TENANT,
      pathway_instance_id: ENCOUNTER,
      workflow_run_id: 77,
      transition_key: 'step_completed',
      metadata: { pathway_runtime: { definition_checksum: 'a'.repeat(64) } },
    }],
  })).resolves.toMatchObject({ run: { id: 77 } });
});

it('rejects replay evidence whose exact checksum pin differs before returning a snapshot', async () => {
  TX.$queryRawUnsafe.mockResolvedValueOnce([{
    instance_id: ENCOUNTER,
    instance_tenant_id: TENANT,
    instance_workflow_run_id: 77,
    instance_workflow_definition_id: 11,
    instance_definition_governance_id: '55555555-5555-4555-8555-555555555555',
    instance_definition_checksum: 'a'.repeat(64),
    run_id: 77,
    run_tenant_id: TENANT,
    run_workflow_definition_id: 11,
    run_workflow_key: 'synthetic_pathway',
    run_workflow_version: 1,
    run_pathway_governance_id: '55555555-5555-4555-8555-555555555555',
    run_pathway_definition_checksum: 'a'.repeat(64),
    definition_id: 11,
    definition_workflow_key: 'synthetic_pathway',
    definition_version: 1,
    ...governedRow(),
  }]);
  await expect(assertPathwayReplayDefinitionPinTx({
    tx: TX,
    tenantId: TENANT,
    pathwayInstanceId: ENCOUNTER,
    events: [{
      tenant_id: TENANT,
      pathway_instance_id: ENCOUNTER,
      workflow_run_id: 77,
      transition_key: 'step_completed',
      metadata: { pathway_runtime: { definition_checksum: 'b'.repeat(64) } },
    }],
  })).rejects.toMatchObject({ code: 'PATHWAY_DEFINITION_PIN_MISMATCH' });
});

it('preflights each distinct enabled tenant-or-global SLA rule under a share lock', async () => {
  TX.$queryRawUnsafe.mockResolvedValueOnce([{
    id: '66666666-6666-4666-8666-666666666666',
    tenant_id: null,
    rule_code: 'result_acknowledgement',
    target_minutes: 15,
    owner_role_codes: ['DOCTOR'],
    escalation_role_codes: ['CMO'],
    metadata: {},
  }]);
  const result = await preflightPathwaySlaRulesTx({
    tx: TX,
    tenantId: TENANT,
    compiledDefinition: {
      steps: [
        { work_semantics: {
          sla_completion_semantics: 'acknowledgement',
          sla_rule_code: 'result_acknowledgement',
        } },
        { work_semantics: {
          sla_completion_semantics: 'acknowledgement',
          sla_rule_code: 'result_acknowledgement',
        } },
      ],
    },
  });

  expect(result).toEqual([expect.objectContaining({
    rule_code: 'result_acknowledgement',
    target_minutes: 15,
    sla_completion_semantics: 'acknowledgement',
  })]);
  expect(TX.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  const [sql, tenantId, ruleCode] = TX.$queryRawUnsafe.mock.calls[0];
  expect(sql).toContain('enabled = TRUE');
  expect(sql).toContain('tenant_id = $1::uuid OR tenant_id IS NULL');
  expect(sql).toContain('ORDER BY CASE WHEN tenant_id = $1::uuid THEN 0 ELSE 1 END');
  expect(sql).toContain('FOR SHARE');
  expect([tenantId, ruleCode]).toEqual([TENANT, 'result_acknowledgement']);
});

it('fails start preflight when a required SLA rule is missing or disabled', async () => {
  TX.$queryRawUnsafe.mockResolvedValueOnce([]);
  await expect(preflightPathwaySlaRulesTx({
    tx: TX,
    tenantId: TENANT,
    compiledDefinition: { steps: [{ work_semantics: {
      sla_completion_semantics: 'acknowledgement',
      sla_rule_code: 'disabled_rule',
    } }] },
  })).rejects.toMatchObject({ code: 'PATHWAY_SLA_RULE_UNAVAILABLE' });
});

it('fails start preflight on an invalid SLA target contract', async () => {
  TX.$queryRawUnsafe.mockResolvedValueOnce([{
    id: '66666666-6666-4666-8666-666666666666',
    rule_code: 'invalid_target',
    target_minutes: 0,
  }]);
  await expect(preflightPathwaySlaRulesTx({
    tx: TX,
    tenantId: TENANT,
    compiledDefinition: { steps: [{ work_semantics: {
      sla_completion_semantics: 'domain_evidence',
      sla_rule_code: 'invalid_target',
    } }] },
  })).rejects.toMatchObject({ code: 'PATHWAY_SLA_RULE_CONTRACT_INVALID' });
});

it('rejects conflicting completion semantics for one SLA rule before querying', async () => {
  await expect(preflightPathwaySlaRulesTx({
    tx: TX,
    tenantId: TENANT,
    compiledDefinition: { steps: [
      { work_semantics: {
        sla_completion_semantics: 'acknowledgement',
        sla_rule_code: 'ambiguous_rule',
      } },
      { work_semantics: {
        sla_completion_semantics: 'domain_evidence',
        sla_rule_code: 'ambiguous_rule',
      } },
    ] },
  })).rejects.toMatchObject({ code: 'PATHWAY_SLA_RULE_CONTRACT_INVALID' });
  expect(TX.$queryRawUnsafe).not.toHaveBeenCalled();
});
