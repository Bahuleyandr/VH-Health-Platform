// src/middleware/sanitizeMiddleware.js - P1 Security: Stored XSS prevention
// Sanitizes user-provided text fields before they reach controllers/services.

import { deepSanitizeStrings, sanitizeFields } from '../utils/sanitize.js';

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

/**
 * Deep sanitizer for clinical free-text mounts (audit finding M7): strips
 * HTML from EVERY string in req.body (recursively), instead of relying on
 * per-route opt-in field lists that covered only a fraction of the clinical
 * documentation surface. Credential/signature-like keys are skipped — see
 * utils/sanitize.js. Mounted in app.js on the clinical documentation routers
 * (notes, diagnoses, assessments, discharge, ICU, theatre, maternity, ...).
 */
export function sanitizeAllBodyStrings(req, _res, next) {
  if (req.body && typeof req.body === 'object') {
    deepSanitizeStrings(req.body);
  }
  next();
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

/** Appointment fields: patient_name, reason, notes */
export const sanitizeAppointmentFields = sanitizeBody('patient_name', 'reason', 'notes');

/** SOS fields: notes, description, address */
export const sanitizeSosFields = sanitizeBody(
  'notes', 'description', 'address', 'location_description'
);
