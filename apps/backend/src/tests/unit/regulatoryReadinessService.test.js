/**
 * S5 unit tests: the readiness-pack assembler hits seven tables across
 * the AI stack. We test the assembler against a stubbed prisma so we
 * cover argument shape, tenant scoping, error handling, and the bias
 * signal summarisation logic without requiring a live DB.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
}));

const { assembleReadinessPack, __testing__ } = await import(
  '../../services/ai/regulatoryReadinessService.js'
);

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

function mockSequence(...rowsPerCall) {
  let i = 0;
  queryUnsafeMock.mockImplementation(() => {
    const rows = rowsPerCall[i] ?? [];
    i += 1;
    if (rows instanceof Error) throw rows;
    return Promise.resolve(rows);
  });
}

function moduleStub() {
  return [{
    module_key: 'discharge_summary',
    display_name: 'Discharge Summary Drafts',
    enabled: true,
    settings: {},
    description: 'discharge',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }];
}

describe('regulatoryReadinessService.assembleReadinessPack', () => {
  it('rejects missing module_key', async () => {
    await expect(assembleReadinessPack({})).rejects.toThrow(/module_key/);
  });

  it('returns a structured pack with all seven sections + row_counts summary', async () => {
    mockSequence(
      moduleStub(),
      [{ id: 1, model_key: 'discharge_summary', version: 'v1', stage: 'production' }],
      [{ id: 2, model_key: 'discharge_summary', version: 'v1', accuracy: 0.92, bias_signals: [] }],
      [{ id: 3, total_cases: 10, pass_count: 9, drift_detected: false, bias_signals: [] }],
      [{ id: 4, module_key: 'discharge_summary', status: 'cleared', findings: [] }],
      [{ id: 5, module_key: 'discharge_summary', version: 'v1', active: true }],
      [{ id: 6, module_key: 'discharge_summary', decision: 'accepted' }],
    );

    const pack = await assembleReadinessPack({
      tenantId: '00000000-0000-4000-8000-000000000001',
      moduleKey: 'discharge_summary',
      generatedBy: { uid: 'admin-uid', role: 'ADMIN' },
    });

    expect(pack.pack_version).toBe(__testing__.PACK_VERSION);
    expect(pack.module_key).toBe('discharge_summary');
    expect(pack.tenant_id).toBe('00000000-0000-4000-8000-000000000001');
    expect(pack.generated_by).toEqual({ uid: 'admin-uid', role: 'ADMIN' });
    expect(pack.decision_support_only).toBe(true);
    expect(pack.sections.module).toBeTruthy();
    expect(pack.sections.model_registry).toHaveLength(1);
    expect(pack.sections.eval_runs).toHaveLength(1);
    expect(pack.sections.canary_runs).toHaveLength(1);
    expect(pack.sections.safety_reviews).toHaveLength(1);
    expect(pack.sections.prompts).toHaveLength(1);
    expect(pack.sections.reviews).toHaveLength(1);
    expect(pack.summary.row_counts).toEqual({
      module: 1,
      model_registry: 1,
      eval_runs: 1,
      canary_runs: 1,
      safety_reviews: 1,
      prompts: 1,
      reviews: 1,
    });
  });

  it('records skipped_sections when a table is missing', async () => {
    queryUnsafeMock.mockImplementation(async (sql) => {
      if (/clinical_ai_safety_reviews/i.test(sql)) {
        const err = new Error('relation "clinical_ai_safety_reviews" does not exist');
        throw err;
      }
      if (/clinical_ai_modules/i.test(sql)) return moduleStub();
      return [];
    });

    const pack = await assembleReadinessPack({
      moduleKey: 'discharge_summary',
    });

    expect(pack.summary.skipped_sections.safety_reviews).toBe('schema_unavailable');
    expect(pack.sections.safety_reviews).toEqual([]);
  });

  it('passes fromVersion / toVersion bounds into the registry + eval queries', async () => {
    mockSequence(
      moduleStub(),
      [],
      [],
      [],
      [],
      [],
      [],
    );

    await assembleReadinessPack({
      moduleKey: 'discharge_summary',
      fromVersion: 'v1.0',
      toVersion: 'v1.5',
    });

    // registry call is index 1 (after module), eval_runs is index 2.
    const registryCall = queryUnsafeMock.mock.calls[1];
    const evalCall = queryUnsafeMock.mock.calls[2];
    expect(registryCall.slice(1)).toEqual(
      expect.arrayContaining(['discharge_summary', 'v1.0', 'v1.5']),
    );
    expect(evalCall.slice(1)).toEqual(
      expect.arrayContaining(['discharge_summary', 'v1.0', 'v1.5']),
    );
  });

  it('summarises bias signals across eval and canary runs', () => {
    const signals = __testing__.summariseBiasSignals(
      [
        { bias_signals: [{ severity: 'critical' }, { severity: 'high' }] },
        { bias_signals: [{ severity: 'medium' }] },
      ],
      [
        { bias_signals: [{ severity: 'high' }] },
      ],
    );
    expect(signals).toEqual({ critical: 1, high: 2, medium: 1 });
  });

  it('summary.bias_signal_counts surfaces severity totals end-to-end', async () => {
    mockSequence(
      moduleStub(),
      [],
      [
        { id: 1, bias_signals: [{ severity: 'critical' }] },
        { id: 2, bias_signals: [{ severity: 'medium' }, { severity: 'medium' }] },
      ],
      [{ id: 3, bias_signals: [{ severity: 'high' }] }],
      [],
      [],
      [],
    );

    const pack = await assembleReadinessPack({ moduleKey: 'discharge_summary' });
    expect(pack.summary.bias_signal_counts).toEqual({ critical: 1, high: 1, medium: 2 });
  });
});
