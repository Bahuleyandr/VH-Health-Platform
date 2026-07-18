import {
  WORKFLOW_ACTION_HANDLERS,
  WORKFLOW_CONDITION_HANDLERS,
  WORKFLOW_STEP_KINDS,
  validateWorkflowDefinitionSteps,
} from '../../services/workflow/workflowDefinitionContract.js';

describe('workflow definition contract', () => {
  it('normalizes canonical and legacy-compatible step field names without mutating input', () => {
    const input = [
      {
        key: 'review_result',
        kind: 'task',
        title: 'Review result',
        assignedRole: 'doctor',
        dueAt: '2026-07-18T12:30:00+05:30',
        metadata: { required: true, tags: ['diagnostic'] },
      },
    ];

    expect(validateWorkflowDefinitionSteps(input)).toEqual([
      {
        step_key: 'review_result',
        display_name: 'Review result',
        step_kind: 'task',
        assigned_role: 'DOCTOR',
        due_at: '2026-07-18T07:00:00.000Z',
        metadata: { required: true, tags: ['diagnostic'] },
        condition_handler: null,
        action_handler: null,
      },
    ]);
    expect(input[0]).not.toHaveProperty('step_key');
  });

  it.each(WORKFLOW_STEP_KINDS)('accepts the database-supported %s step kind', (stepKind) => {
    const steps = validateWorkflowDefinitionSteps([{ step_key: `step_${stepKind}`, step_kind: stepKind }]);
    expect(steps[0].step_kind).toBe(stepKind);
  });

  it.each([null, undefined, {}, 'steps', []])('rejects a missing or empty steps array: %p', (steps) => {
    expect(() => validateWorkflowDefinitionSteps(steps)).toThrow(/steps must be a non-empty array/);
  });

  it.each([null, [], new Date(), Object.create({ inherited: true })])(
    'rejects a non-plain step: %p',
    (step) => {
      expect(() => validateWorkflowDefinitionSteps([step])).toThrow(/must be a plain object/);
    },
  );

  it('rejects missing, non-canonical and duplicate step keys', () => {
    expect(() => validateWorkflowDefinitionSteps([{ step_kind: 'task' }]))
      .toThrow(/step_key must be a string/);
    expect(() => validateWorkflowDefinitionSteps([{ step_key: 'Review Result', step_kind: 'task' }]))
      .toThrow(/canonical lower_snake_case/);
    expect(() => validateWorkflowDefinitionSteps([
      { step_key: 'review', step_kind: 'task' },
      { key: 'review', kind: 'approval' },
    ])).toThrow(/duplicate step_key: review/);
  });

  it('rejects missing and unsupported step kinds', () => {
    expect(() => validateWorkflowDefinitionSteps([{ step_key: 'review' }]))
      .toThrow(/step_kind must be a string/);
    expect(() => validateWorkflowDefinitionSteps([{ step_key: 'review', step_kind: 'script' }]))
      .toThrow(/step_kind must be one of/);
  });

  it('rejects ambiguous aliases instead of choosing one silently', () => {
    expect(() => validateWorkflowDefinitionSteps([{
      step_key: 'review', key: 'other', step_kind: 'task',
    }])).toThrow(/must not define both step_key and key/);
  });

  it.each([
    [{ step_key: 'review', step_kind: 'task', display_name: 12 }, /display_name must be a string/],
    [{ step_key: 'review', step_kind: 'task', assigned_role: [] }, /assigned_role must be a string/],
    [{ step_key: 'review', step_kind: 'task', assigned_role: 'doctor on call' }, /canonical role code/],
    [{ step_key: 'review', step_kind: 'task', due_at: 1_721_300_000 }, /ISO-8601 timestamp string/],
    [{ step_key: 'review', step_kind: 'task', due_at: 'not-a-date' }, /valid ISO-8601 timestamp/],
    [{ step_key: 'review', step_kind: 'task', due_at: '2026-02-30T12:00:00Z' }, /valid ISO-8601 timestamp/],
    [{ step_key: 'review', step_kind: 'task', metadata: [] }, /metadata must be a plain JSON object/],
    [{ step_key: 'review', step_kind: 'task', metadata: { score: Number.NaN } }, /finite numbers/],
  ])('rejects an invalid optional field shape', (step, expected) => {
    expect(() => validateWorkflowDefinitionSteps([step])).toThrow(expected);
  });

  it('rejects circular and executable metadata values', () => {
    const circular = {};
    circular.self = circular;
    expect(() => validateWorkflowDefinitionSteps([{
      step_key: 'review', step_kind: 'task', metadata: circular,
    }])).toThrow(/circular references/);
    expect(() => validateWorkflowDefinitionSteps([{
      step_key: 'review', step_kind: 'task', metadata: { callback: () => true },
    }])).toThrow(/only JSON values/);
  });

  it.each([
    { condition_handler: 'patient_has_signed_result' },
    { conditionHandler: 'patient_has_signed_result' },
    { action_handler: 'create_critical_task' },
    { actionHandler: 'create_critical_task' },
  ])('rejects every unregistered executable identifier: %p', (executableField) => {
    expect(() => validateWorkflowDefinitionSteps([{
      step_key: 'review', step_kind: 'task', ...executableField,
    }])).toThrow(/not a registered executable identifier/);
  });

  it.each(['condition', 'action', 'expression', 'script', 'javascript'])(
    'rejects stored expression-like field %s',
    (field) => {
      expect(() => validateWorkflowDefinitionSteps([{
        step_key: 'review', step_kind: 'task', [field]: 'return true',
      }])).toThrow(new RegExp(`${field} is not supported`));
    },
  );

  it('keeps executable registries and normalized results immutable', () => {
    const result = validateWorkflowDefinitionSteps([{
      step_key: 'review', step_kind: 'task', metadata: { required: true },
    }]);
    expect(Object.isFrozen(WORKFLOW_CONDITION_HANDLERS)).toBe(true);
    expect(Object.isFrozen(WORKFLOW_ACTION_HANDLERS)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
    expect(Object.isFrozen(result[0].metadata)).toBe(true);
  });
});
