// src/utils/websocket/channelAuth.js
//
// Channel taxonomy for the real-time clinical fabric.
// See docs/ROADMAP.md Phase 3A — all subscribers are authorized here.

import { STEMI_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import { isAdmin, isClinical, isStaff } from '../roleHelpers.js';
import { hasRole, SUPER_ADMIN, normalizeRole } from '../roles.js';

/**
 * Channel naming convention:
 *   staff:<topic>           — any staff role (clinical, ops, leadership) + admin
 *   staff:clinical:<topic>  — clinical-only (doctors, nurses, allied health)
 *   admin:<topic>           — admin only
 *   patient:<patientUid>:<topic> — governed per-patient access
 *
 * Legacy channels are listed in LEGACY_CHANNELS to keep existing clients working.
 */

const LEGACY_CHANNELS = new Set([
  'appointment-updates',
  'queue-updates',
]);

const PATIENT_CHANNEL_TOPICS = new Set(['appointments', 'queue']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parsePatientChannel(channel) {
  if (typeof channel !== 'string' || !channel.startsWith('patient:')) return null;
  const parts = channel.split(':');
  if (parts.length !== 3 || !UUID_RE.test(parts[1]) || !PATIENT_CHANNEL_TOPICS.has(parts[2])) {
    return null;
  }
  return { patientUid: parts[1], topic: parts[2] };
}

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

  // Personal channels carry patient-specific appointment/queue metadata and
  // intentionally precede the SUPER_ADMIN board bypass. This synchronous layer
  // permits only the subject; wsServer additionally runs the tenant-resolved
  // governed relationship decision before acknowledging any subscription.
  if (channel.startsWith('patient:')) {
    const parts = channel.split(':');
    if (parts.length !== 3 || !UUID_RE.test(parts[1] || '')) {
      return { allowed: false, reason: 'Malformed patient channel' };
    }
    if (!PATIENT_CHANNEL_TOPICS.has(parts[2])) {
      return { allowed: false, reason: 'Unknown patient channel' };
    }
    return String(parts[1]) === String(user?.userId)
      ? { allowed: true }
      : { allowed: false, reason: 'Not your channel' };
  }

  // SUPER_ADMIN is the platform master role. The REST RBAC (rbacMiddleware) grants it an un-scoped
  // bypass of every requireRole gate; WS board-channel auth must match so a super-admin can subscribe
  // to boards they can already read. Personal patient channels above remain governed.
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

  if (channel === 'staff:code-stemi') {
    return hasRole(user.role, STEMI_ROUTE_ROLES)
      ? { allowed: true }
      : { allowed: false, reason: 'Code-STEMI staff-only channel' };
  }

  if (channel.startsWith('staff:')) {
    return isStaff(user.role)
      ? { allowed: true }
      : { allowed: false, reason: 'Staff-only channel' };
  }

  return { allowed: false, reason: 'Unknown channel namespace' };
}

/**
 * The full taxonomy — for /realtime/channels docs and client discovery.
 */
export const CHANNEL_CATALOG = Object.freeze({
  'staff:clinical-alerts':   { description: 'Vital-sign anomalies (WARNING + CRITICAL)', roles: 'staff' },
  'staff:code-blue':          { description: 'Code Blue / cardiac arrest emergency push', roles: 'staff' },
  'staff:code-stemi':         { description: 'Code-STEMI pathway activation and milestone push', roles: 'staff' },
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
  'staff:cold-chain': { description: 'Cold chain — unit readings, excursions, acknowledgements, corrective actions, and silent-sensor warnings', roles: 'staff' },
  'staff:radiology': { description: 'Radiology board — order lifecycle, acquisition, report submission, sign-off, addendum', roles: 'staff' },
  'staff:pathology': { description: 'Anatomic pathology — accession, grossing, blocks/slides, reports, sign-off, addendum', roles: 'staff' },
  'staff:transport': { description: 'Patient transport — porter task board invalidations and SLA escalations', roles: 'staff' },
  'admin:beds':               { description: 'Bed occupancy + admission/discharge events (admin view)', roles: 'admin' },
  'admin:kpi':                { description: 'Live KPI tile updates for admin dashboard', roles: 'admin' },
  'admin:daily-ops':          { description: 'Daily operations snapshot — OPD/IP/OR/collections/claims headline numbers', roles: 'admin' },
  'admin:teleconsult-ops':     { description: 'Teleconsult operations snapshot — join failures, TURN usage, modality mix, consent, active/waiting counts', roles: 'admin' },
  'staff:ed-board':           { description: 'ED tracking board — visit arrivals, transitions, triage priority', roles: 'staff' },
  // NB: 'admin:audit' was removed from this catalog — no emitter ever
  // existed for it and no client subscribed; advertising it invited
  // subscriptions to a channel that never fires (2026-08-14 findings,
  // services P3 #5). Re-add only together with a real emitter.
  'patient:<patientUid>:queue':   { description: 'Queue position for the patient\'s active appointment', roles: 'governed-patient-access' },
  'patient:<patientUid>:appointments': { description: 'Status changes on the patient\'s own appointments', roles: 'governed-patient-access' },
});
