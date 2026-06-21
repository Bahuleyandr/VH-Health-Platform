// src/controllers/bed/bedController.js
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import bedService from '../../services/bed/bedService.js';
import { success, error } from '../../utils/responseHelper.js';
import { emitBedEvent } from '../../utils/websocket/realtimeEmitter.js';
import { logAudit } from '../../utils/logAudit.js';

// ===== WARD CONTROLLERS =====

export const listWards = async (req, res) => {
  try {
    const result = await bedService.listWards({
      actor: req.user,
      tenantId: req.tenantId,
    });
    success(res, { wards: result.wards, count: result.wards.length }, 'Wards retrieved', HTTP_STATUS.OK, {
      scope: result.scope,
    });
  } catch (err) {
    logger.error('Error listing wards:', err);
    error(res, 'Failed to list wards', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const createWard = async (req, res) => {
  try {
    const ward = await bedService.createWard(req.body);
    await logAudit(req, 'WARD_CREATED', {
      ward_id: ward.id,
      ward_name: ward.name,
      floor: ward.floor,
      total_beds: ward.total_beds,
    }, {
      resource: 'ward',
      resourceId: ward.id,
    });
    emitBedEvent('ward-created', ward);
    success(res, { ward }, 'Ward created', HTTP_STATUS.CREATED);
  } catch (err) {
    if (err && typeof err.statusCode === 'number') {
      return error(res, err.message, err.statusCode, { safe: true, ...(err.details || {}) });
    }
    logger.error('Error creating ward:', err);
    error(res, 'Failed to create ward', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const updateWard = async (req, res) => {
  try {
    const ward = await bedService.updateWard(req.params.id, req.body);
    if (!ward) return error(res, 'Ward not found', HTTP_STATUS.NOT_FOUND);
    success(res, { ward }, 'Ward updated');
  } catch (err) {
    logger.error('Error updating ward:', err);
    error(res, 'Failed to update ward', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const deleteWard = async (req, res) => {
  try {
    const deleted = await bedService.deleteWard(req.params.id);
    if (!deleted) return error(res, 'Ward not found', HTTP_STATUS.NOT_FOUND);
    await logAudit(req, 'WARD_DELETED', {
      ward_id: deleted.id,
      ward_name: deleted.name,
      floor: deleted.floor,
      total_beds: deleted.total_beds,
    }, {
      resource: 'ward',
      resourceId: deleted.id,
    });
    emitBedEvent('ward-deleted', deleted);
    success(res, { ward: deleted }, 'Ward deleted');
  } catch (err) {
    if (err && typeof err.statusCode === 'number') {
      return error(res, err.message, err.statusCode, { safe: true, ...(err.details || {}) });
    }
    logger.error('Error deleting ward:', err);
    error(res, 'Failed to delete ward', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ===== BED CONTROLLERS =====

export const listBeds = async (req, res) => {
  try {
    const result = await bedService.listBeds(req.query || {}, {
      actor: req.user,
      tenantId: req.tenantId,
    });
    success(res, { beds: result.beds, count: result.beds.length }, 'Beds retrieved', HTTP_STATUS.OK, {
      scope: result.scope,
    });
  } catch (err) {
    if (err && typeof err.statusCode === 'number') {
      return error(res, err.message, err.statusCode, err.details);
    }
    logger.error('Error listing beds:', err);
    error(res, 'Failed to list beds', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getBedsByWard = async (req, res) => {
  try {
    const result = await bedService.getBedsByWard(req.params.wardId, req.query || {}, {
      actor: req.user,
      tenantId: req.tenantId,
    });
    success(res, { beds: result.beds, count: result.beds.length }, 'Beds retrieved', HTTP_STATUS.OK, {
      scope: result.scope,
    });
  } catch (err) {
    if (err && typeof err.statusCode === 'number') {
      return error(res, err.message, err.statusCode, err.details);
    }
    logger.error('Error getting beds by ward:', err);
    error(res, 'Failed to get beds', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getBedSummary = async (req, res) => {
  try {
    const result = await bedService.getBedSummary({
      actor: req.user,
      tenantId: req.tenantId,
    });
    success(res, { summary: result.summary }, 'Bed summary retrieved', HTTP_STATUS.OK, {
      scope: result.scope,
    });
  } catch (err) {
    logger.error('Error getting bed summary:', err);
    error(res, 'Failed to get bed summary', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const createBed = async (req, res) => {
  try {
    const bed = await bedService.createBed(req.body, {
      tenantId: req.tenantId || req.user?.tenant_id || req.user?.tenantId || null,
    });
    await logAudit(req, 'BED_CREATED', {
      bed_id: bed.id,
      bed_number: bed.bed_number,
      ward_id: bed.ward_id,
      ward_name: bed.ward_name,
      status: bed.status,
      bed_type: bed.bed_type,
      floor: bed.floor,
    }, {
      resource: 'bed',
      resourceId: bed.id,
    });
    emitBedEvent('bed-created', bed);
    success(res, { bed }, 'Bed created', HTTP_STATUS.CREATED);
  } catch (err) {
    if (err && typeof err.statusCode === 'number') {
      return error(res, err.message, err.statusCode, { safe: true, ...(err.details || {}) });
    }
    logger.error('Error creating bed:', err);
    error(res, 'Failed to create bed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const updateBed = async (req, res) => {
  try {
    const bed = await bedService.updateBed(req.params.id, req.body);
    if (!bed) return error(res, 'Bed not found', HTTP_STATUS.NOT_FOUND);
    emitBedEvent('bed-updated', bed);
    success(res, { bed }, 'Bed updated');
  } catch (err) {
    logger.error('Error updating bed:', err);
    error(res, 'Failed to update bed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const deleteBed = async (req, res) => {
  try {
    const deleted = await bedService.deleteBed(req.params.id);
    if (!deleted) return error(res, 'Bed not found', HTTP_STATUS.NOT_FOUND);
    await logAudit(req, 'BED_DELETED', {
      bed_id: deleted.id,
      bed_number: deleted.bed_number,
      ward_id: deleted.ward_id,
      ward_name: deleted.ward_name,
      status: deleted.status,
      bed_type: deleted.bed_type,
      floor: deleted.floor,
    }, {
      resource: 'bed',
      resourceId: deleted.id,
    });
    emitBedEvent('bed-deleted', deleted);
    success(res, { bed: deleted }, 'Bed deleted');
  } catch (err) {
    if (err && typeof err.statusCode === 'number') {
      return error(res, err.message, err.statusCode, { safe: true, ...(err.details || {}) });
    }
    logger.error('Error deleting bed:', err);
    error(res, 'Failed to delete bed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const admitPatient = async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenant_id || req.user?.tenantId || null;
    // C-2 — route through the hardened bedService.admitPatient, which creates a
    // real admission + bed_transfers + canonical event under a FOR UPDATE lock
    // (the old path left a half-populated bed with no admission). Pass the
    // resolved tenant + the actor's uid through so the canonical/audit layer and
    // RLS scope are correct.
    const bed = await bedService.admitPatient(
      req.params.id,
      req.body,
      req.user?.role,
      { tenantId, actorUid: req.user?.uid || null },
    );
    if (!bed) return error(res, 'Bed not available for admission', HTTP_STATUS.BAD_REQUEST);
    emitBedEvent('patient-admitted', bed);
    success(res, { bed }, 'Patient admitted');
  } catch (err) {
    // Surface AppError (e.g. ICU tier forbidden) so the actor sees the real reason.
    if (err && typeof err.statusCode === 'number') {
      return error(res, err.message, err.statusCode, err.details);
    }
    logger.error('Error admitting patient:', err);
    error(res, 'Failed to admit patient', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const dischargePatient = async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenant_id || req.user?.tenantId || null;
    // C-2 — route through the hardened bedService.dischargePatient, which
    // delegates to bedManagementService.dischargePatient: bed → 'cleaning'
    // (infection-control turnover, not straight-to-available), admission closed,
    // bed_transfers + canonical discharge event in-tx, and a housekeeping
    // cleaning ticket. The old path skipped all of that.
    const bed = await bedService.dischargePatient(
      req.params.id,
      { tenantId, dischargedBy: req.user?.uid || null },
    );
    if (!bed) return error(res, 'Bed is not occupied', HTTP_STATUS.BAD_REQUEST);
    emitBedEvent('patient-discharged', bed);
    success(res, { bed }, 'Patient discharged');
  } catch (err) {
    if (err && typeof err.statusCode === 'number') {
      return error(res, err.message, err.statusCode, err.details);
    }
    logger.error('Error discharging patient:', err);
    error(res, 'Failed to discharge patient', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// PATCH /beds/:id/notes — staff app's bed-board detail sheet uses this
// to save quick notes without touching patient_id/patient_name (the
// full updateBed handler nulls those when they're absent from the body).
// Body: { notes: string | null }. Empty string clears the field; null
// clears it too. Emits a `bed-notes-updated` realtime event so other
// open bed-board screens refresh.
export const updateBedNotes = async (req, res) => {
  try {
    const { notes } = req.body || {};
    if (notes !== null && typeof notes !== 'string') {
      return error(res, 'notes must be a string or null', HTTP_STATUS.BAD_REQUEST);
    }
    const bed = await bedService.updateBedNotes(req.params.id, notes);
    if (!bed) return error(res, 'Bed not found', HTTP_STATUS.NOT_FOUND);
    emitBedEvent('bed-notes-updated', bed);
    success(res, { bed }, 'Bed notes updated');
  } catch (err) {
    if (err && typeof err.statusCode === 'number') {
      return error(res, err.message, err.statusCode, err.details);
    }
    logger.error('Error updating bed notes:', err);
    error(res, 'Failed to update bed notes', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
