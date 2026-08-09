import { body, param, query } from 'express-validator';
import { SOS_SEVERITY } from '../config/sosConfig.js';

// Create SOS alert
export const createAlert = [
  body('phone').optional().isMobilePhone('en-IN').withMessage('Valid Indian mobile number required'),
  body('latitude').optional().isFloat({ min: -90, max: 90 }).withMessage('Valid latitude required'),
  body('longitude').optional().isFloat({ min: -180, max: 180 }).withMessage('Valid longitude required'),
  body('severity').optional().isIn(Object.values(SOS_SEVERITY)).withMessage('Valid severity level required'),
  body('emergencyType').optional().isIn(['medical', 'accident', 'violence', 'mental_health', 'fire', 'other']).withMessage('Valid emergency type required'),
  body('message').optional().isLength({ max: 500 }).withMessage('Message too long (max 500 characters)')
];

// Update emergency contact
export const updateEmergencyContact = [
  body('emergencyContactName').notEmpty().withMessage('Emergency contact name required'),
  body('emergencyContactPhone').isMobilePhone('en-IN').withMessage('Valid emergency contact phone required'),
  body('relationship').optional().isLength({ max: 50 }).withMessage('Relationship description too long')
];

// Cancel alert
export const cancelAlert = [
  param('alertId').isInt({ min: 1 }).withMessage('Valid alert ID required'),
  body('reason').optional().isLength({ max: 200 }).withMessage('Cancellation reason too long'),
  body('resolution').optional().isLength({ max: 500 }).withMessage('Resolution description too long')
];

// Patient: Get SOS alerts
export const getMyAlerts = [
  query('fromDate').optional().isISO8601().withMessage('Invalid fromDate'),
  query('toDate').optional().isISO8601().withMessage('Invalid toDate')
];

// Patient: Get nearby services
export const getNearbyServices = [
  query('latitude').optional().isFloat({ min: -90, max: 90 }).withMessage('Valid latitude required'),
  query('lat').optional().isFloat({ min: -90, max: 90 }).withMessage('Valid latitude required'),
  query('longitude').optional().isFloat({ min: -180, max: 180 }).withMessage('Valid longitude required'),
  query('lng').optional().isFloat({ min: -180, max: 180 }).withMessage('Valid longitude required'),
  query().custom((_, { req }) => {
    const hasLatitude = req.query.latitude !== undefined || req.query.lat !== undefined;
    const hasLongitude = req.query.longitude !== undefined || req.query.lng !== undefined;
    if (!hasLatitude || !hasLongitude) {
      throw new Error('Latitude and longitude are required');
    }
    return true;
  }),
  query('radius').optional().isInt({ min: 1, max: 100 }).withMessage('Radius must be between 1 and 100 km')
];

// Responder: Analytics
export const getAnalytics = [
  query('startDate').optional().isISO8601().withMessage('Invalid startDate'),
  query('endDate').optional().isISO8601().withMessage('Invalid endDate')
];

// Responder: Respond to alert
export const respondToAlert = [
  param('alertId').isInt({ min: 1 }).withMessage('Valid alert ID required'),
  body('responseMessage').notEmpty().withMessage('Response message is required')
];

// Responder: Resolve alert
export const resolveAlert = [
  param('alertId').isInt({ min: 1 }).withMessage('Valid alert ID required'),
  body('resolutionNotes').optional().isLength({ max: 500 }).withMessage('Resolution notes too long')
];

// Admin: View analytics
export const getAdminAnalytics = [
  query('startDate').optional().isISO8601().withMessage('Invalid startDate'),
  query('endDate').optional().isISO8601().withMessage('Invalid endDate')
];

// Admin: View alerts
export const getAdminAlerts = [
  query('status').optional().isIn(['pending', 'resolved', 'cancelled']).withMessage('Invalid status filter'),
  query('severity').optional().isIn(Object.values(SOS_SEVERITY)).withMessage('Invalid severity level')
];

// Admin: Performance report
export const getPerformanceReport = [
  query('month').optional().isInt({ min: 1, max: 12 }).withMessage('Valid month required'),
  query('year').optional().isInt({ min: 2000, max: new Date().getFullYear() }).withMessage('Valid year required')
];

// Admin: Update system config
// Admin: Broadcast alert
export const broadcastAlert = [
  body('title').notEmpty().withMessage('Title is required'),
  body('message').notEmpty().withMessage('Message is required'),
  body('targetGroup').optional().isIn(['public', 'staff', 'responders']).withMessage('Invalid target group')
];

// Admin: Escalate alert
export const escalateAlert = [
  param('alertId').isInt({ min: 1 }).withMessage('Valid alert ID required'),
  body('escalationReason').notEmpty().withMessage('Escalation reason is required')
];
