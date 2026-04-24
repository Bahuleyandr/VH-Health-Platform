// src/validators/health/healthValidators.js
// Only the validators actually referenced by src/routes/health/protectedRoutes.js
// live here. Record-file-upload validators are in validators/record/recordValidators.js.
//
// Trimmed in batch 45:
//   - healthRecordCreateValidator / healthRecordUpdateValidator — only
//     consumed by the deleted `healthRecordController`.
//   - paginationValidator / recordFilterValidator / recordIdValidator —
//     duplicates of the record/ copies that aren't needed now that the
//     staff-facing /records CRUD routes are gone.

import { query, param } from 'express-validator';

export const patientIdValidator = [
  param('patient_id')
    .isInt({ min: 1 })
    .withMessage('Invalid patient ID')
];

export const trendsValidator = [
  query('days')
    .optional()
    .isInt({ min: 1, max: 365 })
    .withMessage('Days must be between 1 and 365'),
  query('vital_type')
    .optional()
    .isString()
    .withMessage('Vital type must be a string')
];

export const activeOnlyValidator = [
  query('active_only')
    .optional()
    .isBoolean()
    .withMessage('active_only must be a boolean')
];
