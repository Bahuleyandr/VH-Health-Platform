/**
 * Admin routes for telemedicine (Phase B1).
 *
 * Mounted at /api/v1/admin/telemedicine via routes/admin/index.js.
 *
 *   POST   /telemedicine/teleconsultations              — create consult
 *   GET    /telemedicine/teleconsultations              — list consults
 *   GET    /telemedicine/teleconsultations/:id          — fetch one
 *   PATCH  /telemedicine/teleconsultations/:id/transition  — status flip
 *   POST   /telemedicine/teleconsultations/:id/consent  — record remote consent
 *
 *   POST   /telemedicine/video-sessions                 — create video session
 *   GET    /telemedicine/video-sessions                 — list
 *   PATCH  /telemedicine/video-sessions/:id/transition  — start/end/cancel
 *
 *   POST   /telemedicine/chat-sessions                  — create chat session
 *   GET    /telemedicine/chat-sessions                  — list
 *   PATCH  /telemedicine/chat-sessions/:id/close        — close
 *   POST   /telemedicine/chat-sessions/:id/messages     — post message
 *   GET    /telemedicine/chat-sessions/:id/messages     — list messages
 *   POST   /telemedicine/chat-sessions/:id/read         — mark read
 *
 *   POST   /telemedicine/remote-prescriptions           — record Rx
 *   GET    /telemedicine/remote-prescriptions           — list
 *   PATCH  /telemedicine/remote-prescriptions/:id/transition  — status flip
 *
 *   PUT    /telemedicine/provider-configs               — upsert provider config
 *   GET    /telemedicine/provider-configs               — list
 *   POST   /telemedicine/provider-configs/:provider/health-check  — record health
 */

import express from 'express';

import { error, success } from '../../utils/responseHelper.js';
import {
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
} from '../../services/telemedicine/telemedicineService.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// teleconsultations
// ---------------------------------------------------------------------------

router.post('/teleconsultations', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await createTeleconsultation({
      tenantId: req.tenantId,
      appointmentId: body.appointment_id,
      patientUid: body.patient_uid,
      doctorUid: body.doctor_uid,
      consultType: body.consult_type,
      scheduledStart: body.scheduled_start,
      scheduledEnd: body.scheduled_end,
      chiefComplaint: body.chief_complaint,
      preConsultForm: body.pre_consult_form,
      remoteConsentId: body.remote_consent_id,
      recordingConsent: body.recording_consent,
      metadata: body.metadata,
      createdBy: req.user?.uid || null,
    });
    return success(res, row, 'Teleconsultation created', 201);
  } catch (err) { return next(err); }
});

router.get('/teleconsultations', async (req, res, next) => {
  try {
    const result = await listTeleconsultations({
      tenantId: req.tenantId,
      status: req.query.status || null,
      patientUid: req.query.patient_uid || null,
      doctorUid: req.query.doctor_uid || null,
      windowStart: req.query.window_start || null,
      windowEnd: req.query.window_end || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Teleconsultations retrieved');
  } catch (err) { return next(err); }
});

router.get('/teleconsultations/:id', async (req, res, next) => {
  try {
    const row = await getTeleconsultation({ tenantId: req.tenantId, id: req.params.id });
    return success(res, row, 'Teleconsultation retrieved');
  } catch (err) { return next(err); }
});

router.patch('/teleconsultations/:id/transition', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await transitionTeleconsultation({
      tenantId: req.tenantId,
      id: req.params.id,
      nextStatus: body.next_status,
      cancellationReason: body.cancellation_reason,
      recordingUrl: body.recording_url,
    });
    return success(res, row, 'Teleconsultation transitioned');
  } catch (err) { return next(err); }
});

router.post('/teleconsultations/:id/consent', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.consent_id) return error(res, 'consent_id is required', 400);
    const row = await recordRemoteConsent({
      tenantId: req.tenantId,
      id: req.params.id,
      consentId: body.consent_id,
      signedAt: body.signed_at,
    });
    return success(res, row, 'Remote consent recorded');
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// video_sessions
// ---------------------------------------------------------------------------

router.post('/video-sessions', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await createVideoSession({
      tenantId: req.tenantId,
      teleconsultationId: body.teleconsultation_id,
      provider: body.provider,
      externalSessionId: body.external_session_id,
      patientJoinUrl: body.patient_join_url,
      doctorJoinUrl: body.doctor_join_url,
      hostToken: body.host_token,
      recordingStatus: body.recording_status,
      metadata: body.metadata,
    });
    return success(res, row, 'Video session created', 201);
  } catch (err) { return next(err); }
});

router.get('/video-sessions', async (req, res, next) => {
  try {
    const result = await listVideoSessions({
      tenantId: req.tenantId,
      teleconsultationId: req.query.teleconsultation_id || null,
      status: req.query.status || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Video sessions retrieved');
  } catch (err) { return next(err); }
});

router.patch('/video-sessions/:id/transition', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await transitionVideoSession({
      tenantId: req.tenantId,
      id: req.params.id,
      status: body.status,
      durationSeconds: body.duration_seconds,
      participantCount: body.participant_count,
      bandwidthKbpsAvg: body.bandwidth_kbps_avg,
      packetLossPct: body.packet_loss_pct,
      recordingId: body.recording_id,
      recordingStatus: body.recording_status,
    });
    return success(res, row, 'Video session transitioned');
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// chat_sessions / chat_session_messages
// ---------------------------------------------------------------------------

router.post('/chat-sessions', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await createChatSession({
      tenantId: req.tenantId,
      teleconsultationId: body.teleconsultation_id,
      patientUid: body.patient_uid,
      doctorUid: body.doctor_uid,
      topic: body.topic,
      metadata: body.metadata,
    });
    return success(res, row, 'Chat session created', 201);
  } catch (err) { return next(err); }
});

router.get('/chat-sessions', async (req, res, next) => {
  try {
    const result = await listChatSessions({
      tenantId: req.tenantId,
      patientUid: req.query.patient_uid || null,
      doctorUid: req.query.doctor_uid || null,
      status: req.query.status || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Chat sessions retrieved');
  } catch (err) { return next(err); }
});

router.patch('/chat-sessions/:id/close', async (req, res, next) => {
  try {
    const row = await closeChatSession({ tenantId: req.tenantId, id: req.params.id });
    return success(res, row, 'Chat session closed');
  } catch (err) { return next(err); }
});

router.post('/chat-sessions/:id/messages', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await postChatMessage({
      tenantId: req.tenantId,
      chatSessionId: req.params.id,
      authoredByUid: body.authored_by_uid || req.user?.uid || null,
      authoredRole: body.authored_role,
      body: body.body,
      bodyKind: body.body_kind,
      attachments: body.attachments,
      metadata: body.metadata,
    });
    return success(res, row, 'Chat message posted', 201);
  } catch (err) { return next(err); }
});

router.get('/chat-sessions/:id/messages', async (req, res, next) => {
  try {
    const result = await listChatMessages({
      tenantId: req.tenantId,
      chatSessionId: req.params.id,
      limit: req.query.limit,
    });
    return success(res, result, 'Chat messages retrieved');
  } catch (err) { return next(err); }
});

router.post('/chat-sessions/:id/read', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await markChatRead({
      tenantId: req.tenantId,
      chatSessionId: req.params.id,
      reader: body.reader,
    });
    return success(res, row, 'Chat session marked read');
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// remote_prescriptions
// ---------------------------------------------------------------------------

router.post('/remote-prescriptions', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await recordRemotePrescription({
      tenantId: req.tenantId,
      teleconsultationId: body.teleconsultation_id,
      prescriptionId: body.prescription_id,
      patientUid: body.patient_uid,
      doctorUid: body.doctor_uid || req.user?.uid || null,
      signatureKind: body.signature_kind,
      signaturePayload: body.signature_payload,
      pdfUrl: body.pdf_url,
      metadata: body.metadata,
    });
    return success(res, row, 'Remote prescription recorded', 201);
  } catch (err) { return next(err); }
});

router.get('/remote-prescriptions', async (req, res, next) => {
  try {
    const result = await listRemotePrescriptions({
      tenantId: req.tenantId,
      teleconsultationId: req.query.teleconsultation_id || null,
      patientUid: req.query.patient_uid || null,
      status: req.query.status || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Remote prescriptions retrieved');
  } catch (err) { return next(err); }
});

router.patch('/remote-prescriptions/:id/transition', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await transitionRemotePrescription({
      tenantId: req.tenantId,
      id: req.params.id,
      nextStatus: body.next_status,
      cancellationReason: body.cancellation_reason,
    });
    return success(res, row, 'Remote prescription transitioned');
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// provider configs
// ---------------------------------------------------------------------------

router.put('/provider-configs', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await upsertProviderConfig({
      tenantId: req.tenantId,
      provider: body.provider,
      isDefault: body.is_default,
      displayName: body.display_name,
      apiKeyCiphertext: body.api_key_ciphertext,
      apiSecretCiphertext: body.api_secret_ciphertext,
      webhookSecretCiphertext: body.webhook_secret_ciphertext,
      endpointBase: body.endpoint_base,
      config: body.config,
      status: body.status,
      metadata: body.metadata,
      createdBy: req.user?.uid || null,
    });
    return success(res, row, 'Provider config saved');
  } catch (err) { return next(err); }
});

router.get('/provider-configs', async (req, res, next) => {
  try {
    const result = await listProviderConfigs({ tenantId: req.tenantId });
    return success(res, result, 'Provider configs retrieved');
  } catch (err) { return next(err); }
});

router.post('/provider-configs/:provider/health-check', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await recordProviderHealthCheck({
      tenantId: req.tenantId,
      provider: req.params.provider,
      healthStatus: body.health_status,
    });
    return success(res, row, 'Provider health recorded');
  } catch (err) { return next(err); }
});

export default router;
