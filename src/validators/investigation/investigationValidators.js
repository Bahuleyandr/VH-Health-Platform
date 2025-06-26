import { body, param, query } from 'express-validator';
import { 
  INVESTIGATION_TYPES, 
  INVESTIGATION_STATUS, 
  PRIORITY_LEVELS 
} from '../../config/investigationConfig.js';

export const investigationRequestValidator = [
  body('patient_id').optional().isInt({ min: 1 }).withMessage('Valid patient ID required'),
  body('doctor_id').optional().isInt({ min: 1 }).withMessage('Valid doctor ID required'),
  body('test_name').notEmpty().trim().withMessage('Test name is required'),
  body('test_code').optional().trim().isLength({ max: 50 }).withMessage('Test code too long'),
  body('type').optional().isIn(Object.values(INVESTIGATION_TYPES)).withMessage('Invalid investigation type'),
  body('priority').optional().isIn(Object.values(PRIORITY_LEVELS)).withMessage('Invalid priority level'),
  body('scheduled_date').optional().isISO8601().withMessage('Valid scheduled date required'),
  body('notes').optional().trim().isLength({ max: 1000 }).withMessage('Notes too long'),
  body('cost').optional().isFloat({ min: 0 }).withMessage('Valid cost required'),
  // Legacy fields
  body('phone').optional().isMobilePhone('en-IN').withMessage('Valid phone number required'),
  body('file_key').optional().isString().withMessage('File key must be a string')
];

export const idValidator = [
  param('id').isInt({ min: 1 }).withMessage('Valid ID required')
];

export const updateStatusValidator = [
  param('id').isInt({ min: 1 }).withMessage('Valid ID required'),
  body('status').isIn(Object.values(INVESTIGATION_STATUS)).withMessage('Invalid status'),
  body('notes').optional().trim().isLength({ max: 1000 }).withMessage('Notes too long')
];

export const addResultsValidator = [
  param('id').isInt({ min: 1 }).withMessage('Valid ID required'),
  body('results').notEmpty().withMessage('Results are required'),
  body('interpretation').optional().trim().isLength({ max: 2000 }).withMessage('Interpretation too long'),
  body('technician_notes').optional().trim().isLength({ max: 1000 }).withMessage('Technician notes too long'),
  body('reviewed_by').optional().isString().withMessage('Reviewed by must be a string')
];

export const listInvestigationsValidator = [
  query('page').optional().isInt({ min: 1 }).withMessage('Valid page number required'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1-100'),
  query('patient_id').optional().isInt({ min: 1 }).withMessage('Valid patient ID required'),
  query('doctor_id').optional().isInt({ min: 1 }).withMessage('Valid doctor ID required'),
  query('type').optional().isIn(Object.values(INVESTIGATION_TYPES)).withMessage('Invalid type'),
  query('status').optional().isIn(Object.values(INVESTIGATION_STATUS)).withMessage('Invalid status'),
  query('date').optional().isISO8601().withMessage('Valid date required')
];

export const patientIdValidator = [
  param('patient_id').isInt({ min: 1 }).withMessage('Valid patient ID required')
];

export const doctorIdValidator = [
  param('doctor_id').isInt({ min: 1 }).withMessage('Valid doctor ID required')
];

export const typeValidator = [
  param('type').isIn(Object.values(INVESTIGATION_TYPES)).withMessage('Invalid investigation type')
];