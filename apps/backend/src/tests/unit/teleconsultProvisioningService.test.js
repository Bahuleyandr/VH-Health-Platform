import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

const queryUnsafeMock = jest.fn();

const prismaMock = { $queryRawUnsafe: queryUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(prismaMock),
  pickTenantClient: () => prismaMock,
}));

const {
  ensureTeleconsultationForAppointment,
  ensureVideoSession,
  getPatientTeleconsultLobbyStateForAppointment,
  getTeleconsultRoomState,
  issueJoinToken,
  recordTeleconsultConsent,
  __testing__,
} = await import('../../services/telemedicine/teleconsultProvisioningService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '00000000-0000-4000-8000-000000000002';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const OTHER_PATIENT = '11111111-1111-4111-8111-111111111112';
const DOCTOR = '22222222-2222-4222-8222-222222222222';
const OTHER_CLINICIAN = '33333333-3333-4333-8333-333333333333';
const APPOINTMENT_ID = 777;
const API_KEY = 'lk-api-key';
const API_SECRET = '01234567890123456789012345678901';

let db;
let originalEnv;

function baseAppointment(overrides = {}) {
  return {
    id: APPOINTMENT_ID,
    tenant_id: TENANT,
    patient_id: 10,
    doctor_id: 20,
    appointment_date: '2026-07-06',
    appointment_time: '10:20',
    status: 'SCHEDULED',
    reason: 'Synthetic video consult',
    department: 'General Medicine',
    visit_type: 'TELE',
    patient_uid: PATIENT,
    doctor_uid: DOCTOR,
    scheduled_start: '2026-07-06T04:50:00.000Z',
    ...overrides,
  };
}

function resetDb(overrides = {}) {
  db = {
    appointment: baseAppointment(overrides.appointment),
    teleconsultations: overrides.teleconsultations || [],
    videoSessions: overrides.videoSessions || [],
    patientConsents: [],
    careTeamMembers: new Set(overrides.careTeamMembers || []),
    nextTeleconsultationId: 1000,
    nextVideoSessionId: 2000,
    nextConsentId: 3000,
  };
}

function consultRow(overrides = {}) {
  const appointment = db.appointment;
  return {
    id: db.nextTeleconsultationId,
    tenant_id: appointment.tenant_id,
    appointment_id: appointment.id,
    patient_uid: appointment.patient_uid,
    doctor_uid: appointment.doctor_uid,
    consult_type: 'video',
    status: 'scheduled',
    scheduled_start: appointment.scheduled_start,
    scheduled_end: null,
    actual_start: null,
    actual_end: null,
    chief_complaint: appointment.reason,
    pre_consult_form: {},
    remote_consent_id: null,
    remote_consent_signed_at: null,
    ai_note_generation_id: null,
    ai_pre_visit_summary_id: null,
    recording_url: null,
    recording_consent: false,
    cancellation_reason: null,
    metadata: {},
    created_by: null,
    created_at: '2026-07-06T04:30:00.000Z',
    updated_at: '2026-07-06T04:30:00.000Z',
    ...overrides,
  };
}

function sessionRow(overrides = {}) {
  return {
    id: db.nextVideoSessionId,
    tenant_id: TENANT,
    teleconsultation_id: db.teleconsultations[0]?.id || 1000,
    provider: 'livekit',
    external_session_id: 'tc_existing_room',
    patient_join_url: null,
    doctor_join_url: null,
    host_token: null,
    started_at: null,
    ended_at: null,
    duration_seconds: null,
    participant_count: null,
    bandwidth_kbps_avg: null,
    packet_loss_pct: null,
    recording_id: null,
    recording_status: 'disabled',
    status: 'created',
    metadata: {},
    created_at: '2026-07-06T04:31:00.000Z',
    updated_at: '2026-07-06T04:31:00.000Z',
    ...overrides,
  };
}

function setupEnv() {
  process.env.LIVEKIT_ENABLED = 'true';
  process.env.LIVEKIT_SERVER_URL = 'https://teleconsult.vhhealth.app';
  process.env.LIVEKIT_API_KEY = API_KEY;
  process.env.LIVEKIT_API_SECRET = API_SECRET;
  process.env.TELECONSULT_TOKEN_TTL_SECONDS = '300';
}

function getConsult(id, tenantId = TENANT) {
  return db.teleconsultations.find((row) => row.id === Number(id) && row.tenant_id === tenantId) || null;
}

function handleQuery(sql, params) {
  const text = String(sql).replace(/\s+/g, ' ');

  if (text.includes('FROM appointments a') && text.includes('WHERE a.id = $1::int')) {
    const [appointmentId, tenantId] = params;
    if (Number(appointmentId) !== db.appointment.id || tenantId !== db.appointment.tenant_id) return [];
    return [db.appointment];
  }

  if (text.includes('FROM teleconsultations') && text.includes('appointment_id = $2::int')) {
    const [tenantId, appointmentId] = params;
    return db.teleconsultations
      .filter((row) => row.tenant_id === tenantId && row.appointment_id === Number(appointmentId))
      .slice(0, 1);
  }

  if (text.includes('INSERT INTO teleconsultations')) {
    const [tenantId, appointmentId, patientUid, doctorUid, consultType, scheduledStart, scheduledEnd, chiefComplaint, preConsultForm, remoteConsentId, recordingConsent, metadata, createdBy] = params;
    const row = consultRow({
      id: db.nextTeleconsultationId++,
      tenant_id: tenantId,
      appointment_id: Number(appointmentId),
      patient_uid: patientUid,
      doctor_uid: doctorUid,
      consult_type: consultType,
      scheduled_start: scheduledStart,
      scheduled_end: scheduledEnd,
      chief_complaint: chiefComplaint,
      pre_consult_form: JSON.parse(preConsultForm),
      remote_consent_id: remoteConsentId,
      recording_consent: recordingConsent,
      metadata: JSON.parse(metadata),
      created_by: createdBy,
    });
    db.teleconsultations.push(row);
    return [row];
  }

  if (text.includes('FROM teleconsultations') && text.includes('WHERE id = $1 AND tenant_id = $2::uuid')) {
    const [consultId, tenantId] = params;
    const row = getConsult(consultId, tenantId);
    return row ? [row] : [];
  }

  if (text.includes('FROM video_sessions')) {
    const [tenantId, teleconsultationId] = params;
    return db.videoSessions.filter((row) =>
      row.tenant_id === tenantId && row.teleconsultation_id === Number(teleconsultationId),
    );
  }

  if (text.includes('INSERT INTO video_sessions')) {
    const [tenantId, teleconsultationId, provider, externalSessionId, patientJoinUrl, doctorJoinUrl, hostToken, recordingStatus, metadata] = params;
    const row = sessionRow({
      id: db.nextVideoSessionId++,
      tenant_id: tenantId,
      teleconsultation_id: Number(teleconsultationId),
      provider,
      external_session_id: externalSessionId,
      patient_join_url: patientJoinUrl,
      doctor_join_url: doctorJoinUrl,
      host_token: hostToken,
      recording_status: recordingStatus,
      metadata: JSON.parse(metadata),
    });
    db.videoSessions.push(row);
    return [row];
  }

  if (text.includes('INSERT INTO patient_consents')) {
    const [tenantId, patientUid, grantedBy, ipAddress, notes, purpose, dataCategories, consentMethod] = params;
    const row = {
      id: db.nextConsentId++,
      tenant_id: tenantId,
      patient_uid: patientUid,
      granted_by: grantedBy,
      ip_address: ipAddress,
      notes,
      purpose,
      data_categories: JSON.parse(dataCategories),
      consent_method: consentMethod,
      consent_type: 'telehealth',
      granted_at: '2026-07-06T04:45:00.000Z',
    };
    db.patientConsents.push(row);
    return [row];
  }

  if (text.includes('UPDATE teleconsultations') && text.includes('remote_consent_id = $1')) {
    const [consentId, signedAt, consultId, tenantId] = params;
    const row = getConsult(consultId, tenantId);
    if (!row) return [];
    row.remote_consent_id = consentId;
    row.remote_consent_signed_at = signedAt || '2026-07-06T04:45:00.000Z';
    return [row];
  }

  if (text.includes('FROM care_team_members')) {
    const [_tenantId, patientUid, staffUid] = params;
    return patientUid === PATIENT && db.careTeamMembers.has(staffUid) ? [{ '?column?': 1 }] : [];
  }

  throw new Error(`Unhandled SQL in teleconsultProvisioningService.test: ${text}`);
}

function decodeAndVerify(tokenResult, role, uid, roomName = tokenResult.room_name) {
  const decoded = jwt.verify(tokenResult.participant_token, API_SECRET, {
    algorithms: ['HS256'],
    issuer: API_KEY,
    subject: `${role}:${uid}`,
  });
  const grant = decoded.video;
  const metadata = JSON.parse(decoded.metadata);
  expect(decoded.exp - decoded.iat).toBe(300);
  expect(grant.room).toBe(roomName);
  expect(grant.roomRecord).toBeUndefined();
  expect(grant.room_record).toBeUndefined();
  expect(grant.egress).toBeUndefined();
  expect(Object.keys(metadata).sort()).toEqual(['appointment_id', 'role', 'teleconsultation_id', 'tenant_id']);
  expect(metadata).toEqual({
    tenant_id: TENANT,
    teleconsultation_id: db.teleconsultations[0].id,
    appointment_id: APPOINTMENT_ID,
    role,
  });
  return { decoded, grant, metadata };
}

beforeAll(() => {
  originalEnv = { ...process.env };
});

beforeEach(() => {
  resetDb();
  setupEnv();
  queryUnsafeMock.mockReset();
  queryUnsafeMock.mockImplementation((sql, ...params) => Promise.resolve(handleQuery(sql, params)));
});

afterAll(() => {
  process.env = originalEnv;
});

describe('teleconsult provisioning service', () => {
  test('feature flag gates all P1 state-changing and room-state entrypoints', async () => {
    process.env.LIVEKIT_ENABLED = 'false';

    await expect(ensureTeleconsultationForAppointment({
      tenantId: TENANT,
      appointmentId: APPOINTMENT_ID,
      actorUid: DOCTOR,
      role: 'DOCTOR',
    })).rejects.toMatchObject({ code: 'LIVEKIT_DISABLED' });

    db.teleconsultations.push(consultRow({ id: 1000 }));
    await expect(recordTeleconsultConsent({
      tenantId: TENANT,
      teleconsultationId: 1000,
      participantUid: PATIENT,
    })).rejects.toMatchObject({ code: 'LIVEKIT_DISABLED' });

    await expect(getTeleconsultRoomState({
      tenantId: TENANT,
      teleconsultationId: 1000,
    })).rejects.toMatchObject({ code: 'LIVEKIT_DISABLED' });
  });

  test('requires ordinary visit_type TELE appointments and is patient self-scoped', async () => {
    resetDb({ appointment: { visit_type: 'IN_PERSON' } });
    await expect(ensureTeleconsultationForAppointment({
      tenantId: TENANT,
      appointmentId: APPOINTMENT_ID,
      actorUid: DOCTOR,
      role: 'DOCTOR',
    })).rejects.toThrow(/not a teleconsult appointment/i);

    resetDb();
    await expect(ensureTeleconsultationForAppointment({
      tenantId: TENANT,
      appointmentId: APPOINTMENT_ID,
      actorUid: OTHER_PATIENT,
      role: 'PATIENT',
    })).rejects.toMatchObject({ code: 'TELECONSULT_PATIENT_SCOPE_DENIED' });
  });

  test('creates at most one teleconsultation and one LiveKit video session per appointment', async () => {
    const first = await ensureTeleconsultationForAppointment({
      tenantId: TENANT,
      appointmentId: APPOINTMENT_ID,
      actorUid: DOCTOR,
      role: 'DOCTOR',
    });
    const second = await ensureTeleconsultationForAppointment({
      tenantId: TENANT,
      appointmentId: APPOINTMENT_ID,
      actorUid: DOCTOR,
      role: 'DOCTOR',
    });

    expect(second.id).toBe(first.id);
    expect(db.teleconsultations).toHaveLength(1);
    expect(first.metadata).toMatchObject({
      source: 'nl3_p1_teleconsult_provisioning',
      visit_type: 'TELE',
      queue_model: 'doctor_department_badge',
    });

    const session1 = await ensureVideoSession({ tenantId: TENANT, teleconsultationId: first.id });
    const session2 = await ensureVideoSession({ tenantId: TENANT, teleconsultationId: first.id });
    expect(session2.id).toBe(session1.id);
    expect(db.videoSessions).toHaveLength(1);
    expect(session1.provider).toBe('livekit');
    expect(session1.recording_status).toBe('disabled');
    expect(session1.external_session_id).toMatch(/^tc_[0-9a-f]{10}_1000_/);
    expect(session1.external_session_id).not.toContain(PATIENT);
    expect(session1.external_session_id).not.toContain(DOCTOR);
  });

  test('patient lobby state degrades honestly when LiveKit is disabled', async () => {
    process.env.LIVEKIT_ENABLED = 'false';

    const state = await getPatientTeleconsultLobbyStateForAppointment({
      tenantId: TENANT,
      appointmentId: APPOINTMENT_ID,
      actorUid: PATIENT,
    });

    expect(state).toMatchObject({
      livekit_enabled: false,
      provider: 'livekit',
      recording_enabled: false,
      media_boundary: 'hospital_infra_only',
      appointment_id: APPOINTMENT_ID,
      teleconsultation_id: null,
      join_state: 'unavailable',
      joinable: false,
      consent_recorded: false,
      video_session: null,
      message: 'Teleconsultation is not available yet',
    });
    expect(db.teleconsultations).toHaveLength(0);

    await expect(getPatientTeleconsultLobbyStateForAppointment({
      tenantId: TENANT,
      appointmentId: APPOINTMENT_ID,
      actorUid: OTHER_PATIENT,
    })).rejects.toMatchObject({ code: 'TELECONSULT_PATIENT_SCOPE_DENIED' });
  });

  test('room state exposes the patient join-state contract', async () => {
    const consult = await ensureTeleconsultationForAppointment({
      tenantId: TENANT,
      appointmentId: APPOINTMENT_ID,
      actorUid: DOCTOR,
      role: 'DOCTOR',
    });

    db.teleconsultations[0].status = 'waiting';
    await expect(getTeleconsultRoomState({
      tenantId: TENANT,
      teleconsultationId: consult.id,
    })).resolves.toMatchObject({ join_state: 'lobby-open', joinable: true });

    db.teleconsultations[0].status = 'in_progress';
    await expect(getTeleconsultRoomState({
      tenantId: TENANT,
      teleconsultationId: consult.id,
    })).resolves.toMatchObject({ join_state: 'in-progress', joinable: true });

    db.teleconsultations[0].status = 'scheduled';
    db.teleconsultations[0].scheduled_start = '2099-07-06T04:50:00.000Z';
    await expect(getTeleconsultRoomState({
      tenantId: TENANT,
      teleconsultationId: consult.id,
    })).resolves.toMatchObject({ join_state: 'not-yet', joinable: false });

    db.teleconsultations[0].scheduled_start = '2000-07-06T04:50:00.000Z';
    await expect(getTeleconsultRoomState({
      tenantId: TENANT,
      teleconsultationId: consult.id,
    })).resolves.toMatchObject({ join_state: 'ended', joinable: false });

    db.teleconsultations[0].status = 'cancelled';
    await expect(getTeleconsultRoomState({
      tenantId: TENANT,
      teleconsultationId: consult.id,
    })).resolves.toMatchObject({ join_state: 'cancelled', joinable: false });
  });

  test('blocks token issuance until consent is recorded, then mints PHI-minimized no-recording grants', async () => {
    const consult = await ensureTeleconsultationForAppointment({
      tenantId: TENANT,
      appointmentId: APPOINTMENT_ID,
      actorUid: DOCTOR,
      role: 'DOCTOR',
    });
    await expect(issueJoinToken({
      tenantId: TENANT,
      teleconsultationId: consult.id,
      participantUid: PATIENT,
      role: 'patient',
    })).rejects.toMatchObject({ code: 'TELECONSULT_CONSENT_REQUIRED' });

    await recordTeleconsultConsent({
      tenantId: TENANT,
      teleconsultationId: consult.id,
      participantUid: PATIENT,
      actorUid: PATIENT,
      actorRole: 'PATIENT',
      consentPayload: { statement: 'I consent', consent_method: 'signature' },
    });

    const patientToken = await issueJoinToken({
      tenantId: TENANT,
      teleconsultationId: consult.id,
      participantUid: PATIENT,
      role: 'patient',
    });
    const clinicianToken = await issueJoinToken({
      tenantId: TENANT,
      teleconsultationId: consult.id,
      participantUid: DOCTOR,
      role: 'clinician',
    });

    expect(patientToken.server_url).toBe('https://teleconsult.vhhealth.app');
    expect(clinicianToken.room_name).toBe(patientToken.room_name);

    const patient = decodeAndVerify(patientToken, 'patient', PATIENT);
    expect(patient.grant.canPublish).toBe(true);
    expect(patient.grant.canPublishSources).toEqual(['camera', 'microphone']);
    expect(patient.grant.roomAdmin).toBeUndefined();

    const clinician = decodeAndVerify(clinicianToken, 'clinician', DOCTOR, patientToken.room_name);
    expect(clinician.grant.canPublish).toBe(true);
    expect(clinician.grant.canPublishSources).toEqual(['camera', 'microphone', 'screen_share']);
    expect(clinician.grant.roomAdmin).toBe(true);
  });

  test('enforces patient, clinician, observer, care-team, cross-tenant, and terminal-state authorization', async () => {
    const consult = await ensureTeleconsultationForAppointment({
      tenantId: TENANT,
      appointmentId: APPOINTMENT_ID,
      actorUid: DOCTOR,
      role: 'DOCTOR',
    });
    await recordTeleconsultConsent({
      tenantId: TENANT,
      teleconsultationId: consult.id,
      participantUid: PATIENT,
      actorUid: PATIENT,
      actorRole: 'PATIENT',
    });

    await expect(issueJoinToken({
      tenantId: TENANT,
      teleconsultationId: consult.id,
      participantUid: OTHER_PATIENT,
      role: 'patient',
    })).rejects.toMatchObject({ code: 'TELECONSULT_PATIENT_SCOPE_DENIED' });

    await expect(issueJoinToken({
      tenantId: TENANT,
      teleconsultationId: consult.id,
      participantUid: OTHER_CLINICIAN,
      role: 'clinician',
    })).rejects.toMatchObject({ code: 'TELECONSULT_CLINICIAN_SCOPE_DENIED' });

    await expect(issueJoinToken({
      tenantId: OTHER_TENANT,
      teleconsultationId: consult.id,
      participantUid: DOCTOR,
      role: 'clinician',
    })).rejects.toMatchObject({ statusCode: 404 });

    db.careTeamMembers.add(OTHER_CLINICIAN);
    const observerToken = await issueJoinToken({
      tenantId: TENANT,
      teleconsultationId: consult.id,
      participantUid: OTHER_CLINICIAN,
      role: 'observer',
    });
    const observer = decodeAndVerify(observerToken, 'observer', OTHER_CLINICIAN);
    expect(observer.grant.canPublish).toBe(false);
    expect(observer.grant.canPublishData).toBe(false);

    db.teleconsultations[0].status = 'completed';
    await expect(issueJoinToken({
      tenantId: TENANT,
      teleconsultationId: consult.id,
      participantUid: DOCTOR,
      role: 'clinician',
    })).rejects.toMatchObject({ code: 'TELECONSULT_STATUS_NOT_JOINABLE' });

    db.teleconsultations[0].status = 'scheduled';
    db.appointment.status = 'CANCELLED';
    await expect(issueJoinToken({
      tenantId: TENANT,
      teleconsultationId: consult.id,
      participantUid: DOCTOR,
      role: 'clinician',
    })).rejects.toMatchObject({ code: 'TELECONSULT_APPOINTMENT_TERMINAL' });
  });

  test('pure token helpers never emit recording grants', () => {
    expect(__testing__.buildLivekitVideoGrant({ role: 'patient', roomName: 'room-a' }))
      .not.toHaveProperty('roomRecord');
    expect(__testing__.buildLivekitVideoGrant({ role: 'clinician', roomName: 'room-a' }))
      .not.toHaveProperty('roomRecord');
    expect(__testing__.buildLivekitVideoGrant({ role: 'observer', roomName: 'room-a' }))
      .toMatchObject({ canPublish: false, canPublishData: false });
  });
});
