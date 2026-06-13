/**
 * Phase B1 — telemedicineService unit tests.
 *
 * Mocks prisma.$queryRawUnsafe to drive validation, state machine, and
 * SQL load shape across teleconsultations, video sessions, chat sessions
 * + messages, remote prescriptions, and provider configs.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
}));

const {
  closeChatSession,
  createChatSession,
  createTeleconsultation,
  createVideoSession,
  getTeleconsultation,
  listChatMessages,
  listChatSessions,
  listProviderConfigs,
  listRemotePrescriptions,
  listTeleconsultations,
  listVideoSessions,
  markChatRead,
  postChatMessage,
  recordProviderHealthCheck,
  recordRemoteConsent,
  recordRemotePrescription,
  transitionRemotePrescription,
  transitionTeleconsultation,
  transitionVideoSession,
  upsertProviderConfig,
  __testing__,
} = await import('../../services/telemedicine/telemedicineService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const DOCTOR = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

// ---------------------------------------------------------------------------
// teleconsultations
// ---------------------------------------------------------------------------

describe('createTeleconsultation', () => {
  it('rejects unknown consult_type', async () => {
    await expect(createTeleconsultation({
      tenantId: TENANT, consultType: 'fax',
    })).rejects.toThrow(/consult_type must be one of/);
  });

  it('inserts a video consult with default status=scheduled', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'scheduled', consult_type: 'video' }]);
    const row = await createTeleconsultation({
      tenantId: TENANT,
      patientUid: PATIENT,
      doctorUid: DOCTOR,
      consultType: 'video',
      chiefComplaint: 'fever 3 days',
    });
    expect(row.status).toBe('scheduled');
    expect(row.consult_type).toBe('video');
  });
});

describe('CONSULT_TRANSITIONS', () => {
  it('exports the correct transition map', () => {
    expect(__testing__.CONSULT_TRANSITIONS.scheduled).toContain('in_progress');
    expect(__testing__.CONSULT_TRANSITIONS.scheduled).toContain('cancelled');
    expect(__testing__.CONSULT_TRANSITIONS.in_progress).toContain('completed');
    expect(__testing__.CONSULT_TRANSITIONS.completed).toEqual([]);
    expect(__testing__.CONSULT_TRANSITIONS.cancelled).toEqual([]);
  });
});

describe('transitionTeleconsultation', () => {
  it('rejects illegal transition (completed -> in_progress)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'completed' }]);
    await expect(transitionTeleconsultation({
      tenantId: TENANT, id: 1, nextStatus: 'in_progress',
    })).rejects.toThrow(/transition/i);
  });

  it('flips scheduled -> in_progress and stamps actual_start', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'scheduled', actual_start: null }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'in_progress' }]);
    const row = await transitionTeleconsultation({
      tenantId: TENANT, id: 1, nextStatus: 'in_progress',
    });
    expect(row.status).toBe('in_progress');
    const sql = queryUnsafeMock.mock.calls[1][0];
    expect(sql).toMatch(/actual_start = \$\d::timestamptz/);
  });

  it('records cancellation_reason on cancel', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'scheduled' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'cancelled' }]);
    await transitionTeleconsultation({
      tenantId: TENANT, id: 1, nextStatus: 'cancelled', cancellationReason: 'patient withdrew',
    });
    const params = queryUnsafeMock.mock.calls[1].slice(1);
    expect(params).toContain('patient withdrew');
  });
});

describe('recordRemoteConsent', () => {
  it('requires consent_id', async () => {
    await expect(recordRemoteConsent({ tenantId: TENANT, id: 1 }))
      .rejects.toThrow(/consent_id is required/);
  });

  it('updates consult with consent', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, remote_consent_id: 'CONS-1' }]);
    const row = await recordRemoteConsent({
      tenantId: TENANT, id: 1, consentId: 'CONS-1',
    });
    expect(row.remote_consent_id).toBe('CONS-1');
  });
});

describe('listTeleconsultations + getTeleconsultation', () => {
  it('listTeleconsultations degrades to empty on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "teleconsultations" does not exist'));
    const result = await listTeleconsultations({ tenantId: TENANT });
    expect(result).toEqual({ teleconsultations: [], count: 0 });
  });

  it('getTeleconsultation throws 404 when missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(getTeleconsultation({ tenantId: TENANT, id: 999 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

// ---------------------------------------------------------------------------
// video_sessions
// ---------------------------------------------------------------------------

describe('createVideoSession', () => {
  it('rejects missing provider', async () => {
    await expect(createVideoSession({
      tenantId: TENANT, teleconsultationId: 1,
    })).rejects.toThrow(/provider is required/);
  });

  it('rejects unknown provider', async () => {
    await expect(createVideoSession({
      tenantId: TENANT, teleconsultationId: 1, provider: 'skype',
    })).rejects.toThrow(/provider must be one of/);
  });

  it('inserts a daily.co session', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, provider: 'daily', status: 'created' }]);
    const row = await createVideoSession({
      tenantId: TENANT, teleconsultationId: 1, provider: 'daily',
      patientJoinUrl: 'https://x.daily.co/abc',
    });
    expect(row.provider).toBe('daily');
    expect(row.status).toBe('created');
  });
});

describe('transitionVideoSession', () => {
  it('flips to active and stamps started_at', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'active' }]);
    const row = await transitionVideoSession({
      tenantId: TENANT, id: 1, status: 'active',
    });
    expect(row.status).toBe('active');
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/started_at = \$\d::timestamptz/);
  });

  it('flips to ended and stamps ended_at + duration', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'ended', duration_seconds: 600 }]);
    await transitionVideoSession({
      tenantId: TENANT, id: 1, status: 'ended', durationSeconds: 600,
      participantCount: 2,
    });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/ended_at = \$\d::timestamptz/);
    expect(sql).toMatch(/duration_seconds = \$\d/);
  });

  it('rejects packet_loss_pct out of range', async () => {
    await expect(transitionVideoSession({
      tenantId: TENANT, id: 1, status: 'ended', packetLossPct: 150,
    })).rejects.toThrow(/packet_loss_pct must be 0..100/);
  });
});

// ---------------------------------------------------------------------------
// chat_sessions + messages
// ---------------------------------------------------------------------------

describe('chat sessions', () => {
  it('createChatSession inserts an active session', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'active' }]);
    const row = await createChatSession({
      tenantId: TENANT, patientUid: PATIENT, doctorUid: DOCTOR,
      topic: 'follow-up',
    });
    expect(row.status).toBe('active');
  });

  it('postChatMessage rejects unknown role', async () => {
    await expect(postChatMessage({
      tenantId: TENANT, chatSessionId: 1, authoredRole: 'admin', body: 'hi',
    })).rejects.toThrow(/authored_role must be one of/);
  });

  it('postChatMessage rejects empty body', async () => {
    await expect(postChatMessage({
      tenantId: TENANT, chatSessionId: 1, authoredRole: 'patient', body: '   ',
    })).rejects.toThrow(/body is required/);
  });

  it('postChatMessage inserts + bumps unread counters', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 99, body: 'hi' }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const row = await postChatMessage({
      tenantId: TENANT, chatSessionId: 1, authoredRole: 'patient', body: 'hi',
    });
    expect(row.id).toBe(99);
    const updateSql = queryUnsafeMock.mock.calls[1][0];
    expect(updateSql).toMatch(/UPDATE chat_sessions/);
    expect(updateSql).toMatch(/unread_count_doctor = unread_count_doctor \+/);
  });

  it('markChatRead resets reader counter', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, unread_count_doctor: 0 }]);
    const row = await markChatRead({
      tenantId: TENANT, chatSessionId: 1, reader: 'doctor',
    });
    expect(row.unread_count_doctor).toBe(0);
    const updateSql = queryUnsafeMock.mock.calls[1][0];
    expect(updateSql).toMatch(/unread_count_doctor = 0/);
  });

  it('markChatRead rejects invalid reader', async () => {
    await expect(markChatRead({ tenantId: TENANT, chatSessionId: 1, reader: 'admin' }))
      .rejects.toThrow(/reader must be "patient" or "doctor"/);
  });

  it('closeChatSession flips status to closed', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'closed' }]);
    const row = await closeChatSession({ tenantId: TENANT, id: 1 });
    expect(row.status).toBe('closed');
  });

  it('closeChatSession throws 404 when already closed', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(closeChatSession({ tenantId: TENANT, id: 1 }))
      .rejects.toThrow(/not found or already closed/);
  });

  it('listChatMessages degrades to empty on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "chat_session_messages" does not exist'));
    const result = await listChatMessages({ tenantId: TENANT, chatSessionId: 1 });
    expect(result).toEqual({ messages: [], count: 0 });
  });

  it('listChatSessions filters by patient', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }]);
    const result = await listChatSessions({ tenantId: TENANT, patientUid: PATIENT });
    expect(result.chat_sessions).toHaveLength(1);
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/patient_uid = \$2::uuid/);
  });
});

// ---------------------------------------------------------------------------
// remote_prescriptions
// ---------------------------------------------------------------------------

describe('remote prescriptions', () => {
  it('rejects unknown signature_kind', async () => {
    await expect(recordRemotePrescription({
      tenantId: TENANT, teleconsultationId: 1, signatureKind: 'wax_seal',
    })).rejects.toThrow(/signature_kind must be one of/);
  });

  it('records an issued Rx with platform_attested signature', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'issued' }]);
    const row = await recordRemotePrescription({
      tenantId: TENANT, teleconsultationId: 1, doctorUid: DOCTOR,
      signatureKind: 'platform_attested',
    });
    expect(row.status).toBe('issued');
  });

  it('transitionRemotePrescription rejects unknown next_status', async () => {
    await expect(transitionRemotePrescription({
      tenantId: TENANT, id: 1, nextStatus: 'frozen',
    })).rejects.toThrow(/next_status must be one of/);
  });

  it('transitionRemotePrescription captures cancellation reason on recall', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'recalled' }]);
    await transitionRemotePrescription({
      tenantId: TENANT, id: 1, nextStatus: 'recalled', cancellationReason: 'wrong dose',
    });
    const params = queryUnsafeMock.mock.calls[0].slice(1);
    expect(params).toContain('wrong dose');
  });

  it('listRemotePrescriptions degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "remote_prescriptions" does not exist'));
    const result = await listRemotePrescriptions({ tenantId: TENANT });
    expect(result).toEqual({ remote_prescriptions: [], count: 0 });
  });
});

// ---------------------------------------------------------------------------
// provider_configs
// ---------------------------------------------------------------------------

describe('provider_configs', () => {
  it('upsertProviderConfig demotes other defaults when setting default=true', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // demote
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, provider: 'daily', is_default: true }]);
    const row = await upsertProviderConfig({
      tenantId: TENANT, provider: 'daily', isDefault: true,
    });
    expect(row.is_default).toBe(true);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/SET is_default = false/);
  });

  it('upsertProviderConfig rejects unknown provider', async () => {
    await expect(upsertProviderConfig({ tenantId: TENANT, provider: 'skype' }))
      .rejects.toThrow(/provider must be one of/);
  });

  it('encrypts provider secrets before storing them', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, provider: 'daily', is_default: false }]);
    await upsertProviderConfig({
      tenantId: TENANT,
      provider: 'daily',
      apiKeyCiphertext: 'daily-api-key',
      apiSecretCiphertext: 'daily-api-secret',
      webhookSecretCiphertext: 'daily-webhook-secret',
    });
    const params = queryUnsafeMock.mock.calls[0].slice(1);
    expect(params).not.toContain('daily-api-key');
    expect(params).not.toContain('daily-api-secret');
    expect(params).not.toContain('daily-webhook-secret');
    // All three secrets encrypted via the field-encryption envelope (enc:v2: now).
    expect(params.filter((p) => typeof p === 'string' && /^enc:v\d+:/.test(p))).toHaveLength(3);
  });

  it('listProviderConfigs degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "teleconsult_provider_configs" does not exist'));
    const result = await listProviderConfigs({ tenantId: TENANT });
    expect(result).toEqual({ configs: [], count: 0 });
  });

  it('recordProviderHealthCheck rejects unknown health_status', async () => {
    await expect(recordProviderHealthCheck({
      tenantId: TENANT, provider: 'daily', healthStatus: 'limbo',
    })).rejects.toThrow(/health_status must be one of/);
  });

  it('recordProviderHealthCheck stamps last_health_status', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, last_health_status: 'ok' }]);
    const row = await recordProviderHealthCheck({
      tenantId: TENANT, provider: 'daily', healthStatus: 'ok',
    });
    expect(row.last_health_status).toBe('ok');
  });
});

describe('listVideoSessions', () => {
  it('filters by teleconsultation_id', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }]);
    await listVideoSessions({ tenantId: TENANT, teleconsultationId: 5 });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/teleconsultation_id = \$2/);
  });
});
