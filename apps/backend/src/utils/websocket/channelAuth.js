// src/utils/websocket/channelAuth.js
//
// Channel taxonomy for the real-time clinical fabric.
// See docs/ROADMAP.md Phase 3A — all subscribers are authorized here.

import { isAdmin, isClinical, isStaff } from '../roleHelpers.js';
import { SUPER_ADMIN, normalizeRole } from '../roles.js';

/**
 * Channel naming convention:
 *   staff:<topic>           — any staff role (clinical, ops, leadership) + admin
 *   staff:clinical:<topic>  — clinical-only (doctors, nurses, allied health)
 *   admin:<topic>           — admin only
 *   patient:<userId>:<top>  — the patient themselves, or clinical staff caring for them
 *
 * Legacy channels are listed in LEGACY_CHANNELS to keep existing clients working.
 */

const LEGACY_CHANNELS = new Set([
  'appointment-updates',
  'queue-updates',
]);

/**
 * Authorize a subscribe request.
 * @param {string} channel
 * @param {{ role: string, userId: string }} user
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function authorizeChannel(channel, user) {
  if (typeof channel !== 'string' || channel.length === 0 || channel.length > 200) {
    return { allowed: false, reason: 'Invalid channel name' };
  }

  // SUPER_ADMIN is the platform master role. The REST RBAC (rbacMiddleware) grants it an un-scoped
  // bypass of every requireRole gate; WS channel auth must match so a super-admin can subscribe to any
  // board they can already read. Without this, isStaff('SUPER_ADMIN') is false → super-admin is denied
  // every staff:* channel.
  if (normalizeRole(user?.role) === SUPER_ADMIN) {
    return { allowed: true };
  }

  if (LEGACY_CHANNELS.has(channel)) {
    return isStaff(user.role)
      ? { allowed: true }
      : { allowed: false, reason: 'Staff-only legacy channel' };
  }

  if (channel.startsWith('admin:')) {
    return isAdmin(user.role)
      ? { allowed: true }
      : { allowed: false, reason: 'Admin-only channel' };
  }

  if (channel.startsWith('staff:clinical:')) {
    return isClinical(user.role) || isAdmin(user.role)
      ? { allowed: true }
      : { allowed: false, reason: 'Clinical-only channel' };
  }

  if (channel.startsWith('staff:')) {
    return isStaff(user.role)
      ? { allowed: true }
      : { allowed: false, reason: 'Staff-only channel' };
  }

  if (channel.startsWith('patient:')) {
    const parts = channel.split(':');
    if (parts.length < 3 || !parts[1]) {
      return { allowed: false, reason: 'Malformed patient channel' };
    }
    const targetUserId = parts[1];
    if (String(targetUserId) === String(user.userId)) return { allowed: true };
    if (isClinical(user.role) || isAdmin(user.role)) return { allowed: true };
    return { allowed: false, reason: 'Not your channel' };
  }

  return { allowed: false, reason: 'Unknown channel namespace' };
}

/**
 * The full taxonomy — for /realtime/channels docs and client discovery.
 */
export const CHANNEL_CATALOG = Object.freeze({
  'staff:clinical-alerts':   { description: 'Vital-sign anomalies (WARNING + CRITICAL)', roles: 'staff' },
  'staff:code-blue':          { description: 'Code Blue / cardiac arrest emergency push', roles: 'staff' },
  'staff:beds':               { description: 'Bed occupancy + admission/discharge events', roles: 'staff' },
  'staff:handovers':          { description: 'New nurse-handover notes', roles: 'staff' },
  'staff:appointments':       { description: 'Appointment + queue status changes (staff view)', roles: 'staff' },
  'staff:or-board':           { description: 'OR board — surgical case schedule/status/cancellation changes', roles: 'staff' },
  'staff:icu-board':          { description: 'ICU command centre — admissions, code status, flowsheet, assessments, ABCDEF bundle', roles: 'staff' },
  'staff:lab': { description: 'Lab — critical-value alerts + pathologist sign-off worklist', roles: 'staff' },
  'staff:micro': { description: 'Microbiology — culture orders, isolates, sensitivities, MDR resistance', roles: 'staff' },
  'staff:incidents': { description: 'Incident reports — sentinel/severe safety events + status changes', roles: 'staff' },
  'staff:dialysis-board': { description: 'Dialysis unit — session lifecycle, intra-dialysis observations, complications, vascular access, serology', roles: 'staff' },
  'staff:blood-bank': { description: 'Blood bank — request lifecycle, unit stock, crossmatch, transfusion closed-loop + reactions', roles: 'staff' },
  'staff:radiology': { description: 'Radiology board — order lifecycle, acquisition, report submission, sign-off, addendum', roles: 'staff' },
  'admin:beds':               { description: 'Bed occupancy + admission/discharge events (admin view)', roles: 'admin' },
  'admin:kpi':                { description: 'Live KPI tile updates for admin dashboard', roles: 'admin' },
  'admin:daily-ops':          { description: 'Daily operations snapshot — OPD/IP/OR/collections/claims headline numbers', roles: 'admin' },
  'staff:ed-board':           { description: 'ED tracking board — visit arrivals, transitions, triage priority', roles: 'staff' },
  'admin:audit':              { description: 'Security-audit events (logins, lockouts, role changes)', roles: 'admin' },
  'patient:<userId>:queue':   { description: 'Queue position for the patient\'s active appointment', roles: 'owner-or-clinical' },
  'patient:<userId>:appointments': { description: 'Status changes on the patient\'s own appointments', roles: 'owner-or-clinical' },
});
