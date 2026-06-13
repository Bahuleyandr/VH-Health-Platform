/**
 * Pilot evidence pack tests cover tenant-scoped rollout evidence without a
 * live DB: enabled modules, real generations, final human review notes,
 * risky-module eval gates, and schema-unavailable fallbacks.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

const {
  assemblePilotEvidencePack,
  createPilotSignoff,
  decidePilotSignoff,
  getPilotStageGate,
  __testing__,
} = await import(
  '../../services/ai/pilotEvidencePackService.js'
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

function tenantRow() {
  return [{
    id: '00000000-0000-4000-8000-000000000001',
    slug: 'pilot-hospital',
    name: 'Pilot Hospital',
    region: 'IN',
    compliance_profile: 'DPDP_HIPAA',
    status: 'active',
  }];
}

function guardrailRow() {
  return [{ id: 1, enabled: true, external_ai_enabled: false }];
}

function moduleRows() {
  return [
    {
      module_key: 'medication_reconciliation',
      display_name: 'Medication Reconciliation',
      effective_enabled: true,
      settings: { risk: 'high', approvalPolicy: 'two_person_for_enablement' },
      tenant_settings: {},
    },
    {
      module_key: 'patient_aftercare_instructions',
      display_name: 'Patient Aftercare Instructions',
      effective_enabled: true,
      settings: { risk: 'medium' },
      tenant_settings: {},
    },
  ];
}

function generationRows() {
  return [
    {
      id: 10,
      module_key: 'medication_reconciliation',
      admission_id: 1001,
      status: 'completed',
      used_ai: true,
      generation_mode: 'ai',
      safety_flags: [],
      created_at: new Date().toISOString(),
    },
    {
      id: 11,
      module_key: 'patient_aftercare_instructions',
      admission_id: 1002,
      status: 'completed',
      used_ai: false,
      generation_mode: 'template_fallback',
      fallback_reason: 'provider_unavailable',
      safety_flags: [{ severity: 'low', code: 'EDU_REVIEW', message: 'Review wording' }],
      created_at: new Date().toISOString(),
    },
  ];
}

function reviewRows() {
  return [
    {
      id: 20,
      generation_id: 10,
      module_key: 'medication_reconciliation',
      reviewer_uid: 'doctor-1',
      reviewer_role: 'DOCTOR',
      decision: 'accepted',
      reviewer_note_present: true,
      reviewer_note_chars: 34,
      reviewer_note_words: 5,
    },
    {
      id: 21,
      generation_id: 11,
      module_key: 'patient_aftercare_instructions',
      reviewer_uid: 'doctor-2',
      reviewer_role: 'DOCTOR',
      decision: 'edited',
      reviewer_note_present: true,
      reviewer_note_chars: 42,
      reviewer_note_words: 6,
    },
  ];
}

function safetyRows() {
  return [
    { id: 30, generation_id: 10, module_key: 'medication_reconciliation', status: 'passed' },
    { id: 31, generation_id: 11, module_key: 'patient_aftercare_instructions', status: 'passed' },
  ];
}

function readyPackQueryRows() {
  return [
    tenantRow(),
    guardrailRow(),
    moduleRows(),
    generationRows(),
    reviewRows(),
    safetyRows(),
    [],
    [{ id: 40, model_key: 'medication_reconciliation', reviewer_decision: 'accepted' }],
    [{ id: 50, action: 'CLINICAL_AI_REVIEW_UPDATED' }],
  ];
}

function signoffPayload(overrides = {}) {
  return {
    kind: 'clinical_ai_pilot_signoff',
    pack_hash: 'abc123',
    pack_version: __testing__.PACK_VERSION,
    pilot_stage: 'stage_1_clinical_review',
    module_keys: __testing__.DEFAULT_PILOT_MODULES,
    evidence_window: {
      from: '2026-05-01T00:00:00.000Z',
      to: '2026-05-15T00:00:00.000Z',
      window_days: 14,
    },
    min_reviewed_per_module: 1,
    decision_support_only: true,
    human_review_required: true,
    pilot_ready: true,
    blockers: [],
    skipped_sections: {},
    row_counts: { generations: 2, reviews: 2 },
    module_summary: [],
    ...overrides,
  };
}

function signoffRow(overrides = {}) {
  return {
    id: 70,
    tenant_id: '00000000-0000-4000-8000-000000000001',
    approval_type: __testing__.SIGNOFF_APPROVAL_TYPE,
    module_key: null,
    status: 'pending',
    requested_by: '88888888-8888-4888-8888-888888888888',
    approved_by: null,
    rejected_by: null,
    reason: 'Pilot signoff requested',
    payload: signoffPayload(),
    expires_at: '2099-01-01T00:00:00.000Z',
    decided_at: null,
    created_at: '2026-05-26T00:00:00.000Z',
    updated_at: '2026-05-26T00:00:00.000Z',
    ...overrides,
  };
}

describe('pilotEvidencePackService.assemblePilotEvidencePack', () => {
  it('defaults to the first pilot modules and returns a pilot-ready pack', async () => {
    mockSequence(
      tenantRow(),
      guardrailRow(),
      moduleRows(),
      generationRows(),
      reviewRows(),
      safetyRows(),
      [],
      [{ id: 40, model_key: 'medication_reconciliation', reviewer_decision: 'accepted' }],
      [{ id: 50, action: 'CLINICAL_AI_REVIEW_UPDATED' }],
    );

    const pack = await assemblePilotEvidencePack({
      tenantId: '00000000-0000-4000-8000-000000000001',
      generatedBy: { uid: 'admin-uid', role: 'ADMIN' },
    });

    expect(pack.pack_version).toBe(__testing__.PACK_VERSION);
    expect(pack.module_keys).toEqual(__testing__.DEFAULT_PILOT_MODULES);
    expect(pack.tenant_id).toBe('00000000-0000-4000-8000-000000000001');
    expect(pack.generated_by).toEqual({ uid: 'admin-uid', role: 'ADMIN' });
    expect(pack.decision_support_only).toBe(true);
    expect(pack.human_review_required).toBe(true);
    expect(pack.summary.pilot_ready).toBe(true);
    expect(pack.summary.blockers).toEqual([]);
    expect(pack.sections.generations[0]).not.toHaveProperty('draft');
    expect(pack.sections.reviews[0]).not.toHaveProperty('reviewer_note');
    expect(pack.summary.row_counts).toEqual({
      tenant: 1,
      guardrails: 1,
      modules: 2,
      generations: 2,
      reviews: 2,
      safety_reviews: 2,
      approvals: 0,
      eval_runs: 1,
      audit_events: 1,
    });

    const auditQuery = queryUnsafeMock.mock.calls.find(([sql]) => /FROM audit_logs/i.test(sql))?.[0];
    expect(auditQuery).toContain("$2::timestamptz AT TIME ZONE current_setting('TimeZone')");
    expect(auditQuery).toContain("$3::timestamptz AT TIME ZONE current_setting('TimeZone')");
  });

  it('blocks rollout evidence when final human reviews have no reviewer note', async () => {
    mockSequence(
      tenantRow(),
      guardrailRow(),
      [moduleRows()[1]],
      [generationRows()[1]],
      [{ ...reviewRows()[1], reviewer_note_present: false, reviewer_note_chars: 0, reviewer_note_words: 0 }],
      [safetyRows()[1]],
      [],
      [],
      [],
    );

    const pack = await assemblePilotEvidencePack({
      moduleKeys: ['patient_aftercare_instructions'],
    });

    expect(pack.summary.pilot_ready).toBe(false);
    expect(pack.summary.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'FINAL_REVIEW_WITHOUT_REVIEWER_NOTE',
          module_key: 'patient_aftercare_instructions',
        }),
        expect.objectContaining({ code: 'HUMAN_REVIEW_NOTE_GATE_VIOLATION' }),
      ]),
    );
  });

  it('records skipped_sections when rollout evidence schema is unavailable', async () => {
    queryUnsafeMock.mockImplementation(async (sql) => {
      if (/clinical_ai_safety_reviews/i.test(sql)) {
        throw new Error('relation "clinical_ai_safety_reviews" does not exist');
      }
      if (/tenants/i.test(sql)) return tenantRow();
      if (/clinical_ai_guardrails/i.test(sql)) return guardrailRow();
      if (/clinical_ai_modules/i.test(sql)) return [moduleRows()[1]];
      if (/clinical_ai_generations/i.test(sql)) return [generationRows()[1]];
      if (/clinical_ai_reviews/i.test(sql)) return [reviewRows()[1]];
      return [];
    });

    const pack = await assemblePilotEvidencePack({
      moduleKeys: ['patient_aftercare_instructions'],
    });

    expect(pack.summary.skipped_sections.safety_reviews).toBe('schema_unavailable');
    expect(pack.sections.safety_reviews).toEqual([]);
    expect(pack.summary.pilot_ready).toBe(false);
    expect(pack.summary.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'EVIDENCE_SECTION_UNAVAILABLE',
          section: 'safety_reviews',
          reason: 'schema_unavailable',
        }),
      ]),
    );
  });

  it('deduplicates comma-delimited module keys', () => {
    expect(__testing__.normalizeModuleKeys('medication_reconciliation, medication_reconciliation')).toEqual([
      'medication_reconciliation',
    ]);
  });
});

describe('pilotEvidencePackService pilot signoffs', () => {
  it('persists a pending signoff with a hashed, redacted evidence snapshot', async () => {
    const packRows = readyPackQueryRows();
    let i = 0;
    queryUnsafeMock.mockImplementation((sql, ...args) => {
      if (/INSERT INTO clinical_ai_approvals/i.test(sql)) {
        const payload = JSON.parse(args[4]);
        return Promise.resolve([
          signoffRow({
            reason: args[3],
            payload,
            expires_at: args[5].toISOString(),
          }),
        ]);
      }
      const rows = packRows[i] ?? [];
      i += 1;
      return Promise.resolve(rows);
    });

    const result = await createPilotSignoff({
      reason: 'Stage 1 pilot evidence reviewed by clinical lead',
      generatedBy: { uid: 'admin-uid', role: 'ADMIN' },
    }, '88888888-8888-4888-8888-888888888888', {
      tenantId: '00000000-0000-4000-8000-000000000001',
    });

    const insertCall = queryUnsafeMock.mock.calls.find(([sql]) => /INSERT INTO clinical_ai_approvals/i.test(sql));
    const insertedPayload = JSON.parse(insertCall[5]);

    expect(insertCall[2]).toBe(__testing__.SIGNOFF_APPROVAL_TYPE);
    expect(result.signoff.status).toBe('pending');
    expect(result.signoff.pilot_ready).toBe(true);
    expect(result.signoff.stage_expansion_allowed).toBe(false);
    expect(result.signoff.pack_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(insertedPayload.pack_hash).toBe(result.signoff.pack_hash);
    expect(insertedPayload.pack_snapshot.sections.generations[0]).not.toHaveProperty('draft');
    expect(insertedPayload.pack_snapshot.sections.reviews[0]).not.toHaveProperty('reviewer_note');
    expect(result.evidence_pack.summary.pilot_ready).toBe(true);
  });

  it('refuses to approve a signoff when the evidence pack has blockers', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      signoffRow({
        payload: signoffPayload({
          pilot_ready: false,
          blockers: [{ code: 'NO_REAL_WORKFLOW_GENERATION', module_key: 'medication_reconciliation' }],
        }),
      }),
    ]);

    await expect(decidePilotSignoff(
      70,
      'approved',
      '99999999-9999-4999-8999-999999999999',
      'Cannot approve while real workflow evidence is missing',
      { tenantId: '00000000-0000-4000-8000-000000000001' },
    )).rejects.toMatchObject({
      code: 'CLINICAL_AI_PILOT_EVIDENCE_BLOCKED',
      statusCode: 403,
    });
  });

  it('allows a hold decision for a blocked signoff and keeps expansion blocked', async () => {
    const blockedPayload = signoffPayload({
      pilot_ready: false,
      blockers: [{ code: 'NO_REAL_WORKFLOW_GENERATION', module_key: 'medication_reconciliation' }],
    });
    queryUnsafeMock
      .mockResolvedValueOnce([signoffRow({ payload: blockedPayload })])
      .mockImplementationOnce((sql, ...args) => Promise.resolve([
        signoffRow({
          status: 'hold',
          rejected_by: args[2],
          reason: args[3],
          payload: JSON.parse(args[4]),
          decided_at: '2026-05-26T01:00:00.000Z',
        }),
      ]));

    const result = await decidePilotSignoff(
      70,
      'hold',
      '99999999-9999-4999-8999-999999999999',
      'Hold until reviewer notes are complete',
      { tenantId: '00000000-0000-4000-8000-000000000001' },
    );

    expect(result.status).toBe('hold');
    expect(result.rejected_by).toBe('99999999-9999-4999-8999-999999999999');
    expect(result.stage_expansion_allowed).toBe(false);
    expect(result.blocking_reason).toBe('SIGNOFF_ON_HOLD');
  });

  it('blocks the stage gate without a complete approved signoff and opens it with one', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);

    const blockedGate = await getPilotStageGate({
      tenantId: '00000000-0000-4000-8000-000000000001',
      pilotStage: 'stage_1_clinical_review',
      moduleKeys: __testing__.DEFAULT_PILOT_MODULES,
    });

    expect(blockedGate.stage_expansion_allowed).toBe(false);
    expect(blockedGate.blocking_reason).toBe('SIGNOFF_REQUIRED');

    queryUnsafeMock.mockResolvedValueOnce([
      signoffRow({
        status: 'approved',
        approved_by: '99999999-9999-4999-8999-999999999999',
        decided_at: '2026-05-26T01:00:00.000Z',
      }),
    ]);

    const allowedGate = await getPilotStageGate({
      tenantId: '00000000-0000-4000-8000-000000000001',
      pilotStage: 'stage_1_clinical_review',
      moduleKeys: __testing__.DEFAULT_PILOT_MODULES,
    });

    expect(allowedGate.stage_expansion_allowed).toBe(true);
    expect(allowedGate.blocking_reason).toBeNull();
    expect(allowedGate.latest_signoff.status).toBe('approved');
  });
});
