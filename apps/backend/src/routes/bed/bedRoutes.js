// src/routes/bed/bedRoutes.js
import express from 'express';
import * as bedController from '../../controllers/bed/bedController.js';
import {
  createWardValidation, updateWardValidation, deleteWardValidation,
  createBedValidation, updateBedValidation, deleteBedValidation,
  admitValidation, dischargeValidation, wardIdValidation
} from '../../validators/bed/bedValidators.js';

export const bedRouter = express.Router();
export const wardRouter = express.Router();

// ===== BED ROUTES =====
bedRouter.get('/', bedController.listBeds);
bedRouter.get('/summary', bedController.getBedSummary);
bedRouter.get('/ward/:wardId', wardIdValidation, bedController.getBedsByWard);
bedRouter.post('/', createBedValidation, bedController.createBed);
bedRouter.put('/:id', updateBedValidation, bedController.updateBed);
// PATCH /:id/notes — quick-note save from the staff bed-board sheet.
// Separate from PUT /:id because that handler's body contract requires
// patient fields and would null them out when the sheet only sends notes.
bedRouter.patch('/:id/notes', bedController.updateBedNotes);
bedRouter.delete('/:id', deleteBedValidation, bedController.deleteBed);
bedRouter.post('/:id/admit', admitValidation, bedController.admitPatient);
bedRouter.post('/:id/discharge', dischargeValidation, bedController.dischargePatient);

// ===== WARD ROUTES =====
wardRouter.get('/', bedController.listWards);
wardRouter.post('/', createWardValidation, bedController.createWard);
wardRouter.put('/:id', updateWardValidation, bedController.updateWard);
wardRouter.delete('/:id', deleteWardValidation, bedController.deleteWard);
