import {
  assertOwnerSourceMetadata,
  normalizeChemoLink,
  normalizeCtcaeGrade,
  normalizeRecommendationDueDate,
  transitionTumorBoardCaseState,
  validateTnmCategory,
} from '../../services/oncology/oncologyCompletionService.js';

describe('oncology completion validation helpers', () => {
  test('validates well-formed TNM category fields without embedding staging tables', () => {
    expect(validateTnmCategory('T', 'cT2')).toBe('cT2');
    expect(validateTnmCategory('N', 'pN1a')).toBe('pN1a');
    expect(validateTnmCategory('M', 'M0')).toBe('M0');
    expect(() => validateTnmCategory('T', 'stage II')).toThrow(/malformed/i);
  });

  test('requires owner-source metadata before staging or CTCAE sign-off', () => {
    expect(assertOwnerSourceMetadata({
      source: 'Hospital AJCC staging subscription',
      version: '2026-07',
      edition: 'AJCC 8',
      attachmentRefs: [],
    })).toEqual({
      source: 'Hospital AJCC staging subscription',
      version: '2026-07',
      edition: 'AJCC 8',
      attachmentRefs: [],
    });
    expect(() => assertOwnerSourceMetadata({
      source: 'Hospital AJCC staging subscription',
      version: '',
      edition: 'AJCC 8',
      attachmentRefs: [],
    })).toThrow(/source, version, and edition/i);
  });

  test('normalizes CTCAE grade to the allowed 1-5 range', () => {
    expect(normalizeCtcaeGrade('3')).toBe(3);
    expect(() => normalizeCtcaeGrade(0)).toThrow(/1 to 5/);
    expect(() => normalizeCtcaeGrade(6)).toThrow(/1 to 5/);
  });

  test('enforces tumor-board state transitions', () => {
    expect(transitionTumorBoardCaseState('queued', 'in_review')).toBe('in_review');
    expect(transitionTumorBoardCaseState('in_review', 'recommended')).toBe('recommended');
    expect(() => transitionTumorBoardCaseState('recommended', 'queued')).toThrow(/Invalid state transition/);
  });

  test('requires recommendation due dates that are not in the past', () => {
    const now = new Date('2026-07-09T10:00:00.000Z');
    expect(normalizeRecommendationDueDate('2026-07-09', now)).toBe('2026-07-09');
    expect(normalizeRecommendationDueDate('2026-07-10', now)).toBe('2026-07-10');
    expect(() => normalizeRecommendationDueDate('', now)).toThrow(/due_date is required/);
    expect(() => normalizeRecommendationDueDate('2026-07-08', now)).toThrow(/cannot be in the past/);
  });

  test('uses the hospital calendar day at the IST midnight boundary', () => {
    const beforeIstMidnight = new Date('2026-07-09T18:29:59.999Z');
    expect(normalizeRecommendationDueDate('2026-07-09', beforeIstMidnight)).toBe('2026-07-09');
    expect(() => normalizeRecommendationDueDate('2026-07-08', beforeIstMidnight))
      .toThrow(/cannot be in the past/);

    const atIstMidnight = new Date('2026-07-09T18:30:00.000Z');
    expect(normalizeRecommendationDueDate('2026-07-10', atIstMidnight)).toBe('2026-07-10');
    expect(() => normalizeRecommendationDueDate('2026-07-09', atIstMidnight))
      .toThrow(/cannot be in the past/);
  });

  test('normalizes optional chemo plan, cycle, and administration links', () => {
    expect(normalizeChemoLink({
      chemoPlanId: '10',
      chemoCycleId: '12',
      chemoAdministrationId: '',
    })).toEqual({
      chemoPlanId: 10,
      chemoCycleId: 12,
      chemoAdministrationId: null,
    });
    expect(() => normalizeChemoLink({ chemoCycleId: 'abc' })).toThrow(/positive integer/);
  });
});
