/**
 * Pilot evidence pack tests cover tenant-scoped rollout evidence without a
 * live DB: enabled modules, real generations, final human review notes,
 * risky-module eval gates, and schema-unavailable fallbacks.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
}));

const { assemblePilotEvidencePack, __testing__ } = await import(
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
