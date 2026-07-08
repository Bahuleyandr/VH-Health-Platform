import {
  deriveLoadStatus,
  getAllowedIssueTransitions,
  validateSetContents,
} from '../../services/cssd/cssdService.js';

describe('cssdService pure helpers', () => {
  test('validateSetContents normalizes set contents', () => {
    const result = validateSetContents([
      { code: 'FORCEP-01', item_name: 'Artery forceps', qty: '2', critical: 'yes' },
    ]);

    expect(result).toEqual([
      {
        item_code: 'FORCEP-01',
        name: 'Artery forceps',
        quantity: 2,
        category: null,
        critical: true,
      },
    ]);
  });

  test('validateSetContents rejects invalid shapes and quantities', () => {
    expect(() => validateSetContents({})).toThrow(/contents must be an array/);
    expect(() => validateSetContents([{ name: 'Clamp', quantity: 0 }])).toThrow(/quantity/);
    expect(() => validateSetContents([{ quantity: 1 }])).toThrow(/name is required/);
  });

  test('deriveLoadStatus makes failed indicators dominant', () => {
    expect(deriveLoadStatus({
      status: 'passed',
      biological_indicator_result: 'failed',
      chemical_indicator_result: 'passed',
      mechanical_indicator_result: 'passed',
    })).toBe('failed');
  });

  test('deriveLoadStatus requires complete indicators before passed', () => {
    expect(() => deriveLoadStatus({
      status: 'passed',
      biological_indicator_result: 'passed',
      chemical_indicator_result: 'pending',
      mechanical_indicator_result: 'passed',
    })).toThrow(/pending indicators/);
  });

  test('deriveLoadStatus infers passed completed loads when indicators clear', () => {
    expect(deriveLoadStatus({
      completed_at: '2026-07-07T08:00:00Z',
      biological_indicator_result: 'passed',
      chemical_indicator_result: 'passed',
      mechanical_indicator_result: 'not_required',
    })).toBe('passed');
  });

  test('issue-loop state machine exposes only forward operational transitions', () => {
    expect(getAllowedIssueTransitions('issued')).toEqual(['in_theatre', 'returned', 'cancelled']);
    expect(getAllowedIssueTransitions('in_theatre')).toEqual(['returned']);
    expect(getAllowedIssueTransitions('returned')).toEqual(['awaiting_sterilization']);
    expect(getAllowedIssueTransitions('awaiting_sterilization')).toEqual([]);
  });
});
