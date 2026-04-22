import { classifyInferenceResults } from '../../services/ai/imagingAiService.js';

describe('imaging AI inference classifier', () => {
  it('returns normal when nothing meets the confidence threshold', () => {
    const out = classifyInferenceResults([
      { label: 'pneumonia', confidence: 0.2 },
      { label: 'opacity', confidence: 0.15 },
    ]);
    expect(out.overall_severity).toBe('normal');
    expect(out.findings.length).toBe(0);
  });

  it('classifies a confident pneumothorax as critical', () => {
    const out = classifyInferenceResults([
      { label: 'Pneumothorax', confidence: 0.78 },
      { label: 'cardiomegaly', confidence: 0.62 },
    ]);
    expect(out.overall_severity).toBe('critical');
    expect(out.findings[0].severity).toBe('critical');
    expect(out.findings[0].label).toBe('pneumothorax');
  });

  it('falls back to actionable when only actionable labels fire', () => {
    const out = classifyInferenceResults([
      { label: 'pneumonia', confidence: 0.82 },
      { label: 'pleural effusion', confidence: 0.64 },
    ]);
    expect(out.overall_severity).toBe('actionable');
    expect(out.findings[0].severity).toBe('actionable');
  });

  it('returns incidental when only low-confidence labels fire', () => {
    const out = classifyInferenceResults([
      { label: 'calcified granuloma', confidence: 0.4 },
    ]);
    expect(out.overall_severity).toBe('incidental');
  });

  it('sorts findings by severity then confidence', () => {
    const out = classifyInferenceResults([
      { label: 'pneumonia', confidence: 0.9 },
      { label: 'pneumothorax', confidence: 0.55 },
      { label: 'opacity', confidence: 0.7 },
    ]);
    expect(out.findings[0].severity).toBe('critical');
    expect(out.findings[0].label).toBe('pneumothorax');
    expect(out.findings[1].label).toBe('pneumonia');
  });

  it('tops out confidence_pct at the max confidence seen', () => {
    const out = classifyInferenceResults([
      { label: 'consolidation', confidence: 0.85 },
      { label: 'opacity', confidence: 0.65 },
    ]);
    expect(out.confidence_pct).toBe(85);
  });

  it('handles non-array or empty input gracefully', () => {
    expect(classifyInferenceResults(null)).toEqual({
      findings: [],
      overall_severity: 'normal',
      confidence_pct: 0,
    });
    expect(classifyInferenceResults([])).toEqual({
      findings: [],
      overall_severity: 'normal',
      confidence_pct: 0,
    });
  });
});
