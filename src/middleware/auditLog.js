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

import db from '../config/database.js';
import logger from '../logging/logger.js';

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
  if (path.includes('/overtime'))          return 'overtime';
  if (path.includes('/replacement'))       return 'replacement';
  if (path.includes('/regulariz'))         return 'regularization';
  if (path.includes('/dispute'))           return 'disputes';
  if (path.includes('/doctor'))            return 'doctors';
  if (path.includes('/patient'))           return 'patients';
  if (path.includes('/appointment'))       return 'appointments';
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
function deriveAction(method, path) {
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

  // Appointments
  if (m === 'POST' && p.includes('/appointment'))                    return 'book_appointment';
  if (p.includes('/appointment') && p.includes('/cancel'))           return 'cancel_appointment';
  if (p.includes('/appointment') && p.includes('/confirm'))          return 'confirm_appointment';

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
      try {
        const { method, originalUrl, query, body, ip, headers } = req;
        const cleanPath = originalUrl ? originalUrl.split('?')[0] : (req.path || '');

        if (shouldSkip(method, cleanPath)) return;

        const user = req.user;
        const userId   = user?.uid || user?.id || null;
        const userName = user?.name || user?.displayName || user?.email || null;
        const userRole = user?.role || user?.claims?.role || null;

        const statusCode    = res.statusCode;
        const responseTimeMs = Date.now() - startMs;
        const isSuccess     = statusCode < 400;

        await db.query(`
          INSERT INTO audit_log
            (user_id, user_name, user_role, ip_address, method, path, module, action,
             query_params, request_summary, status_code, response_time_ms, success, user_agent)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        `, [
          userId,
          userName,
          userRole,
          ip || headers['x-forwarded-for'] || null,
          method,
          cleanPath,
          deriveModule(cleanPath),
          deriveAction(method, cleanPath),
          Object.keys(query || {}).length ? JSON.stringify(query) : null,
          method !== 'GET' ? sanitizeBody(body) : null,
          statusCode,
          responseTimeMs,
          isSuccess,
          (headers['user-agent'] || '').substring(0, 200),
        ]);
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
