// src/routes/emr/clinicalNotesRoutes.js
import express from 'express';
import * as clinicalNotesService from '../../services/emr/clinicalNotesService.js';
import { createDowntimeSnapshot } from '../../services/emr/clinicalTimelineService.js';
import { publishEvent } from '../../services/events/eventOutboxService.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { success, error } from '../../utils/responseHelper.js';

const router = express.Router();

// ===================================================================
// POST /emr/notes — Create clinical note
// ===================================================================

router.post('/notes', async (req, res, next) => {
  try {
    const { encounter_id, patient_uid, author_role, note_type, content } = req.body;

    if (!patient_uid || !note_type || !content) {
      return error(res, 'patient_uid, note_type, and content are required', 400);
    }

    const note = await clinicalNotesService.createNote({
      encounter_id: encounter_id || null,
      patient_uid,
      author_uid: req.user.uid,
      author_role: author_role || req.user.role,
      note_type,
      content,
    });

    // HIPAA audit — log note creation
    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: patient_uid,
      recordType: `clinical_note:${note_type}`,
      action: 'CREATE',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, note, 'Clinical note created', 201);
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// POST /emr/notes/:id/addendum — Add addendum to existing note
// ===================================================================

router.post('/notes/:id/addendum', async (req, res, next) => {
  try {
    const noteId = parseInt(req.params.id, 10);
    const { content, author_role } = req.body;

    if (!content || Object.keys(content).length === 0) {
      return error(res, 'Addendum content is required', 400);
    }

    const addendum = await clinicalNotesService.addAddendum(
      noteId,
      content,
      req.user.uid,
      author_role || req.user.role
    );

    // HIPAA audit — log addendum creation
    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: addendum.patient_uid,
      recordType: `clinical_note_addendum:${addendum.note_type}`,
      action: 'CREATE',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, addendum, 'Addendum added', 201);
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// POST /emr/notes/:id/sign — Sign a clinical note
// ===================================================================

router.post('/notes/:id/sign', async (req, res, next) => {
  try {
    const noteId = parseInt(req.params.id, 10);

    const signed = await clinicalNotesService.signNote(noteId, req.user.uid);

    // HIPAA audit — log note signing
    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: signed.patient_uid,
      recordType: `clinical_note_sign:${signed.note_type}`,
      action: 'SIGN',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, signed, 'Note signed successfully');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// GET /emr/notes/patient/:uid — Patient's notes (filtered, paginated)
// ===================================================================

router.get('/notes/patient/:uid', async (req, res, next) => {
  try {
    const { uid } = req.params;
    const { note_type, date_from, date_to, author_uid, page, limit } = req.query;

    const result = await clinicalNotesService.getPatientNotes(uid, {
      note_type,
      date_from,
      date_to,
      author_uid,
      page: page || 1,
      limit: limit || 20,
    });

    // HIPAA audit — log PHI access on every note read
    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: uid,
      recordType: 'clinical_notes_list',
      action: 'VIEW',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, result.notes, 'Patient notes retrieved', 200, { pagination: result.pagination });
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// GET /emr/notes/encounter/:encounterId — Encounter notes
// ===================================================================

router.get('/notes/encounter/:encounterId', async (req, res, next) => {
  try {
    const { encounterId } = req.params;

    const notes = await clinicalNotesService.getEncounterNotes(encounterId);

    // HIPAA audit — log encounter notes access
    if (notes.length > 0) {
      logPhiAccess({
        userId: req.user.uid,
        userRole: req.user.role,
        patientId: notes[0].patient_uid,
        recordType: 'clinical_notes_encounter',
        action: 'VIEW',
        ip: req.ip,
        requestId: req.id,
      });
    }

    return success(res, notes, 'Encounter notes retrieved');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// GET /emr/notes/:id — Note detail with version history
// ===================================================================

router.get('/notes/:id', async (req, res, next) => {
  try {
    const noteId = parseInt(req.params.id, 10);

    const note = await clinicalNotesService.getNoteDetail(noteId);

    // HIPAA audit — log individual note access
    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: note.patient_uid,
      recordType: `clinical_note_detail:${note.note_type}`,
      action: 'VIEW',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, note, 'Note detail retrieved');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// GET /emr/timeline/:patientUid — Unified clinical timeline
// ===================================================================

router.get('/timeline/:patientUid', async (req, res, next) => {
  try {
    const { patientUid } = req.params;
    const { date_from, date_to } = req.query;

    const timeline = await clinicalNotesService.getPatientTimeline(
      patientUid,
      date_from || null,
      date_to || null
    );

    // HIPAA audit — log timeline access (comprehensive PHI view)
    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: patientUid,
      recordType: 'clinical_timeline',
      action: 'VIEW',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, timeline, 'Patient timeline retrieved');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// POST /emr/downtime-snapshot/:patientUid - Create offline chart packet
// ===================================================================

router.post('/downtime-snapshot/:patientUid', async (req, res, next) => {
  try {
    const { patientUid } = req.params;
    const hoursToLive = Math.min(Math.max(parseInt(req.body?.hours_to_live, 10) || 12, 1), 72);
    const snapshot = await createDowntimeSnapshot(patientUid, req.user.uid, {
      scope: req.body?.scope || 'patient_chart',
      hoursToLive,
    });

    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: patientUid,
      recordType: 'downtime_snapshot',
      action: 'CREATE',
      ip: req.ip,
      requestId: req.id,
    });

    await publishEvent({
      eventType: 'downtime.snapshot.created',
      aggregateType: 'downtime_snapshot',
      aggregateId: snapshot.id,
      patientUid,
      payload: {
        scope: snapshot.scope,
        expires_at: snapshot.expires_at,
        generated_by: req.user.uid,
      },
    });

    return success(res, snapshot, 'Downtime snapshot created', 201);
  } catch (err) {
    next(err);
  }
});

export default router;
