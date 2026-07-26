const PATIENT_NEXT_STEP_STATUSES = new Set([
  'planned',
  'open',
  'scheduled',
  'pending',
  'in_progress',
  'ready',
  'completed',
  'cancelled',
  'on_hold',
  'overdue',
]);

const PATIENT_NEXT_STEP_ROUTE_TOKENS = new Set([
  'home',
  'health',
  'appointments',
  'investigations',
  'lab_results',
  'diagnostic_results',
  'referrals',
  'discharge_summaries',
  'messages',
]);

const PATIENT_PENDING_RESULT_STATUSES = new Map([
  ['pending', 'pending'],
  ['result_available', 'ready'],
  ['resolved', 'completed'],
]);

const PATIENT_CLINICIAN_ROLE_LABELS = new Map([
  ['DOCTOR', 'Doctor'],
  ['NURSE', 'Nurse'],
  ['NURSING_STAFF', 'Nurse'],
  ['PHARMACIST', 'Pharmacist'],
  ['PHYSIOTHERAPIST', 'Physiotherapist'],
  ['DIETITIAN', 'Dietitian'],
]);

const PATIENT_VISIBLE_DISCHARGE_STATUSES = new Set(['signed', 'delivered']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readOwnDataProperty(value, key) {
  if (!isPlainObject(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || descriptor.get || descriptor.set) return undefined;
  return descriptor.value;
}

function patientText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function patientDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
  return value;
}

function patientEnum(value, allowed) {
  const normalized = patientText(value, 80)?.toLowerCase();
  return normalized && allowed.has(normalized) ? normalized : null;
}

export function serializePatientNextStep(value) {
  if (!isPlainObject(value)) return null;
  const label = patientText(readOwnDataProperty(value, 'label'), 180);
  if (!label) return null;

  return {
    label,
    explanation: patientText(readOwnDataProperty(value, 'explanation'), 1200),
    due_date: patientDate(readOwnDataProperty(value, 'due_date')),
    status: patientEnum(readOwnDataProperty(value, 'status'), PATIENT_NEXT_STEP_STATUSES),
    patient_action: patientText(readOwnDataProperty(value, 'patient_action'), 500),
    responsible_clinician_display_name: null,
    responsible_clinician_role: null,
    safe_contact: null,
    route_token: patientEnum(
      readOwnDataProperty(value, 'route_token'),
      PATIENT_NEXT_STEP_ROUTE_TOKENS,
    ),
  };
}

export function serializePatientNextSteps(
  value,
  { limit = 50, responsibleClinician = null, safeContact = null } = {},
) {
  let source = value;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(source)) return [];

  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 50));
  const resolvedClinicianName = responsibleClinician
    ? patientText(readOwnDataProperty(responsibleClinician, 'display_name'), 160)
    : null;
  const rawResolvedClinicianRole = responsibleClinician
    ? patientText(readOwnDataProperty(responsibleClinician, 'role'), 80)?.toUpperCase()
    : null;
  const resolvedClinicianRole = rawResolvedClinicianRole
    ? PATIENT_CLINICIAN_ROLE_LABELS.get(rawResolvedClinicianRole) || null
    : null;
  const resolvedSafeContact = patientText(safeContact, 240);
  const projected = [];
  for (const candidate of source) {
    const nextStep = serializePatientNextStep(candidate);
    if (nextStep) {
      projected.push({
        ...nextStep,
        responsible_clinician_display_name: responsibleClinician
          ? resolvedClinicianName
          : null,
        responsible_clinician_role: responsibleClinician
          ? resolvedClinicianRole
          : null,
        safe_contact: resolvedSafeContact,
      });
    }
    if (projected.length >= safeLimit) break;
  }
  return projected;
}

export function serializePatientPendingResult(value, { summaryId } = {}) {
  if (!isPlainObject(value)) return null;
  const expectedSummaryId = Number.parseInt(summaryId, 10);
  const includedSummaryId = Number.parseInt(
    readOwnDataProperty(value, 'discharge_summary_id'),
    10,
  );
  if (
    !Number.isSafeInteger(expectedSummaryId)
    || expectedSummaryId <= 0
    || includedSummaryId !== expectedSummaryId
    || !readOwnDataProperty(value, 'summary_included_at')
    || !readOwnDataProperty(value, 'summary_inclusion_timeline_event_id')
  ) {
    return null;
  }

  const summaryStatus = patientText(readOwnDataProperty(value, 'summary_status'), 40)
    ?.toLowerCase();
  if (!summaryStatus || !PATIENT_VISIBLE_DISCHARGE_STATUSES.has(summaryStatus)) return null;

  const label = patientText(readOwnDataProperty(value, 'patient_safe_label'), 180);
  if (!label) return null;

  const handoffState = patientText(readOwnDataProperty(value, 'handoff_state'), 40)
    ?.toLowerCase();
  const status = handoffState ? PATIENT_PENDING_RESULT_STATUSES.get(handoffState) : null;
  if (!status) return null;

  const rawRole = patientText(readOwnDataProperty(value, 'resolved_clinician_role'), 80)
    ?.toUpperCase();
  return {
    label,
    status,
    responsible_clinician_display_name: patientText(
      readOwnDataProperty(value, 'resolved_clinician_display_name'),
      160,
    ),
    responsible_clinician_role: rawRole
      ? PATIENT_CLINICIAN_ROLE_LABELS.get(rawRole) || null
      : null,
  };
}

export function serializePatientPendingResults(value, { summaryId, limit = 50 } = {}) {
  if (!Array.isArray(value)) return [];
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 50));
  const projected = [];
  for (const candidate of value) {
    const result = serializePatientPendingResult(candidate, { summaryId });
    if (result) projected.push(result);
    if (projected.length >= safeLimit) break;
  }
  return projected;
}

export const __testing__ = {
  PATIENT_CLINICIAN_ROLE_LABELS,
  PATIENT_NEXT_STEP_ROUTE_TOKENS,
  PATIENT_NEXT_STEP_STATUSES,
  PATIENT_PENDING_RESULT_STATUSES,
};
