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
  body('status').optional().isIn(['available', 'occupied', 'reserved', 'maintenance'])
    .withMessage('Invalid bed status'),
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
  body('patient_name').trim().notEmpty().withMessage('Patient name is required'),
  body('patient_id').optional().isInt({ min: 1 }),
  body('notes').optional().trim(),
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
