import { extractRuleBasedTasksFromEvents } from '../../services/ai/clinicalTaskExtractorService.js';

function event(overrides = {}) {
  return {
    event_type: overrides.event_type || 'clinical_note',
    sub_type: overrides.sub_type || null,
    id: overrides.id || 1,
    summary: overrides.summary || 'Progress note',
    timestamp: overrides.timestamp || '2026-04-22T08:00:00.000Z',
    payload: overrides.payload || {},
  };
}

describe('clinical task extractor helpers', () => {
  it('extracts task-like plan statements with priority and owner hints', () => {
    const tasks = extractRuleBasedTasksFromEvents([
      event({
        id: 7,
        summary: 'PLAN: repeat CBC tomorrow; arrange echo today; call family before discharge.',
      }),
    ]);

    expect(tasks.map((task) => task.task_title)).toEqual(
      expect.arrayContaining([
        'repeat CBC tomorrow',
        'arrange echo today',
        'call family before discharge',
      ])
    );
    expect(tasks.find((task) => task.task_title === 'arrange echo today')?.priority).toBe('urgent');
    expect(tasks.find((task) => task.task_title === 'call family before discharge')?.category).toBe('family_communication');
    expect(tasks.every((task) => task.source_citations.length > 0)).toBe(true);
  });

  it('adds deterministic candidates for pending investigations and active orders', () => {
    const tasks = extractRuleBasedTasksFromEvents([
      event({
        event_type: 'investigation',
        id: 8,
        sub_type: 'PENDING',
        summary: 'Chest X-ray - PENDING',
        payload: { status: 'PENDING', priority: 'URGENT' },
      }),
      event({
        event_type: 'clinical_order',
        id: 9,
        sub_type: 'medication',
        summary: 'routine medication order ORD-AI-001 - ordered',
        payload: { status: 'ordered', order_type: 'medication' },
      }),
    ]);

    expect(tasks.some((task) => task.metadata.extraction === 'pending_investigation_rule')).toBe(true);
    expect(tasks.some((task) => task.metadata.extraction === 'active_order_rule')).toBe(true);
    expect(tasks.find((task) => task.metadata.extraction === 'pending_investigation_rule')?.priority).toBe('urgent');
  });
});
