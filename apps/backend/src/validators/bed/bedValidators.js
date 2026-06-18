// src/validators/bed/bedValidators.js
import { body, param, validationResult } from 'express-validator';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
  }
  next();
};

export const createWardValidation = [
  body('name').trim().notEmpty().withMessage('Ward name is required')
    .isLength({ max: 100 }).withMessage('Ward name must be under 100 characters'),
  body('floor').optional().isInt({ min: -5, max: 100 }).withMessage('Floor must be an integer'),
  body('department_id').optional().isInt({ min: 1 }).withMessage('Department ID must be a positive integer'),
  body('total_beds').optional().isInt({ min: 0 }).withMessage('Total beds must be non-negative'),
  validate
];

export const updateWardValidation = [
  param('id').isInt({ min: 1 }).withMessage('Ward ID must be a positive integer'),
  body('name').optional().trim().isLength({ max: 100 }),
  body('floor').optional().isInt({ min: -5, max: 100 }),
  body('department_id').optional().isInt({ min: 1 }),
  body('total_beds').optional().isInt({ min: 0 }),
  validate
];

export const deleteWardValidation = [
  param('id').isInt({ min: 1 }).withMessage('Ward ID must be a positive integer'),
  validate
];

export const createBedValidation = [
  body('ward_id').isInt({ min: 1 }).withMessage('Ward ID is required'),
  body('bed_number').trim().notEmpty().withMessage('Bed number is required')
    .isLength({ max: 20 }).withMessage('Bed number must be under 20 characters'),
  body('status').optional().isIn(['available', 'maintenance'])
    .withMessage('New beds can only start as available or maintenance'),
  body('bed_type').optional().trim().isLength({ max: 50 })
    .withMessage('Bed type must be under 50 characters'),
  body('notes').optional().trim(),
  validate
];

export const updateBedValidation = [
  param('id').isInt({ min: 1 }).withMessage('Bed ID must be a positive integer'),
  body('ward_id').optional().isInt({ min: 1 }),
  body('bed_number').optional().trim().isLength({ max: 20 }),
  body('status').optional().isIn(['available', 'occupied', 'reserved', 'maintenance']),
  body('patient_id').optional({ nullable: true }).isInt({ min: 1 }),
  body('patient_name').optional({ nullable: true }).trim().isLength({ max: 100 }),
  body('notes').optional().trim(),
  validate
];

export const deleteBedValidation = [
  param('id').isInt({ min: 1 }).withMessage('Bed ID must be a positive integer'),
  validate
];

export const admitValidation = [
  param('id').isInt({ min: 1 }).withMessage('Bed ID must be a positive integer'),
  // C-2 (audit 2026-06-18): bedService.admitPatient now creates a REAL admission
  // (admissions.patient_uid + bed_transfers.patient_uid are NOT NULL), so a bed can
  // no longer be occupied by name alone. patient_name is optional — the service
  // falls back to users.name — but a resolvable patient reference is mandatory.
  body('patient_name').optional().trim(),
  body('patient_id').optional().isInt({ min: 1 }),
  body('patient_uid').optional().isUUID().withMessage('patient_uid must be a valid UUID'),
  body('notes').optional().trim(),
  // Require at least one resolvable patient reference (patient_id or patient_uid).
  // Rejects a name-only body at the edge (400) instead of letting it fail deeper
  // in bedService.admitPatient (AppError ADMIT_PATIENT_REQUIRED).
  body().custom((_value, { req }) => {
    const rawId = req.body?.patient_id;
    const hasId = rawId !== undefined && rawId !== null && String(rawId).trim() !== '';
    const rawUid = req.body?.patient_uid;
    const hasUid = typeof rawUid === 'string' && rawUid.trim() !== '';
    if (!hasId && !hasUid) {
      throw new Error('patient_uid or patient_id is required');
    }
    return true;
  }),
  validate
];

export const dischargeValidation = [
  param('id').isInt({ min: 1 }).withMessage('Bed ID must be a positive integer'),
  validate
];

export const wardIdValidation = [
  param('wardId').isInt({ min: 1 }).withMessage('Ward ID must be a positive integer'),
  validate
];
