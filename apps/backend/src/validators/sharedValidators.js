/**
 * Shared Input Validators
 * Reusable express-validator chains for common patterns across the codebase.
 * Import specific validators where needed instead of duplicating validation logic.
 */

import { body, param, query } from 'express-validator';

// ─── Primitive validators ────────────────────────────────────────────────────

/** Validate a required UUID or integer ID path parameter */
export const paramId = (name = 'id') =>
  param(name).notEmpty().withMessage(`${name} is required`);

/** Validate an optional positive integer query param */
export const queryInt = (name, { min = 1, max } = {}) => {
  let chain = query(name).optional().isInt({ min }).withMessage(`${name} must be a positive integer`);
  if (max) chain = chain.isInt({ max }).withMessage(`${name} must be at most ${max}`);
  return chain.toInt();
};

/** Validate a required non-empty string body field with max length */
export const requiredString = (name, maxLen = 1000) =>
  body(name)
    .exists({ checkFalsy: true }).withMessage(`${name} is required`)
    .isString().withMessage(`${name} must be a string`)
    .trim()
    .isLength({ max: maxLen }).withMessage(`${name} must be at most ${maxLen} characters`);

/** Validate an optional string body field with max length */
export const optionalString = (name, maxLen = 1000) =>
  body(name)
    .optional({ nullable: true })
    .isString().withMessage(`${name} must be a string`)
    .trim()
    .isLength({ max: maxLen }).withMessage(`${name} must be at most ${maxLen} characters`);

/** Validate a required enum body field */
export const requiredEnum = (name, allowed) =>
  body(name)
    .exists({ checkFalsy: true }).withMessage(`${name} is required`)
    .isIn(allowed).withMessage(`${name} must be one of: ${allowed.join(', ')}`);

/** Validate an optional enum body field */
export const optionalEnum = (name, allowed) =>
  body(name)
    .optional({ nullable: true })
    .isIn(allowed).withMessage(`${name} must be one of: ${allowed.join(', ')}`);

/** Validate a required boolean body field */
export const requiredBool = (name) =>
  body(name)
    .exists().withMessage(`${name} is required`)
    .isBoolean().withMessage(`${name} must be a boolean`);

/** Validate a required positive number */
export const requiredNumber = (name, { min = 0, max } = {}) => {
  let chain = body(name)
    .exists({ checkFalsy: true }).withMessage(`${name} is required`)
    .isFloat({ min }).withMessage(`${name} must be at least ${min}`);
  if (max !== undefined) chain = chain.isFloat({ max }).withMessage(`${name} must be at most ${max}`);
  return chain.toFloat();
};

/** Validate an optional positive number */
export const optionalNumber = (name, { min = 0, max } = {}) => {
  let chain = body(name)
    .optional({ nullable: true })
    .isFloat({ min }).withMessage(`${name} must be at least ${min}`);
  if (max !== undefined) chain = chain.isFloat({ max }).withMessage(`${name} must be at most ${max}`);
  return chain.toFloat();
};

/** Validate a required ISO date string */
export const requiredDate = (name) =>
  body(name)
    .exists({ checkFalsy: true }).withMessage(`${name} is required`)
    .isISO8601().withMessage(`${name} must be a valid ISO 8601 date`);

/** Validate an optional ISO date string */
export const optionalDate = (name) =>
  body(name)
    .optional({ nullable: true })
    .isISO8601().withMessage(`${name} must be a valid ISO 8601 date`);

/** Validate a required UUID */
export const requiredUUID = (name) =>
  body(name)
    .exists({ checkFalsy: true }).withMessage(`${name} is required`)
    .isUUID().withMessage(`${name} must be a valid UUID`);

/** Validate a required phone number */
export const requiredPhone = (name = 'phone') =>
  body(name)
    .exists({ checkFalsy: true }).withMessage(`${name} is required`)
    .matches(/^\+?\d{10,15}$/).withMessage(`${name} must be a valid phone number`);

// ─── Domain-specific validators ──────────────────────────────────────────────

/** Clinical vitals (NEWS2 scoring) */
export const vitalsValidator = [
  requiredUUID('patient_uid'),
  requiredNumber('heart_rate', { min: 20, max: 300 }),
  requiredNumber('systolic_bp', { min: 40, max: 300 }),
  optionalNumber('diastolic_bp', { min: 20, max: 200 }),
  requiredNumber('respiratory_rate', { min: 4, max: 60 }),
  requiredNumber('temperature', { min: 30, max: 45 }),
  requiredNumber('spo2', { min: 50, max: 100 }),
  optionalEnum('consciousness', ['A', 'C', 'V', 'P', 'U']),
  optionalBool('supplemental_o2'),
];

// Helper for optionalBool used above
function optionalBool(name) {
  return body(name).optional({ nullable: true }).isBoolean().withMessage(`${name} must be a boolean`);
}

/** MAR (Medication Administration Record) schedule */
export const marScheduleValidator = [
  requiredUUID('patient_uid'),
  requiredString('medication_name', 255),
  requiredString('dosage', 100),
  requiredString('route', 50),
  requiredString('frequency', 100),
  requiredDate('start_date'),
  optionalDate('end_date'),
  optionalString('notes', 500),
];

/** MAR administration */
export const marAdministerValidator = [
  paramId('id'),
  optionalString('notes', 500),
  optionalEnum('status', ['ADMINISTERED', 'MISSED', 'HELD', 'REFUSED']),
];

/** Clinical handover */
export const handoverValidator = [
  requiredUUID('patient_uid'),
  requiredString('summary', 2000),
  requiredString('to_staff_uid'),
  optionalString('pending_tasks', 2000),
  optionalString('alerts', 1000),
  optionalEnum('priority', ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
];

/** Billing invoice */
export const invoiceValidator = [
  requiredUUID('patient_uid'),
  requiredNumber('total_amount', { min: 0 }),
  optionalString('description', 500),
  optionalEnum('payment_method', ['CASH', 'CARD', 'UPI', 'INSURANCE', 'CHEQUE']),
];

/** Billing payment */
export const paymentValidator = [
  paramId('id'),
  requiredNumber('amount', { min: 0 }),
  requiredEnum('payment_method', ['CASH', 'CARD', 'UPI', 'INSURANCE', 'CHEQUE']),
  optionalString('reference_number', 100),
  optionalString('notes', 500),
];

/** Insurance claim */
export const insuranceClaimValidator = [
  requiredUUID('patient_uid'),
  requiredString('policy_number', 50),
  requiredString('insurer_name', 200),
  requiredNumber('claim_amount', { min: 0 }),
  optionalString('description', 1000),
];

/** Radiology order */
export const radiologyOrderValidator = [
  requiredUUID('patient_uid'),
  requiredString('study_type', 200),
  optionalString('clinical_indication', 500),
  optionalEnum('priority', ['ROUTINE', 'URGENT', 'STAT']),
  optionalString('notes', 500),
];

/** Blood bank request */
export const bloodRequestValidator = [
  requiredUUID('patient_uid'),
  requiredEnum('blood_group', ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']),
  requiredNumber('units', { min: 1, max: 10 }),
  requiredEnum('component', ['WHOLE_BLOOD', 'PACKED_RBC', 'PLATELETS', 'FFP', 'CRYOPRECIPITATE']),
  optionalString('clinical_indication', 500),
  optionalEnum('priority', ['ROUTINE', 'URGENT', 'EMERGENCY']),
];

/** Dietary order */
export const dietaryOrderValidator = [
  requiredUUID('patient_uid'),
  requiredString('diet_type', 100),
  optionalString('restrictions', 500),
  optionalString('allergies', 500),
  optionalString('notes', 500),
];

/** Operating theatre schedule */
export const theatreScheduleValidator = [
  requiredUUID('patient_uid'),
  requiredString('procedure_name', 300),
  requiredString('surgeon_uid'),
  requiredDate('scheduled_date'),
  optionalString('anesthesia_type', 100),
  optionalString('notes', 500),
  optionalEnum('priority', ['ELECTIVE', 'URGENT', 'EMERGENCY']),
];

/** Referral */
export const referralValidator = [
  requiredUUID('patient_uid'),
  requiredString('from_doctor_uid'),
  requiredString('to_department', 100),
  requiredString('reason', 1000),
  optionalEnum('priority', ['ROUTINE', 'URGENT', 'EMERGENCY']),
  optionalString('notes', 500),
];

/** Consent grant/revoke */
export const consentValidator = [
  requiredUUID('patient_uid'),
  requiredString('consent_type', 100),
  optionalString('purpose', 500),
];

/** Messaging */
export const messageValidator = [
  requiredString('to_uid'),
  requiredString('content', 2000),
  optionalEnum('priority', ['LOW', 'NORMAL', 'HIGH', 'URGENT']),
];

/** Medication reminder */
export const reminderValidator = [
  requiredString('medication_name', 255),
  requiredString('dosage', 100),
  requiredString('frequency', 100),
  optionalDate('start_date'),
  optionalDate('end_date'),
  optionalString('notes', 500),
];

/** Breach report */
export const breachReportValidator = [
  requiredString('description', 2000),
  requiredEnum('severity', ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  requiredString('affected_data_types', 500),
  optionalNumber('individuals_affected', { min: 0 }),
  optionalString('containment_actions', 2000),
];

/** Quality/infection incident */
export const qualityIncidentValidator = [
  requiredString('description', 2000),
  requiredEnum('category', ['MEDICATION_ERROR', 'FALL', 'INFECTION', 'EQUIPMENT_FAILURE', 'PROCEDURE_ERROR', 'OTHER']),
  requiredEnum('severity', ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  optionalString('location', 200),
  optionalUUID('patient_uid'),
];

function optionalUUID(name) {
  return body(name).optional({ nullable: true }).isUUID().withMessage(`${name} must be a valid UUID`);
}

/** System settings update */
export const systemSettingsValidator = [
  body('settings').exists().withMessage('settings is required').isObject().withMessage('settings must be an object'),
];

/** Feature flag */
export const featureFlagValidator = [
  requiredString('name', 100),
  requiredBool('is_enabled'),
  optionalString('description', 500),
];

/** Doctor create */
export const doctorCreateValidator = [
  requiredString('name', 255),
  optionalString('specialty', 100),
  optionalString('department', 100),
  optionalPhone('phone'),
  optionalString('email', 255),
  optionalString('qualification', 255),
];

function optionalPhone(name = 'phone') {
  return body(name).optional({ nullable: true }).matches(/^\+?\d{10,15}$/).withMessage(`${name} must be a valid phone number`);
}
