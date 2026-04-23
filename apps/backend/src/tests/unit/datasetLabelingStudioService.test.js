import {
  normalizeLabel,
  labelsEqual,
  labelsPartialMatch,
  computeAgreement,
  computeConfidenceBand,
  computeTaskStatus,
  computeConsensusLabel,
  classifyDifficulty,
  aggregateAnnotations,
  buildLabelingActions,
} from '../../services/ai/datasetLabelingStudioService.js';

describe('dataset labeling studio helpers', () => {
  describe('normalizeLabel', () => {
    it('yields the same string for the same object on two calls', () => {
      const label = { code: 'J18.9', description: 'Pneumonia' };
      const a = normalizeLabel(label);
      const b = normalizeLabel(label);
      expect(a).toBe(b);
    });
  });

  describe('labelsEqual', () => {
    it('returns true for two objects with the same single key', () => {
      expect(labelsEqual({ code: 'J18.9' }, { code: 'J18.9' })).toBe(true);
    });

    it('returns false for two objects with differing code values', () => {
      expect(labelsEqual({ code: 'J18.9' }, { code: 'A41.9' })).toBe(false);
    });

    it('is case-sensitive for primitive string labels', () => {
      expect(labelsEqual('left', 'LEFT')).toBe(false);
    });
  });

  describe('labelsPartialMatch', () => {
    it('returns true when 1 of 2 keys match on same-shape objects', () => {
      expect(
        labelsPartialMatch(
          { code: 'J18.9', side: 'left' },
          { code: 'J18.9', side: 'right' }
        )
      ).toBe(true);
    });

    it('returns false for primitive inputs', () => {
      expect(labelsPartialMatch('left', 'right')).toBe(false);
    });
  });

  describe('computeAgreement', () => {
    it('returns pending for an empty annotation list', () => {
      expect(computeAgreement([])).toBe('pending');
    });

    it('returns pending for a single accepted annotation (need >= 2)', () => {
      expect(
        computeAgreement([{ label: { c: 'A' }, reviewer_decision: 'accepted' }])
      ).toBe('pending');
    });

    it('returns match when two accepted annotations agree', () => {
      expect(
        computeAgreement([
          { label: { c: 'A' }, reviewer_decision: 'accepted' },
          { label: { c: 'A' }, reviewer_decision: 'accepted' },
        ])
      ).toBe('match');
    });

    it('returns disagree when two accepted annotations differ', () => {
      expect(
        computeAgreement([
          { label: { c: 'A' }, reviewer_decision: 'accepted' },
          { label: { c: 'B' }, reviewer_decision: 'accepted' },
        ])
      ).toBe('disagree');
    });
  });

  describe('computeConfidenceBand', () => {
    it('returns high when match + quorum + avg >= 0.8', () => {
      expect(
        computeConfidenceBand({
          agreement: 'match',
          acceptedCount: 3,
          requiredLabelers: 2,
          averageConfidence: 0.9,
        })
      ).toBe('high');
    });

    it('returns low when annotations disagree', () => {
      expect(
        computeConfidenceBand({
          agreement: 'disagree',
          acceptedCount: 2,
          requiredLabelers: 2,
          averageConfidence: 0.9,
        })
      ).toBe('low');
    });
  });

  describe('computeTaskStatus', () => {
    it('returns ready_to_use when match + quorum', () => {
      expect(
        computeTaskStatus({
          agreement: 'match',
          acceptedCount: 2,
          requiredLabelers: 2,
          anyRejected: false,
        })
      ).toBe('ready_to_use');
    });

    it('returns conflict when annotations disagree', () => {
      expect(
        computeTaskStatus({
          agreement: 'disagree',
          acceptedCount: 2,
          requiredLabelers: 2,
          anyRejected: false,
        })
      ).toBe('conflict');
    });

    it('returns pending when no annotations yet', () => {
      expect(
        computeTaskStatus({
          agreement: 'pending',
          acceptedCount: 0,
          requiredLabelers: 2,
          anyRejected: false,
        })
      ).toBe('pending');
    });

    it('returns in_progress when one accepted annotation but quorum not met', () => {
      expect(
        computeTaskStatus({
          agreement: 'pending',
          acceptedCount: 1,
          requiredLabelers: 2,
          anyRejected: false,
        })
      ).toBe('in_progress');
    });

    it('returns rejected when all annotations rejected and none accepted', () => {
      expect(
        computeTaskStatus({
          agreement: 'pending',
          acceptedCount: 0,
          requiredLabelers: 2,
          anyRejected: true,
        })
      ).toBe('rejected');
    });
  });

  describe('computeConsensusLabel', () => {
    it('returns the majority accepted label when match/partial', () => {
      const consensus = computeConsensusLabel({
        annotations: [
          { label: { c: 'A' }, reviewer_decision: 'accepted' },
          { label: { c: 'A' }, reviewer_decision: 'accepted' },
          { label: { c: 'B' }, reviewer_decision: 'accepted' },
        ],
      });
      expect(consensus).not.toBeNull();
      expect(consensus.c).toBe('A');
    });
  });

  describe('classifyDifficulty', () => {
    it('returns hard when disagree at quorum', () => {
      expect(
        classifyDifficulty({ acceptedCount: 2, agreement: 'disagree', requiredLabelers: 2 })
      ).toBe('hard');
    });

    it('returns easy when match at quorum', () => {
      expect(
        classifyDifficulty({ acceptedCount: 2, agreement: 'match', requiredLabelers: 2 })
      ).toBe('easy');
    });
  });

  describe('aggregateAnnotations', () => {
    it('rolls up to ready_to_use + match when two accepted annotations agree at quorum', () => {
      const result = aggregateAnnotations({
        annotations: [
          { label: { c: 'A' }, reviewer_decision: 'accepted' },
          { label: { c: 'A' }, reviewer_decision: 'accepted' },
        ],
        requiredLabelers: 2,
      });
      expect(result.status).toBe('ready_to_use');
      expect(result.agreement).toBe('match');
    });
  });

  describe('buildLabelingActions', () => {
    it('includes disclaimer and references conflict/adjudicator when status=conflict', () => {
      const actions = buildLabelingActions({
        status: 'conflict',
        agreement: 'disagree',
        signals: [],
      });
      const disclaimerPresent = actions.some((line) =>
        /eval lead review required/i.test(line)
      );
      const conflictLine = actions.some((line) => /conflict|adjudicator/i.test(line));
      expect(disclaimerPresent).toBe(true);
      expect(conflictLine).toBe(true);
    });
  });
});
