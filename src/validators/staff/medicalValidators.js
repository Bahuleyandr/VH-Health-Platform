import { body } from 'express-validator';

export const consultationUploadValidation = [
  body('phone').isMobilePhone('en-IN').withMessage('Valid phone number required'),
  body('file_key').notEmpty().withMessage('File key required'),
  body('file_name').notEmpty().withMessage('File name required'),
  body('consultation_type').optional().isIn(['follow_up', 'emergency', 'routine', 'specialist']).withMessage('Valid consultation type required')
];

export const investigationUploadValidation = [
  body('phone').isMobilePhone('en-IN').withMessage('Valid phone number required'),
  body('test_name').notEmpty().withMessage('Test name required'),
  body('file_key').notEmpty().withMessage('File key required'),
  body('result_status').optional().isIn(['normal', 'abnormal', 'critical', 'pending']).withMessage('Valid result status required')
];