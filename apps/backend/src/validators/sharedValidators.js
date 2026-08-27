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
//
// Each array below mirrors the LIVE contract of exactly one route (named in
// its docblock) — the field names and required/optional split come from what
// the mounted controller/service actually reads, not from any aspirational
// shape. When changing one, re-read the route + service first; a field the
// handler treats as optional must stay `.optional()` here.

// Small private helpers used by the domain validators.
function optionalBool(name) {
  return body(name)
    .optional({ nullable: true })
    .isBoolean().withMessage(`${name} must be a boolean`)
    .toBoolean();
}

function optionalUUID(name) {
  return body(name).optional({ nullable: true }).isUUID().withMessage(`${name} must be a valid UUID`);
}

function optionalNumeric(name) {
  // Type-only numeric check: no clinical range enforcement (see
  // vitalsValidator note below).
  return body(name)
    .optional({ nullable: true })
    .isFloat().withMessage(`${name} must be a number`)
    .toFloat();
}

function optionalInt(name, { min, max } = {}) {
  return body(name)
    .optional({ nullable: true })
    .isInt({ min, max }).withMessage(`${name} must be an integer`)
    .toInt();
}

function optionalArray(name, { min } = {}) {
  const chain = body(name).optional({ nullable: true });
  return min
    ? chain.isArray({ min }).withMessage(`${name} must be a non-empty array`)
    : chain.isArray().withMessage(`${name} must be an array`);
}

function requiredArray(name, { min = 1 } = {}) {
  return body(name)
    .exists().withMessage(`${name} is required`)
    .isArray({ min }).withMessage(`${name} must be a non-empty array`);
}

/**
 * Clinical vitals — POST /emr/vitals (routes/emr/vitalsRoutes.js).
 * Type/shape validation ONLY, deliberately: every vital is optional (partial
 * charting is legitimate) and clinical range/alarm bounds belong to the
 * vitals alarm-integrity work (vitalSignMonitor / open finding C-M4), not
 * this transport-shape gate.
 */
export const vitalsValidator = [
  optionalUUID('patient_uid'),
  optionalInt('patient_id', { min: 1 }),
  optionalInt('visit_id', { min: 1 }),
  body().custom((value) => {
    if (!value?.patient_uid && !value?.patient_id) {
      throw new Error('patient_uid or patient_id is required');
    }
    return true;
  }),
  optionalNumeric('heart_rate'),
  optionalNumeric('systolic_bp'),
  optionalNumeric('diastolic_bp'),
  optionalNumeric('temperature'),
  optionalNumeric('spo2'),
  optionalInt('spo2_scale', { min: 1, max: 2 }),
  optionalNumeric('respiratory_rate'),
  optionalNumeric('blood_glucose'),
  optionalNumeric('pain_score'),
  optionalNumeric('weight_kg'),
  optionalNumeric('height_cm'),
  optionalNumeric('gcs_score'),
  optionalNumeric('o2_flow_rate'),
  optionalNumeric('fhr'),
  optionalNumeric('fundal_height_cm'),
  optionalBool('supplemental_o2'),
];

/**
 * MAR schedule — POST /clinical/mar/schedule (routes/clinical/clinicalRoutes.js).
 * The live payload is { patient_uid, prescription_id?, medications?: [...] };
 * per-medication field validation (medication_name/dose/route/scheduled_time,
 * frequency expansion) lives in marService.scheduleMedications, which 400s
 * with precise messages — this gate checks the envelope shape only.
 */
export const marScheduleValidator = [
  requiredUUID('patient_uid'),
  optionalArray('medications'),
  body('medications.*').isObject().withMessage('each medication must be an object'),
  body('medications.*.clinical_order_id')
    .optional({ nullable: true })
    .isInt({ min: 1 }).withMessage('clinical_order_id must be a positive integer')
    .toInt(),
  body('medications.*.supply_quantity_per_dose')
    .optional({ nullable: true })
    .isFloat({ gt: 0 }).withMessage('supply_quantity_per_dose must be positive')
    .toFloat(),
];

/** MAR administration — POST /clinical/mar/:id/administer (clinicalRoutes.js). */
export const marAdministerValidator = [
  paramId('id'),
  optionalString('notes', 500),
  optionalString('override_reason', 500),
  optionalString('supply_override_reason', 500),
  optionalNumber('supply_quantity', { min: Number.MIN_VALUE }),
  optionalUUID('witness_uid'),
];

/** Nurse handover — POST /clinical/handover (clinicalRoutes.js → handoverService.createHandover). */
export const handoverValidator = [
  requiredUUID('patient_uid'),
  requiredString('summary', 2000),
  body('incoming_nurse')
    .exists({ checkFalsy: true }).withMessage('incoming_nurse is required')
    .isUUID().withMessage('incoming_nurse must be a valid UUID'),
  requiredString('shift', 20),
  optionalString('patient_summary', 2000),
  optionalString('ward', 100),
  optionalString('bed_number', 50),
  optionalUUID('outgoing_nurse'),
  optionalArray('active_issues'),
  optionalArray('pending_tasks'),
  optionalArray('medications_due'),
  optionalString('special_instructions', 2000),
];

/** Billing invoice — POST /billing/invoice (routes/billing/billingRoutes.js → billingService.createInvoice). */
export const invoiceValidator = [
  requiredUUID('patient_uid'),
  requiredString('type', 50),
  requiredArray('items'),
  body('items.*').isObject().withMessage('each invoice item must be an object'),
  // subtotal 0 is legal (full discount) — exists() without checkFalsy.
  body('subtotal')
    .exists({ checkNull: true }).withMessage('subtotal is required')
    .isFloat({ min: 0 }).withMessage('subtotal must be a non-negative number')
    .toFloat(),
  // A fully discounted invoice may legitimately total zero as well.
  body('total_amount')
    .exists({ checkNull: true }).withMessage('total_amount is required')
    .isFloat({ min: 0 }).withMessage('total_amount must be a non-negative number')
    .toFloat(),
  optionalNumber('tax_amount', { min: 0 }),
  optionalNumber('discount_amount', { min: 0 }),
  optionalString('notes', 1000),
];

/** Billing payment — POST /billing/invoice/:id/payment (billingRoutes.js → billingService.recordPayment). */
export const paymentValidator = [
  paramId('id'),
  requiredNumber('amount', { min: 0 }),
  body('payment_method')
    .exists({ checkFalsy: true }).withMessage('payment_method is required')
    .isString().withMessage('payment_method must be a string')
    .custom((value) => typeof value === 'string'
      && ['cash', 'card', 'upi', 'insurance', 'cheque'].includes(value.toLowerCase()))
    .withMessage('payment_method must be one of: cash, card, upi, insurance, cheque')
    .customSanitizer((value) => typeof value === 'string' ? value.toLowerCase() : value),
  optionalString('transaction_ref', 100),
];

/** Insurance claim — POST /billing/insurance/claim (billingRoutes.js → billingService.submitInsuranceClaim). */
export const insuranceClaimValidator = [
  requiredUUID('patient_uid'),
  requiredString('policy_number', 50),
  requiredString('insurance_provider', 200),
  requiredNumber('claim_amount', { min: 0 }),
  optionalInt('invoice_id'),
  optionalArray('documents'),
];

/**
 * Radiology order — POST /radiology/orders (routes/radiology/radiologyRoutes.js).
 * priority is validated (case-insensitively, with defaulting) by
 * radiologyService.normalisePriority — not duplicated here.
 */
export const radiologyOrderValidator = [
  requiredUUID('patient_uid'),
  requiredString('modality', 50),
  requiredString('body_part', 100),
  optionalString('clinical_indication', 500),
  optionalString('notes', 500),
  body('contrast_planned').optional({ nullable: true })
    .isBoolean().withMessage('contrast_planned must be a boolean'),
  optionalString('contrast_agent', 120),
  // Acknowledged contrast-allergy override (mirrors the prescription CDS
  // override shape): { override: { reason, approvedBy? } }. The service
  // enforces the >=5-char reason rule; here we only shape-check.
  optionalString('override.reason', 500),
];

/** Contrast plan amendment — PUT /radiology/:id/contrast (routes/radiology/radiologyRoutes.js → radiologyService.setContrastPlan). */
export const radiologyContrastPlanValidator = [
  body('contrast_planned').optional({ nullable: true })
    .isBoolean().withMessage('contrast_planned must be a boolean'),
  optionalString('contrast_agent', 120),
  // Required by the service when the amendment clears an existing contrast
  // plan (contrast_planned true → false); shape-checked only here.
  optionalString('reason', 500),
  optionalString('override.reason', 500),
];

/** Blood bank request — POST /blood-bank/request (routes/bloodbank/bloodBankRoutes.js → bloodBankService.createRequest). */
export const bloodRequestValidator = [
  requiredUUID('patient_uid'),
  requiredEnum('blood_group', ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']),
  body('units')
    .exists({ checkFalsy: true }).withMessage('units is required')
    .isInt({ min: 1, max: 10 }).withMessage('units must be an integer between 1 and 10')
    .toInt(),
  requiredEnum('component', ['whole_blood', 'prbc', 'ffp', 'platelets', 'cryoprecipitate']),
  requiredString('clinical_indication', 500),
  optionalEnum('urgency', ['routine', 'urgent', 'emergency']),
];

/** Dietary order — POST /dietary/orders (routes/dietary/dietaryRoutes.js → dietaryService.createDietOrder). */
export const dietaryOrderValidator = [
  requiredUUID('patient_uid'),
  requiredEnum('diet_type', ['regular', 'diabetic', 'cardiac', 'renal', 'soft', 'liquid', 'npo', 'enteral']),
  // toTextArray in the service accepts an array of strings OR a single
  // delimited string for both fields.
  body('restrictions').optional({ nullable: true })
    .custom((v) => Array.isArray(v) || typeof v === 'string')
    .withMessage('restrictions must be an array or a string'),
  body('allergies').optional({ nullable: true })
    .custom((v) => Array.isArray(v) || typeof v === 'string')
    .withMessage('allergies must be an array or a string'),
  optionalString('meal_preferences', 500),
  optionalNumber('calories_target', { min: 0 }),
  optionalString('special_instructions', 1000),
];

/** Operating theatre schedule — POST /theatre/schedule (routes/theatre/theatreRoutes.js → theatreService.scheduleSurgery). */
export const theatreScheduleValidator = [
  requiredUUID('patient_uid'),
  requiredString('procedure_name', 300),
  body('surgeon')
    .exists({ checkFalsy: true }).withMessage('surgeon is required')
    .isUUID().withMessage('surgeon must be a valid UUID'),
  requiredDate('scheduled_date'),
  optionalString('procedure_code', 50),
  optionalString('ot_room', 50),
  optionalString('scheduled_time', 20),
  optionalNumber('estimated_duration', { min: 1 }),
  optionalArray('equipment_needed'),
  body('equipment_needed.*')
    .isString().withMessage('each equipment_needed item must be a string')
    .trim()
    .isLength({ min: 1, max: 200 }).withMessage('each equipment_needed item must be between 1 and 200 characters'),
  optionalBool('blood_arranged'),
  optionalBool('consent_obtained'),
];

/**
 * Referral — POST /referral (routes/referral/referralRoutes.js).
 * The department is accepted under either its canonical name
 * (referred_to_department) or the legacy alias (to_department) — see the
 * dual-field finding cited in the route. referring_doctor derives from the
 * JWT, never from the body (except for referral admins).
 */
export const referralValidator = [
  requiredUUID('patient_uid'),
  requiredString('reason', 1000),
  body().custom((value) => {
    const department = value?.referred_to_department || value?.to_department;
    if (!department || typeof department !== 'string' || !department.trim()) {
      throw new Error('referred_to_department (or to_department) is required');
    }
    return true;
  }),
  optionalString('referred_to_department', 100),
  optionalString('to_department', 100),
  optionalString('clinical_summary', 2000),
];

/** Consent grant — POST /consent/grant (routes/consentRoutes.js). */
export const consentValidator = [
  requiredUUID('patient_uid'),
  requiredString('consent_type', 100),
  optionalString('notes', 1000),
  optionalString('purpose', 500),
  optionalArray('data_categories'),
  body('data_categories.*')
    .isString().withMessage('each data category must be a string')
    .trim()
    .isLength({ min: 1, max: 100 }).withMessage('each data category must be between 1 and 100 characters'),
  optionalDate('expires_at'),
  optionalEnum('consent_method', ['signature', 'thumbprint', 'verbal']),
  optionalString('witness_name', 160),
  optionalUUID('witness_uid'),
  optionalString('form_language', 30),
];

/**
 * Messaging — POST /messaging/send (routes/messaging/messagingRoutes.js).
 * Runs AFTER normalizeSendPayload, which maps the legacy to_uid/content
 * aliases onto recipient_uid/body and lowercases priority.
 */
export const messageValidator = [
  requiredUUID('recipient_uid'),
  requiredString('body', 2000),
  optionalEnum('priority', ['normal', 'urgent', 'critical']),
  optionalUUID('patient_uid'),
];

/** Medication reminder — POST /reminders/medication (controllers/patient/medicationReminderController.createReminder). */
export const reminderValidator = [
  requiredString('medication_name', 255),
  requiredString('dosage', 100),
  // Frequency aliases (OD/BD/TDS/QID/…) are normalised by the controller.
  requiredString('frequency', 100),
  requiredArray('reminder_times'),
  body('reminder_times.*')
    .isString().withMessage('each reminder time must be a string')
    .matches(/^(?:[01]\d|2[0-3]):[0-5]\d$/).withMessage('each reminder time must use HH:MM in 24-hour time'),
  requiredDate('start_date'),
  optionalDate('end_date'),
  optionalString('notes', 500),
];

/** Breach report — POST /compliance/breach/report (routes/compliance/breachRoutes.js → breachService.reportBreach). */
export const breachReportValidator = [
  requiredString('title', 255),
  requiredString('description', 2000),
  requiredEnum('severity', ['low', 'medium', 'high', 'critical']),
  optionalInt('affected_records', { min: 0 }),
  optionalArray('affected_patient_uids'),
  body('affected_patient_uids.*').isUUID().withMessage('each affected patient UID must be a valid UUID'),
  body('phi_involved')
    .optional({ nullable: true })
    .isBoolean({ strict: true })
    .withMessage('phi_involved must be a boolean'),
];

/** Quality incident — POST /quality/incidents (routes/quality/qualityRoutes.js). */
export const qualityIncidentValidator = [
  requiredString('description', 2000),
  requiredEnum('incident_type', ['fall', 'medication_error', 'infection', 'equipment_failure', 'near_miss', 'complaint', 'other']),
  requiredEnum('severity', ['minor', 'moderate', 'major', 'sentinel', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  requiredDate('date_occurred'),
  optionalString('location', 200),
  optionalUUID('patient_uid'),
];

/**
 * System settings update — PUT /system/settings
 * (controllers/system/systemController.updateSettings). The live payload is
 * a flat object of setting keys (filtered against DEFAULT_SETTINGS in the
 * controller) — there is no `settings` wrapper.
 */
export const systemSettingsValidator = [
  body().custom((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('request body must be a settings object');
    }
    return true;
  }),
];

/** Legacy doctor directory create — POST /doctor (routes/doctor/adminDoctorRoutes.js → adminDoctorController.addDoctor). */
export const doctorCreateValidator = [
  requiredString('name', 255),
  requiredString('department', 100),
  optionalString('intro', 2000),
  optionalString('imageUrl', 500),
];
