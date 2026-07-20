import { randomUUID } from 'node:crypto';

// The concurrency cases must commit on independent connections. Their pathway
// evidence is DB-enforced append-only, so each owns a random tenant in the
// scratch database that the backend test bootstrap recreates before a run.
// Atomicity cases use explicit rollback and verify that no owned rows survive.

import { jest } from '@jest/globals';

import prisma, { isTenantTransactionClient, setTenantTx } from '../lib/prisma.js';
import { compileWorkflowDefinition } from '../services/workflow/workflowDefinitionCompiler.js';
import {
  createRegisteredWorkflowSystemActor,
  createWorkflowRuntimeRegistry,
} from '../services/workflow/workflowRuntimeRegistry.js';
import { transitionTask } from '../services/workflow/taskService.js';

const actualCanonicalModule = await import(
  '../services/clinical/canonicalClinicalPlatformService.js'
);

const canonicalFault = {
  auditOrdinal: null,
  auditWrites: 0,
};

function canonicalFaultDb(tx) {
  if (canonicalFault.auditOrdinal === null) return tx;
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property === '$queryRawUnsafe') {
        return async (sql, ...params) => {
          if (/INSERT\s+INTO\s+clinical_audit_events/i.test(String(sql))) {
            canonicalFault.auditWrites += 1;
            if (canonicalFault.auditWrites === canonicalFault.auditOrdinal) {
              throw new Error('forced pathway canonical-audit failure');
            }
          }
          return target.$queryRawUnsafe(sql, ...params);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

jest.unstable_mockModule(
  '../services/clinical/canonicalClinicalPlatformService.js',
  () => ({
    ...actualCanonicalModule,
    recordCanonicalClinicalEvent: (input, options = {}) => (
      actualCanonicalModule.recordCanonicalClinicalEvent(input, {
        ...options,
        db: canonicalFaultDb(options.db),
      })
    ),
  }),
);

const {
  completePathwayTaskAndExecuteFromRegisteredEvidence,
  createPathwayActivationEvidenceCapabilityForTests,
  executePathwayCommand,
  getCarePathwayInstance,
  startCarePathwayInstance,
} = await import('../services/pathways/pathwayExecutorService.js');
const {
  acquirePathwayStartLocksTx,
} = await import('../services/pathways/pathwayRuntimePersistence.js');

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const APPROVAL_KIND = 'care_pathway_definition_governance';
const APPROVAL_SUBJECT_TYPE = 'care_pathway_definition';
const ROLLBACK_MARKER = 'rollback pathway executor deep fixture';

const actionContexts = new Map();
const conditionEvaluations = new Map();
const evidenceLoaderTenants = new Set();
const evidenceLoaderExpectedTransactions = new Map();
const evidenceLoaderObservations = new Map();
const forwardJumpTenants = new Set();
const domainEvidenceTenants = new Set();
const domainEvidenceDecisionOverrides = new Map();
const childFanoutInputs = new Map();
const childFanoutCalls = new Map();

const registry = createWorkflowRuntimeRegistry({
  version: 980_001,
  conditions: [[
    'synthetic.pathway_condition.v1',
    {
      stepKinds: ['wait', 'task', 'approval'],
      decisionCodes: ['satisfied', 'blocked', 'jump_to_target'],
      loadEvidence: async ({ tenantId, tx }) => {
        if (!evidenceLoaderTenants.has(tenantId)) return {};
        const before = await tx.$queryRawUnsafe(
          `SELECT settings ->> 'outer_probe' AS outer_probe,
                  settings ->> 'loader_probe' AS loader_probe
             FROM tenants
            WHERE id = $1::uuid`,
          tenantId,
        );
        await tx.$queryRawUnsafe(
          `UPDATE tenants
              SET settings = jsonb_set(settings, '{loader_probe}', '"mutated"'::jsonb, true)
            WHERE id = $1::uuid`,
          tenantId,
        );
        const after = await tx.$queryRawUnsafe(
          `SELECT settings ->> 'outer_probe' AS outer_probe,
                  settings ->> 'loader_probe' AS loader_probe
             FROM tenants
            WHERE id = $1::uuid`,
          tenantId,
        );
        return {
          outer_probe_before: before[0].outer_probe,
          outer_probe_after: after[0].outer_probe,
          loader_probe_before: before[0].loader_probe,
          loader_probe_after: after[0].loader_probe,
          tx_branded: isTenantTransactionClient(tx),
          tx_exact: evidenceLoaderExpectedTransactions.get(tenantId) === tx,
        };
      },
      evaluate: async (context) => {
        const { tenantId, signal, loadedEvidence } = context;
        if (domainEvidenceTenants.has(tenantId)) {
          const task = context.tasks[0] || null;
          const sla = context.slas.find(
            (candidate) => String(candidate.id) === String(task?.workflow_sla_instance_id || ''),
          ) || null;
          const satisfied = task?.status === 'completed' && Boolean(sla?.completed_at);
          const decision = domainEvidenceDecisionOverrides.get(tenantId)
            || (satisfied ? 'satisfied' : 'blocked');
          return {
            decision,
            evidence: {
              kind: 'synthetic_registered_domain_evidence',
              resource_type: 'workflow_steps',
              resource_id: String(context.step.id),
              task_status: task?.status || 'not_materialized',
              sla_completed: Boolean(sla?.completed_at),
              forced_decision: domainEvidenceDecisionOverrides.get(tenantId) || null,
            },
          };
        }
        if (evidenceLoaderTenants.has(tenantId)) {
          evidenceLoaderObservations.set(tenantId, {
            loadedEvidence,
            loadedEvidenceFrozen: Object.isFrozen(loadedEvidence),
            evaluateHasTx: Object.hasOwn(context, 'tx'),
            evaluateHasQueryCapability: Object.values(context).some(
              (value) => typeof value?.$queryRawUnsafe === 'function',
            ),
          });
          return { decision: 'satisfied', evidence: loadedEvidence };
        }
        if (forwardJumpTenants.has(tenantId)) {
          return {
            decision: 'jump_to_target',
            evidence: { source: 'synthetic_forward_exception' },
          };
        }
        const commandToken = signal.payload.command_token;
        const evaluation = (conditionEvaluations.get(commandToken) || 0) + 1;
        conditionEvaluations.set(commandToken, evaluation);
        return {
          decision: evaluation === 1 ? 'satisfied' : 'blocked',
          evidence: { signal_kind: signal.kind, evaluation },
        };
      },
    },
  ]],
  actions: [[
    'synthetic.pathway_action.v1',
    {
      stepKinds: ['automation'],
      execute: async (context) => {
        const { tenantId } = context;
        actionContexts.set(tenantId, {
          contextFrozen: Object.isFrozen(context),
          hasTx: Object.hasOwn(context, 'tx'),
          hasQueryCapability: Object.values(context).some(
            (value) => typeof value?.$queryRawUnsafe === 'function',
          ),
        });
        return { recorded: true };
      },
    },
  ]],
  childFanouts: [[
    'synthetic.pathway_child.v1',
    {
      stepKinds: ['subworkflow'],
      resolve: async ({ tenantId }) => {
        childFanoutCalls.set(tenantId, (childFanoutCalls.get(tenantId) || 0) + 1);
        const child = childFanoutInputs.get(tenantId);
        if (!child) throw new Error(`Missing child fan-out fixture for ${tenantId}`);
        return [child];
      },
    },
  ]],
  systemActors: ['synthetic.pathway_projector.v1'],
});

const activationCapability = createPathwayActivationEvidenceCapabilityForTests();

function compactToken() {
  return randomUUID().replaceAll('-', '');
}

function actor(uid) {
  return Object.freeze({
    kind: 'user',
    uid,
    roles: Object.freeze(['DOCTOR']),
    primaryRole: 'DOCTOR',
    authorizationMode: 'assigned_user',
  });
}

function startInput(fixture, definition, suffix = 'start') {
  return {
    tenantId: fixture.tenantId,
    workflowDefinitionId: Number(definition.id),
    patientUid: fixture.patientUid,
    pathwayKey: definition.workflow_key,
    sourceEpisodeType: 'patient',
    sourceEpisodeId: fixture.patientUid,
    owningClinicianUid: fixture.doctorUid,
    accountableRole: 'DOCTOR',
    triggerKind: 'manual',
    triggerPayload: { deep_test: true },
    context: { test_case: suffix },
    metadata: { synthetic: true },
    idempotencyKey: `${suffix}.${compactToken()}`,
    actor: actor(fixture.doctorUid),
    registry,
    activationEvidenceCapability: activationCapability,
  };
}

function commandInput(fixture, instanceId, idempotencyKey, signalKind = 'advance') {
  return {
    tenantId: fixture.tenantId,
    pathwayInstanceId: instanceId,
    idempotencyKey,
    signal: {
      kind: signalKind,
      payload: { deep_test: true, command_token: idempotencyKey },
    },
    actor: actor(fixture.doctorUid),
    registry,
    activationEvidenceCapability: activationCapability,
  };
}

async function seedTenantActors(tx, {
  tenantId = randomUUID(),
  patientUid = randomUUID(),
  doctorUid = randomUUID(),
  approverUid = randomUUID(),
} = {}) {
  const token = compactToken();
  await tx.$queryRawUnsafe(
    `INSERT INTO tenants (id, slug, name, settings)
     VALUES ($1::uuid, $2::text, 'Pathway executor deep test', '{}'::jsonb)`,
    tenantId,
    `pathway-executor-${token}`,
  );
  await tx.$queryRawUnsafe(
    `INSERT INTO users (uid, tenant_id, name, role, is_active, updated_at)
     VALUES ($1::uuid, $3::uuid, 'Pathway Deep Patient', 'PATIENT', true, NOW()),
            ($2::uuid, $3::uuid, 'Pathway Deep Doctor', 'DOCTOR', true, NOW()),
            ($4::uuid, $3::uuid, 'Pathway Deep Approver', 'ADMIN', true, NOW())`,
    patientUid,
    doctorUid,
    tenantId,
    approverUid,
  );
  return { tenantId, patientUid, doctorUid, approverUid };
}

async function seedGovernedDefinition(tx, fixture, rawDefinition) {
  const compiled = compileWorkflowDefinition(rawDefinition, { registry });
  const inserted = await tx.$queryRawUnsafe(
    `INSERT INTO workflow_definitions
       (tenant_id, workflow_key, version, display_name, steps, triggers, defaults,
        is_active, created_by)
     VALUES
       ($1::uuid, $2::text, $3::integer, $4::text, $5::jsonb, $6::jsonb, $7::jsonb,
        true, $8::uuid)
     RETURNING id, workflow_key, version`,
    fixture.tenantId,
    compiled.workflow_key,
    compiled.version,
    `Synthetic ${compiled.workflow_key}`,
    JSON.stringify(rawDefinition.steps),
    JSON.stringify(rawDefinition.triggers || []),
    JSON.stringify(rawDefinition.defaults || {}),
    fixture.doctorUid,
  );
  const definition = inserted[0];
  const decidedAt = new Date(Date.now() - 120_000);
  const approvedAt = new Date(Date.now() - 60_000);
  const approvals = await tx.$queryRawUnsafe(
    `INSERT INTO approvals
       (tenant_id, approval_kind, subject_resource_type, subject_resource_id,
         required_approvers, required_role, status, approved_by, decided_by,
         decided_at, created_by, metadata)
     VALUES
       ($1::uuid, $2::text, $3::text, $4::text,
        1, 'ADMIN', 'approved', $5::jsonb, $6::uuid,
         $7::timestamptz, $6::uuid,
         jsonb_build_object(
           'care_pathway_definition_governance',
           jsonb_build_object('definition_checksum', $8::text)
         ))
     RETURNING id`,
    fixture.tenantId,
    APPROVAL_KIND,
    APPROVAL_SUBJECT_TYPE,
    String(definition.id),
    JSON.stringify([{ uid: fixture.approverUid, at: decidedAt.toISOString() }]),
    fixture.approverUid,
    decidedAt.toISOString(),
    compiled.checksum,
  );
  await tx.$queryRawUnsafe(
    `INSERT INTO care_pathway_definition_governance
       (tenant_id, workflow_definition_id, clinical_owner_uid, operational_owner_uid,
        governance_status, approval_id, approved_by, approved_at,
        patient_visibility_policy_ref, definition_checksum)
     VALUES
       ($1::uuid, $2::integer, $3::uuid, $3::uuid,
        'approved', $4::integer, $7::uuid, $5::timestamptz,
        'staff_only_test_policy', $6::text)`,
    fixture.tenantId,
    Number(definition.id),
    fixture.doctorUid,
    Number(approvals[0].id),
    approvedAt.toISOString(),
    compiled.checksum,
    fixture.approverUid,
  );
  await tx.$queryRawUnsafe(
    `UPDATE tenants
        SET settings = jsonb_set(
          COALESCE(settings, '{}'::jsonb),
          '{care_pathways}',
          COALESCE(settings -> 'care_pathways', '{}'::jsonb)
            || jsonb_build_object($2::text, 'active'::text),
          true
        )
      WHERE id = $1::uuid`,
    fixture.tenantId,
    compiled.workflow_key,
  );
  return { ...definition, compiled };
}

async function seedFixture(definitions) {
  const tenantId = randomUUID();
  return setTenantTx(tenantId, async (tx) => {
    const fixture = await seedTenantActors(tx, { tenantId });
    fixture.definitions = [];
    for (const definition of definitions) {
      fixture.definitions.push(await seedGovernedDefinition(tx, fixture, definition));
    }
    return fixture;
  });
}

async function tenantRuntimeCounts(tenantId) {
  return setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::integer FROM workflow_runs WHERE tenant_id = $1::uuid) AS run_count,
         (SELECT COUNT(*)::integer FROM workflow_steps WHERE tenant_id = $1::uuid) AS step_count,
         (SELECT COUNT(*)::integer FROM tasks WHERE tenant_id = $1::uuid) AS task_count,
         (SELECT COUNT(*)::integer FROM approvals WHERE tenant_id = $1::uuid
           AND workflow_run_id IS NOT NULL) AS approval_count,
         (SELECT COUNT(*)::integer FROM care_pathway_instances WHERE tenant_id = $1::uuid) AS instance_count,
         (SELECT COUNT(*)::integer FROM care_pathway_transition_events WHERE tenant_id = $1::uuid) AS transition_count,
         (SELECT COUNT(*)::integer FROM clinical_timeline_events WHERE tenant_id = $1::uuid
           AND resource_type = 'care_pathway_transition_event') AS timeline_count,
         (SELECT COUNT(*)::integer FROM clinical_audit_events WHERE tenant_id = $1::uuid
           AND resource_type = 'care_pathway_transition_event') AS audit_count`,
      tenantId,
    );
    return Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [key, Number(value)]));
  });
}

function waitDefinition(pathwayKey, stepCount = 3) {
  return {
    workflow_key: pathwayKey,
    version: 1,
    triggers: [],
    defaults: {},
    steps: Array.from({ length: stepCount }, (_, index) => ({
      step_key: `gate_${index + 1}`,
      step_kind: 'wait',
      assigned_role: 'DOCTOR',
      condition_handler: 'synthetic.pathway_condition.v1',
    })),
  };
}

function taskDefinition(pathwayKey) {
  return {
    workflow_key: pathwayKey,
    version: 1,
    triggers: [],
    defaults: {},
    steps: [{
      step_key: 'review_work',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: {
        task_kind: 'review',
        priority: 'normal',
        title: 'Review synthetic pathway work',
        sla_completion_semantics: 'none',
      },
    }],
  };
}

function domainEvidenceTaskDefinition(pathwayKey, ruleCode) {
  return {
    workflow_key: pathwayKey,
    version: 1,
    triggers: [],
    defaults: {},
    steps: [{
      step_key: 'verify_domain_evidence',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      condition_handler: 'synthetic.pathway_condition.v1',
      work_semantics: {
        task_kind: 'verification',
        priority: 'high',
        title: 'Verify synthetic domain evidence',
        sla_completion_semantics: 'domain_evidence',
        sla_rule_code: ruleCode,
      },
    }],
  };
}

function domainEvidenceApprovalDefinition(pathwayKey, ruleCode) {
  return {
    workflow_key: pathwayKey,
    version: 1,
    triggers: [],
    defaults: {},
    steps: [{
      step_key: 'approve_domain_evidence',
      step_kind: 'approval',
      assigned_role: 'DOCTOR',
      condition_handler: 'synthetic.pathway_condition.v1',
      work_semantics: {
        approval_kind: 'synthetic_domain_evidence_review',
        required_approvers: 1,
        required_role: 'DOCTOR',
        task_kind: 'verification',
        priority: 'high',
        title: 'Approve synthetic domain evidence',
        sla_completion_semantics: 'domain_evidence',
        sla_rule_code: ruleCode,
      },
    }],
  };
}

function domainEvidenceExceptionDefinition(pathwayKey, ruleCode) {
  return {
    workflow_key: pathwayKey,
    version: 1,
    triggers: [],
    defaults: {},
    steps: [
      {
        step_key: 'verify_domain_evidence',
        step_kind: 'task',
        assigned_role: 'DOCTOR',
        condition_handler: 'synthetic.pathway_condition.v1',
        exception_transitions: [{
          decision_code: 'jump_to_target',
          target_step_key: 'exception_target',
        }],
        work_semantics: {
          task_kind: 'verification',
          priority: 'high',
          title: 'Verify synthetic domain evidence',
          sla_completion_semantics: 'domain_evidence',
          sla_rule_code: ruleCode,
        },
      },
      {
        step_key: 'exception_target',
        step_kind: 'automation',
        assigned_role: 'DOCTOR',
        action_handler: 'synthetic.pathway_action.v1',
      },
    ],
  };
}

async function seedDomainEvidenceRule(fixture, ruleCode, title = 'Synthetic domain evidence') {
  await setTenantTx(fixture.tenantId, async (tx) => {
    await tx.$queryRawUnsafe(
      `INSERT INTO workflow_sla_rules
         (tenant_id, rule_code, title, trigger_event_type, target_minutes,
          severity, owner_role_codes, escalation_role_codes, enabled, metadata)
       VALUES
         ($1::uuid, $2::text, $3::text, 'synthetic.domain_evidence', 30,
          'high', ARRAY['DOCTOR']::text[], ARRAY['ADMIN']::text[], TRUE,
          '{"synthetic":true}'::jsonb)`,
      fixture.tenantId,
      ruleCode,
      title,
    );
  });
}

function approvalDefinition(pathwayKey) {
  return {
    workflow_key: pathwayKey,
    version: 1,
    triggers: [],
    defaults: {},
    steps: [{
      step_key: 'approve_work',
      step_kind: 'approval',
      assigned_role: 'DOCTOR',
      work_semantics: {
        approval_kind: 'synthetic_pathway_review',
        required_approvers: 1,
        required_role: 'DOCTOR',
        task_kind: 'review',
        priority: 'normal',
        title: 'Approve synthetic pathway work',
        sla_completion_semantics: 'none',
      },
    }],
  };
}

function automationDefinition(pathwayKey) {
  return {
    workflow_key: pathwayKey,
    version: 1,
    triggers: [],
    defaults: {},
    steps: [{
      step_key: 'record_action',
      step_kind: 'automation',
      assigned_role: 'DOCTOR',
      action_handler: 'synthetic.pathway_action.v1',
    }],
  };
}

function evidenceLoaderDefinition(pathwayKey) {
  return {
    workflow_key: pathwayKey,
    version: 1,
    triggers: [],
    defaults: {},
    steps: [
      {
        step_key: 'load_guarded_evidence',
        step_kind: 'wait',
        assigned_role: 'DOCTOR',
        condition_handler: 'synthetic.pathway_condition.v1',
      },
      {
        step_key: 'apply_after_evidence',
        step_kind: 'automation',
        assigned_role: 'DOCTOR',
        action_handler: 'synthetic.pathway_action.v1',
      },
    ],
  };
}

function forwardJumpDefinition(pathwayKey) {
  return {
    workflow_key: pathwayKey,
    version: 1,
    triggers: [],
    defaults: {},
    steps: [
      {
        step_key: 'source_gate',
        step_kind: 'wait',
        assigned_role: 'DOCTOR',
        condition_handler: 'synthetic.pathway_condition.v1',
        exception_transitions: [{
          decision_code: 'jump_to_target',
          target_step_key: 'target_approval',
        }],
      },
      {
        step_key: 'bypassed_action',
        step_kind: 'automation',
        assigned_role: 'DOCTOR',
        action_handler: 'synthetic.pathway_action.v1',
      },
      {
        step_key: 'bypassed_gate',
        step_kind: 'wait',
        assigned_role: 'DOCTOR',
        condition_handler: 'synthetic.pathway_condition.v1',
      },
      {
        step_key: 'target_approval',
        step_kind: 'approval',
        assigned_role: 'DOCTOR',
        work_semantics: {
          approval_kind: 'synthetic_forward_jump_review',
          required_approvers: 1,
          required_role: 'DOCTOR',
          task_kind: 'review',
          priority: 'normal',
          title: 'Review synthetic forward jump',
          sla_completion_semantics: 'none',
        },
      },
    ],
  };
}

async function dropSkipFailureTrigger() {
  await prisma.$executeRawUnsafe(
    'DROP TRIGGER IF EXISTS trg_pathway_executor_deep_fail_skip ON workflow_steps',
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    'DROP FUNCTION IF EXISTS pathway_executor_deep_fail_skip()',
  ).catch(() => {});
}

async function dropStaleCasTrigger() {
  await prisma.$executeRawUnsafe(
    'DROP TRIGGER IF EXISTS trg_pathway_executor_deep_stale_cas ON workflow_steps',
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    'DROP FUNCTION IF EXISTS pathway_executor_deep_stale_cas()',
  ).catch(() => {});
}

async function installStaleCasTrigger() {
  await dropStaleCasTrigger();
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION pathway_executor_deep_stale_cas()
     RETURNS trigger
     LANGUAGE plpgsql
     AS $$
     BEGIN
       IF OLD.status = 'in_progress'
          AND NEW.status = 'completed'
          AND EXISTS (
            SELECT 1
              FROM tenants
             WHERE id = NEW.tenant_id
               AND settings ->> 'executor_deep_stale_cas' = 'true'
          )
       THEN
         RETURN NULL;
       END IF;
       RETURN NEW;
     END;
     $$`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER trg_pathway_executor_deep_stale_cas
       BEFORE UPDATE OF status ON workflow_steps
       FOR EACH ROW EXECUTE FUNCTION pathway_executor_deep_stale_cas()`,
  );
}

async function installSkipFailureTrigger() {
  await dropSkipFailureTrigger();
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION pathway_executor_deep_fail_skip()
     RETURNS trigger
     LANGUAGE plpgsql
     AS $$
     BEGIN
       IF OLD.status = 'pending'
          AND NEW.status = 'skipped'
          AND NEW.ordering = 2
          AND EXISTS (
            SELECT 1
              FROM tenants
             WHERE id = NEW.tenant_id
               AND settings ->> 'executor_deep_fail_skip' = 'true'
          )
       THEN
         RAISE EXCEPTION 'forced pathway second-skip failure';
       END IF;
       RETURN NEW;
     END;
     $$`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER trg_pathway_executor_deep_fail_skip
       BEFORE UPDATE OF status ON workflow_steps
       FOR EACH ROW EXECUTE FUNCTION pathway_executor_deep_fail_skip()`,
  );
}

d('pathway executor PostgreSQL conformance', () => {
  beforeEach(() => {
    canonicalFault.auditOrdinal = null;
    canonicalFault.auditWrites = 0;
    actionContexts.clear();
    conditionEvaluations.clear();
    evidenceLoaderTenants.clear();
    evidenceLoaderExpectedTransactions.clear();
    evidenceLoaderObservations.clear();
    forwardJumpTenants.clear();
    domainEvidenceTenants.clear();
    domainEvidenceDecisionOverrides.clear();
    childFanoutInputs.clear();
    childFanoutCalls.clear();
  });

  afterAll(async () => {
    await dropSkipFailureTrigger();
    await dropStaleCasTrigger();
    await prisma.$disconnect().catch(() => {});
  });

  it('rolls back every runtime and canonical row when atomic start evidence fails', async () => {
    const fixture = await seedFixture([
      automationDefinition(`synthetic_atomic_start_${compactToken()}`),
    ]);
    const definition = fixture.definitions[0];
    canonicalFault.auditOrdinal = 1;

    await expect(startCarePathwayInstance(startInput(
      fixture,
      definition,
      'atomic-start-failure',
    ))).rejects.toThrow('forced pathway canonical-audit failure');

    await expect(tenantRuntimeCounts(fixture.tenantId)).resolves.toEqual({
      run_count: 0,
      step_count: 0,
      task_count: 0,
      approval_count: 0,
      instance_count: 0,
      transition_count: 0,
      timeline_count: 0,
      audit_count: 0,
    });
  }, 60_000);

  it('serializes two competing workers into two legal forward commands', async () => {
    const fixture = await seedFixture([
      waitDefinition(`synthetic_concurrency_${compactToken()}`),
    ]);
    const definition = fixture.definitions[0];
    const started = await startCarePathwayInstance(startInput(
      fixture,
      definition,
      'two-worker-start',
    ));
    const keyA = `worker-a.${compactToken()}`;
    const keyB = `worker-b.${compactToken()}`;

    const outcomes = await Promise.allSettled([
      executePathwayCommand(commandInput(fixture, started.id, keyA, 'worker_a')),
      executePathwayCommand(commandInput(fixture, started.id, keyB, 'worker_b')),
    ]);
    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
    const currentSteps = outcomes.map((outcome) => outcome.value.instance.run.current_step_key).sort();
    expect(currentSteps).toEqual(['gate_2', 'gate_3']);
    const persistedKeys = outcomes.map((outcome) => outcome.value.events[0].idempotency_key);
    expect(persistedKeys.every((key) => key.startsWith(`u:${fixture.doctorUid}:`))).toBe(true);
    expect(persistedKeys).not.toContain(keyA);
    expect(persistedKeys).not.toContain(keyB);

    const bundle = await getCarePathwayInstance({
      tenantId: fixture.tenantId,
      id: started.id,
    });
    expect(bundle.run).toMatchObject({ status: 'blocked', current_step_key: 'gate_3' });
    expect(bundle.steps.map((step) => step.status)).toEqual([
      'completed',
      'completed',
      'blocked',
    ]);

    await setTenantTx(fixture.tenantId, async (tx) => {
      const commandGroups = await tx.$queryRawUnsafe(
        `SELECT idempotency_key, COUNT(*)::integer AS event_count
           FROM care_pathway_transition_events
          WHERE tenant_id = $1::uuid
            AND pathway_instance_id = $2::uuid
            AND idempotency_key = ANY($3::text[])
          GROUP BY idempotency_key
          ORDER BY idempotency_key`,
        fixture.tenantId,
        started.id,
        persistedKeys,
      );
      expect(commandGroups).toHaveLength(2);
      expect(commandGroups.every((row) => Number(row.event_count) > 0)).toBe(true);
      const sequences = await tx.$queryRawUnsafe(
        `SELECT sequence_number
           FROM care_pathway_transition_events
          WHERE tenant_id = $1::uuid AND pathway_instance_id = $2::uuid
          ORDER BY sequence_number`,
        fixture.tenantId,
        started.id,
      );
      expect(sequences.map((row) => Number(row.sequence_number))).toEqual(
        Array.from({ length: sequences.length }, (_, index) => index + 1),
      );
    });
  }, 60_000);

  it('fails fast when nested starts acquire definition locks in opposite order', async () => {
    const tenantId = randomUUID();
    const barriers = {
      leftReady: Promise.withResolvers(),
      rightReady: Promise.withResolvers(),
      leftFailed: Promise.withResolvers(),
      rightFailed: Promise.withResolvers(),
    };
    const lockInput = (workflowDefinitionId) => ({
      tenantId,
      workflowDefinitionId,
      pathwayKey: `synthetic_child_${workflowDefinitionId}`,
      sourceEpisodeType: 'synthetic_child_episode',
      sourceEpisodeId: `episode-${workflowDefinitionId}`,
      idempotencyKey: `c:${String(workflowDefinitionId).padStart(64, '0')}`,
      waitForLocks: false,
    });
    const contender = async ({ first, second, ready, peerReady, failed, peerFailed }) => (
      setTenantTx(tenantId, async (tx) => {
        await acquirePathwayStartLocksTx({ tx, ...lockInput(first) });
        ready.resolve();
        await peerReady.promise;
        let failure;
        try {
          await acquirePathwayStartLocksTx({ tx, ...lockInput(second) });
        } catch (error) {
          failure = error;
        }
        failed.resolve();
        await peerFailed.promise;
        if (failure) throw failure;
        throw new Error('nested start lock contention unexpectedly succeeded');
      })
    );

    const outcomes = await Promise.allSettled([
      contender({
        first: 900001,
        second: 900002,
        ready: barriers.leftReady,
        peerReady: barriers.rightReady,
        failed: barriers.leftFailed,
        peerFailed: barriers.rightFailed,
      }),
      contender({
        first: 900002,
        second: 900001,
        ready: barriers.rightReady,
        peerReady: barriers.leftReady,
        failed: barriers.rightFailed,
        peerFailed: barriers.leftFailed,
      }),
    ]);

    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
    for (const outcome of outcomes) {
      expect(outcome.reason).toMatchObject({
        statusCode: 409,
        code: 'PATHWAY_START_SERIALIZATION_BUSY',
      });
      expect(outcome.reason.code).not.toBe('40P01');
      expect(outcome.reason.message).toContain('retry the transaction');
    }
  }, 30_000);

  it('replays the original committed response after an intervening command', async () => {
    const fixture = await seedFixture([
      waitDefinition(`synthetic_lost_response_${compactToken()}`),
    ]);
    const definition = fixture.definitions[0];
    const started = await startCarePathwayInstance(startInput(
      fixture,
      definition,
      'lost-response-start',
    ));
    const lostKey = `lost-response.${compactToken()}`;
    const original = await executePathwayCommand(commandInput(
      fixture,
      started.id,
      lostKey,
      'first_command',
    ));
    expect(original.instance.run.current_step_key).toBe('gate_2');

    await executePathwayCommand(commandInput(
      fixture,
      started.id,
      `intervening.${compactToken()}`,
      'second_command',
    ));
    const transitionCountBeforeRetry = (await tenantRuntimeCounts(
      fixture.tenantId,
    )).transition_count;

    const replay = await executePathwayCommand(commandInput(
      fixture,
      started.id,
      lostKey,
      'first_command',
    ));
    expect(replay.replayed).toBe(true);
    expect(replay.events.map((event) => event.id)).toEqual(
      original.events.map((event) => event.id),
    );
    expect(replay.instance.run.current_step_key).toBe(
      original.instance.run.current_step_key,
    );
    await expect(tenantRuntimeCounts(fixture.tenantId)).resolves.toMatchObject({
      transition_count: transitionCountBeforeRetry,
    });
  }, 60_000);

  it('rolls back run, step, task, and prior command evidence when canonical evidence fails late', async () => {
    const fixture = await seedFixture([
      taskDefinition(`synthetic_command_rollback_${compactToken()}`),
    ]);
    const definition = fixture.definitions[0];
    const started = await startCarePathwayInstance(startInput(
      fixture,
      definition,
      'command-rollback-start',
    ));
    const before = await tenantRuntimeCounts(fixture.tenantId);
    expect(before).toMatchObject({
      run_count: 1,
      step_count: 1,
      task_count: 0,
      approval_count: 0,
      instance_count: 1,
      transition_count: 1,
      timeline_count: 1,
      audit_count: 1,
    });
    canonicalFault.auditOrdinal = 4;

    await expect(executePathwayCommand(commandInput(
      fixture,
      started.id,
      `command-rollback.${compactToken()}`,
      'materialize_work',
    ))).rejects.toThrow('forced pathway canonical-audit failure');
    expect(canonicalFault.auditWrites).toBe(4);

    const bundle = await getCarePathwayInstance({
      tenantId: fixture.tenantId,
      id: started.id,
    });
    expect(bundle.run).toMatchObject({ status: 'started', current_step_key: null });
    expect(bundle.steps).toHaveLength(1);
    expect(bundle.steps[0].status).toBe('pending');
    expect(bundle.tasks).toEqual([]);
    await expect(tenantRuntimeCounts(fixture.tenantId)).resolves.toEqual(before);
  }, 60_000);

  it('rolls back activation and buffered action evidence when completion loses its CAS', async () => {
    const fixture = await seedFixture([
      automationDefinition(`synthetic_stale_cas_${compactToken()}`),
    ]);
    const definition = fixture.definitions[0];
    const started = await startCarePathwayInstance(startInput(
      fixture,
      definition,
      'stale-cas-start',
    ));
    await setTenantTx(fixture.tenantId, async (tx) => {
      await tx.$queryRawUnsafe(
        `UPDATE tenants
            SET settings = jsonb_set(
              settings,
              '{executor_deep_stale_cas}',
              'true'::jsonb,
              true
            )
          WHERE id = $1::uuid`,
        fixture.tenantId,
      );
    });
    const before = await tenantRuntimeCounts(fixture.tenantId);
    await installStaleCasTrigger();
    try {
      await expect(executePathwayCommand(commandInput(
        fixture,
        started.id,
        `stale-cas.${compactToken()}`,
        'inject_stale_writer',
      ))).rejects.toMatchObject({ code: 'PATHWAY_STEP_CAS_CONFLICT' });
    } finally {
      await dropStaleCasTrigger();
    }

    const bundle = await getCarePathwayInstance({
      tenantId: fixture.tenantId,
      id: started.id,
    });
    expect(bundle.run).toMatchObject({ status: 'started', current_step_key: null });
    expect(bundle.steps).toHaveLength(1);
    expect(bundle.steps[0]).toMatchObject({
      status: 'pending',
      completed_at: null,
      outcome: null,
    });
    expect(actionContexts.get(fixture.tenantId)).toEqual({
      contextFrozen: true,
      hasTx: false,
      hasQueryCapability: false,
    });
    await expect(tenantRuntimeCounts(fixture.tenantId)).resolves.toEqual(before);
  }, 60_000);

  it('keeps shadow execution observable while suppressing task and approval effects', async () => {
    const fixture = await seedFixture([
      approvalDefinition(`synthetic_shadow_${compactToken()}`),
    ]);
    const definition = fixture.definitions[0];
    await setTenantTx(fixture.tenantId, async (tx) => {
      await tx.$queryRawUnsafe(
        `UPDATE tenants
            SET settings = jsonb_set(
              settings,
              ARRAY['care_pathways', $2::text],
              '"shadow"'::jsonb,
              false
            )
          WHERE id = $1::uuid`,
        fixture.tenantId,
        definition.workflow_key,
      );
    });
    const started = await startCarePathwayInstance(startInput(
      fixture,
      definition,
      'shadow-start',
    ));
    const result = await executePathwayCommand(commandInput(
      fixture,
      started.id,
      `shadow-command.${compactToken()}`,
      'observe_shadow',
    ));

    expect(result.mode).toBe('shadow');
    expect(result.instance.tasks).toEqual([]);
    expect(result.instance.approvals).toEqual([]);
    expect(result.events.map((event) => event.transition_key)).toEqual(expect.arrayContaining([
      'task_materialization_suppressed',
      'approval_materialization_suppressed',
    ]));
    const suppressedEffects = result.events.filter((event) => (
      ['task_materialization_suppressed', 'approval_materialization_suppressed']
        .includes(event.transition_key)
    ));
    expect(suppressedEffects).toHaveLength(2);
    expect(suppressedEffects.every((event) => (
      Number(event.workflow_step_id) === Number(result.instance.steps[0].id)
    ))).toBe(true);
    await expect(tenantRuntimeCounts(fixture.tenantId)).resolves.toMatchObject({
      task_count: 0,
      approval_count: 0,
    });
  }, 60_000);

  it('deduplicates active approval work under concurrent lost-response retries', async () => {
    const fixture = await seedFixture([
      approvalDefinition(`synthetic_approval_${compactToken()}`),
    ]);
    const definition = fixture.definitions[0];
    const started = await startCarePathwayInstance(startInput(
      fixture,
      definition,
      'approval-dedup-start',
    ));
    const commandKey = `approval-dedup.${compactToken()}`;

    const [first, second] = await Promise.all([
      executePathwayCommand(commandInput(fixture, started.id, commandKey, 'materialize_approval')),
      executePathwayCommand(commandInput(fixture, started.id, commandKey, 'materialize_approval')),
    ]);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    const persistedCommandKey = first.events[0].idempotency_key;

    const bundle = await getCarePathwayInstance({
      tenantId: fixture.tenantId,
      id: started.id,
    });
    expect(bundle.tasks).toHaveLength(1);
    expect(bundle.approvals).toHaveLength(1);
    expect(Number(bundle.approvals[0].task_id)).toBe(Number(bundle.tasks[0].id));
    expect(bundle.tasks[0].stage_occurrence_key).toBe(
      `${started.id}:approve_work:approval_task`,
    );
    await setTenantTx(fixture.tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT event.transition_key, event.workflow_step_id, step.step_key
           FROM care_pathway_transition_events AS event
           JOIN workflow_steps AS step
             ON step.tenant_id = event.tenant_id
            AND step.id = event.workflow_step_id
            AND step.workflow_run_id = event.workflow_run_id
          WHERE event.tenant_id = $1::uuid
            AND event.pathway_instance_id = $2::uuid
            AND event.idempotency_key = $3::text
            AND event.transition_key IN ('task_materialized', 'approval_materialized')
          ORDER BY event.effect_ordinal`,
        fixture.tenantId,
        started.id,
        persistedCommandKey,
      );
      expect(rows).toEqual([
        {
          transition_key: 'task_materialized',
          workflow_step_id: bundle.steps[0].id,
          step_key: 'approve_work',
        },
        {
          transition_key: 'approval_materialized',
          workflow_step_id: bundle.steps[0].id,
          step_key: 'approve_work',
        },
      ]);
    });
  }, 60_000);

  it('isolates registered condition evidence reads in a rollback-only savepoint', async () => {
    const fixture = await seedFixture([
      evidenceLoaderDefinition(`synthetic_evidence_loader_${compactToken()}`),
    ]);
    const definition = fixture.definitions[0];
    const started = await startCarePathwayInstance(startInput(
      fixture,
      definition,
      'evidence-loader-start',
    ));
    evidenceLoaderTenants.add(fixture.tenantId);

    await setTenantTx(fixture.tenantId, async (tx) => {
      evidenceLoaderExpectedTransactions.set(fixture.tenantId, tx);
      await tx.$queryRawUnsafe(
        `UPDATE tenants
            SET settings = jsonb_set(settings, '{outer_probe}', '"visible"'::jsonb, true)
          WHERE id = $1::uuid`,
        fixture.tenantId,
      );
      const completed = await executePathwayCommand({
        ...commandInput(
          fixture,
          started.id,
          `evidence-loader.${compactToken()}`,
          'load_evidence',
        ),
        tx,
      });
      expect(completed.instance.run.status).toBe('completed');
    });

    const evaluation = evidenceLoaderObservations.get(fixture.tenantId);
    expect(evaluation).toMatchObject({
      loadedEvidence: {
        outer_probe_before: 'visible',
        outer_probe_after: 'visible',
        loader_probe_before: null,
        loader_probe_after: 'mutated',
        tx_branded: true,
        tx_exact: true,
      },
      loadedEvidenceFrozen: true,
      evaluateHasTx: false,
      evaluateHasQueryCapability: false,
    });
    expect(actionContexts.get(fixture.tenantId)).toEqual({
      contextFrozen: true,
      hasTx: false,
      hasQueryCapability: false,
    });
    await setTenantTx(fixture.tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT settings ->> 'outer_probe' AS outer_probe,
                settings ->> 'loader_probe' AS loader_probe
           FROM tenants
          WHERE id = $1::uuid`,
        fixture.tenantId,
      );
      expect(rows[0]).toEqual({ outer_probe: 'visible', loader_probe: null });
    });
  }, 60_000);

  it('completes registered domain work before same-transaction evidence re-verification', async () => {
    const ruleCode = `synthetic_domain_${compactToken()}`.slice(0, 100);
    const fixture = await seedFixture([
      domainEvidenceTaskDefinition(`synthetic_domain_task_${compactToken()}`, ruleCode),
    ]);
    const definition = fixture.definitions[0];
    await setTenantTx(fixture.tenantId, async (tx) => {
      await tx.$queryRawUnsafe(
        `INSERT INTO workflow_sla_rules
           (tenant_id, rule_code, title, trigger_event_type, target_minutes,
            severity, owner_role_codes, escalation_role_codes, enabled, metadata)
         VALUES
           ($1::uuid, $2::text, 'Synthetic domain evidence', 'synthetic.domain_evidence', 30,
            'high', ARRAY['DOCTOR']::text[], ARRAY['ADMIN']::text[], TRUE,
            '{"synthetic":true}'::jsonb)`,
        fixture.tenantId,
        ruleCode,
      );
    });
    domainEvidenceTenants.add(fixture.tenantId);
    const started = await startCarePathwayInstance(startInput(
      fixture,
      definition,
      'domain-evidence-start',
    ));
    const materialized = await executePathwayCommand(commandInput(
      fixture,
      started.id,
      `domain-evidence-materialize.${compactToken()}`,
      'check_domain_evidence',
    ));
    expect(materialized.instance.run).toMatchObject({
      status: 'running',
      current_step_key: 'verify_domain_evidence',
    });
    expect(materialized.instance.tasks).toHaveLength(1);
    expect(materialized.instance.tasks[0]).toMatchObject({
      status: 'open',
      sla_completion_semantics: 'domain_evidence',
    });
    await expect(transitionTask({
      tenantId: fixture.tenantId,
      id: Number(materialized.instance.tasks[0].id),
      nextStatus: 'completed',
      actorUid: fixture.doctorUid,
    })).rejects.toMatchObject({ code: 'PATHWAY_EXECUTOR_REQUIRED' });
    const stillOpen = await getCarePathwayInstance({
      tenantId: fixture.tenantId,
      id: started.id,
    });
    expect(stillOpen.tasks[0].status).toBe('open');

    const completionKey = `domain-evidence-complete.${compactToken()}`;
    await setTenantTx(fixture.tenantId, async (tx) => {
      const combinedInput = {
        ...commandInput(fixture, started.id, completionKey, 'reverify_domain_evidence'),
        taskId: Number(materialized.instance.tasks[0].id),
        workflowRunId: Number(materialized.instance.run.id),
        workflowStepId: Number(materialized.instance.steps[0].id),
        conditionHandler: 'synthetic.pathway_condition.v1',
        evidence: {
          kind: 'synthetic_verified_result',
          resource_type: 'synthetic_result',
          resource_id: 'result-42',
        },
        tx,
      };
      const combined = await completePathwayTaskAndExecuteFromRegisteredEvidence(combinedInput);
      expect(combined.instance.run.status).toBe('completed');
      const replayed = await completePathwayTaskAndExecuteFromRegisteredEvidence(combinedInput);
      expect(replayed).toMatchObject({ replayed: true, mode: 'active' });
      const taskEvidenceEvent = replayed.events.find(
        (event) => event.transition_key === 'domain_evidence_task_completed',
      );
      expect(taskEvidenceEvent).toMatchObject({
        transition_scope: 'task',
        workflow_step_id: materialized.instance.steps[0].id,
        source_resource_type: 'tasks',
        source_resource_id: String(materialized.instance.tasks[0].id),
        workflow_sla_instance_id: materialized.instance.tasks[0].workflow_sla_instance_id,
        event_payload: {
          task_id: materialized.instance.tasks[0].id,
          workflow_sla_instance_id: materialized.instance.tasks[0].workflow_sla_instance_id,
          evidence: {
            kind: 'pathway_registered_condition',
            handler_id: 'synthetic.pathway_condition.v1',
            decision: 'satisfied',
          },
        },
      });
      expect(taskEvidenceEvent.event_payload.evidence).toEqual(expect.objectContaining({
        evidence_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }));
      expect(taskEvidenceEvent.event_payload.evidence).not.toHaveProperty('payload');

      const rows = await tx.$queryRawUnsafe(
        `SELECT task.status AS task_status,
                task.due_at AS task_due_at,
                sla.status AS sla_status,
                sla.due_at AS sla_due_at,
                sla.completed_at AS sla_completed_at,
                sla.metadata -> 'completion_evidence' AS completion_evidence
           FROM tasks AS task
           JOIN workflow_sla_instances AS sla
             ON sla.tenant_id = task.tenant_id
            AND sla.id = task.workflow_sla_instance_id
          WHERE task.tenant_id = $1::uuid
            AND task.id = $2::bigint`,
        fixture.tenantId,
        Number(materialized.instance.tasks[0].id),
      );
      expect(rows[0]).toMatchObject({
        task_status: 'completed',
        sla_status: 'completed',
        completion_evidence: {
          kind: 'pathway_registered_condition',
          handler_id: 'synthetic.pathway_condition.v1',
          decision: 'satisfied',
          resource_type: 'workflow_steps',
          resource_id: String(materialized.instance.steps[0].id),
          provenance: {
            actor_kind: 'user',
            actor_uid: fixture.doctorUid,
            authorization_mode: 'assigned_user',
            signal_kind: 'reverify_domain_evidence',
          },
        },
      });
      expect(rows[0].sla_completed_at).not.toBeNull();
      expect(new Date(rows[0].task_due_at).toISOString()).toBe(
        new Date(rows[0].sla_due_at).toISOString(),
      );
    });
  }, 60_000);

  it('keeps evidence-satisfied approval work open until the governed approval is decided', async () => {
    const ruleCode = `synthetic_domain_approval_${compactToken()}`.slice(0, 100);
    const fixture = await seedFixture([
      domainEvidenceApprovalDefinition(`synthetic_domain_approval_${compactToken()}`, ruleCode),
    ]);
    await seedDomainEvidenceRule(fixture, ruleCode, 'Synthetic approval evidence');
    domainEvidenceTenants.add(fixture.tenantId);
    const started = await startCarePathwayInstance(startInput(
      fixture,
      fixture.definitions[0],
      'domain-evidence-approval-start',
    ));
    const materialized = await executePathwayCommand(commandInput(
      fixture,
      started.id,
      `domain-evidence-approval-materialize.${compactToken()}`,
      'check_domain_evidence_approval',
    ));
    expect(materialized.instance.tasks).toHaveLength(1);
    expect(materialized.instance.approvals).toHaveLength(1);

    const completed = await completePathwayTaskAndExecuteFromRegisteredEvidence({
      ...commandInput(
        fixture,
        started.id,
        `domain-evidence-approval-complete.${compactToken()}`,
        'reverify_domain_evidence_approval',
      ),
      taskId: Number(materialized.instance.tasks[0].id),
      workflowRunId: Number(materialized.instance.run.id),
      workflowStepId: Number(materialized.instance.steps[0].id),
      conditionHandler: 'synthetic.pathway_condition.v1',
      evidence: {
        kind: 'synthetic_verified_result',
        resource_type: 'synthetic_result',
        resource_id: 'approval-result-42',
      },
    });

    expect(completed.instance.run).toMatchObject({
      status: 'running',
      current_step_key: 'approve_domain_evidence',
    });
    expect(completed.instance.tasks[0].status).toBe('completed');
    expect(completed.instance.approvals[0].status).toBe('pending');
    expect(completed.events.map((event) => event.transition_key)).toEqual(expect.arrayContaining([
      'domain_evidence_task_completed',
      'approval_waiting',
    ]));
    expect(completed.events.some((event) => event.transition_key === 'step_completed')).toBe(false);
    const waiting = completed.events.find((event) => event.transition_key === 'approval_waiting');
    expect(waiting.event_payload).toEqual(expect.objectContaining({
      task_id: materialized.instance.tasks[0].id,
      approval_id: materialized.instance.approvals[0].id,
      evidence_satisfied: true,
      condition_evidence: expect.any(Object),
    }));
  }, 60_000);

  it.each([
    ['blocked/unsatisfied', domainEvidenceTaskDefinition, 'blocked'],
    ['exception-routed', domainEvidenceExceptionDefinition, 'jump_to_target'],
  ])('rolls task and SLA completion back when registered evidence is %s', async (
    _label,
    definitionFactory,
    forcedDecision,
  ) => {
    const ruleCode = `synthetic_domain_postcondition_${compactToken()}`.slice(0, 100);
    const fixture = await seedFixture([
      definitionFactory(`synthetic_domain_postcondition_${compactToken()}`, ruleCode),
    ]);
    await seedDomainEvidenceRule(fixture, ruleCode, 'Synthetic postcondition evidence');
    domainEvidenceTenants.add(fixture.tenantId);
    const started = await startCarePathwayInstance(startInput(
      fixture,
      fixture.definitions[0],
      'domain-evidence-postcondition-start',
    ));
    const materialized = await executePathwayCommand(commandInput(
      fixture,
      started.id,
      `domain-evidence-postcondition-materialize.${compactToken()}`,
      'check_domain_evidence_postcondition',
    ));
    const beforeCounts = await tenantRuntimeCounts(fixture.tenantId);
    const before = await getCarePathwayInstance({
      tenantId: fixture.tenantId,
      id: started.id,
    });
    domainEvidenceDecisionOverrides.set(fixture.tenantId, forcedDecision);

    await expect(completePathwayTaskAndExecuteFromRegisteredEvidence({
      ...commandInput(
        fixture,
        started.id,
        `domain-evidence-postcondition-complete.${compactToken()}`,
        'reverify_domain_evidence_postcondition',
      ),
      taskId: Number(materialized.instance.tasks[0].id),
      workflowRunId: Number(materialized.instance.run.id),
      workflowStepId: Number(materialized.instance.steps[0].id),
      conditionHandler: 'synthetic.pathway_condition.v1',
      evidence: {
        kind: 'synthetic_verified_result',
        resource_type: 'synthetic_result',
        resource_id: `${forcedDecision}-result-42`,
      },
    })).rejects.toMatchObject({ code: 'PATHWAY_DOMAIN_EVIDENCE_POSTCONDITION_FAILED' });

    await expect(tenantRuntimeCounts(fixture.tenantId)).resolves.toEqual(beforeCounts);
    const after = await getCarePathwayInstance({
      tenantId: fixture.tenantId,
      id: started.id,
    });
    expect(after.run).toEqual(before.run);
    expect(after.steps).toEqual(before.steps);
    expect(after.tasks[0].status).toBe('open');
    await setTenantTx(fixture.tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT sla.status AS sla_status,
                sla.completed_at,
                COUNT(comment.id)::integer AS completion_comment_count
           FROM tasks AS task
           JOIN workflow_sla_instances AS sla
             ON sla.tenant_id = task.tenant_id
            AND sla.id = task.workflow_sla_instance_id
           LEFT JOIN task_comments AS comment
             ON comment.tenant_id = task.tenant_id
            AND comment.task_id = task.id
            AND comment.metadata ->> 'completion_via' = 'domain_evidence'
          WHERE task.tenant_id = $1::uuid
            AND task.id = $2::bigint
          GROUP BY sla.status, sla.completed_at`,
        fixture.tenantId,
        Number(materialized.instance.tasks[0].id),
      );
      expect(rows).toEqual([{
        sla_status: 'active',
        completed_at: null,
        completion_comment_count: 0,
      }]);
    });
  }, 60_000);

  it('rejects cross-instance task wiring and same-user key reuse before mutating the target task', async () => {
    const ruleA = `synthetic_domain_context_a_${compactToken()}`.slice(0, 100);
    const ruleB = `synthetic_domain_context_b_${compactToken()}`.slice(0, 100);
    const fixture = await seedFixture([
      domainEvidenceTaskDefinition(`synthetic_domain_context_a_${compactToken()}`, ruleA),
      domainEvidenceTaskDefinition(`synthetic_domain_context_b_${compactToken()}`, ruleB),
    ]);
    await seedDomainEvidenceRule(fixture, ruleA, 'Synthetic context evidence A');
    await seedDomainEvidenceRule(fixture, ruleB, 'Synthetic context evidence B');
    domainEvidenceTenants.add(fixture.tenantId);
    const startedA = await startCarePathwayInstance(startInput(
      fixture,
      fixture.definitions[0],
      'domain-evidence-context-a-start',
    ));
    const startedB = await startCarePathwayInstance(startInput(
      fixture,
      fixture.definitions[1],
      'domain-evidence-context-b-start',
    ));
    const materializedA = await executePathwayCommand(commandInput(
      fixture,
      startedA.id,
      `domain-evidence-context-a-materialize.${compactToken()}`,
      'check_domain_evidence_context_a',
    ));
    const materializedB = await executePathwayCommand(commandInput(
      fixture,
      startedB.id,
      `domain-evidence-context-b-materialize.${compactToken()}`,
      'check_domain_evidence_context_b',
    ));
    const taskA = materializedA.instance.tasks[0];
    const taskB = materializedB.instance.tasks[0];

    await expect(completePathwayTaskAndExecuteFromRegisteredEvidence({
      ...commandInput(
        fixture,
        startedB.id,
        `domain-evidence-crosswire.${compactToken()}`,
        'crosswire_domain_evidence',
      ),
      taskId: Number(taskA.id),
      workflowRunId: Number(materializedA.instance.run.id),
      workflowStepId: Number(materializedA.instance.steps[0].id),
      conditionHandler: 'synthetic.pathway_condition.v1',
      evidence: { resource_id: 'crosswire-result' },
    })).rejects.toMatchObject({ code: 'PATHWAY_TASK_CONTEXT_MISMATCH' });

    const sharedRawKey = `domain-evidence-shared-user-key.${compactToken()}`;
    await completePathwayTaskAndExecuteFromRegisteredEvidence({
      ...commandInput(fixture, startedA.id, sharedRawKey, 'complete_domain_evidence_a'),
      taskId: Number(taskA.id),
      workflowRunId: Number(materializedA.instance.run.id),
      workflowStepId: Number(materializedA.instance.steps[0].id),
      conditionHandler: 'synthetic.pathway_condition.v1',
      evidence: { resource_id: 'result-a' },
    });
    await expect(completePathwayTaskAndExecuteFromRegisteredEvidence({
      ...commandInput(fixture, startedB.id, sharedRawKey, 'complete_domain_evidence_b'),
      taskId: Number(taskB.id),
      workflowRunId: Number(materializedB.instance.run.id),
      workflowStepId: Number(materializedB.instance.steps[0].id),
      conditionHandler: 'synthetic.pathway_condition.v1',
      evidence: { resource_id: 'different-result-b' },
    })).rejects.toMatchObject({ code: 'PATHWAY_IDEMPOTENCY_KEY_REUSED' });

    const bundleB = await getCarePathwayInstance({
      tenantId: fixture.tenantId,
      id: startedB.id,
    });
    expect(bundleB.tasks[0].status).toBe('open');
    await setTenantTx(fixture.tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT sla.status AS sla_status,
                sla.completed_at,
                COUNT(comment.id)::integer AS completion_comment_count
           FROM tasks AS task
           JOIN workflow_sla_instances AS sla
             ON sla.tenant_id = task.tenant_id
            AND sla.id = task.workflow_sla_instance_id
           LEFT JOIN task_comments AS comment
             ON comment.tenant_id = task.tenant_id
            AND comment.task_id = task.id
            AND comment.metadata ->> 'completion_via' = 'domain_evidence'
          WHERE task.tenant_id = $1::uuid
            AND task.id = $2::bigint
          GROUP BY sla.status, sla.completed_at`,
        fixture.tenantId,
        Number(taskB.id),
      );
      expect(rows).toEqual([{
        sla_status: 'active',
        completed_at: null,
        completion_comment_count: 0,
      }]);
    });
  }, 60_000);

  it('rolls task and SLA completion back when combined executor evidence fails', async () => {
    const ruleCode = `synthetic_domain_rollback_${compactToken()}`.slice(0, 100);
    const fixture = await seedFixture([
      domainEvidenceTaskDefinition(`synthetic_domain_rollback_${compactToken()}`, ruleCode),
    ]);
    const definition = fixture.definitions[0];
    await setTenantTx(fixture.tenantId, async (tx) => {
      await tx.$queryRawUnsafe(
        `INSERT INTO workflow_sla_rules
           (tenant_id, rule_code, title, trigger_event_type, target_minutes,
            severity, owner_role_codes, escalation_role_codes, enabled, metadata)
         VALUES
           ($1::uuid, $2::text, 'Synthetic domain evidence rollback',
            'synthetic.domain_evidence_rollback', 30, 'high', ARRAY['DOCTOR']::text[],
            ARRAY['ADMIN']::text[], TRUE, '{"synthetic":true}'::jsonb)`,
        fixture.tenantId,
        ruleCode,
      );
    });
    domainEvidenceTenants.add(fixture.tenantId);
    const started = await startCarePathwayInstance(startInput(
      fixture,
      definition,
      'domain-evidence-rollback-start',
    ));
    const materialized = await executePathwayCommand(commandInput(
      fixture,
      started.id,
      `domain-evidence-rollback-materialize.${compactToken()}`,
      'check_domain_evidence',
    ));
    const beforeCounts = await tenantRuntimeCounts(fixture.tenantId);
    canonicalFault.auditOrdinal = 1;

    await expect(completePathwayTaskAndExecuteFromRegisteredEvidence({
      ...commandInput(
        fixture,
        started.id,
        `domain-evidence-rollback-complete.${compactToken()}`,
        'reverify_domain_evidence',
      ),
      taskId: Number(materialized.instance.tasks[0].id),
      workflowRunId: Number(materialized.instance.run.id),
      workflowStepId: Number(materialized.instance.steps[0].id),
      conditionHandler: 'synthetic.pathway_condition.v1',
      evidence: {
        kind: 'synthetic_verified_result',
        resource_type: 'synthetic_result',
        resource_id: 'rollback-result-42',
      },
    })).rejects.toThrow('forced pathway canonical-audit failure');

    await expect(tenantRuntimeCounts(fixture.tenantId)).resolves.toEqual(beforeCounts);
    await setTenantTx(fixture.tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT task.status AS task_status,
                sla.status AS sla_status,
                sla.completed_at,
                COUNT(comment.id)::integer AS completion_comment_count
           FROM tasks AS task
           JOIN workflow_sla_instances AS sla
             ON sla.tenant_id = task.tenant_id
            AND sla.id = task.workflow_sla_instance_id
           LEFT JOIN task_comments AS comment
             ON comment.tenant_id = task.tenant_id
            AND comment.task_id = task.id
            AND comment.metadata ->> 'completion_via' = 'domain_evidence'
          WHERE task.tenant_id = $1::uuid
            AND task.id = $2::bigint
          GROUP BY task.status, sla.status, sla.completed_at`,
        fixture.tenantId,
        Number(materialized.instance.tasks[0].id),
      );
      expect(rows).toEqual([{
        task_status: 'open',
        sla_status: 'active',
        completed_at: null,
        completion_comment_count: 0,
      }]);
    });
  }, 60_000);

  it('converges a two-connection domain-completion and executor race without duplicate closure', async () => {
    const ruleCode = `synthetic_domain_race_${compactToken()}`.slice(0, 100);
    const fixture = await seedFixture([
      domainEvidenceTaskDefinition(`synthetic_domain_race_${compactToken()}`, ruleCode),
    ]);
    const definition = fixture.definitions[0];
    await setTenantTx(fixture.tenantId, async (tx) => {
      await tx.$queryRawUnsafe(
        `INSERT INTO workflow_sla_rules
           (tenant_id, rule_code, title, trigger_event_type, target_minutes,
            severity, owner_role_codes, escalation_role_codes, enabled, metadata)
         VALUES
           ($1::uuid, $2::text, 'Synthetic domain evidence race',
            'synthetic.domain_evidence_race', 30, 'high', ARRAY['DOCTOR']::text[],
            ARRAY['ADMIN']::text[], TRUE, '{"synthetic":true}'::jsonb)`,
        fixture.tenantId,
        ruleCode,
      );
    });
    domainEvidenceTenants.add(fixture.tenantId);
    const started = await startCarePathwayInstance(startInput(
      fixture,
      definition,
      'domain-evidence-race-start',
    ));
    const materialized = await executePathwayCommand(commandInput(
      fixture,
      started.id,
      `domain-evidence-race-materialize.${compactToken()}`,
      'check_domain_evidence',
    ));
    const task = materialized.instance.tasks[0];
    const step = materialized.instance.steps[0];
    const run = materialized.instance.run;
    const racingCommandKey = `domain-evidence-race-command.${compactToken()}`;

    const [completionResult, racingResult] = await Promise.allSettled([
      completePathwayTaskAndExecuteFromRegisteredEvidence({
        ...commandInput(fixture, started.id, racingCommandKey, 'complete_domain_evidence'),
        taskId: Number(task.id),
        workflowRunId: Number(run.id),
        workflowStepId: Number(step.id),
        conditionHandler: 'synthetic.pathway_condition.v1',
        evidence: {
          kind: 'synthetic_verified_result',
          resource_type: 'synthetic_result',
          resource_id: 'race-result-42',
        },
      }),
      executePathwayCommand(commandInput(
        fixture,
        started.id,
        `domain-evidence-race-competitor.${compactToken()}`,
        'race_domain_evidence',
      )),
    ]);
    expect(completionResult.status).toBe('fulfilled');
    const completion = completionResult.value;
    expect(completion.instance.tasks[0].status).toBe('completed');
    if (racingResult.status === 'rejected') {
      expect(racingResult.reason).toMatchObject({ code: 'PATHWAY_RUN_TERMINAL' });
    }
    let finalBundle = completion.instance.run.status === 'completed'
      ? completion.instance
      : racingResult.value?.instance;
    if (finalBundle.run.status !== 'completed') {
      finalBundle = (await executePathwayCommand(commandInput(
        fixture,
        started.id,
        `domain-evidence-race-retry.${compactToken()}`,
        'retry_domain_evidence',
      ))).instance;
    }
    expect(finalBundle.run.status).toBe('completed');

    await setTenantTx(fixture.tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT task.status AS task_status,
                sla.status AS sla_status,
                COUNT(comment.id)::integer AS completion_comment_count
           FROM tasks AS task
           JOIN workflow_sla_instances AS sla
             ON sla.tenant_id = task.tenant_id
            AND sla.id = task.workflow_sla_instance_id
           LEFT JOIN task_comments AS comment
             ON comment.tenant_id = task.tenant_id
            AND comment.task_id = task.id
            AND comment.metadata ->> 'completion_via' = 'domain_evidence'
          WHERE task.tenant_id = $1::uuid
            AND task.id = $2::bigint
          GROUP BY task.status, sla.status`,
        fixture.tenantId,
        Number(task.id),
      );
      expect(rows).toEqual([{
        task_status: 'completed',
        sla_status: 'completed',
        completion_comment_count: 1,
      }]);
    });
  }, 60_000);

  it('records skipped intermediates before activating and materializing a forward-jump target', async () => {
    const fixture = await seedFixture([
      forwardJumpDefinition(`synthetic_forward_jump_${compactToken()}`),
    ]);
    const definition = fixture.definitions[0];
    const started = await startCarePathwayInstance(startInput(
      fixture,
      definition,
      'forward-jump-start',
    ));
    forwardJumpTenants.add(fixture.tenantId);

    const result = await executePathwayCommand(commandInput(
      fixture,
      started.id,
      `forward-jump.${compactToken()}`,
      'jump_to_target',
    ));
    expect(result.instance.run).toMatchObject({
      status: 'running',
      current_step_key: 'target_approval',
    });
    expect(result.instance.steps.map((step) => step.status)).toEqual([
      'completed',
      'skipped',
      'skipped',
      'in_progress',
    ]);
    for (const step of result.instance.steps.slice(1, 3)) {
      expect(step).toMatchObject({
        outcome: 'forward_exception_bypassed',
        outcome_payload: {
          source_step_key: 'source_gate',
          target_step_key: 'target_approval',
          decision: 'jump_to_target',
        },
      });
    }
    expect(result.instance.tasks).toHaveLength(1);
    expect(result.instance.approvals).toHaveLength(1);
    const skippedEvents = result.events.filter(
      (event) => event.transition_key === 'step_skipped',
    );
    expect(skippedEvents).toHaveLength(2);
    expect(skippedEvents.map((event) => event.stage_key)).toEqual([
      'bypassed_action',
      'bypassed_gate',
    ]);
    const stepIds = new Map(result.instance.steps.map((step) => [
      step.step_key,
      Number(step.id),
    ]));
    const stageEffects = result.events.filter((event) => (
      event.stage_key && ['step', 'task', 'approval'].includes(event.transition_scope)
    ));
    expect(stageEffects.every((event) => (
      Number(event.workflow_step_id) === stepIds.get(event.stage_key)
    ))).toBe(true);
    expect(skippedEvents.every((event) => (
      event.previous_state.status === 'pending'
      && event.new_state.status === 'skipped'
      && event.event_payload.decision === 'jump_to_target'
    ))).toBe(true);
  }, 60_000);

  it('rolls back the entire forward jump when an intermediate skip fails', async () => {
    const fixture = await seedFixture([
      forwardJumpDefinition(`synthetic_forward_jump_failure_${compactToken()}`),
    ]);
    const definition = fixture.definitions[0];
    const started = await startCarePathwayInstance(startInput(
      fixture,
      definition,
      'forward-jump-failure-start',
    ));
    forwardJumpTenants.add(fixture.tenantId);
    await setTenantTx(fixture.tenantId, async (tx) => {
      await tx.$queryRawUnsafe(
        `UPDATE tenants
            SET settings = jsonb_set(settings, '{executor_deep_fail_skip}', 'true'::jsonb, true)
          WHERE id = $1::uuid`,
        fixture.tenantId,
      );
    });
    const before = await tenantRuntimeCounts(fixture.tenantId);
    await installSkipFailureTrigger();
    try {
      await expect(executePathwayCommand(commandInput(
        fixture,
        started.id,
        `forward-jump-failure.${compactToken()}`,
        'jump_to_target',
      ))).rejects.toThrow('forced pathway second-skip failure');
    } finally {
      await dropSkipFailureTrigger();
    }

    const bundle = await getCarePathwayInstance({
      tenantId: fixture.tenantId,
      id: started.id,
    });
    expect(bundle.run).toMatchObject({ status: 'started', current_step_key: null });
    expect(bundle.steps.map((step) => step.status)).toEqual([
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    expect(bundle.tasks).toEqual([]);
    expect(bundle.approvals).toEqual([]);
    await expect(tenantRuntimeCounts(fixture.tenantId)).resolves.toEqual(before);
  }, 60_000);

  it('persists sealed system-actor lineage through the executor evidence chain', async () => {
    const fixture = await seedFixture([
      waitDefinition(`synthetic_system_actor_${compactToken()}`, 1),
    ]);
    const definition = fixture.definitions[0];
    const started = await startCarePathwayInstance(startInput(
      fixture,
      definition,
      'system-actor-start',
    ));
    const commandKey = `system-actor.${compactToken()}`;
    const occurredAt = '2026-07-19T04:30:00.000Z';
    const signalContext = {
      sourceResourceType: 'event_outbox',
      sourceResourceId: '9223372036854775807',
      occurredAt,
    };
    const bigintSystemActor = createRegisteredWorkflowSystemActor({
      registry,
      systemKey: 'synthetic.pathway_projector.v1',
      sourceEventId: 9223372036854775807n,
      causationId: commandKey,
      signalContext,
    });
    const stringSystemActor = createRegisteredWorkflowSystemActor({
      registry,
      systemKey: 'synthetic.pathway_projector.v1',
      sourceEventId: '0009223372036854775807',
      causationId: commandKey,
      signalContext,
    });

    const command = {
      tenantId: fixture.tenantId,
      pathwayInstanceId: started.id,
      idempotencyKey: commandKey,
      signal: {
        kind: 'project_event',
        payload: { command_token: commandKey },
      },
      registry,
      activationEvidenceCapability: activationCapability,
    };
    const result = await executePathwayCommand({ ...command, actor: bigintSystemActor });
    expect(result.instance.run.status).toBe('completed');
    const persistedCommandKey = result.events[0].idempotency_key;
    expect(persistedCommandKey).toMatch(/^s:[a-f0-9]{64}$/);
    expect(persistedCommandKey).not.toContain(commandKey);
    const replay = await executePathwayCommand({ ...command, actor: stringSystemActor });
    expect(replay.replayed).toBe(true);
    expect(replay.events.map((event) => event.id)).toEqual(
      result.events.map((event) => event.id),
    );

    await setTenantTx(fixture.tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT transition.id AS transition_id,
                transition.actor_uid, transition.system_actor_key, transition.actor_role,
                transition.source_resource_type, transition.source_resource_id,
                to_char(
                  transition.occurred_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                ) AS occurred_at_utc,
                transition.metadata AS transition_metadata,
                timeline.actor_uid AS timeline_actor_uid,
                timeline.source_table AS timeline_source_table,
                timeline.source_id AS timeline_source_id,
                timeline.payload AS timeline_payload,
                audit.actor_uid AS audit_actor_uid,
                audit.resource_table AS audit_resource_table,
                audit.resource_id AS audit_resource_id,
                audit.metadata AS audit_metadata
           FROM care_pathway_transition_events AS transition
           JOIN clinical_timeline_events AS timeline
             ON timeline.tenant_id = transition.tenant_id
            AND timeline.id = transition.canonical_timeline_event_id
           JOIN clinical_audit_events AS audit
             ON audit.tenant_id = transition.tenant_id
            AND audit.id = transition.canonical_audit_event_id
          WHERE transition.tenant_id = $1::uuid
            AND transition.pathway_instance_id = $2::uuid
            AND transition.idempotency_key = $3::text
          ORDER BY transition.effect_ordinal`,
        fixture.tenantId,
        started.id,
        persistedCommandKey,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row).toMatchObject({
          actor_uid: null,
          system_actor_key: 'synthetic.pathway_projector.v1',
          actor_role: null,
          source_resource_type: 'event_outbox',
          source_resource_id: '9223372036854775807',
          transition_metadata: {
            provenance: {
              kind: 'system',
              system_key: 'synthetic.pathway_projector.v1',
              source_event_id: '9223372036854775807',
              causation_id: commandKey,
            },
          },
          timeline_actor_uid: null,
          timeline_source_table: 'care_pathway_transition_events',
          timeline_source_id: row.transition_id,
          timeline_payload: {
            system_actor_key: 'synthetic.pathway_projector.v1',
            event_id: row.transition_id,
          },
          audit_actor_uid: null,
          audit_resource_table: 'care_pathway_transition_events',
          audit_resource_id: row.transition_id,
          audit_metadata: {
            provenance: {
              kind: 'system',
              system_key: 'synthetic.pathway_projector.v1',
              source_event_id: '9223372036854775807',
              causation_id: commandKey,
            },
          },
        });
        expect(row.occurred_at_utc).toBe(occurredAt);
      }
    });
  }, 60_000);

  it('deduplicates registered child fan-out under concurrent lost-response retries', async () => {
    const childKey = `synthetic_child_${compactToken()}`;
    const parentKey = `synthetic_parent_${compactToken()}`;
    const fixture = await seedFixture([
      waitDefinition(childKey, 1),
      {
        workflow_key: parentKey,
        version: 1,
        triggers: [],
        defaults: {},
        steps: [{
          step_key: 'launch_child',
          step_kind: 'subworkflow',
          assigned_role: 'DOCTOR',
          child_rules: [{
            rule_key: 'child_episode',
            fanout_handler: 'synthetic.pathway_child.v1',
            child_pathway_key: childKey,
            relationship: 'informational',
          }],
        }],
      },
    ]);
    const childDefinition = fixture.definitions[0];
    const parentDefinition = fixture.definitions[1];
    childFanoutInputs.set(fixture.tenantId, {
      workflowDefinitionId: Number(childDefinition.id),
      pathwayKey: childKey,
      sourceEpisodeType: 'synthetic_child_episode',
      sourceEpisodeId: `child-${compactToken()}`,
      owningClinicianUid: fixture.doctorUid,
      accountableRole: 'DOCTOR',
    });
    const parent = await startCarePathwayInstance(startInput(
      fixture,
      parentDefinition,
      'child-dedup-start',
    ));
    const commandKey = `child-dedup.${compactToken()}`;

    const [first, second] = await Promise.all([
      executePathwayCommand(commandInput(fixture, parent.id, commandKey, 'launch_child')),
      executePathwayCommand(commandInput(fixture, parent.id, commandKey, 'launch_child')),
    ]);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(childFanoutCalls.get(fixture.tenantId)).toBe(1);
    const persistedCommandKey = first.events[0].idempotency_key;

    await setTenantTx(fixture.tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT id, parent_instance_id, pathway_key, idempotency_key
           FROM care_pathway_instances
          WHERE tenant_id = $1::uuid AND parent_instance_id = $2::uuid`,
        fixture.tenantId,
        parent.id,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        parent_instance_id: parent.id,
        pathway_key: childKey,
      });
      expect(rows[0].idempotency_key).toMatch(/^c:[a-f0-9]{64}$/);
      expect(rows[0].idempotency_key).not.toContain(commandKey);
      const childCreationEvidence = await tx.$queryRawUnsafe(
        `SELECT idempotency_key
           FROM care_pathway_transition_events
          WHERE tenant_id = $1::uuid
            AND pathway_instance_id = $2::uuid
            AND transition_key = 'pathway_instance_created'`,
        fixture.tenantId,
        rows[0].id,
      );
      expect(childCreationEvidence).toEqual([{ idempotency_key: rows[0].idempotency_key }]);
      const evidence = await tx.$queryRawUnsafe(
        `SELECT event.workflow_step_id, event.stage_key, step.step_key
           FROM care_pathway_transition_events AS event
           JOIN workflow_steps AS step
             ON step.tenant_id = event.tenant_id
            AND step.id = event.workflow_step_id
            AND step.workflow_run_id = event.workflow_run_id
          WHERE event.tenant_id = $1::uuid
            AND event.pathway_instance_id = $2::uuid
            AND event.idempotency_key = $3::text
            AND event.transition_key = 'child_pathway_materialized'`,
        fixture.tenantId,
        parent.id,
        persistedCommandKey,
      );
      expect(evidence).toEqual([{
        workflow_step_id: parent.steps[0].id,
        stage_key: 'launch_child',
        step_key: 'launch_child',
      }]);
    });
  }, 60_000);

  it('reuses the supplied branded tenant transaction and obeys its outer rollback', async () => {
    const tenantId = randomUUID();
    let instanceId;

    await expect(setTenantTx(tenantId, async (tx) => {
      const fixture = await seedTenantActors(tx, { tenantId });
      const definition = await seedGovernedDefinition(
        tx,
        fixture,
        automationDefinition(`synthetic_tx_reuse_${compactToken()}`),
      );
      const started = await startCarePathwayInstance({
        ...startInput(fixture, definition, 'tx-reuse-start'),
        tx,
      });
      instanceId = started.id;
      const completed = await executePathwayCommand({
        ...commandInput(fixture, started.id, `tx-reuse.${compactToken()}`, 'run_action'),
        tx,
      });

      expect(actionContexts.get(tenantId)).toEqual({
        contextFrozen: true,
        hasTx: false,
        hasQueryCapability: false,
      });
      expect(completed.instance.run.status).toBe('completed');
      const visible = await tx.$queryRawUnsafe(
        `SELECT COUNT(*)::integer AS count
           FROM care_pathway_transition_events
          WHERE tenant_id = $1::uuid AND pathway_instance_id = $2::uuid`,
        tenantId,
        instanceId,
      );
      expect(Number(visible[0].count)).toBeGreaterThan(1);
      throw new Error(ROLLBACK_MARKER);
    })).rejects.toThrow(ROLLBACK_MARKER);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::integer FROM tenants WHERE id = $1::uuid) AS tenant_count,
         (SELECT COUNT(*)::integer FROM workflow_runs WHERE tenant_id = $1::uuid) AS run_count,
         (SELECT COUNT(*)::integer FROM workflow_steps WHERE tenant_id = $1::uuid) AS step_count,
         (SELECT COUNT(*)::integer FROM tasks WHERE tenant_id = $1::uuid) AS task_count,
         (SELECT COUNT(*)::integer FROM approvals WHERE tenant_id = $1::uuid) AS approval_count,
         (SELECT COUNT(*)::integer FROM care_pathway_instances WHERE id = $2::uuid) AS instance_count,
         (SELECT COUNT(*)::integer FROM care_pathway_transition_events
           WHERE pathway_instance_id = $2::uuid) AS transition_count,
         (SELECT COUNT(*)::integer FROM clinical_timeline_events
           WHERE tenant_id = $1::uuid) AS timeline_count,
         (SELECT COUNT(*)::integer FROM clinical_audit_events
           WHERE tenant_id = $1::uuid) AS audit_count`,
      tenantId,
      instanceId,
    );
    expect(rows[0]).toEqual({
      tenant_count: 0,
      run_count: 0,
      step_count: 0,
      task_count: 0,
      approval_count: 0,
      instance_count: 0,
      transition_count: 0,
      timeline_count: 0,
      audit_count: 0,
    });
  }, 60_000);
});
