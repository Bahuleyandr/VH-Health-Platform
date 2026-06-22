import { jest } from '@jest/globals';

// M13 (audit 2026-06-22): the patient-facing RAG chatbot ships with its module
// disabled (patient_record_chatbot enabled:false / surface:'patient'), but the
// entry points never consulted the toggle — so it answered over the patient's PHI
// while the platform reported the module disabled. Every write/AI entry point must
// now refuse when the module is disabled for the tenant.

const queryUnsafeMock = jest.fn();
const getClinicalAiModuleMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
  setTenant: async (_t, fn) => fn({ $queryRawUnsafe: queryUnsafeMock }),
  setTenantTx: async (_t, fn) => fn({ $queryRawUnsafe: queryUnsafeMock }),
  pickTenantClient: () => ({ $queryRawUnsafe: queryUnsafeMock }),
}));

// The gate lazily imports getClinicalAiModule from the (large) module service.
// Keep every other real export intact (the chatbot's RAG/LLM dependency chain
// pulls other members) and override ONLY getClinicalAiModule.
const actualModuleService = await import('../../services/ai/clinicalAiModuleService.js');
jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => ({
  ...actualModuleService,
  getClinicalAiModule: getClinicalAiModuleMock,
}));

const { startConversation, sendMessage } = await import('../../services/ai/patientChatbotService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '00000000-0000-4000-8000-0000000abcd1';

function req() {
  return { user: { uid: PATIENT, role: 'PATIENT' }, tenantId: TENANT };
}

describe('patient chatbot module enable-gate (M13)', () => {
  beforeEach(() => {
    queryUnsafeMock.mockReset();
    queryUnsafeMock.mockResolvedValue([]);
    getClinicalAiModuleMock.mockReset();
  });

  it('startConversation refuses when the module is disabled and writes nothing', async () => {
    getClinicalAiModuleMock.mockResolvedValue({ module_key: 'patient_record_chatbot', enabled: false });

    await expect(startConversation({ tenantId: TENANT, patientUid: PATIENT }))
      .rejects.toMatchObject({ statusCode: 403, code: 'CLINICAL_AI_MODULE_DISABLED' });

    // The gate fired before any DB write.
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO patient_chat_conversations/i.test(String(sql)))).toBe(false);
  });

  it('sendMessage refuses when the module is disabled and persists no message', async () => {
    getClinicalAiModuleMock.mockResolvedValue({ module_key: 'patient_record_chatbot', enabled: false });

    await expect(sendMessage({ req: req(), conversationId: 1, message: 'hello' }))
      .rejects.toMatchObject({ statusCode: 403, code: 'CLINICAL_AI_MODULE_DISABLED' });

    expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO patient_chat_messages/i.test(String(sql)))).toBe(false);
  });

  it('startConversation proceeds past the gate when the module is enabled', async () => {
    getClinicalAiModuleMock.mockResolvedValue({ module_key: 'patient_record_chatbot', enabled: true });
    // Answer the conversation INSERT so the happy path can complete.
    queryUnsafeMock.mockResolvedValue([{ id: 7, tenant_id: TENANT, patient_uid: PATIENT, status: 'active' }]);

    const conv = await startConversation({ tenantId: TENANT, patientUid: PATIENT });
    expect(conv).toBeDefined();
    expect(getClinicalAiModuleMock).toHaveBeenCalledWith('patient_record_chatbot', { tenantId: TENANT });
  });
});
