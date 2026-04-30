// Unit tests for the rule-based first cut of the clinical differential
// debate (TradingAgents-style bull/bear adapted to pursue/challenge).
// These tests cover the gating contract (module must opt in) and the
// adjudicator's balance verdict — the tests exist to lock the wiring in,
// so when the LLM-backed implementation lands, replacing the bodies of
// runPursueAgent / runChallengeAgent / runAdjudicator does not silently
// break gating or the safety_flag emission.

import {
  runAdjudicator,
  runChallengeAgent,
  runDifferentialDebate,
  runPursueAgent,
} from '../../services/ai/clinicalDebateService.js';

describe('runDifferentialDebate gating', () => {
  it('skips when the module has not opted in and emits zero flags', () => {
    const out = runDifferentialDebate({
      chartPacket: {},
      draft: { discharge_diagnosis: 'pneumonia' },
      module: { settings: { enableDifferentialDebate: false } },
      citations: [],
    });
    expect(out.debate_enabled).toBe(false);
    expect(out.debate_skipped).toBe(true);
    expect(out.evidence_balance).toBeNull();
    expect(out.safety_flags).toEqual([]);
  });

  it('runs when the module opts in via settings.enableDifferentialDebate', () => {
    const out = runDifferentialDebate({
      chartPacket: { admission: { chief_complaint: 'chest pain' }, recent_notes: [] },
      draft: { discharge_diagnosis: 'pneumonia' },
      module: { settings: { enableDifferentialDebate: true } },
      citations: [{ source_type: 'note', source_id: 1, label: 'a' }],
    });
    expect(out.debate_enabled).toBe(true);
    expect(out.debate_skipped).toBe(false);
    expect(out.evidence_balance).not.toBeNull();
  });
});

describe('runPursueAgent', () => {
  it('returns an unknown-confidence stub when the draft has no hypothesis', () => {
    const result = runPursueAgent({ chartPacket: {}, draft: {} });
    expect(result.hypothesis).toBeNull();
    expect(result.confidence).toBe('unknown');
    expect(result.supporting_evidence).toEqual([]);
  });

  it('extracts evidence that mentions the hypothesis token by token', () => {
    const result = runPursueAgent({
      chartPacket: {
        active_diagnoses: [
          { summary: 'Community-acquired pneumonia (right lower lobe)' },
          { summary: 'Type 2 diabetes mellitus' },
        ],
        recent_notes: [
          { summary: 'Started antibiotics for suspected pneumonia' },
        ],
        investigations: [
          { summary: 'CXR: right lower zone consolidation consistent with pneumonia' },
        ],
      },
      draft: { discharge_diagnosis: 'Pneumonia' },
    });
    expect(result.hypothesis).toBe('Pneumonia');
    expect(result.confidence).toBe('high');
    expect(result.supporting_evidence.length).toBeGreaterThanOrEqual(3);
  });
});

describe('runChallengeAgent', () => {
  it('surfaces must-not-miss alternatives for chest pain', () => {
    const result = runChallengeAgent({
      chartPacket: { admission: { chief_complaint: 'crushing chest pain radiating to left arm' } },
      draft: { discharge_diagnosis: 'Costochondritis' },
      citations: [{ source_type: 'note', source_id: 1, label: 'a' }],
    });
    expect(result.alternatives).toEqual(
      expect.arrayContaining(['acute coronary syndrome', 'pulmonary embolism', 'aortic dissection'])
    );
  });

  it('flags evidence gaps when citations are sparse', () => {
    const result = runChallengeAgent({
      chartPacket: { admission: { chief_complaint: 'fever' }, recent_notes: [] },
      draft: { discharge_diagnosis: 'viral fever' },
      citations: [{ source_type: 'note', source_id: 1, label: 'a' }],
    });
    expect(result.evidence_gaps).toEqual(
      expect.arrayContaining([expect.stringMatching(/fewer than 2 chart sources/i)])
    );
  });

  it('flags abnormal vitals as refuting signals', () => {
    const result = runChallengeAgent({
      chartPacket: {
        admission: { chief_complaint: 'shortness of breath' },
        recent_vitals: [{ payload: { spo2: 86, heart_rate: 135 } }],
      },
      draft: { discharge_diagnosis: 'Anxiety' },
      citations: [],
    });
    expect(result.refuting_signals.some((s) => s.includes('SpO2'))).toBe(true);
    expect(result.refuting_signals.some((s) => s.includes('HR'))).toBe(true);
  });
});

describe('runAdjudicator', () => {
  it('returns insufficient_evidence when both sides are empty', () => {
    const out = runAdjudicator({
      pursue: { supporting_evidence: [] },
      challenge: { alternatives: [], refuting_signals: [], evidence_gaps: [] },
    });
    expect(out.balance).toBe('insufficient_evidence');
  });

  it('returns supports_leading_hypothesis when pursue dominates 2:1', () => {
    const out = runAdjudicator({
      pursue: { supporting_evidence: ['a', 'b', 'c'] },
      challenge: { alternatives: [], refuting_signals: [], evidence_gaps: [] },
    });
    expect(out.balance).toBe('supports_leading_hypothesis');
  });

  it('returns challenges_leading_hypothesis when challenge dominates', () => {
    const out = runAdjudicator({
      pursue: { supporting_evidence: [] },
      challenge: { alternatives: ['x', 'y'], refuting_signals: ['z'], evidence_gaps: ['gap'] },
    });
    expect(out.balance).toBe('challenges_leading_hypothesis');
  });

  it('returns mixed when neither side dominates', () => {
    const out = runAdjudicator({
      pursue: { supporting_evidence: ['a', 'b'] },
      challenge: { alternatives: ['x'], refuting_signals: ['y'], evidence_gaps: [] },
    });
    expect(out.balance).toBe('mixed');
  });

  it('always includes a decision-support-only adjudication note', () => {
    const out = runAdjudicator({ pursue: null, challenge: null });
    expect(out.adjudication_note).toMatch(/decision support only/i);
  });
});

describe('runDifferentialDebate safety flags', () => {
  it('emits DEBATE_CHALLENGES_LEADING_HYPOTHESIS at high severity when challenge dominates', () => {
    const out = runDifferentialDebate({
      chartPacket: {
        admission: { chief_complaint: 'crushing chest pain' },
        recent_vitals: [{ payload: { spo2: 84 } }],
      },
      draft: { discharge_diagnosis: 'Costochondritis' },
      module: { settings: { enableDifferentialDebate: true } },
      citations: [],
    });
    const codes = out.safety_flags.map((f) => f.code);
    expect(codes).toContain('DEBATE_CHALLENGES_LEADING_HYPOTHESIS');
    expect(out.safety_flags.find((f) => f.code === 'DEBATE_CHALLENGES_LEADING_HYPOTHESIS').severity).toBe('high');
  });

  it('emits DEBATE_MUST_NOT_MISS when the chief complaint triggers alternatives', () => {
    const out = runDifferentialDebate({
      chartPacket: { admission: { chief_complaint: 'pregnancy with severe headache' } },
      draft: { discharge_diagnosis: 'Tension headache' },
      module: { settings: { enableDifferentialDebate: true } },
      citations: [
        { source_type: 'note', source_id: 1, label: 'a' },
        { source_type: 'note', source_id: 2, label: 'b' },
      ],
    });
    const codes = out.safety_flags.map((f) => f.code);
    expect(codes).toContain('DEBATE_MUST_NOT_MISS');
  });
});
