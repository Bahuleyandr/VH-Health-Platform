// src/routes/emr/clinicalNotesRoutes.js
import express from 'express';
import { patientAccessGuard, patientAccessGuardForResource } from '../../middleware/phiAccessMiddleware.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import { clinicalContinuityReplayMiddleware } from '../../middleware/clinicalContinuityReplayMiddleware.js';
import { rejectMobileClinicalWrite } from '../../middleware/rejectMobileClinicalWriteMiddleware.js';
import {
  resolvePatientUidFromBody,
  saveClinicalNoteDraft,
} from '../../controllers/emr/clinicalNoteDraftController.js';
import * as clinicalNotesService from '../../services/emr/clinicalNotesService.js';
import * as clinicalNoteDraftService from '../../services/emr/clinicalNoteDraftService.js';
import {
  CLINICAL_CONTINUITY_PRIVATE_DRAFT_EFFECT,
  registerClinicalContinuityActionRoute,
} from '../../services/downtime/clinicalContinuityActionBindingRegistry.js';
import { createDowntimeSnapshot } from '../../services/emr/clinicalTimelineService.js';
import { publishEvent } from '../../services/events/eventOutboxService.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessDecisionService.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { success, error } from '../../utils/responseHelper.js';
import {
  NURSING_NOTE_DRAFT_ACTION_SCHEMA,
  OP_NOTE_DRAFT_ACTION_SCHEMA
} from '../../validators/clinicalContinuityActionSchemas.js';

const router = express.Router();

const guardClinicalNoteView = patientAccessGuard('CLINICAL_NOTE', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
});
const guardClinicalNoteWrite = patientAccessGuard('CLINICAL_NOTE', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
});
const guardClinicalNoteResourceView = patientAccessGuardForResource('CLINICAL_NOTE', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
  resourceType: 'clinical_note',
});
const guardClinicalNoteResourceWrite = patientAccessGuardForResource('CLINICAL_NOTE', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  resourceType: 'clinical_note',
});
const guardClinicalNoteEncounterView = patientAccessGuardForResource('CLINICAL_NOTE', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
  resourceType: 'encounter',
  idParam: 'encounterId',
});

const NURSING_NOTE_CODES = new Set([
  'observation',
  'medication note',
  'post-procedure',
  'intake/output',
  'patient complaint',
  'wound care',
  'shift handover',
  'emergency note',
  'other',
]);

function normalizeNotePayload(body) {
  const rawType = String(body.note_type || '').trim();
  const typeKey = rawType.toLowerCase();
  const priority = String(body.priority || 'normal').trim().toLowerCase();
  const content = body.content;

  if (
    rawType === 'nursing_assessment' ||
    NURSING_NOTE_CODES.has(typeKey)
  ) {
    const text =
      typeof content === 'string'
        ? content.trim()
        : String(content?.free_text || content?.plan_of_care || '').trim();
    return {
      note_type: 'nursing_assessment',
      content: {
        pain_level: body.pain_level ?? content?.pain_level ?? 'Not recorded',
        mobility: body.mobility ?? content?.mobility ?? 'Not recorded',
        plan_of_care: text,
        note_category: rawType || 'Observation',
        priority,
        free_text: text,
      },
    };
  }

  if (rawType === 'progress' && typeof content === 'string') {
    const text = content.trim();
    return {
      note_type: 'progress',
      content: {
        summary: text,
        current_status: text,
        plan: body.plan || 'See progress note',
      },
    };
  }

  return { note_type: rawType, content };
}

// ===================================================================
// POST /emr/notes — Create clinical note
// ===================================================================

router.post('/notes', rejectMobileClinicalWrite, requireIdempotencyKey({ required: false, scope: 'clinical_note' }), guardClinicalNoteWrite, async (req, res, next) => {
  try {
    const { encounter_id, appointment_id, author_role, title } = req.body;
    const patient_uid = await resolvePatientUidFromBody(req.body);
    const { note_type, content } = normalizeNotePayload(req.body);

    if (!patient_uid || !note_type || !content) {
      return error(res, 'patient_uid or patient phone, note_type, and content are required', 400);
    }

    const note = await clinicalNotesService.createNote({
      tenant_id: req.tenantId,
      encounter_id: encounter_id || null,
      appointment_id: appointment_id ?? null,
      patient_uid,
      author_uid: req.user.uid,
      author_role: author_role || req.user.role,
      note_type,
      title: title || null,
      content,
      // Authenticated caller identity for the assigned-doctor ownership guard
      // (H2). author_role can be spoofed via the body; req.user is trusted.
      acting_user: { id: req.user.id, uid: req.user.uid, role: req.user.role },
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

router.post('/notes/:id/addendum', rejectMobileClinicalWrite, guardClinicalNoteResourceWrite, async (req, res, next) => {
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
      author_role || req.user.role,
      req.tenantId
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
// Clinical note DRAFTS — autosave (note_drafts). MUST be declared BEFORE the
// /notes/:id routes so the literal "draft" segment isn't captured by :id.
// Drafts are the author's private scratchpad and emit NO canonical timeline/
// audit events (clinicalNoteDraftService); the real note + its events are
// written only on finalize (POST /notes), which clears the matching draft.
// Gated like a note write (rejectMobileClinicalWrite + guardClinicalNoteWrite)
// so autosave is permitted exactly when saving the note would be. No
// phiAccessLogger here — opening the chart/encounter already logged PHI access;
// the draft is the author's own composition (design spec §4).
// ===================================================================

// PUT /emr/notes/draft — autosave-upsert the author's draft for a context.
registerClinicalContinuityActionRoute({
  router,
  method: 'PUT',
  routePath: '/notes/draft',
  fullRoutePath: '/api/v1/emr/notes/draft',
  handler: saveClinicalNoteDraft,
  transactionalHandler: clinicalNoteDraftService.upsertNoteDraftTx,
  effectContract: CLINICAL_CONTINUITY_PRIVATE_DRAFT_EFFECT,
  beforeHandlers: [
    rejectMobileClinicalWrite,
    guardClinicalNoteWrite,
    clinicalContinuityReplayMiddleware,
    requireIdempotencyKey({
      required: true,
      scope: 'clinical_continuity_replay',
      continuityReceiptRequired: true,
      onlyWhen: req => Boolean(req.clinicalContinuityReplay),
    }),
  ],
  actions: [
    {
      actionId: 'emr.nursing_note.draft.store',
      bindingId: 'emr.note_draft.store/v1',
      schema: NURSING_NOTE_DRAFT_ACTION_SCHEMA,
      schemaRecordId: 'emr.nursing_note.draft.store/v1',
    },
    {
      actionId: 'emr.op_note.draft.store',
      bindingId: 'emr.note_draft.store/v1',
      schema: OP_NOTE_DRAFT_ACTION_SCHEMA,
      schemaRecordId: 'emr.op_note.draft.store/v1',
    }
  ]
});

// GET /emr/notes/draft — load the author's OWN draft for a context (or null).
router.get('/notes/draft', guardClinicalNoteView, async (req, res, next) => {
  try {
    const patient_uid = req.query.patient_uid;
    const note_type = req.query.note_type;
    if (!patient_uid || !note_type) {
      return error(res, 'patient_uid and note_type query params are required', 400);
    }
    const draft = await clinicalNoteDraftService.getNoteDraft({
      tenantId: req.tenantId,
      authorUid: req.user.uid,
      patientUid: patient_uid,
      appointmentId: req.query.appointment_id ?? null,
      noteType: note_type,
    });
    return success(res, draft, draft ? 'Draft loaded' : 'No draft');
  } catch (err) {
    next(err);
  }
});

// DELETE /emr/notes/draft — discard the author's draft for a context.
router.delete('/notes/draft', guardClinicalNoteWrite, async (req, res, next) => {
  try {
    const patient_uid = req.query.patient_uid || req.body?.patient_uid;
    const note_type = req.query.note_type || req.body?.note_type;
    if (!patient_uid || !note_type) {
      return error(res, 'patient_uid and note_type are required', 400);
    }
    const removed = await clinicalNoteDraftService.deleteNoteDraft({
      tenantId: req.tenantId,
      authorUid: req.user.uid,
      patientUid: patient_uid,
      appointmentId: req.query.appointment_id ?? req.body?.appointment_id ?? null,
      noteType: note_type,
    });
    return success(res, { removed }, 'Draft discarded');
  } catch (err) {
    next(err);
  }
});

// PUT / PATCH /emr/notes/:id — edit note content.
// Allowed by service policy for ADMIN/SUPER_ADMIN corrections, and for the
// original assigned doctor revising an unsigned OP appointment note while the
// appointment is still open. Other clinical corrections remain addenda.
// Author_uid / author_role / note_type / created_at are preserved; only
// content + updated_at + version change.
async function adminUpdateNote(req, res, next) {
  try {
    const noteId = parseInt(req.params.id, 10);
    if (!Number.isFinite(noteId)) {
      return error(res, 'Invalid note id', 400);
    }
    const { content } = req.body;
    if (!content || typeof content !== 'object' || Object.keys(content).length === 0) {
      return error(res, 'content (object) is required', 400);
    }

    const updated = await clinicalNotesService.updateNote(
      noteId,
      content,
      req.user.uid,
      req.user.role,
      { id: req.user.id, uid: req.user.uid, role: req.user.role },
      req.tenantId,
    );

    // HIPAA audit — log admin overwrite (action=UPDATE) so the legal trail
    // captures who rewrote the note, even though the original content is
    // gone from the row itself.
    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: updated.patient_uid,
      recordType: `clinical_note:${updated.note_type}`,
      action: 'UPDATE',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, updated, 'Clinical note updated');
  } catch (err) {
    next(err);
  }
}

router.put('/notes/:id', rejectMobileClinicalWrite, guardClinicalNoteResourceWrite, adminUpdateNote);
router.patch('/notes/:id', rejectMobileClinicalWrite, guardClinicalNoteResourceWrite, adminUpdateNote);

// ===================================================================
// POST /emr/notes/:id/sign — Sign a clinical note
// ===================================================================

router.post('/notes/:id/sign', rejectMobileClinicalWrite, guardClinicalNoteResourceWrite, async (req, res, next) => {
  try {
    const noteId = parseInt(req.params.id, 10);

    const signed = await clinicalNotesService.signNote(noteId, req.user.uid, {
      id: req.user.id,
      uid: req.user.uid,
      role: req.user.role,
    }, req.tenantId);

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

router.get('/notes/patient/:uid', guardClinicalNoteView, async (req, res, next) => {
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

router.get('/notes/encounter/:encounterId', guardClinicalNoteEncounterView, async (req, res, next) => {
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

router.get('/notes/:id', guardClinicalNoteResourceView, async (req, res, next) => {
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

router.get('/timeline/:patientUid', guardClinicalNoteView, async (req, res, next) => {
  try {
    const { patientUid } = req.params;
    const { date_from, date_to, limit } = req.query;

    const timeline = await clinicalNotesService.getPatientTimeline(
      patientUid,
      date_from || null,
      date_to || null,
      {
        tenantId: req.tenantId || req.user?.tenant_id,
        limit,
        includeLegacy: req.query.include_legacy === 'true',
      },
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

router.post('/downtime-snapshot/:patientUid', guardClinicalNoteView, async (req, res, next) => {
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
