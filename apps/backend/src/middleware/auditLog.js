/**
 * Universal Audit Log Middleware
 * Captures every API request after response. Fire-and-forget — never blocks the request.
 *
 * Usage: app.use(auditLogMiddleware) — add AFTER auth middleware so req.user is populated.
 *
 * Skips:
 * - GET requests to read-only list/stats endpoints (too noisy) — configurable
 * - Health checks and static assets
 * Audit-log reads and exports are deliberately included so access to the audit
 * trail is itself auditable.
 */

import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { normalizeAuditLogUserId } from '../utils/auditLogIdentity.js';
import { isHl7ReceiveEndpoint } from '../utils/urlRedaction.js';

let pendingAuditLogs = 0;
const MAX_PENDING_AUDIT_LOGS = 1000;

// ─── Durable file fallback ────────────────────────────────────────────────────
// The "audit never lost" guarantee: when the universal audit row cannot reach
// the DB — whether because the bounded queue is full (backpressure drop) or the
// INSERT itself failed — the entry is written to the Winston file sink instead
// of being silently dropped. Error severity makes the fallback both durable in
// error.log/combined.log and visible to the production alerting pipeline. The inner
// try/catch keeps even a logger/transport failure from escaping (last resort:
// console.error) since several call sites run inside detached setImmediate
// callbacks where a throw would become an unhandled rejection.
function _auditLogToFile(reason, entry) {
  try {
    logger.error(`Audit log ${reason}, writing to file fallback:`, entry);
  } catch (logErr) {
    try {
      console.error('AUDIT_LOG file fallback failed:', reason, JSON.stringify(entry), logErr?.message);
    } catch {
      // Nothing more we can safely do; never throw out of the audit path.
    }
  }
}

// ─── Path → module mapping ───────────────────────────────────────────────────
export function deriveModule(path) {
  const p = String(path || '').toLowerCase();
  if (p.includes('/auth'))              return 'auth';
  if (p.includes('/attendance'))        return 'attendance';
  if (p.includes('/leave'))             return 'leave';
  if (p.includes('/shift'))             return 'shifts';
  if (p.includes('/incident'))          return 'incidents';
  if (p.includes('/grievance'))         return 'grievances';
  if (p.includes('/housekeeping'))      return 'housekeeping';
  if (p.includes('/overtime'))          return 'overtime';
  if (p.includes('/replacement'))       return 'replacement';
  if (p.includes('/regulariz'))         return 'regularization';
  if (p.includes('/dispute'))           return 'disputes';
  if (p.includes('/doctor'))            return 'doctors';
  if (p.includes('/appointment'))       return 'appointments';
  if (p.includes('/lab/alerts/critical')) return 'critical_lab_alerts';
  if (p.includes('/emr/notes'))         return 'clinical_notes';
  if (p.includes('/medical/consultations')) return 'clinical_notes';
  if (p.includes('/emr/orders'))        return 'clinical_orders';
  if (p.includes('/emr/vitals'))        return 'vitals';
  if (p.includes('/emr/io'))            return 'intake_output';
  if (p.includes('/emr/timeline'))      return 'clinical_timeline';
  if (p.includes('/emr/case-sheet'))    return 'case_sheet';
  if (p.includes('/drug-chart') || p.includes('/clinical/drug-chart')) return 'drug_chart';
  if (p.includes('/discharge-summaries')) return 'discharge_summaries';
  if (p.includes('/prescription'))        return 'prescriptions';
  if (p.includes('/diagnos'))             return 'diagnoses';
  if (p.includes('/referral'))            return 'referrals';
  if (p.includes('/blood-bank') || p.includes('/bloodbank')) return 'blood_bank';
  if (p.includes('/mar'))                 return 'medication_administration';
  if (p.includes('/handover'))            return 'handovers';
  if (p.includes('/theatre'))             return 'theatre';
  if (p.includes('/admission'))         return 'admissions';
  if (p.includes('/patient'))           return 'patients';
  if (p.includes('/pharmacy'))          return 'pharmacy';
  if (p.includes('/investigation'))     return 'investigations';
  if (p.includes('/bed'))               return 'beds';
  if (p.includes('/department'))        return 'departments';
  if (p.includes('/staff'))             return 'staff';
  if (p.includes('/user'))              return 'users';
  if (p.includes('/admin'))             return 'admin';
  if (p.includes('/setting'))           return 'settings';
  if (p.includes('/report'))            return 'reports';
  if (p.includes('/audit'))             return 'audit';
  if (p.includes('/notification'))      return 'notifications';
  if (p.includes('/log'))               return 'logs';
  return 'other';
}

// ─── Method + path → human action ───────────────────────────────────────────
export function deriveAction(method, path) {
  const p = path.toLowerCase();
  const m = method.toUpperCase();

  // Auth
  if (p.includes('/login'))    return 'login';
  if (p.includes('/logout'))   return 'logout';
  if (p.includes('/register')) return 'register';
  if (p.includes('/reset'))    return 'password_reset';

  // Audit oversight. These checks intentionally precede generic admin/user
  // matching so viewing and exporting the trail is itself a named action.
  if (p.includes('/admin/audit') && p.includes('/export')) return 'export_audit_events';
  if (p.includes('/admin/audit') && p.includes('/health')) return 'view_audit_health';
  if (p.includes('/admin/audit') && m === 'GET')           return 'view_audit_events';

  // Leave
  if (p.includes('/leave/apply'))                             return 'apply_leave';
  if (p.includes('/leave') && p.includes('/approve'))        return 'approve_leave';
  if (p.includes('/leave') && p.includes('/reject'))         return 'reject_leave';
  if (p.includes('/leave-balance'))                          return 'view_leave_balance';

  // Attendance
  if (p.includes('/attendance') && m === 'POST')             return 'mark_attendance';
  if (p.includes('/regulariz') && m === 'POST')              return 'request_regularization';
  if (p.includes('/regulariz') && p.includes('/approve'))    return 'approve_regularization';
  if (p.includes('/dispute') && m === 'POST')                return 'submit_dispute';
  if (p.includes('/dispute') && p.includes('/resolve'))      return 'resolve_dispute';
  if (p.includes('/break/start'))                            return 'start_break';
  if (p.includes('/break/end'))                              return 'end_break';
  if (p.includes('/calendar'))                               return 'view_calendar';
  if (p.includes('/bulk-correct'))                           return 'bulk_attendance_correction';

  // Overtime
  if (p.includes('/overtime/request'))                       return 'request_overtime';
  if (p.includes('/overtime') && p.includes('/approve'))     return 'approve_overtime';

  // Replacement
  if (p.includes('/replacement/request'))                    return 'request_replacement';
  if (p.includes('/replacement') && p.includes('/respond'))  return 'respond_replacement';
  if (p.includes('/replacement') && p.includes('/hr-approve')) return 'hr_approve_replacement';

  // Shifts
  if (p.includes('/shifts/assign'))                                  return 'assign_shift';
  if (p.includes('/shifts/custom') && m === 'POST')                  return 'create_custom_shift';
  if (p.includes('/shifts/custom') && m === 'PUT')                   return 'update_custom_shift';
  if (p.includes('/shifts/custom') && m === 'DELETE')                return 'deactivate_shift';

  // Incidents & Grievances
  if (p.includes('/incidents/submit'))                               return 'submit_incident';
  if (p.includes('/incidents') && p.includes('/update'))             return 'update_incident';
  if (p.includes('/grievances/submit'))                              return 'submit_grievance';
  if (p.includes('/grievances') && p.includes('/update'))            return 'update_grievance';

  // Staff clinical adapters must be classified before generic /staff routes.
  if (p.includes('/staff/medical/consultations') && m === 'POST') return 'create_clinical_note';
  if (p.includes('/staff/medical/investigations') && m === 'POST') return 'record_investigation_result';

  // Staff/Users
  if (m === 'POST'   && (p.includes('/staff') || p.includes('/user'))) return 'create_user';
  if (m === 'PUT'    && (p.includes('/staff') || p.includes('/user'))) return 'update_user';
  if (m === 'DELETE' && (p.includes('/staff') || p.includes('/user'))) return 'delete_user';
  if (p.includes('/archive'))                                        return 'archive_staff';

  // Patients
  if (m === 'POST' && p.includes('/patient')) return 'create_patient';
  if (m === 'PUT'  && p.includes('/patient')) return 'update_patient';

  // Appointments / Front Office queue
  if (p.includes('/appointment') && p.includes('/cancel'))           return 'cancel_appointment';
  if (p.includes('/appointment') && p.includes('/confirm'))          return 'confirm_appointment';
  if (p.includes('/appointment') && p.includes('/no-show'))          return 'mark_appointment_no_show';
  if (p.includes('/appointment') && p.includes('/reschedule'))       return 'reschedule_appointment';
  if (p.includes('/appointment') && p.includes('/complete'))         return 'complete_appointment';
  if (p.includes('/appointment') && p.includes('/walk-in'))          return 'register_walk_in';
  if (p.includes('/appointment') && p.includes('/advise-admission')) return 'advise_ip_admission';
  if (p.includes('/appointment') && p.includes('/status'))           return 'update_appointment_status';
  if (m === 'POST' && p.includes('/appointment'))                    return 'book_appointment';

  // IP admission / discharge / transfer
  if (p.includes('/admission') && p.includes('/assign-bed'))         return 'assign_admission_bed';
  if (p.includes('/admission') && p.includes('/mark-for-discharge')) return 'mark_for_discharge';
  if (p.includes('/admission') && p.includes('/consults') && p.includes('/complete')) return 'complete_discharge_work_item';
  if (p.includes('/admission') && p.includes('/mark-drugs-dispensed')) return 'mark_discharge_drugs_dispensed';
  if (p.includes('/admission') && p.includes('/discharge-hub'))      return 'view_discharge_hub';
  if (p.includes('/admission') && p.includes('/discharge'))          return 'final_discharge';
  if (p.includes('/admission') && p.includes('/transfer'))           return 'transfer_inpatient';
  if (m === 'POST' && p.includes('/admission'))                     return 'create_ip_admission';

  // IP vitals and I/O
  if (p.includes('/emr/notes') && p.includes('/sign'))             return 'sign_clinical_note';
  if (p.includes('/emr/notes') && m === 'POST')                    return 'create_clinical_note';
  if (p.includes('/emr/notes') && (m === 'PUT' || m === 'PATCH'))  return 'update_clinical_note';
  if (p.includes('/emr/notes') && m === 'GET')                     return 'view_clinical_notes';
  if (p.includes('/emr/orders') && p.includes('/verify'))          return 'verify_clinical_order';
  if (p.includes('/emr/orders') && p.includes('/complete'))        return 'complete_clinical_order';
  if (p.includes('/emr/orders') && p.includes('/discontinue'))     return 'discontinue_clinical_order';
  if (p.includes('/emr/orders') && m === 'POST')                   return 'create_clinical_order';
  if (p.includes('/emr/orders') && m === 'GET')                    return 'view_clinical_orders';
  if (p.includes('/emr/timeline') && m === 'GET')                  return 'view_patient_timeline';
  if (p.includes('/emr/case-sheet') && m === 'GET')                return 'view_case_sheet';
  if ((p.includes('/drug-chart') || p.includes('/clinical/drug-chart')) && m === 'GET') return 'view_drug_chart';
  if ((p.includes('/drug-chart') || p.includes('/clinical/drug-chart')) && m !== 'GET') return 'update_drug_chart';
  if (p.includes('/discharge-summaries') && p.includes('/sign'))   return 'sign_discharge_summary';
  if (p.includes('/discharge-summaries') && m === 'POST')          return 'create_discharge_summary';
  if (p.includes('/discharge-summaries') && (m === 'PUT' || m === 'PATCH')) return 'update_discharge_summary';
  if (p.includes('/discharge-summaries') && m === 'GET')           return 'view_discharge_summary';

  // IP vitals and I/O
  if (p.includes('/emr/vitals') && m === 'POST')                     return 'record_vitals';
  if (p.includes('/emr/vitals') && (m === 'PUT' || m === 'PATCH'))   return 'correct_vitals';
  if (p.includes('/emr/vitals') && m === 'GET')                      return 'view_vitals';
  if (p.includes('/emr/io') && m === 'POST')                         return 'record_io';
  if (p.includes('/emr/io') && m === 'GET')                          return 'view_io_balance';

  // Beds and housekeeping
  if (p.includes('/beds') && p.includes('/ready'))                   return 'mark_bed_ready';
  if (p.includes('/beds') && p.includes('/clean'))                   return 'request_bed_cleaning';
  if (p.includes('/beds') && p.includes('/transfer'))                return 'transfer_bed';
  if (p.includes('/beds') && p.includes('/notes'))                   return 'update_bed_notes';
  if (p.includes('/beds') && p.includes('/status'))                  return 'update_bed_status';
  if (p.includes('/housekeeping') && p.includes('/assign'))          return 'assign_housekeeping_task';
  if (p.includes('/housekeeping') && p.includes('/logs') && m === 'POST') return 'submit_housekeeping_log';
  if (p.includes('/housekeeping') && p.includes('/start'))           return 'start_housekeeping_task';
  if (p.includes('/housekeeping') && p.includes('/request') && m === 'POST') return 'create_housekeeping_request';
  if (p.includes('/housekeeping') && p.includes('/complete'))        return 'complete_housekeeping_task';
  if (p.includes('/housekeeping') && p.includes('/verify'))          return 'verify_housekeeping_task';

  // Notifications and safety acknowledgement
  if (p.includes('/lab/alerts/critical') && p.includes('/ack'))      return 'acknowledge_critical_lab_alert';
  if (p.includes('/lab/alerts/critical'))                            return 'view_critical_lab_alert';
  if (p.includes('/notifications') && p.includes('/ack'))            return 'acknowledge_alert';
  if (p.includes('/notifications') && p.includes('/read'))           return 'mark_alert_read';

  // Investigations
  if (p.includes('/investigation') && p.includes('/notif'))          return 'send_investigation_notification';
  if (p.includes('/investigation') && p.includes('/collect'))        return 'collect_investigation_sample';
  if (p.includes('/investigation') && p.includes('/reject'))         return 'reject_investigation_sample';
  if (p.includes('/investigation') && p.includes('/result'))         return 'record_investigation_result';
  if (p.includes('/investigation') && p.includes('/status'))         return 'update_investigation_status';
  if (m === 'POST' && p.includes('/investigation'))                  return 'create_investigation';

  // Diagnoses, prescriptions, referrals, MAR, handovers, theatre, blood bank
  if (p.includes('/diagnos') && p.includes('/status'))               return 'update_diagnosis_status';
  if (p.includes('/diagnos') && m === 'POST')                        return 'record_diagnosis';
  if (p.includes('/prescription') && p.includes('/sign'))            return 'sign_prescription';
  if (p.includes('/prescription') && m === 'POST')                   return 'create_prescription';
  if (p.includes('/prescription') && (m === 'PUT' || m === 'PATCH')) return 'update_prescription';
  if (p.includes('/referral') && p.includes('/accept'))              return 'accept_referral';
  if (p.includes('/referral') && p.includes('/declin'))              return 'decline_referral';
  if (p.includes('/referral') && p.includes('/complete'))            return 'complete_referral';
  if (p.includes('/referral') && p.includes('/seen'))                return 'mark_referral_seen';
  if (p.includes('/referral') && m === 'POST')                       return 'create_referral';
  if (p.includes('/mar') && p.includes('/administer'))               return 'administer_medication';
  if (p.includes('/mar') && p.includes('/miss'))                     return 'mark_medication_missed';
  if (p.includes('/mar') && p.includes('/hold'))                     return 'hold_medication';
  if (p.includes('/handover') && p.includes('/ack'))                 return 'acknowledge_handover';
  if (p.includes('/handover') && m === 'POST')                       return 'create_handover';
  if (p.includes('/theatre') && p.includes('/cancel'))               return 'cancel_theatre_case';
  if (p.includes('/theatre') && p.includes('/checklist'))            return 'update_theatre_checklist';
  if (p.includes('/theatre') && p.includes('/status'))               return 'update_theatre_status';
  if (p.includes('/theatre') && m === 'POST')                        return 'schedule_theatre_case';
  if ((p.includes('/blood-bank') || p.includes('/bloodbank')) && p.includes('/cross')) return 'crossmatch_blood';
  if ((p.includes('/blood-bank') || p.includes('/bloodbank')) && p.includes('/issue')) return 'issue_blood';
  if ((p.includes('/blood-bank') || p.includes('/bloodbank')) && p.includes('/transfus')) return 'record_transfusion';
  if ((p.includes('/blood-bank') || p.includes('/bloodbank')) && m === 'POST') return 'request_blood';

  // Pharmacy
  if (m === 'POST' && p.includes('/pharmacy'))                       return 'pharmacy_action';

  // Settings
  if (m === 'PUT'  && p.includes('/setting')) return 'update_settings';
  if (m === 'POST' && p.includes('/setting')) return 'update_settings';

  // Generic
  if (m === 'GET')    return 'view';
  if (m === 'POST')   return 'create';
  if (m === 'PUT')    return 'update';
  if (m === 'PATCH')  return 'patch';
  if (m === 'DELETE') return 'delete';
  return 'unknown';
}

// ─── Sensitive fields to redact ──────────────────────────────────────────────
const REDACT_FIELDS = new Set([
  'password', 'password_hash', 'token', 'access_token', 'refresh_token',
  'secret', 'api_key', 'apikey', 'authorization', 'otp', 'pin',
  'ssn', 'aadhar', 'pan', 'bank_account',
]);

const CLINICAL_TEXT_FIELDS = new Set([
  'content', 'note', 'notes', 'clinical_notes', 'result', 'results',
  'structured_results', 'result_summary', 'interpretation', 'findings',
  'diagnosis', 'diagnoses', 'symptoms', 'chief_complaint', 'history',
  'subjective', 'objective', 'examination', 'assessment', 'plan',
  'treatment_plan', 'clinical_summary', 'response_notes', 'completion_notes',
  'follow_up_notes', 'instructions', 'discharge_summary',
]);

const ALLOWED_DEVICE_TYPES = new Set(['mobile', 'tablet', 'desktop', 'web']);

function normalizeDeviceType(value) {
  if (value === null || value === undefined) return null;
  const text = String(Array.isArray(value) ? value[0] : value)
    .trim()
    .toLowerCase();
  return ALLOWED_DEVICE_TYPES.has(text) ? text : null;
}

function requestDeviceType(req) {
  return normalizeDeviceType(
    req.headers?.['x-device-type'] ?? req.headers?.['x-vh-device-type'],
  );
}

export function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return null;
  try {
    const cleaned = {};
    for (const [k, v] of Object.entries(body)) {
      if (REDACT_FIELDS.has(k.toLowerCase())) {
        cleaned[k] = '[REDACTED]';
      } else if (CLINICAL_TEXT_FIELDS.has(k.toLowerCase())) {
        cleaned[k] = '[REDACTED_CLINICAL_TEXT]';
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        cleaned[k] = sanitizeBody(v);
      } else if (Array.isArray(v)) {
        cleaned[k] = `[Array(${v.length})]`;
      } else {
        cleaned[k] = v;
      }
    }
    const summary = JSON.stringify(cleaned);
    return summary.length > 500 ? summary.substring(0, 500) + '…' : summary;
  } catch {
    return '[unserializable]';
  }
}

function excludesAuditRequestBody(cleanPath) {
  // HL7 fields can carry PHI at arbitrary positions, including hostile query
  // input, so this endpoint cannot safely derive audit context from either.
  return isHl7ReceiveEndpoint(String(cleanPath || ''));
}

// ─── Paths to skip entirely ──────────────────────────────────────────────────
// '/pay/' is the public bill-payment landing page (audit F8). Its URL carries
// the payment link_token, which IS the bearer credential for that link — the
// same reason paymentLinkService never logs it. Auditing the path would persist
// the credential into audit_logs (and the Winston file fallback), so this
// unauthenticated read-only page is skipped outright. Matching is on '/pay/'
// with the trailing slash, which no other route contains ('/payment-links/',
// '/payroll/' etc. do not match).
const SKIP_PATHS = [
  '/health', '/ping', '/favicon', '/pay/',
];

// GET-only paths that are too noisy to log (reads, not writes)
const SKIP_GET_PATHS = [
  '/stats', '/dashboard', '/reports', '/balance',
];

function cleanContextValue(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function firstContextValue(sources, keys) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      const value = cleanContextValue(source[key]);
      if (value) return value;
    }
  }
  return null;
}

function pathId(path, pattern) {
  const match = String(path || '').match(pattern);
  return match?.[1] ?? null;
}

function derivePathContext(path) {
  const lowerPath = String(path || '').toLowerCase();
  const context = {};
  if (lowerPath.includes('/appointment')) {
    const appointmentId = pathId(path, /\/appointments?\/(\d+)(?:\/|$)/i);
    if (appointmentId) context.appointment_id = appointmentId;
  }
  if (lowerPath.includes('/admission')) {
    const admissionId = pathId(path, /\/(?:emr\/)?admissions?\/(\d+)(?:\/|$)/i);
    if (admissionId) context.admission_id = admissionId;
  }
  if (lowerPath.includes('/patient')) {
    const patientUid = pathId(path, /\/patients?\/([0-9a-f]{8}-[0-9a-f-]{27,})(?:\/|$)/i);
    if (patientUid) context.patient_uid = patientUid;
  }
  if (lowerPath.includes('/billing')) {
    const invoiceId = pathId(path, /\/invoices\/(\d+)(?:\/|$)/i);
    if (invoiceId) context.invoice_id = invoiceId;
  }
  return context;
}

function auditTenantId(req) {
  return req.tenantId
    || req.user?.tenant_id
    || req.user?.tenantId
    || req.tenant?.id
    || null;
}

function primaryAuditResource(lowerPath, context) {
  if (lowerPath.includes('/billing') && context.invoice_id) {
    return { name: 'billing_invoice', id: context.invoice_id };
  }
  if (lowerPath.includes('/appointment') && context.appointment_id) {
    return { name: 'appointment', id: context.appointment_id };
  }
  if (lowerPath.includes('/admission') && context.admission_id) {
    return { name: 'admission', id: context.admission_id };
  }
  if (lowerPath.includes('/patient') && (context.patient_uid || context.patient_id)) {
    return { name: 'patient', id: context.patient_uid || context.patient_id };
  }
  if (context.appointment_id) return { name: 'appointment', id: context.appointment_id };
  if (context.admission_id) return { name: 'admission', id: context.admission_id };
  if (context.invoice_id) return { name: 'billing_invoice', id: context.invoice_id };
  if (context.patient_uid || context.patient_id) {
    return { name: 'patient', id: context.patient_uid || context.patient_id };
  }
  return { name: null, id: null };
}

export function deriveAuditResourceContext(
  req,
  cleanPath,
  { deviceType = null, userRole = null } = {},
) {
  const pathContext = derivePathContext(cleanPath);
  const trustedDeviceType = normalizeDeviceType(deviceType) || deviceType || null;
  const headerDeviceType = requestDeviceType(req);
  const sources = excludesAuditRequestBody(cleanPath)
    ? [req.params]
    : [
      req.params,
      req.body,
      req.query,
      req.body?.patient,
      req.body?.appointment,
      req.body?.admission,
      req.body?.invoice,
    ];

  const context = {
    request_id: req.id || null,
    device_type: trustedDeviceType,
    ...(headerDeviceType ? { request_device_type: headerDeviceType } : {}),
    ...(trustedDeviceType
      && headerDeviceType
      && trustedDeviceType !== headerDeviceType
      ? { device_type_mismatch: true }
      : {}),
    tenant_id: auditTenantId(req),
    actor_role: userRole,
    ...pathContext,
  };

  const assign = (key, aliases) => {
    if (context[key]) return;
    const value = firstContextValue(sources, aliases);
    if (value) context[key] = value;
  };

  assign('patient_uid', ['patient_uid', 'patientUid', 'patientUID']);
  assign('patient_id', ['patient_id', 'patientId', 'patientID']);
  assign('appointment_id', ['appointment_id', 'appointmentId', 'appointmentID']);
  assign('admission_id', ['admission_id', 'admissionId', 'admissionID']);
  assign('invoice_id', ['invoice_id', 'invoiceId', 'invoiceID']);
  assign('encounter_id', ['encounter_id', 'encounterId', 'encounterID']);
  assign('doctor_id', ['doctor_id', 'doctorId', 'doctorID']);

  const lowerPath = String(cleanPath || '').toLowerCase();
  if (!context.patient_uid && lowerPath.includes('/patient')) assign('patient_uid', ['uid']);
  if (!context.appointment_id && lowerPath.includes('/appointment')) assign('appointment_id', ['id']);
  if (!context.admission_id && lowerPath.includes('/admission')) assign('admission_id', ['id']);
  if (!context.invoice_id && lowerPath.includes('/billing')) assign('invoice_id', ['id']);

  const resource = primaryAuditResource(lowerPath, context);
  return {
    resource: resource.name,
    resourceId: resource.id,
    metadata: context,
  };
}

function shouldSkip(method, path) {
  if (SKIP_PATHS.some(p => path.startsWith(p) || path.includes(p))) return true;
  if (method === 'GET' && SKIP_GET_PATHS.some(p => path.includes(p))) return true;
  return false;
}

// ─── The middleware ───────────────────────────────────────────────────────────
export function auditLogMiddleware(req, res, next) {
  const startMs = Date.now();

  res.on('finish', () => {
    if (pendingAuditLogs >= MAX_PENDING_AUDIT_LOGS) {
      // Backpressure drop — but the audit entry must still be durable. Write it
      // to the same Winston file fallback the DB-error path uses so it is never
      // silently lost (audit §3). Build the minimal recoverable tuple here; the
      // full enrichment in the setImmediate branch is skipped under load.
      const cleanPathOnDrop = req.originalUrl ? req.originalUrl.split('?')[0] : (req.path || '');
      const userOnDrop = req.user;
      _auditLogToFile('queue full', {
        action: deriveAction(req.method, cleanPathOnDrop),
        module: deriveModule(cleanPathOnDrop),
        userId: normalizeAuditLogUserId(
          userOnDrop?.id ?? userOnDrop?.userId ?? userOnDrop?.user_id ?? null,
        ),
        userRole: userOnDrop?.role || userOnDrop?.claims?.role || null,
        path: excludesAuditRequestBody(cleanPathOnDrop) ? cleanPathOnDrop : req.originalUrl,
        method: req.method,
        status_code: res.statusCode,
        tenant_id: auditTenantId(req),
        timestamp: new Date().toISOString(),
      });
      return;
    }
    pendingAuditLogs++;
    setImmediate(async () => {
      const { method, originalUrl, query, body, ip, headers } = req;
      const cleanPath = originalUrl ? originalUrl.split('?')[0] : (req.path || '');
      const user = req.user;
      const userId = normalizeAuditLogUserId(user?.id ?? user?.userId ?? user?.user_id ?? null);
      try {
        if (shouldSkip(method, cleanPath)) return;

        // userId already declared above for catch block access
        const userName = user?.name || user?.displayName || user?.username || user?.email || null;
        const userRole = user?.role || user?.claims?.role || null;

        const statusCode    = res.statusCode;
        const responseTimeMs = Date.now() - startMs;
        const isSuccess     = statusCode < 400;

        const actorUid = req.acting?.actorUid ?? user?.uid ?? null;
        const subjectUid = user?.uid ?? null;
        const actingAsDependent = req.acting != null;
        const deviceType = user?.deviceType ?? user?.claims?.deviceType ?? null;
        const auditContext = deriveAuditResourceContext(req, cleanPath, {
          deviceType,
          userRole,
        });

        await prisma.$queryRawUnsafe(`
          INSERT INTO audit_log
            (uid, user_id, user_name, user_role, ip_address, method, path, module, action,
             resource, resource_id, metadata, query_params, request_summary,
             status_code, response_time_ms, success, user_agent,
             actor_uid, subject_uid, acting_as_dependent, device_type)
          VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,
                  CAST($13 AS jsonb),$14,$15,$16,$17,$18,
                  $19::uuid,$20::uuid,$21,$22)
        `,
          actorUid,
          userId,
          userName,
          userRole,
          ip || headers['x-forwarded-for'] || null,
          method,
          cleanPath,
          deriveModule(cleanPath),
          deriveAction(method, cleanPath),
          auditContext.resource,
          auditContext.resourceId == null ? null : String(auditContext.resourceId),
          JSON.stringify(auditContext.metadata),
          !excludesAuditRequestBody(cleanPath) && Object.keys(query || {}).length
            ? JSON.stringify(query)
            : null,
          method !== 'GET' && !excludesAuditRequestBody(cleanPath) ? sanitizeBody(body) : null,
          statusCode,
          responseTimeMs,
          isSuccess,
          (headers['user-agent'] || '').substring(0, 200),
          actorUid,
          subjectUid,
          actingAsDependent,
          deviceType,
        );
      } catch (err) {
        // Fallback: write to audit log file when DB is unavailable
        _auditLogToFile('DB write failed', {
          action: deriveAction(method, cleanPath),
          userId: userId,
          path: excludesAuditRequestBody(cleanPath) ? cleanPath : req.originalUrl,
          method: req.method,
          timestamp: new Date().toISOString(),
          error: err?.message
        });
      } finally {
        pendingAuditLogs--;
      }
    });
  });

  next();
}
