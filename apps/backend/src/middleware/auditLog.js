/**
 * Universal Audit Log Middleware
 * Captures every API request after response. Fire-and-forget — never blocks the request.
 *
 * Usage: app.use(auditLogMiddleware) — add AFTER auth middleware so req.user is populated.
 *
 * Skips:
 * - GET requests to read-only list/stats endpoints (too noisy) — configurable
 * - Health checks and static assets
 * - Audit log endpoints themselves (prevent infinite loops)
 */

import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { normalizeAuditLogUserId } from '../utils/auditLogIdentity.js';

let pendingAuditLogs = 0;
const MAX_PENDING_AUDIT_LOGS = 1000;

// ─── Path → module mapping ───────────────────────────────────────────────────
function deriveModule(path) {
  if (path.includes('/auth'))              return 'auth';
  if (path.includes('/attendance'))        return 'attendance';
  if (path.includes('/leave'))             return 'leave';
  if (path.includes('/shift'))             return 'shifts';
  if (path.includes('/incident'))          return 'incidents';
  if (path.includes('/grievance'))         return 'grievances';
  if (path.includes('/housekeeping'))      return 'housekeeping';
  if (path.includes('/overtime'))          return 'overtime';
  if (path.includes('/replacement'))       return 'replacement';
  if (path.includes('/regulariz'))         return 'regularization';
  if (path.includes('/dispute'))           return 'disputes';
  if (path.includes('/doctor'))            return 'doctors';
  if (path.includes('/patient'))           return 'patients';
  if (path.includes('/appointment'))       return 'appointments';
  if (path.includes('/admission'))         return 'admissions';
  if (path.includes('/emr/vitals'))        return 'vitals';
  if (path.includes('/emr/io'))            return 'intake_output';
  if (path.includes('/pharmacy'))          return 'pharmacy';
  if (path.includes('/investigation'))     return 'investigations';
  if (path.includes('/bed'))               return 'beds';
  if (path.includes('/department'))        return 'departments';
  if (path.includes('/staff'))             return 'staff';
  if (path.includes('/user'))              return 'users';
  if (path.includes('/admin'))             return 'admin';
  if (path.includes('/setting'))           return 'settings';
  if (path.includes('/report'))            return 'reports';
  if (path.includes('/audit'))             return 'audit';
  if (path.includes('/notification'))      return 'notifications';
  if (path.includes('/log'))               return 'logs';
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
  if (p.includes('/emr/vitals') && m === 'POST')                     return 'record_vitals';
  if (p.includes('/emr/vitals') && (m === 'PUT' || m === 'PATCH'))   return 'correct_vitals';
  if (p.includes('/emr/vitals') && m === 'GET')                      return 'view_vitals';
  if (p.includes('/emr/io') && m === 'POST')                         return 'record_io';
  if (p.includes('/emr/io') && m === 'GET')                          return 'view_io_balance';

  // Beds and housekeeping
  if (p.includes('/beds') && p.includes('/ready'))                   return 'mark_bed_ready';
  if (p.includes('/beds') && p.includes('/clean'))                   return 'request_bed_cleaning';
  if (p.includes('/beds') && p.includes('/transfer'))                return 'transfer_bed';
  if (p.includes('/beds') && p.includes('/status'))                  return 'update_bed_status';
  if (p.includes('/housekeeping') && p.includes('/assign'))          return 'assign_housekeeping_task';
  if (p.includes('/housekeeping') && p.includes('/complete'))        return 'complete_housekeeping_task';
  if (p.includes('/housekeeping') && p.includes('/verify'))          return 'verify_housekeeping_task';

  // Notifications and safety acknowledgement
  if (p.includes('/notifications') && p.includes('/ack'))            return 'acknowledge_alert';
  if (p.includes('/notifications') && p.includes('/read'))           return 'mark_alert_read';

  // Investigations
  if (p.includes('/investigation') && p.includes('/notif'))          return 'send_investigation_notification';
  if (m === 'POST' && p.includes('/investigation'))                  return 'create_investigation';

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

function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return null;
  try {
    const cleaned = {};
    for (const [k, v] of Object.entries(body)) {
      if (REDACT_FIELDS.has(k.toLowerCase())) {
        cleaned[k] = '[REDACTED]';
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

// ─── Paths to skip entirely ──────────────────────────────────────────────────
const SKIP_PATHS = [
  '/health', '/ping', '/favicon',
  '/api/v1/admin/audit',
  '/api/v1/logs/audit',
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
  const sources = [
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
      logger.warn('Audit log queue full, dropping entry');
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
          Object.keys(query || {}).length ? JSON.stringify(query) : null,
          method !== 'GET' ? sanitizeBody(body) : null,
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
        logger.warn('Audit DB write failed, writing to file fallback:', {
          action: deriveAction(method, cleanPath),
          userId: userId,
          path: req.originalUrl,
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
