import { body, param, query } from 'express-validator';
import { MEDICATION_CATEGORIES } from '../../config/pharmacyConfig.js';

export const createMedicationValidation = [
  body('name').notEmpty().trim().isLength({ max: 200 }).withMessage('Name is required (max 200 characters)'),
  body('generic_name').notEmpty().trim().isLength({ max: 200 }).withMessage('Generic name is required (max 200 characters)'),
  body('brand').optional().trim().isLength({ max: 100 }).withMessage('Brand too long (max 100 characters)'),
  body('category').notEmpty().isIn(Object.values(MEDICATION_CATEGORIES)).withMessage('Valid category required'),
  body('dosage').optional().trim().isLength({ max: 50 }).withMessage('Dosage too long (max 50 characters)'),
  body('form').optional().trim().isLength({ max: 50 }).withMessage('Form too long (max 50 characters)'),
  body('price').isFloat({ min: 0 }).withMessage('Valid price required'),
  body('stock_quantity').optional().isInt({ min: 0 }).withMessage('Stock quantity must be non-negative'),
  body('expiry_date').optional().isISO8601().withMessage('Valid expiry date required (YYYY-MM-DD)'),
  body('manufacturer').optional().trim().isLength({ max: 200 }).withMessage('Manufacturer too long (max 200 characters)'),
  body('prescription_required').optional().isBoolean().withMessage('Prescription required must be boolean'),
  body('description').optional().trim().isLength({ max: 1000 }).withMessage('Description too long (max 1000 characters)')
];

export const updateMedicationValidation = [
  param('id').isInt({ min: 1 }).withMessage('Valid medication ID required'),
  body('name').optional().trim().isLength({ max: 200 }).withMessage('Name too long (max 200 characters)'),
  body('generic_name').optional().trim().isLength({ max: 200 }).withMessage('Generic name too long (max 200 characters)'),
  body('brand').optional().trim().isLength({ max: 100 }).withMessage('Brand too long (max 100 characters)'),
  body('category').optional().isIn(Object.values(MEDICATION_CATEGORIES)).withMessage('Valid category required'),
  body('dosage').optional().trim().isLength({ max: 50 }).withMessage('Dosage too long (max 50 characters)'),
  body('form').optional().trim().isLength({ max: 50 }).withMessage('Form too long (max 50 characters)'),
  body('price').optional().isFloat({ min: 0 }).withMessage('Valid price required'),
  body('stock_quantity').optional().isInt({ min: 0 }).withMessage('Stock quantity must be non-negative'),
  body('expiry_date').optional().isISO8601().withMessage('Valid expiry date required (YYYY-MM-DD)'),
  body('manufacturer').optional().trim().isLength({ max: 200 }).withMessage('Manufacturer too long (max 200 characters)'),
  body('prescription_required').optional().isBoolean().withMessage('Prescription required must be boolean'),
  body('description').optional().trim().isLength({ max: 1000 }).withMessage('Description too long (max 1000 characters)')
];

export const updateStockValidation = [
  param('id').isInt({ min: 1 }).withMessage('Valid medication ID required'),
  body('quantity').isInt({ min: 0 }).withMessage('Valid quantity required'),
  body('operation').optional().isIn(['set', 'add', 'subtract']).withMessage('Operation must be set, add, or subtract')
];

export const searchMedicationValidation = [
  query('q').optional().trim().isLength({ min: 1, max: 100 }).withMessage('Search query too long (max 100 characters)'),
  query('category').optional().isIn(Object.values(MEDICATION_CATEGORIES)).withMessage('Valid category required'),
  query('prescription_required').optional().isIn(['true', 'false']).withMessage('Prescription required must be true or false'),
  query('min_price').optional().isFloat({ min: 0 }).withMessage('Min price must be non-negative'),
  query('max_price').optional().isFloat({ min: 0 }).withMessage('Max price must be non-negative'),
  query('in_stock_only').optional().isIn(['true', 'false']).withMessage('In stock only must be true or false')
];