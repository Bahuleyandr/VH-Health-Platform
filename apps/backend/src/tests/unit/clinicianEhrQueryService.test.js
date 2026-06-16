import { jest } from '@jest/globals';

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn() },
  prismaReadOnly: { $queryRawUnsafe: jest.fn() },
}));

jest.unstable_mockModule('../../services/emr/clinicalTimelineService.js', () => {
  const collectAdmissionClinicalContext = jest.fn();
  const getPatientTimeline = jest.fn();
  // Real makeCitation is a pure builder; mirror its real shape so the test
  // exercises the same wiring the orchestrator relies on.
  const makeCitation = jest.fn((event) => ({
    source_type: event.event_type,
    source_id: event.id ? String(event.id) : null,
    timestamp: event.timestamp,
    label: event.summary,
  }));
  return {
    collectAdmissionClinicalContext,
    getPatientTimeline,
    makeCitation,
    default: { collectAdmissionClinicalContext, getPatientTimeline, makeCitation },
  };
});

jest.unstable_mockModule('../../services/ai/localLlmClient.js', () => {
  const generateClinicalText = jest.fn();
  return { generateClinicalText, default: { generateClinicalText } };
});

jest.unstable_mockModule('../../services/ai/hallucinationDefenses.js', () => {
  const runOutputDefenses = jest.fn();
  return { runOutputDefenses, default: { runOutputDefenses } };
});

jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => {
  const getClinicalAiModule = jest.fn();
  return { getClinicalAiModule, default: { getClinicalAiModule } };
});

const prismaMod = await import('../../lib/prisma.js');
const timelineMod = await import('../../services/emr/clinicalTimelineService.js');
const llmMod = await import('../../services/ai/localLlmClient.js');
const defensesMod = await import('../../services/ai/hallucinationDefenses.js');
const moduleMod = await import('../../services/ai/clinicalAiModuleService.js');

const svc = await import('../../services/ai/clinicianEhrQueryService.js');
const { serializeEhrContext, resolveCurrentAdmission } = svc.__testing__;
const { answerEhrQuery } = svc;

beforeEach(() => {
  jest.clearAllMocks();
  // Default: module enabled.
  moduleMod.getClinicalAiModule.mockResolvedValue({ enabled: true, display_name: 'Clinician EHR Query' });
  // Default: no safety flags.
  defensesMod.runOutputDefenses.mockReturnValue([]);
  // Default: INSERT returns a row.
  prismaMod.default.$queryRawUnsafe.mockResolvedValue([{ id: 1, status: 'completed', created_at: 'now' }]);
});

// ── Helper tests (Task 1 — kept green) ──────────────────────────────────────

test('serializeEhrContext labels both sections and flattens citations', () => {
  const out = serializeEhrContext({
    currentAdmission: { admission: { id: 7 }, timeline: [{ timestamp: '2026-06-10T00:00:00Z', type: 'lab', summary: 'Creatinine 2.1', citation: { id: 'c1' } }] },
    history: [{ timestamp: '2024-03-01T00:00:00Z', type: 'lab', summary: 'Creatinine 0.9', citation: { id: 'c2' } }],
    scope: 'both',
  });
  expect(out.text).toContain('[CURRENT ADMISSION]');
  expect(out.text).toContain('Creatinine 2.1');
  expect(out.text).toContain('[PRIOR HISTORY]');
  expect(out.text).toContain('Creatinine 0.9');
  expect(out.citations.map((c) => c.id)).toEqual(['c1', 'c2']);
});

test('serializeEhrContext with scope=current_admission omits history', () => {
  const out = serializeEhrContext({ currentAdmission: { admission: { id: 7 }, timeline: [{ timestamp: 't', type: 'note', summary: 'x' }] }, history: [{ timestamp: 't2', type: 'note', summary: 'y' }], scope: 'current_admission' });
  expect(out.text).toContain('[CURRENT ADMISSION]');
  expect(out.text).not.toContain('[PRIOR HISTORY]');
  expect(out.text).not.toContain('y');
});

test('serializeEhrContext with scope=history omits the current-admission section', () => {
  const out = serializeEhrContext({ currentAdmission: { admission: { id: 7 }, timeline: [{ timestamp: 't', type: 'note', summary: 'admitnote' }] }, history: [{ timestamp: 't2', type: 'note', summary: 'historynote' }], scope: 'history' });
  expect(out.text).not.toContain('[CURRENT ADMISSION]');
  expect(out.text).not.toContain('admitnote');
  expect(out.text).toContain('[PRIOR HISTORY]');
  expect(out.text).toContain('historynote');
});

test('serializeEhrContext handles a null currentAdmission (outpatient) gracefully', () => {
  const out = serializeEhrContext({ currentAdmission: null, history: [{ timestamp: 't2', type: 'note', summary: 'historynote', citation: { id: 'c9' } }], scope: 'both' });
  expect(out.text).not.toContain('[CURRENT ADMISSION]');
  expect(out.text).toContain('[PRIOR HISTORY]');
  expect(out.citations.map((c) => c.id)).toEqual(['c9']);
});

test('serializeEhrContext with everything empty emits only the history header and no citations', () => {
  const out = serializeEhrContext({ currentAdmission: null, history: [], scope: 'both' });
  expect(out.citations).toEqual([]);
  expect(out.text).toContain('[PRIOR HISTORY]');
  expect(out.text).not.toContain('[CURRENT ADMISSION]');
});

test('resolveCurrentAdmission returns the active admission id or null', async () => {
  prismaMod.prismaReadOnly.$queryRawUnsafe.mockResolvedValueOnce([{ id: 42 }]);
  await expect(resolveCurrentAdmission('p1', 't1')).resolves.toBe(42);
  prismaMod.prismaReadOnly.$queryRawUnsafe.mockResolvedValueOnce([]);
  await expect(resolveCurrentAdmission('p1', 't1')).resolves.toBeNull();
});

// ── answerEhrQuery orchestration tests (Task 2) ─────────────────────────────

const baseReq = { tenantId: 'tenant-uuid', tenant_region: 'in', user: { uid: 'doc-uuid' } };

function makePacket() {
  return {
    admission: { id: 99, admitted_at: '2026-06-01T00:00:00Z' },
    timeline: [
      { id: 11, event_type: 'lab', summary: 'Creatinine 2.1 this admission', timestamp: '2026-06-10T00:00:00Z' },
    ],
    citations: [
      { source_type: 'lab', source_id: '11', timestamp: '2026-06-10T00:00:00Z', label: 'Creatinine 2.1 this admission' },
    ],
  };
}

test('answerEhrQuery happy path (scope=both) returns chart-grounded answer with both-section citations', async () => {
  prismaMod.prismaReadOnly.$queryRawUnsafe.mockResolvedValueOnce([{ id: 99 }]); // resolveCurrentAdmission
  timelineMod.collectAdmissionClinicalContext.mockResolvedValueOnce(makePacket());
  timelineMod.getPatientTimeline.mockResolvedValueOnce([
    { id: 5, event_type: 'diagnosis', summary: 'CKD stage 3 prior', timestamp: '2024-03-01T00:00:00Z' },
  ]);
  llmMod.generateClinicalText.mockResolvedValueOnce({
    text: 'THIS ADMISSION: creatinine 2.1. PRIOR HISTORY: CKD stage 3.',
    usedAi: true,
    provider: 'ollama',
    model: 'llama3.1',
    tier: 'quick',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });

  const res = await answerEhrQuery({ patientUid: 'pat-uuid', question: 'How is the kidney function trending?', scope: 'both', req: baseReq });

  expect(res.answer).toBe('THIS ADMISSION: creatinine 2.1. PRIOR HISTORY: CKD stage 3.');
  expect(res.scope).toBe('both');
  expect(res.used_ai).toBe(true);
  expect(res.window.current_admission_id).toBe(99);
  expect(res.window.event_count).toBe(2);

  // Citations must include BOTH a current-admission citation (source_id 11) and
  // a history citation (source_id 5) — proves the zip + makeCitation wiring.
  const ids = res.citations.map((c) => c.source_id);
  expect(ids).toContain('11');
  expect(ids).toContain('5');

  // generateClinicalText called with the right taskType + tenant context.
  const genArgs = llmMod.generateClinicalText.mock.calls[0][0];
  expect(genArgs.taskType).toBe('clinician_ehr_query');
  expect(genArgs.tenantId).toBe('tenant-uuid');
  expect(genArgs.tenantRegion).toBe('in');
  expect(genArgs.userPrompt).toContain('CLINICIAN QUESTION: How is the kidney function trending?');

  // Audit INSERT happened.
  const insertCall = prismaMod.default.$queryRawUnsafe.mock.calls.find((c) => /INSERT INTO clinical_ai_generations/i.test(c[0]));
  expect(insertCall).toBeDefined();
});

test('answerEhrQuery suppresses the answer when a critical PHI-leak flag fires', async () => {
  prismaMod.prismaReadOnly.$queryRawUnsafe.mockResolvedValueOnce([{ id: 99 }]);
  timelineMod.collectAdmissionClinicalContext.mockResolvedValueOnce(makePacket());
  timelineMod.getPatientTimeline.mockResolvedValueOnce([
    { id: 5, event_type: 'diagnosis', summary: 'CKD stage 3 prior', timestamp: '2024-03-01T00:00:00Z' },
  ]);
  llmMod.generateClinicalText.mockResolvedValueOnce({ text: 'leaked 9f8e7d6c-1234-4abc-89ab-0123456789ab', usedAi: true, provider: 'ollama', model: 'm', usage: {} });
  defensesMod.runOutputDefenses.mockReturnValueOnce([
    { severity: 'critical', code: 'PHI_LEAK_SUSPECTED', message: 'Draft contains 1 UID not found in source citations', metadata: { kind: 'uid', count: 1 } },
  ]);

  const res = await answerEhrQuery({ patientUid: 'pat-uuid', question: 'q', scope: 'both', req: baseReq });

  expect(res.answer).toBeNull();
  expect(res.safety_flags.some((f) => f.severity === 'critical' && f.code === 'PHI_LEAK_SUSPECTED')).toBe(true);

  // Audit INSERT still happened, and draft.answer was null.
  const insertCall = prismaMod.default.$queryRawUnsafe.mock.calls.find((c) => /INSERT INTO clinical_ai_generations/i.test(c[0]));
  expect(insertCall).toBeDefined();
  // draft is the jsonb param — find the JSON.stringify'd draft arg with answer:null.
  const draftArg = insertCall.slice(1).find((a) => typeof a === 'string' && a.includes('"answer"'));
  expect(draftArg).toBeDefined();
  expect(JSON.parse(draftArg).answer).toBeNull();
});

test('answerEhrQuery rejects with 403 when the module is disabled', async () => {
  moduleMod.getClinicalAiModule.mockResolvedValueOnce({ enabled: false, display_name: 'Clinician EHR Query' });
  await expect(answerEhrQuery({ patientUid: 'pat-uuid', question: 'q', scope: 'both', req: baseReq }))
    .rejects.toMatchObject({ statusCode: 403, code: 'EHR_QUERY_MODULE_DISABLED' });
});

test('answerEhrQuery rejects with 400 when patientUid or question is missing', async () => {
  await expect(answerEhrQuery({ patientUid: '', question: 'q', req: baseReq })).rejects.toMatchObject({ statusCode: 400 });
  await expect(answerEhrQuery({ patientUid: 'pat-uuid', question: '  ', req: baseReq })).rejects.toMatchObject({ statusCode: 400 });
});

test('answerEhrQuery scope=current_admission omits history and counts only admission events', async () => {
  prismaMod.prismaReadOnly.$queryRawUnsafe.mockResolvedValueOnce([{ id: 99 }]);
  timelineMod.collectAdmissionClinicalContext.mockResolvedValueOnce(makePacket());
  llmMod.generateClinicalText.mockResolvedValueOnce({ text: 'admission-only answer', usedAi: true, provider: 'ollama', model: 'm', usage: {} });

  const res = await answerEhrQuery({ patientUid: 'pat-uuid', question: 'q', scope: 'current_admission', req: baseReq });

  expect(timelineMod.getPatientTimeline).not.toHaveBeenCalled();
  expect(res.scope).toBe('current_admission');
  expect(res.window.event_count).toBe(1); // only the single admission event
  // Only the current-admission citation is present.
  expect(res.citations.map((c) => c.source_id)).toEqual(['11']);
});
