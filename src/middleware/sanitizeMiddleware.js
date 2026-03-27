// src/middleware/sanitizeMiddleware.js - P1 Security: Stored XSS prevention
// Sanitizes user-provided text fields before they reach controllers/services.

import { sanitizeFields } from '../utils/sanitize.js';

/**
 * Creates middleware that sanitizes specified fields in req.body.
 * @param  {...string} fields - Field names to sanitize
 * @returns {Function} Express middleware
 */
export function sanitizeBody(...fields) {
  return (req, _res, next) => {
    if (req.body) {
      sanitizeFields(req.body, fields);
    }
    next();
  };
}

// Pre-configured sanitizers for specific domains

/** Profile fields: name, address, allergies, emergency_contact */
export const sanitizeProfileFields = sanitizeBody(
  'name', 'address', 'allergies', 'emergency_contact',
  'emergency_contact_name', 'emergency_contact_phone',
  'medical_history', 'notes'
);

/** Feedback fields: comment, question */
export const sanitizeFeedbackFields = sanitizeBody('comment', 'question');

/** Pharmacy order fields: order_note, delivery_address, delivery_landmark */
export const sanitizePharmacyFields = sanitizeBody(
  'order_note', 'delivery_address', 'delivery_landmark', 'notes'
);

/** Investigation booking fields: notes, custom_test_names, collection_address */
export const sanitizeInvestigationFields = sanitizeBody(
  'notes', 'custom_test_names', 'collection_address', 'collection_landmark'
);

/** Appointment fields: reason, notes */
export const sanitizeAppointmentFields = sanitizeBody('reason', 'notes');

/** SOS fields: notes, description, address */
export const sanitizeSosFields = sanitizeBody(
  'notes', 'description', 'address', 'location_description'
);
