import {
  checksumCompiledWorkflowDefinition,
  compileWorkflowDefinition,
} from '../../services/workflow/workflowDefinitionCompiler.js';
import {
  assertWorkflowJsonBudget,
  WORKFLOW_JSON_LIMITS,
} from '../../services/workflow/workflowJsonGuard.js';
import {
  createRegisteredWorkflowSystemActor,
  createWorkflowRuntimeRegistry,
  isRegisteredWorkflowSystemActor,
  isWorkflowRuntimeRegistry,
  workflowRuntimeRegistry,
} from '../../services/workflow/workflowRuntimeRegistry.js';

let nextSyntheticRegistryVersion = 700;

function syntheticRegistry() {
  return createWorkflowRuntimeRegistry({
    version: nextSyntheticRegistryVersion++,
    conditions: [
      ['synthetic.result_classification.v1', {
        stepKinds: ['wait', 'task'],
        decisionCodes: ['blocked', 'satisfied', 'abnormal'],
        evaluate: async () => ({ decision: 'satisfied', evidence: [] }),
      }],
    ],
    actions: [
      ['synthetic.record_marker.v1', {
        stepKinds: ['automation'],
        execute: async () => ({ outcome: 'recorded' }),
      }],
    ],
    childFanouts: [
      ['synthetic.child_episode.v1', {
        stepKinds: ['subworkflow', 'task'],
        resolve: async () => [],
      }],
    ],
    systemActors: ['synthetic.projector.v1'],
  });
}

function taskStep(overrides = {}) {
  return {
    step_key: 'review_result',
    step_kind: 'task',
    display_name: 'Review result',
    assigned_role: 'DOCTOR',
    work_semantics: {
      task_kind: 'review',
      priority: 'high',
      sla_completion_semantics: 'none',
    },
    ...overrides,
  };
}

function sealedSignalContext() {
  return {
    sourceResourceType: 'event_outbox',
    sourceResourceId: '42',
    occurredAt: '2026-07-19T10:00:00Z',
  };
}

describe('workflow JSON safety budget', () => {
  it('accepts the exact depth and node ceilings and rejects one beyond each', () => {
    const nested = (depth) => {
      let value = 'leaf';
      for (let index = 0; index < depth; index += 1) value = { value };
      return value;
    };
    expect(assertWorkflowJsonBudget(nested(WORKFLOW_JSON_LIMITS.maxDepth))).toMatchObject({
      maxDepth: WORKFLOW_JSON_LIMITS.maxDepth,
    });
    expect(() => assertWorkflowJsonBudget(
      nested(WORKFLOW_JSON_LIMITS.maxDepth + 1),
    )).toThrow(/JSON depth limit/);

    expect(assertWorkflowJsonBudget(
      Array.from({ length: WORKFLOW_JSON_LIMITS.maxNodes - 1 }, () => null),
    )).toMatchObject({ nodes: WORKFLOW_JSON_LIMITS.maxNodes });
    expect(() => assertWorkflowJsonBudget(
      Array.from({ length: WORKFLOW_JSON_LIMITS.maxNodes }, () => null),
    )).toThrow(/node JSON limit/);
  });

  it('accepts exactly 65536 serialized UTF-8 bytes and rejects one byte more', () => {
    const emptyBytes = Buffer.byteLength(JSON.stringify({ value: '' }), 'utf8');
    const exact = { value: 'a'.repeat(WORKFLOW_JSON_LIMITS.maxBytes - emptyBytes) };
    const over = { value: `${exact.value}a` };

    expect(assertWorkflowJsonBudget(exact)).toMatchObject({
      bytes: WORKFLOW_JSON_LIMITS.maxBytes,
    });
    expect(() => assertWorkflowJsonBudget(over)).toThrow(/serialized JSON limit/);
  });

  it('rejects sparse arrays instead of hashing holes differently from durable JSON', () => {
    const sparse = new Array(1);
    expect(() => assertWorkflowJsonBudget(sparse)).toThrow(/must not be a sparse array/);
    expect(assertWorkflowJsonBudget([null])).toMatchObject({ nodes: 2 });
  });
});

describe('workflow runtime registry', () => {
  it('keeps the production registry empty, immutable and identity-verifiable', () => {
    expect(isWorkflowRuntimeRegistry(workflowRuntimeRegistry)).toBe(true);
    expect(workflowRuntimeRegistry.conditionHandlerIds).toEqual([]);
    expect(workflowRuntimeRegistry.actionHandlerIds).toEqual([]);
    expect(workflowRuntimeRegistry.childFanoutHandlerIds).toEqual([]);
    expect(Object.isFrozen(workflowRuntimeRegistry)).toBe(true);
    expect(isWorkflowRuntimeRegistry({ version: 1 })).toBe(false);
  });

  it('copies handler declarations and resolves exact versioned ids only', () => {
    const stepKinds = ['wait'];
    const descriptor = {
      stepKinds,
      decisionCodes: ['blocked', 'satisfied'],
      evaluate: async () => ({ decision: 'blocked', evidence: [] }),
    };
    const registry = createWorkflowRuntimeRegistry({
      version: 2,
      conditions: [['synthetic.wait_gate.v1', descriptor]],
    });
    stepKinds.push('task');
    descriptor.decisionCodes.push('unexpected');

    expect(registry.resolveCondition('synthetic.wait_gate.v1')).toMatchObject({
      id: 'synthetic.wait_gate.v1',
      stepKinds: ['wait'],
      decisionCodes: ['blocked', 'satisfied'],
    });
    expect(registry.resolveCondition('synthetic.wait_gate')).toBeUndefined();
    expect(Object.isFrozen(registry.resolveCondition('synthetic.wait_gate.v1'))).toBe(true);
  });

  it('binds each registry version to one exact identity', () => {
    createWorkflowRuntimeRegistry({ version: 3 });
    expect(() => createWorkflowRuntimeRegistry({
      version: 3,
      actions: [[
        'synthetic.different_behavior.v1',
        { stepKinds: ['automation'], execute: async () => ({ changed: true }) },
      ]],
    })).toThrow(/version 3 is already registered/);
  });

  it('rejects unversioned, duplicate and malformed handlers', () => {
    expect(() => createWorkflowRuntimeRegistry({
      conditions: [['synthetic.wait_gate', {
        stepKinds: ['wait'],
        decisionCodes: ['blocked'],
        evaluate: async () => ({}),
      }]],
    })).toThrow(/versioned canonical identifier/);
    expect(() => createWorkflowRuntimeRegistry({
      actions: [
        ['synthetic.action.v1', { stepKinds: ['automation'], execute: async () => ({}) }],
        ['synthetic.action.v1', { stepKinds: ['automation'], execute: async () => ({}) }],
      ],
    })).toThrow(/Duplicate/);
    expect(() => createWorkflowRuntimeRegistry({
      childFanouts: [['synthetic.child.v1', { stepKinds: ['script'], resolve: async () => [] }]],
    })).toThrow(/unsupported step kind/);
  });

  it('creates identity-sealed registered system actors and rejects lookalikes', () => {
    const registry = syntheticRegistry();
    const actor = createRegisteredWorkflowSystemActor({
      registry,
      systemKey: 'synthetic.projector.v1',
      sourceEventId: 42n,
      causationId: 'synthetic:42',
      signalContext: sealedSignalContext(),
    });

    expect(actor.sourceEventId).toBe('42');
    expect(isRegisteredWorkflowSystemActor(actor)).toBe(true);
    expect(isRegisteredWorkflowSystemActor(actor, { registry })).toBe(true);
    expect(isRegisteredWorkflowSystemActor({ ...actor })).toBe(false);
    expect(() => createRegisteredWorkflowSystemActor({
      registry,
      systemKey: 'synthetic.unregistered.v1',
    })).toThrow(/not registered/);
    expect(() => createRegisteredWorkflowSystemActor({
      registry,
      systemKey: 'synthetic.projector.v1',
      signalContext: sealedSignalContext(),
    })).toThrow(/sourceEventId is required/);
    expect(createRegisteredWorkflowSystemActor({
      registry,
      systemKey: 'synthetic.projector.v1',
      sourceEventId: '00042',
      signalContext: sealedSignalContext(),
    }).sourceEventId).toBe('42');
    expect(() => createRegisteredWorkflowSystemActor({
      registry,
      systemKey: 'synthetic.projector.v1',
      sourceEventId: '42',
    })).toThrow(/signalContext is required/);
  });
});

describe('workflow definition compiler', () => {
  it.each(['PATIENT', 'WEBHOOK_CLIENT', 'DEVICE_GATEWAY', 'UNKNOWN_CLINICAL_ROLE'])(
    'rejects unreachable human task owner role %s',
    (assignedRole) => {
      expect(() => compileWorkflowDefinition({
        workflow_key: 'unreachable_task_owner',
        steps: [{
          step_key: 'review',
          step_kind: 'task',
          assigned_role: assignedRole,
          work_semantics: {
            task_kind: 'review',
            priority: 'normal',
            sla_completion_semantics: 'none',
          },
        }],
      })).toThrow(/route-capable human clinical role/);
    },
  );

  it('rejects an unreachable approval role', () => {
    expect(() => compileWorkflowDefinition({
      workflow_key: 'unreachable_approval_owner',
      steps: [{
        step_key: 'approve',
        step_kind: 'approval',
        assigned_role: 'ADMIN',
        work_semantics: {
          approval_kind: 'clinical_review',
          required_approvers: 1,
          required_role: 'PATIENT',
          sla_completion_semantics: 'none',
        },
      }],
    })).toThrow(/route-capable human clinical role/);
  });

  it('compiles and freezes the linear task/approval built-in subset', () => {
    const compiled = compileWorkflowDefinition({
      workflow_key: 'synthetic_pathway',
      version: 3,
      steps: [
        taskStep(),
        {
          step_key: 'approve_closure',
          step_kind: 'approval',
          display_name: 'Approve closure',
          assigned_role: 'CMO',
          work_semantics: {
            approval_kind: 'pathway_closure',
            required_approvers: 1,
            required_role: 'CMO',
            sla_completion_semantics: 'none',
          },
        },
      ],
      triggers: [],
      defaults: { patient_visibility_status: 'hidden' },
    });

    expect(compiled).toMatchObject({
      workflow_key: 'synthetic_pathway',
      version: 3,
      registry_version: 1,
    });
    expect(compiled.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(checksumCompiledWorkflowDefinition(compiled)).toBe(compiled.checksum);
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.steps)).toBe(true);
    expect(Object.isFrozen(compiled.steps[0].work_semantics)).toBe(true);
  });

  it('accepts a registered forward exception and registered child fan-out', () => {
    const registry = syntheticRegistry();
    const compiled = compileWorkflowDefinition({
      workflow_key: 'synthetic_branching_pathway',
      version: 1,
      steps: [
        {
          step_key: 'classify_result',
          step_kind: 'wait',
          assigned_role: 'DOCTOR',
          condition_handler: 'synthetic.result_classification.v1',
          exception_transitions: [{
            decision_code: 'abnormal',
            target_step_key: 'abnormal_review',
          }],
        },
        {
          step_key: 'launch_follow_up',
          step_kind: 'subworkflow',
          assigned_role: 'DOCTOR',
          child_rules: [{
            rule_key: 'launch_follow_up',
            fanout_handler: 'synthetic.child_episode.v1',
            child_pathway_key: 'synthetic_child_pathway',
            relationship: 'blocking',
          }],
        },
        taskStep({ step_key: 'normal_closure', display_name: 'Normal closure' }),
        taskStep({ step_key: 'abnormal_review', display_name: 'Abnormal review' }),
      ],
    }, { registry });

    expect(compiled.steps[0].exception_transitions).toEqual([{
      decision_code: 'abnormal',
      target_step_key: 'abnormal_review',
    }]);
    expect(compiled.steps[1].child_rules[0]).toMatchObject({
      fanout_handler: 'synthetic.child_episode.v1',
      relationship: 'blocking',
    });
  });

  it('keeps human gates pure until an explicit exit-effect contract exists', () => {
    const registry = createWorkflowRuntimeRegistry({
      version: nextSyntheticRegistryVersion++,
      actions: [['synthetic.unsafe_gate_action.v1', {
        stepKinds: ['task', 'approval'],
        execute: async () => ({}),
      }]],
      childFanouts: [['synthetic.unsafe_gate_child.v1', {
        stepKinds: ['task', 'approval'],
        resolve: async () => [],
      }]],
    });
    expect(() => compileWorkflowDefinition({
      workflow_key: 'unsafe_task_action',
      steps: [taskStep({ action_handler: 'synthetic.unsafe_gate_action.v1' })],
    }, { registry })).toThrow(/action_handler is supported only/);
    expect(() => compileWorkflowDefinition({
      workflow_key: 'unsafe_approval_child',
      steps: [{
        step_key: 'approve',
        step_kind: 'approval',
        assigned_role: 'DOCTOR',
        work_semantics: {
          approval_kind: 'clinical_release',
          required_approvers: 1,
          sla_completion_semantics: 'none',
        },
        child_rules: [{
          rule_key: 'premature_child',
          fanout_handler: 'synthetic.unsafe_gate_child.v1',
          child_pathway_key: 'synthetic_child_pathway',
          relationship: 'informational',
        }],
      }],
    }, { registry })).toThrow(/child_rules is supported only/);
  });

  it('binds the registry version into the governed definition checksum', () => {
    const first = syntheticRegistry();
    const second = syntheticRegistry();
    const definition = {
      workflow_key: 'registry_bound_checksum',
      steps: [taskStep()],
    };
    expect(compileWorkflowDefinition(definition, { registry: first }).checksum)
      .not.toBe(compileWorkflowDefinition(definition, { registry: second }).checksum);
  });

  it('rejects unregistered behavior, backward exceptions and arbitrary fields', () => {
    expect(() => compileWorkflowDefinition({
      workflow_key: 'bad_unregistered',
      steps: [taskStep({ condition_handler: 'synthetic.unregistered.v1' })],
    })).toThrow(/not a registered executable identifier/);

    expect(() => compileWorkflowDefinition({
      workflow_key: 'bad_backward',
      steps: [
        taskStep({ step_key: 'first' }),
        taskStep({
          step_key: 'second',
          condition_handler: 'synthetic.result_classification.v1',
          exception_transitions: [{ decision_code: 'abnormal', target_step_key: 'first' }],
        }),
      ],
    }, { registry: syntheticRegistry() })).toThrow(/must target a later step/);

    expect(() => compileWorkflowDefinition({
      workflow_key: 'bad_expression',
      steps: [taskStep({ expression: 'return true' })],
    })).toThrow(/expression is not supported/);

    expect(() => compileWorkflowDefinition({
      workflow_key: 'bad_top_level_code',
      steps: [taskStep()],
      sql: 'SELECT dangerous_runtime()',
    })).toThrow(/definition.sql is not supported/);
  });

  it('rejects unsupported executable kinds without their registered handler contract', () => {
    expect(() => compileWorkflowDefinition({
      workflow_key: 'bad_automation',
      steps: [{ step_key: 'run_code', step_kind: 'automation' }],
    })).toThrow(/action_handler is required/);
    expect(() => compileWorkflowDefinition({
      workflow_key: 'bad_wait',
      steps: [{ step_key: 'wait_for_time', step_kind: 'wait' }],
    })).toThrow(/condition_handler is required/);
    expect(() => compileWorkflowDefinition({
      workflow_key: 'bad_subworkflow',
      steps: [{ step_key: 'launch_child', step_kind: 'subworkflow' }],
    })).toThrow(/child_rules is required/);
    expect(() => compileWorkflowDefinition({
      workflow_key: 'bad_child_handler',
      steps: [{
        step_key: 'launch_child',
        step_kind: 'subworkflow',
        child_rules: [{
          rule_key: 'child',
          child_pathway_key: 'synthetic_child_pathway',
          relationship: 'blocking',
        }],
      }],
    }, { registry: syntheticRegistry() })).toThrow(/fanout_handler is required/);
  });

  it('rejects an unsafe or ambiguous task SLA contract', () => {
    expect(() => compileWorkflowDefinition({
      workflow_key: 'missing_task_contract',
      steps: [{ step_key: 'review', step_kind: 'task' }],
    })).toThrow(/work_semantics is required/);
    expect(() => compileWorkflowDefinition({
      workflow_key: 'missing_sla_rule',
      steps: [taskStep({
        work_semantics: { sla_completion_semantics: 'domain_evidence' },
      })],
    })).toThrow(/sla_rule_code is required/);
    expect(() => compileWorkflowDefinition({
      workflow_key: 'unexpected_sla_rule',
      steps: [taskStep({
        work_semantics: {
          sla_completion_semantics: 'none',
          sla_rule_code: 'should_not_exist',
        },
      })],
    })).toThrow(/requires acknowledgement or domain_evidence/);
    expect(() => compileWorkflowDefinition({
      workflow_key: 'unbound_domain_evidence',
      steps: [taskStep({
        work_semantics: {
          sla_completion_semantics: 'domain_evidence',
          sla_rule_code: 'synthetic_release_evidence',
        },
      })],
    })).toThrow(/condition_handler is required for domain_evidence/);
    expect(() => compileWorkflowDefinition({
      workflow_key: 'approval_without_task_sla_contract',
      steps: [{
        step_key: 'approve',
        step_kind: 'approval',
        work_semantics: {
          approval_kind: 'synthetic_approval',
          required_approvers: 1,
        },
      }],
    })).toThrow(/sla_completion_semantics must be a string/);
  });

  it('keeps reusable human-work deadlines in SLA rules and validates informational timestamps', () => {
    expect(() => compileWorkflowDefinition({
      workflow_key: 'bad_due_at',
      steps: [taskStep({ due_at: 'July 19, 2026' })],
    })).toThrow(/must be an ISO timestamp/);
    expect(() => compileWorkflowDefinition({
      workflow_key: 'rolled_due_at',
      steps: [taskStep({ due_at: '2026-02-31T12:00:00Z' })],
    })).toThrow(/must be an ISO timestamp/);
    expect(() => compileWorkflowDefinition({
      workflow_key: 'stale_human_due_at',
      steps: [taskStep({ due_at: '2026-07-19T12:00:00+05:30' })],
    })).toThrow(/use the SLA rule/);
    const registry = syntheticRegistry();
    expect(compileWorkflowDefinition({
      workflow_key: 'informational_due_at',
      steps: [{
        step_key: 'record_marker',
        step_kind: 'automation',
        action_handler: 'synthetic.record_marker.v1',
        due_at: '2026-07-19T12:00:00+05:30',
      }],
    }, { registry }).steps[0].due_at).toBe('2026-07-19T06:30:00.000Z');
  });

  it('produces a stable checksum independent of input object key ordering', () => {
    const first = compileWorkflowDefinition({
      workflow_key: 'checksum_pathway',
      steps: [taskStep({ metadata: { a: 1, b: 2 } })],
      defaults: { alpha: true, beta: false },
    });
    const second = compileWorkflowDefinition({
      defaults: { beta: false, alpha: true },
      steps: [taskStep({ metadata: { b: 2, a: 1 } })],
      workflow_key: 'checksum_pathway',
    });
    expect(second.checksum).toBe(first.checksum);
  });

  it('rejects over-budget definition JSON with a controlled definition error', () => {
    let tooDeep = 'leaf';
    for (let index = 0; index < WORKFLOW_JSON_LIMITS.maxDepth; index += 1) {
      tooDeep = { value: tooDeep };
    }
    expect(() => compileWorkflowDefinition({
      workflow_key: 'definition_json_too_deep',
      steps: [taskStep()],
      defaults: tooDeep,
    })).toThrow(/JSON depth limit/);
    expect(() => compileWorkflowDefinition({
      workflow_key: 'definition_json_too_large',
      steps: [taskStep()],
      defaults: { value: 'a'.repeat(WORKFLOW_JSON_LIMITS.maxBytes) },
    })).toThrow(/serialized JSON limit/);
  });

  it('enforces the definition and per-step complexity caps at their boundaries', () => {
    const stepsAtCap = Array.from({ length: 128 }, (_unused, index) => taskStep({
      step_key: `review_${index}`,
      display_name: `Review ${index}`,
    }));
    expect(compileWorkflowDefinition({
      workflow_key: 'steps_at_cap',
      steps: stepsAtCap,
    }).steps).toHaveLength(128);
    expect(() => compileWorkflowDefinition({
      workflow_key: 'steps_over_cap',
      steps: [...stepsAtCap, taskStep({ step_key: 'review_128' })],
    })).toThrow(/at most 128/);

    const decisions = Array.from({ length: 17 }, (_unused, index) => `branch_${index}`);
    const targets = Array.from({ length: 17 }, (_unused, index) => taskStep({
      step_key: `target_${index}`,
    }));
    const conditionRegistry = createWorkflowRuntimeRegistry({
      version: nextSyntheticRegistryVersion++,
      conditions: [['synthetic.bounded_condition.v1', {
        stepKinds: ['wait'],
        decisionCodes: ['blocked', 'satisfied', ...decisions],
        evaluate: async () => ({ decision: 'blocked', evidence: {} }),
      }]],
    });
    const exceptionStep = {
      step_key: 'branch',
      step_kind: 'wait',
      condition_handler: 'synthetic.bounded_condition.v1',
      exception_transitions: decisions.slice(0, 16).map((decision_code, index) => ({
        decision_code,
        target_step_key: `target_${index}`,
      })),
    };
    expect(compileWorkflowDefinition({
      workflow_key: 'exceptions_at_cap',
      steps: [exceptionStep, ...targets],
    }, { registry: conditionRegistry }).steps[0].exception_transitions).toHaveLength(16);
    expect(() => compileWorkflowDefinition({
      workflow_key: 'exceptions_over_cap',
      steps: [{
        ...exceptionStep,
        exception_transitions: decisions.map((decision_code, index) => ({
          decision_code,
          target_step_key: `target_${index}`,
        })),
      }, ...targets],
    }, { registry: conditionRegistry })).toThrow(/at most 16/);

    const childRegistry = createWorkflowRuntimeRegistry({
      version: nextSyntheticRegistryVersion++,
      childFanouts: [['synthetic.bounded_child.v1', {
        stepKinds: ['subworkflow'],
        resolve: async () => [],
      }]],
    });
    const childRules = Array.from({ length: 17 }, (_unused, index) => ({
      rule_key: `child_${index}`,
      fanout_handler: 'synthetic.bounded_child.v1',
      child_pathway_key: 'synthetic_child',
      relationship: 'informational',
    }));
    expect(compileWorkflowDefinition({
      workflow_key: 'children_at_cap',
      steps: [{ step_key: 'children', step_kind: 'subworkflow', child_rules: childRules.slice(0, 16) }],
    }, { registry: childRegistry }).steps[0].child_rules).toHaveLength(16);
    expect(() => compileWorkflowDefinition({
      workflow_key: 'children_over_cap',
      steps: [{ step_key: 'children', step_kind: 'subworkflow', child_rules: childRules }],
    }, { registry: childRegistry })).toThrow(/at most 16/);
  });

  it('caps approval quorum and deterministic auto-chain intent cost at exact boundaries', () => {
    expect(compileWorkflowDefinition({
      workflow_key: 'approval_quorum_at_cap',
      steps: [{
        step_key: 'approve',
        step_kind: 'approval',
        assigned_role: 'ADMIN',
        work_semantics: {
          approval_kind: 'synthetic_review',
          required_approvers: 100,
          sla_completion_semantics: 'none',
        },
      }],
    }).steps[0].work_semantics.required_approvers).toBe(100);
    expect(() => compileWorkflowDefinition({
      workflow_key: 'approval_quorum_over_cap',
      steps: [{
        step_key: 'approve',
        step_kind: 'approval',
        assigned_role: 'ADMIN',
        work_semantics: {
          approval_kind: 'synthetic_review',
          required_approvers: 101,
          sla_completion_semantics: 'none',
        },
      }],
    })).toThrow(/at most 100/);

    const registry = syntheticRegistry();
    const autoSteps = (count) => Array.from({ length: count }, (_unused, index) => ({
      step_key: `auto_${index}`,
      step_kind: 'automation',
      action_handler: 'synthetic.record_marker.v1',
    }));
    expect(compileWorkflowDefinition({
      workflow_key: 'auto_intents_at_cap',
      steps: autoSteps(127),
    }, { registry }).steps).toHaveLength(127);
    expect(() => compileWorkflowDefinition({
      workflow_key: 'auto_intents_over_cap',
      steps: autoSteps(128),
    }, { registry })).toThrow(/exceeds 512 transition intents/);

    const nonblockingFanout = {
      step_key: 'dispatch_children',
      step_kind: 'subworkflow',
      child_rules: [{
        rule_key: 'informational_children',
        fanout_handler: 'synthetic.child_episode.v1',
        child_pathway_key: 'synthetic_child',
        relationship: 'informational',
      }],
    };
    expect(compileWorkflowDefinition({
      workflow_key: 'auto_with_child_reserve_at_cap',
      steps: [...autoSteps(110), nonblockingFanout],
    }, { registry }).steps).toHaveLength(111);
    expect(() => compileWorkflowDefinition({
      workflow_key: 'auto_with_child_reserve_over_cap',
      steps: [...autoSteps(111), nonblockingFanout],
    }, { registry })).toThrow(/exceeds 512 transition intents/);
  });
});
