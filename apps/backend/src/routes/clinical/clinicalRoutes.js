// src/routes/clinical/clinicalRoutes.js
import express from 'express';
import multer from 'multer';
import { validationResult } from 'express-validator';
import * as handoverService from '../../services/clinical/handoverService.js';
import * as marService from '../../services/clinical/marService.js';
import * as marFiveRightsService from '../../services/clinical/marFiveRightsService.js';
import * as news2Service from '../../services/clinical/news2Service.js';
import * as voiceSoapService from '../../services/ai/voiceSoapService.js';
import { describeSttConfig } from '../../services/ai/sttService.js';
import { reviewPolypharmacy } from '../../services/ai/polypharmacyAiService.js';
import { scoreDeterioration } from '../../services/ai/deteriorationEarlyWarningService.js';
import { createAmbientEncounter, listAmbientEncounters } from '../../services/ai/ambientDocumentationService.js';
import { success, error } from '../../utils/responseHelper.js';
import {
  requiredUUID, requiredString, requiredNumber, optionalString, paramId,
} from '../../validators/sharedValidators.js';

// Dedicated audio uploader — memory-backed, 20MB cap, audio-mime allowlist.
// Kept separate from the hospital-wide file uploader so voice-note-specific
// limits don't leak into the patient/radiology/pharmacy upload paths.
const AUDIO_MIMES = new Set([
  'audio/wav', 'audio/wave', 'audio/x-wav',
  'audio/mpeg', 'audio/mp4', 'audio/m4a', 'audio/x-m4a',
  'audio/ogg', 'audio/webm', 'audio/aac',
]);
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const type = String(file.mimetype || '').toLowerCase();
    if (!AUDIO_MIMES.has(type)) {
      return cb(new Error(`Unsupported audio type: ${type}`));
    }
    cb(null, true);
  },
});

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

// ===================================================================
// NEWS2 Scoring Routes
// ===================================================================

/**
 * POST /clinical/news2/record
 * Record a NEWS2 assessment for a patient.
 */
router.post('/news2/record', requiredUUID('patient_uid'), validate, async (req, res, next) => {
  try {
    const { patient_uid, vitals } = req.body;

    if (!patient_uid || !vitals) {
      return error(res, 'patient_uid and vitals are required', 400);
    }

    const requiredVitals = ['respiration_rate', 'spo2', 'temperature', 'systolic_bp', 'heart_rate', 'consciousness'];
    const missing = requiredVitals.filter((v) => vitals[v] === undefined && vitals[v] !== 0);
    if (missing.length > 0) {
      return error(res, `Missing required vital signs: ${missing.join(', ')}`, 400);
    }

    const record = await news2Service.recordNEWS2(patient_uid, vitals, req.user.uid);
    return success(res, record, 'NEWS2 assessment recorded', 201);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /clinical/news2/patient/:patientUid
 * Get NEWS2 history for a patient.
 */
router.get('/news2/patient/:patientUid', async (req, res, next) => {
  try {
    const { patientUid } = req.params;
    const limit = parseInt(req.query.limit, 10) || 50;

    const result = await news2Service.getPatientNEWS2History(patientUid, limit);
    return success(res, result, 'NEWS2 history retrieved');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// Medication Administration Record (MAR) Routes
// ===================================================================

/**
 * POST /clinical/mar/schedule
 * Schedule medications for a patient.
 */
// E-10 — discoverability alias for the existing POST /api/v1/emr/notes
// path. Doctors searching for "where do I file a progress note?" hit
// /consultations, /visits, /progress-notes — none of which existed.
// This alias delegates to clinicalNotesService.createNote so the path
// people expect actually works. Finding:
// 2026-05-08-follow-up-opd-doctor-no-progress-note-api.
router.post('/progress-notes', async (req, res, next) => {
  try {
    const { default: clinicalNotesService } = await import('../../services/emr/clinicalNotesService.js');
    const note = await clinicalNotesService.createNote({
      encounter_id: req.body.encounter_id || req.body.appointment_id || null,
      patient_uid: req.body.patient_uid,
      author_uid: req.user?.uid,
      author_role: req.body.author_role || req.user?.role,
      note_type: req.body.note_type || 'progress',
      content: req.body.content || req.body.note || req.body.body,
    });
    return success(res, note, 'Progress note filed', 201);
  } catch (err) {
    next(err);
  }
});

router.post('/mar/schedule', requiredUUID('patient_uid'), validate, async (req, res, next) => {
  try {
    const { patient_uid, prescription_id, medications } = req.body;

    if (!patient_uid) {
      return error(res, 'patient_uid is required', 400);
    }

    // E-4 — MAR can be pre-staged on admission with no medications yet,
    // so the nurse has a frame to chart against once the doctor's first
    // prescription lands. Empty medications[] returns an empty MAR list
    // (the chart frame already exists conceptually — the API just confirms
    // there are no scheduled doses yet). Finding:
    // 2026-05-08-inpatient-admission-nurse-mar-chicken-and-egg.
    const meds = Array.isArray(medications) ? medications : [];
    if (meds.length === 0) {
      return success(res, [], 'MAR ready (no medications scheduled yet)', 201);
    }

    const records = await marService.scheduleMedications(patient_uid, prescription_id, meds);
    return success(res, records, 'Medications scheduled', 201);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /clinical/mar/:id/administer
 * Record medication administration.
 */
router.post('/mar/:id/administer', paramId(), optionalString('notes', 500), validate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { notes, witness_uid } = req.body;

    const record = await marService.recordAdministration(
      parseInt(id, 10),
      req.user.uid,
      notes || null,
      witness_uid || null
    );
    return success(res, record, 'Medication administration recorded');
  } catch (err) {
    next(err);
  }
});

/**
 * POST /clinical/mar/verify
 * Dry-run 5-rights check for a scheduled medication_administrations row.
 * Body: { ma_id, scanned_patient_uid, scanned_barcode }.
 * Returns { rights, allPassed, ma, context }. Does not write.
 */
router.post('/mar/verify',
  requiredNumber('ma_id'),
  requiredUUID('scanned_patient_uid'),
  requiredString('scanned_barcode', 100),
  validate,
  async (req, res, next) => {
    try {
      const { ma_id, scanned_patient_uid, scanned_barcode } = req.body;
      const result = await marFiveRightsService.evaluate5Rights({
        ma_id: parseInt(ma_id, 10),
        scanned_patient_uid,
        scanned_barcode,
      });
      return success(res, result, result.allPassed ? 'All 5 rights passed' : '5-rights check failed');
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /clinical/mar/:id/administer-with-scan
 * Commit a medication administration after a wristband + drug-barcode scan.
 * Body: { scanned_patient_uid, scanned_barcode, override_reason? }.
 * If any right fails and override_reason is absent, returns 409 with the
 * failing rights so the client can drive the override modal.
 */
router.post('/mar/:id/administer-with-scan',
  paramId(),
  requiredUUID('scanned_patient_uid'),
  requiredString('scanned_barcode', 100),
  optionalString('override_reason', 500),
  validate,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { scanned_patient_uid, scanned_barcode, override_reason } = req.body;
      const record = await marFiveRightsService.administerWithScan({
        ma_id: parseInt(id, 10),
        scanned_patient_uid,
        scanned_barcode,
        administeredBy: req.user.uid,
        overrideReason: override_reason && override_reason.trim().length >= 5 ? override_reason.trim() : null,
      });
      return success(res, record, 'Medication administration recorded');
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /clinical/mar/:id/miss
 * Record a missed medication dose.
 */
router.post('/mar/:id/miss', paramId(), requiredString('reason', 500), validate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return error(res, 'Reason is required for missed medication', 400);
    }

    const record = await marService.recordMissed(parseInt(id, 10), reason);
    return success(res, record, 'Missed medication recorded');
  } catch (err) {
    next(err);
  }
});

/**
 * POST /clinical/mar/:id/hold
 * Hold a medication with reason.
 */
router.post('/mar/:id/hold', paramId(), requiredString('reason', 500), validate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return error(res, 'Reason is required to hold medication', 400);
    }

    const record = await marService.holdMedication(parseInt(id, 10), reason, req.user.uid);
    return success(res, record, 'Medication held');
  } catch (err) {
    next(err);
  }
});

/**
 * GET /clinical/mar/patient/:patientUid
 * Get patient's MAR for a specific date.
 */
router.get('/mar/patient/:patientUid', async (req, res, next) => {
  try {
    const { patientUid } = req.params;
    const { date } = req.query;

    const records = await marService.getPatientMAR(patientUid, date || null);
    return success(res, records, 'Patient MAR retrieved');
  } catch (err) {
    next(err);
  }
});

/**
 * GET /clinical/mar/overdue
 * Get overdue medications, optionally filtered by ward.
 */
router.get('/mar/overdue', async (req, res, next) => {
  try {
    const { ward_id } = req.query;
    const wardId = ward_id ? parseInt(ward_id, 10) : null;

    const records = await marService.getOverdueMedications(Number.isFinite(wardId) ? wardId : null);
    return success(res, records, 'Overdue medications retrieved');
  } catch (err) {
    next(err);
  }
});

/**
 * GET /clinical/mar/due
 * Nurse "due meds" list — scheduled/held medications within a rolling
 * window around now. Joins patient name + bed/ward for a single-fetch list.
 * Query params: ward_id?, past_minutes? (default 120), future_minutes? (default 60).
 * Window bounds clamped to the 0..1440-minute (24h) range.
 */
router.get('/mar/due', async (req, res, next) => {
  try {
    const wardIdRaw = req.query.ward_id ? parseInt(req.query.ward_id, 10) : null;
    const pastRaw = req.query.past_minutes ? parseInt(req.query.past_minutes, 10) : 120;
    const futureRaw = req.query.future_minutes ? parseInt(req.query.future_minutes, 10) : 60;

    const wardId = Number.isFinite(wardIdRaw) ? wardIdRaw : null;
    const pastMinutes = Math.max(0, Math.min(Number.isFinite(pastRaw) ? pastRaw : 120, 1440));
    const futureMinutes = Math.max(0, Math.min(Number.isFinite(futureRaw) ? futureRaw : 60, 1440));

    const records = await marService.getDueMedications({ wardId, pastMinutes, futureMinutes });
    return success(res, records, 'Due medications retrieved');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// Nurse Handover Routes
// ===================================================================

/**
 * POST /clinical/handover/generate
 * Generate a draft handover summary from the patient timeline.
 */
router.post('/handover/generate', requiredUUID('patient_uid'), validate, async (req, res, next) => {
  try {
    const draft = await handoverService.generateHandoverDraft(req.body.patient_uid, req.user.uid, req.tenantId);
    return success(res, draft, 'Handover draft generated');
  } catch (err) {
    next(err);
  }
});

/**
 * POST /clinical/handover
 * Create a nurse handover note.
 */
router.post('/handover', requiredUUID('patient_uid'), requiredString('summary', 2000), requiredString('incoming_nurse'), validate, async (req, res, next) => {
  try {
    const data = {
      ...req.body,
      outgoing_nurse: req.body.outgoing_nurse || req.user.uid,
    };

    const record = await handoverService.createHandover(data);
    return success(res, record, 'Handover created', 201);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /clinical/handover/:id/acknowledge
 * Acknowledge a handover as the incoming nurse.
 */
router.post('/handover/:id/acknowledge', paramId(), validate, async (req, res, next) => {
  try {
    const { id } = req.params;

    const record = await handoverService.acknowledgeHandover(parseInt(id, 10), req.user.uid);
    return success(res, record, 'Handover acknowledged');
  } catch (err) {
    next(err);
  }
});

/**
 * GET /clinical/handover/pending
 * Get pending (unacknowledged) handovers for the current nurse.
 */
router.get('/handover/pending', async (req, res, next) => {
  try {
    const records = await handoverService.getActiveHandovers(req.user.uid);
    return success(res, records, 'Pending handovers retrieved');
  } catch (err) {
    next(err);
  }
});

/**
 * GET /clinical/handover/patient/:patientUid
 * Get handover history for a patient.
 */
router.get('/handover/patient/:patientUid', async (req, res, next) => {
  try {
    const { patientUid } = req.params;
    const limit = parseInt(req.query.limit, 10) || 50;

    const records = await handoverService.getPatientHandoverHistory(patientUid, limit);
    return success(res, records, 'Patient handover history retrieved');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// Voice-to-SOAP routes (M3)
// ===================================================================

/**
 * GET /clinical/voice-note/config
 * Returns the configured STT provider so clients can show the right UI
 * (e.g. disable recording if no provider is reachable).
 */
router.get('/voice-note/config', (_req, res) => {
  return success(res, describeSttConfig(), 'STT configuration retrieved');
});

/**
 * POST /clinical/voice-note/transcribe (multipart)
 * Field: audio (file). Optional query/body: patient_uid, admission_id, language.
 */
router.post('/voice-note/transcribe', audioUpload.single('audio'), async (req, res, next) => {
  try {
    if (!req.file) return error(res, 'audio file required', 400);

    const saved = await voiceSoapService.createAndTranscribeVoiceNote({
      req,
      audioBuffer: req.file.buffer,
      mimeType: req.file.mimetype,
      patientUid: req.body?.patient_uid || req.query?.patient_uid || null,
      admissionId: req.body?.admission_id ? Number.parseInt(req.body.admission_id, 10) : null,
      durationSeconds: req.body?.duration_seconds ? Number(req.body.duration_seconds) : null,
      language: req.body?.language || null,
    });
    return success(res, saved, 'Voice note stored', 201);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /clinical/voice-note/:id/generate-soap
 * Convert a completed transcript into a SOAP draft. Enters the review queue.
 */
router.post('/voice-note/:id/generate-soap', async (req, res, next) => {
  try {
    const draft = await voiceSoapService.generateSoapDraftFromVoiceNote({
      req,
      voiceNoteId: req.params.id,
    });
    return success(res, draft, 'SOAP draft generated');
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /clinical/voice-note/my
 * List this clinician's recent voice notes (tenant-scoped).
 */
router.get('/voice-note/my', async (req, res, next) => {
  try {
    const result = await voiceSoapService.listVoiceNotes({
      tenantId: req.tenantId,
      recordedBy: req.user?.uid || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Voice notes retrieved');
  } catch (err) {
    return next(err);
  }
});

// ===================================================================
// Clinical safety AI — deterioration + polypharmacy (Batch 3)
// ===================================================================

/**
 * POST /clinical/safety/deterioration/:patientUid
 * Score an admitted patient's deterioration risk from the last 4h of
 * vitals + recent labs. Returns the NEWS2-like composite with band.
 */
router.post('/safety/deterioration/:patientUid', async (req, res, next) => {
  try {
    const result = await scoreDeterioration({
      patientUid: req.params.patientUid,
      admissionId: req.body?.admission_id || null,
      tenantId: req.tenantId,
    });
    return success(res, result, 'Deterioration score computed');
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /clinical/safety/polypharmacy
 * Body: { patient_id?, patient_uid, medications: [{name,dose,route,frequency}],
 *         admission_id? }
 * Runs rules + AI drug-interaction review. Returns combined_severity with
 * rule + AI findings. Persists row for reviewer decisioning.
 */
router.post('/safety/polypharmacy', async (req, res, next) => {
  try {
    if (!Array.isArray(req.body?.medications) || req.body.medications.length === 0) {
      return error(res, 'medications array is required', 400);
    }
    const result = await reviewPolypharmacy({
      patientId: req.body?.patient_id || null,
      patientUid: req.body?.patient_uid || null,
      medications: req.body.medications,
      admissionId: req.body?.admission_id || null,
      req,
    });
    return success(res, result, 'Polypharmacy review complete');
  } catch (err) {
    return next(err);
  }
});

// ===================================================================
// Ambient clinical documentation (full-encounter multi-speaker note)
// ===================================================================

/**
 * POST /clinical/ambient/encounters
 * Body:
 *   patient_uid, admission_id?, clinician_uid?, recording_started_at,
 *   recording_ended_at?, duration_seconds?, audio_storage_key?, audio_mime?,
 *   stt_provider?, stt_model?, stt_language?, diarization_provider?,
 *   raw_transcript?, diarization_payload?,
 *   transcript_segments: [{ speaker:'doctor'|'patient'|'caregiver'|'other',
 *                           text, start_seconds, end_seconds }],
 *   consent_reference
 *
 * Returns the generated structured visit note with citations back to
 * transcript segments. Enters the review queue.
 */
router.post('/ambient/encounters', async (req, res, next) => {
  try {
    const result = await createAmbientEncounter({
      req,
      patientUid: req.body?.patient_uid,
      admissionId: req.body?.admission_id || null,
      clinicianUid: req.body?.clinician_uid || req.user?.uid || null,
      recordedBy: req.user?.uid || null,
      recordingStartedAt: req.body?.recording_started_at,
      recordingEndedAt: req.body?.recording_ended_at || null,
      durationSeconds: req.body?.duration_seconds || null,
      audioStorageKey: req.body?.audio_storage_key || null,
      audioMime: req.body?.audio_mime || null,
      sttProvider: req.body?.stt_provider || 'none',
      sttModel: req.body?.stt_model || null,
      sttLanguage: req.body?.stt_language || null,
      diarizationProvider: req.body?.diarization_provider || null,
      diarizationPayload: req.body?.diarization_payload || null,
      rawTranscript: req.body?.raw_transcript || null,
      transcriptSegments: req.body?.transcript_segments || [],
      consentReference: req.body?.consent_reference || null,
    });
    return success(res, result, 'Ambient visit note draft generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/ambient/encounters', async (req, res, next) => {
  try {
    const result = await listAmbientEncounters({
      tenantId: req.tenantId,
      patientUid: req.query?.patient_uid || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Ambient encounters retrieved');
  } catch (err) {
    return next(err);
  }
});

export default router;
