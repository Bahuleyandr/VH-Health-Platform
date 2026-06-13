// AI-5 (WS5 B5.1) — requiresCitations must be BLOCKING, not advisory.
//
// buildCommonSafetyFlags() is the workflow node that assembles the common
// safety flags before persistence. For a module declaring
// requiresCitations:true, a draft with zero citations must produce a
// CRITICAL MISSING_CITATIONS flag — the workflow's persist_generation step
// turns any critical flag into status='failed' (dead-letter), so the draft
// never reaches a reviewer as an acceptable item. Modules that don't require
// citations must NOT get the flag.

import { buildCommonSafetyFlags } from '../../services/ai/clinicalAiWorkflowService.js';

describe('AI-5 missing-citations blocking flag', () => {
  const emptyContext = {};

  it('emits a CRITICAL MISSING_CITATIONS flag when requiresCitations and no citations', () => {
    const module = { settings: { requiresCitations: true } };
    const flags = buildCommonSafetyFlags(emptyContext, module, []);
    const flag = flags.find((f) => f.code === 'MISSING_CITATIONS');
    expect(flag).toBeTruthy();
    expect(flag.severity).toBe('critical');
  });

  it('does NOT emit MISSING_CITATIONS when citations are present', () => {
    const module = { settings: { requiresCitations: true } };
    const citations = [{ source_type: 'note', source_id: 'n1', label: 'Progress note' }];
    const flags = buildCommonSafetyFlags(emptyContext, module, citations);
    expect(flags.some((f) => f.code === 'MISSING_CITATIONS')).toBe(false);
  });

  it('does NOT emit MISSING_CITATIONS for a module that does not require citations', () => {
    const module = { settings: { requiresCitations: false } };
    const flags = buildCommonSafetyFlags(emptyContext, module, []);
    expect(flags.some((f) => f.code === 'MISSING_CITATIONS')).toBe(false);
  });

  it('a critical missing-citations flag would dead-letter the draft (severity contract)', () => {
    // The workflow persist step marks status='failed' iff any flag is
    // severity 'critical'. This asserts the flag we emit satisfies that
    // contract so the dead-letter path triggers.
    const module = { settings: { requiresCitations: true } };
    const flags = buildCommonSafetyFlags(emptyContext, module, []);
    expect(flags.some((f) => f.severity === 'critical')).toBe(true);
  });
});
