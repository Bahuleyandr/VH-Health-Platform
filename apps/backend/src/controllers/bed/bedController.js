// src/controllers/bed/bedController.js
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import bedService from '../../services/bed/bedService.js';
import { success, error } from '../../utils/responseHelper.js';
import { emitBedEvent } from '../../utils/websocket/realtimeEmitter.js';

// ===== WARD CONTROLLERS =====

export const listWards = async (req, res) => {
  try {
    const wards = await bedService.listWards();
    success(res, { wards, count: wards.length }, 'Wards retrieved');
  } catch (err) {
    logger.error('Error listing wards:', err);
    error(res, 'Failed to list wards', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const createWard = async (req, res) => {
  try {
    const ward = await bedService.createWard(req.body);
    success(res, { ward }, 'Ward created', HTTP_STATUS.CREATED);
  } catch (err) {
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
    success(res, null, 'Ward deleted');
  } catch (err) {
    logger.error('Error deleting ward:', err);
    error(res, 'Failed to delete ward', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ===== BED CONTROLLERS =====

export const listBeds = async (req, res) => {
  try {
    const beds = await bedService.listBeds(req.query || {});
    success(res, { beds, count: beds.length }, 'Beds retrieved');
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
    const beds = await bedService.getBedsByWard(req.params.wardId, req.query || {});
    success(res, { beds, count: beds.length }, 'Beds retrieved');
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
    const summary = await bedService.getBedSummary();
    success(res, { summary }, 'Bed summary retrieved');
  } catch (err) {
    logger.error('Error getting bed summary:', err);
    error(res, 'Failed to get bed summary', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const createBed = async (req, res) => {
  try {
    const bed = await bedService.createBed(req.body);
    emitBedEvent('bed-created', bed);
    success(res, { bed }, 'Bed created', HTTP_STATUS.CREATED);
  } catch (err) {
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
    emitBedEvent('bed-deleted', { id: req.params.id });
    success(res, null, 'Bed deleted');
  } catch (err) {
    logger.error('Error deleting bed:', err);
    error(res, 'Failed to delete bed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const admitPatient = async (req, res) => {
  try {
    const bed = await bedService.admitPatient(req.params.id, req.body, req.user?.role);
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
    const bed = await bedService.dischargePatient(req.params.id);
    if (!bed) return error(res, 'Bed is not occupied', HTTP_STATUS.BAD_REQUEST);
    emitBedEvent('patient-discharged', bed);
    success(res, { bed }, 'Patient discharged');
  } catch (err) {
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
