import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const getClinicalAiModuleMock = jest.fn();
const transcribeMock = jest.fn();
const publishEventMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
}));

jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => ({
  getClinicalAiModule: getClinicalAiModuleMock,
}));

jest.unstable_mockModule('../../services/ai/localLlmClient.js', () => ({
  generateClinicalText: jest.fn(),
}));

jest.unstable_mockModule('../../services/ai/sttService.js', () => ({
  describeSttConfig: () => ({ provider: 'mock', configured: true }),
  transcribe: transcribeMock,
}));

jest.unstable_mockModule('../../services/events/eventOutboxService.js', () => ({
  publishEvent: publishEventMock,
}));

const {
  createAndTranscribeVoiceNote,
  getVoiceCapturePolicy,
} = await import('../../services/ai/voiceSoapService.js');

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const DOCTOR_UID = '22222222-2222-4222-8222-222222222222';

function req(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    tenant: { region: 'IN' },
    user: { uid: DOCTOR_UID, role: 'DOCTOR' },
    ...overrides,
  };
}

function moduleRow(overrides = {}) {
  return {
    module_key: 'soap_from_dictation',
    enabled: true,
    settings: {
      requiresClinicianSignoff: true,
      retentionDays: 365,
      approvalPolicy: 'clinician_signoff',
      reviewRoles: ['DOCTOR', 'NURSING_STAFF'],
    },
    ...overrides,
  };
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  getClinicalAiModuleMock.mockReset();
  transcribeMock.mockReset();
  publishEventMock.mockReset();
});

describe('voiceSoapService voice capture governance', () => {
  it('describes disabled capture when SOAP from Dictation is not enabled for the tenant', async () => {
    getClinicalAiModuleMock.mockResolvedValue(moduleRow({ enabled: false }));

    const policy = await getVoiceCapturePolicy({ req: req() });

    expect(getClinicalAiModuleMock).toHaveBeenCalledWith(
      'soap_from_dictation',
      { tenantId: TENANT_ID, refresh: false },
    );
    expect(policy).toEqual(expect.objectContaining({
      module_key: 'soap_from_dictation',
      tenant_id: TENANT_ID,
      module_enabled: false,
      audio_capture_allowed: false,
      blocking_reason: 'VOICE_MODULE_DISABLED',
      decision_support_only: true,
      human_review_required: true,
      patient_dispatch_allowed: false,
      consent_policy_required: true,
    }));
  });

  it('blocks raw transcription before STT or persistence when capture is disabled', async () => {
    getClinicalAiModuleMock.mockResolvedValue(moduleRow({ enabled: false }));

    await expect(createAndTranscribeVoiceNote({
      req: req(),
      audioBuffer: Buffer.from('RIFFmockWAVEfmt fakeaudio', 'ascii'),
      mimeType: 'audio/wav',
      patientUid: '33333333-3333-4333-8333-333333333333',
      admissionId: 123,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'CLINICAL_AI_VOICE_CAPTURE_DISABLED',
    });

    expect(transcribeMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it('persists capture-policy metadata when transcription is allowed', async () => {
    getClinicalAiModuleMock.mockResolvedValue(moduleRow());
    transcribeMock.mockResolvedValue({
      status: 'completed',
      provider: 'mock',
      model: 'mock-stt',
      language: 'en-IN',
      text: 'mock transcript',
      reason: null,
    });
    queryRawUnsafeMock.mockResolvedValue([{
      id: 44,
      tenant_id: TENANT_ID,
      recorded_by: DOCTOR_UID,
      transcript_status: 'completed',
      stt_provider: 'mock',
      transcript: 'mock transcript',
    }]);

    const saved = await createAndTranscribeVoiceNote({
      req: req(),
      audioBuffer: Buffer.from('RIFFmockWAVEfmt fakeaudio', 'ascii'),
      mimeType: 'audio/wav',
      patientUid: '33333333-3333-4333-8333-333333333333',
      admissionId: 123,
      language: 'en-IN',
    });

    expect(saved.id).toBe(44);
    expect(transcribeMock).toHaveBeenCalledWith(expect.objectContaining({
      mimeType: 'audio/wav',
      language: 'en-IN',
      tenantRegion: 'IN',
    }));
    const metadata = JSON.parse(queryRawUnsafeMock.mock.calls[0].at(-1));
    expect(metadata.capture_policy).toEqual(expect.objectContaining({
      module_key: 'soap_from_dictation',
      tenant_id: TENANT_ID,
      audio_capture_allowed: true,
      consent_policy_required: true,
    }));
    expect(publishEventMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'clinical_voice_note.created',
      patientUid: '33333333-3333-4333-8333-333333333333',
    }));
  });
});
