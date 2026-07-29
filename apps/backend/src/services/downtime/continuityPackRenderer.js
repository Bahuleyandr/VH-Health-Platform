const AGE_WARNING_MS = 15 * 60 * 1000;
const HARD_EXPIRY_MS = 24 * 60 * 60 * 1000;
const DATE_TIME_LOCALE = 'en-GB';

const ALLERGY_UNKNOWN_TEXT = 'Allergy status UNKNOWN — not recorded';
const CODE_STATUS_UNKNOWN_TEXT = 'Code status NOT RECORDED — confirm per hospital policy';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function requireIanaTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) {
    throw new TypeError('Facility IANA time zone is required');
  }

  const normalized = timeZone.trim();
  try {
    new Intl.DateTimeFormat(DATE_TIME_LOCALE, { timeZone: normalized }).format(new Date(0));
  } catch {
    throw new RangeError(`Invalid facility IANA time zone: ${normalized}`);
  }
  return normalized;
}

function toDate(value) {
  if (value == null || value === '') return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Format an input UTC instant for a facility while retaining the IANA zone
 * label in the human-readable output. The source value is never mutated.
 */
export function formatFacilityLocalTimestamp(value, timeZone) {
  const zone = requireIanaTimeZone(timeZone);
  const parsed = toDate(value);
  if (!parsed) return 'unavailable';

  const parts = new Intl.DateTimeFormat(DATE_TIME_LOCALE, {
    timeZone: zone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(parsed);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;

  return `${part('day')} ${part('month')} ${part('year')}, ${part('hour')}:${part('minute')} (${zone})`;
}

export const formatFacilityTimestamp = formatFacilityLocalTimestamp;

function normalizedField(raw) {
  if (raw == null) {
    return { state: 'unavailable', value: null, recordedAt: null };
  }

  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const isEnvelope = Object.hasOwn(raw, 'state') || Object.hasOwn(raw, 'value');
    if (isEnvelope) {
      const value = Object.hasOwn(raw, 'value') ? raw.value : null;
      const timestampUnavailable = ['not_available', 'unavailable']
        .includes(String(raw.timestamp_basis ?? raw.timestampBasis ?? '').toLowerCase());
      return {
        state: String(raw.state || (value == null ? 'unavailable' : 'known')).toLowerCase(),
        value,
        recordedAt: timestampUnavailable
          ? null
          : raw.recorded_at ?? raw.recordedAt ?? value?.recorded_at ?? null,
      };
    }

    return {
      state: 'known',
      value: raw,
      recordedAt: raw.recorded_at ?? raw.recordedAt ?? null,
    };
  }

  return { state: 'known', value: raw, recordedAt: null };
}

function isKnown(field) {
  return field.state === 'known' && field.value != null && field.value !== '';
}

function ageInMs(timestamp, now) {
  const recorded = toDate(timestamp);
  if (!recorded || !now) return null;
  return Math.max(0, now.getTime() - recorded.getTime());
}

function formatAge(ageMs) {
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function renderAgeBadge(timestamp, now, kind) {
  const ageMs = ageInMs(timestamp, now);
  if (ageMs == null || ageMs <= AGE_WARNING_MS) return '';
  return renderAgeBadgeForMs(ageMs, kind);
}

function renderAgeBadgeForMs(ageMs, kind) {
  const label = kind === 'pack' ? 'PACK AGE' : 'FIELD AGE';
  return `<span class="age-badge age-badge--warning" aria-label="${label} is over 15 minutes">${label} ${formatAge(ageMs)}</span>`;
}

function renderFieldMeta(field, timeZone, now) {
  const recordedAt = toDate(field.recordedAt);
  if (!recordedAt) {
    return '<p class="field-meta"><span class="recorded-at unavailable">Recorded at unavailable</span></p>';
  }

  return `<p class="field-meta"><span class="recorded-at">Recorded at ${escapeHtml(
    formatFacilityLocalTimestamp(recordedAt, timeZone),
  )}</span>${renderAgeBadge(recordedAt, now, 'field')}</p>`;
}

function scalarValue(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'object') return String(value);

  for (const key of ['display', 'label', 'name', 'text', 'summary', 'code', 'number', 'phone', 'priority', 'status']) {
    if (value[key] != null && value[key] !== '') return String(value[key]);
  }
  return null;
}

function civilDateDescription(value) {
  let year;
  let month;
  let day;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    year = value.getUTCFullYear();
    month = value.getUTCMonth() + 1;
    day = value.getUTCDate();
  } else if (typeof value === 'string') {
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T|\s)/);
    if (!match) return null;
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    return null;
  }

  const daysInMonth = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) {
    return null;
  }

  const monthNames = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${String(day).padStart(2, '0')} ${monthNames[month - 1]} ${String(year).padStart(4, '0')}`;
}

function locationScalar(value) {
  if (value == null || typeof value === 'object') return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function locationDescription(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'object' || value instanceof Date || Array.isArray(value)) {
    return locationScalar(value);
  }

  const parts = [];
  const appendFirst = (label, keys) => {
    for (const key of keys) {
      const selected = locationScalar(value[key]);
      if (selected != null) {
        parts.push(`${label}: ${selected}`);
        return;
      }
    }
  };

  appendFirst('Ward', ['ward_name', 'ward_id']);
  appendFirst('Bed', ['bed_number', 'bed_id']);
  appendFirst('Department', ['department_name']);
  appendFirst('Queue', ['queue_label', 'queue_id']);
  appendFirst('Appointment', ['appointment_id']);
  appendFirst('Clinic day', ['clinic_day']);
  appendFirst('ED board', ['board']);
  appendFirst('Visit', ['visit_number']);
  appendFirst('Status', ['status']);

  return parts.length ? parts.join(' · ') : null;
}

function renderFieldCard(label, raw, valueRenderer, { className = '' } = {}, context) {
  const field = normalizedField(raw);
  const renderedValue = valueRenderer(field);
  return `<section class="field-card ${className}">
    <h3>${escapeHtml(label)}</h3>
    <div class="field-value">${renderedValue}</div>
    ${renderFieldMeta(field, context.timeZone, context.now)}
  </section>`;
}

function renderSimpleField(label, raw, context) {
  return renderFieldCard(
    label,
    raw,
    (field) => {
      if (!isKnown(field)) return '<span class="unavailable">Unavailable</span>';
      const value = scalarValue(field.value);
      return value == null
        ? '<span class="unavailable">Unavailable</span>'
        : `<span>${escapeHtml(value)}</span>`;
    },
    {},
    context,
  );
}

function renderCivilDateField(label, raw, context) {
  return renderFieldCard(
    label,
    raw,
    (field) => {
      if (!isKnown(field)) return '<span class="unavailable">Unavailable</span>';
      const formatted = civilDateDescription(field.value);
      return formatted == null
        ? '<span class="unavailable">Unavailable</span>'
        : `<span>${escapeHtml(formatted)}</span>`;
    },
    {},
    context,
  );
}

function renderLocationField(label, raw, context) {
  return renderFieldCard(
    label,
    raw,
    (field) => {
      if (!isKnown(field)) return '<span class="unavailable">Unavailable</span>';
      const description = locationDescription(field.value);
      return description == null
        ? '<span class="unavailable">Unavailable</span>'
        : `<span>${escapeHtml(description)}</span>`;
    },
    {},
    context,
  );
}

function renderTimestampField(label, raw, context) {
  return renderFieldCard(
    label,
    raw,
    (field) => {
      if (!isKnown(field)) return '<span class="unavailable">Unavailable</span>';
      const candidate = typeof field.value === 'object'
        ? field.value.at ?? field.value.time ?? field.value.timestamp ?? field.value.value
        : field.value;
      const formatted = formatFacilityLocalTimestamp(candidate, context.timeZone);
      return formatted === 'unavailable'
        ? '<span class="unavailable">Unavailable</span>'
        : `<span>${escapeHtml(formatted)}</span>`;
    },
    {},
    context,
  );
}

function renderIdentity(patient, context) {
  const identityField = normalizedField(patient.identity);
  const identity = identityField.value && typeof identityField.value === 'object'
    ? identityField.value
    : {};

  return `<section class="identity-grid" aria-label="Patient identity">
    ${renderSimpleField('Name', identity.name, context)}
    ${renderSimpleField('MRN', identity.mrn, context)}
    ${renderSimpleField('UID', identity.uid, context)}
    ${renderCivilDateField('Date of birth', identity.dob, context)}
  </section>`;
}

function allergyDescription(item) {
  const value = normalizedField(item).value;
  if (value == null) return null;
  if (typeof value !== 'object') return String(value);

  const allergen = value.allergen ?? value.name ?? value.substance ?? value.label;
  if (allergen == null || allergen === '') return null;
  const detail = [value.severity, value.reaction].filter(Boolean).map(String);
  return detail.length ? `${allergen} (${detail.join('; ')})` : String(allergen);
}

function renderAllergies(raw, context) {
  return renderFieldCard(
    'Allergies',
    raw,
    (field) => {
      if (!isKnown(field)) {
        return `<p class="safety-alert safety-alert--critical" role="alert">${ALLERGY_UNKNOWN_TEXT}</p>`;
      }

      const entries = (Array.isArray(field.value) ? field.value : [field.value])
        .map(allergyDescription)
        .filter(Boolean);
      if (!entries.length) {
        return `<p class="safety-alert safety-alert--critical" role="alert">${ALLERGY_UNKNOWN_TEXT}</p>`;
      }
      return `<p class="safety-alert safety-alert--critical" role="alert"><strong>SAFETY ALERT — ALLERGIES:</strong> ${entries.map(escapeHtml).join('; ')}</p>`;
    },
    { className: 'safety-field' },
    context,
  );
}

function codeStatusValue(value) {
  if (value == null) return null;
  if (typeof value !== 'object') return String(value);
  return value.status ?? value.code ?? value.label ?? value.display ?? null;
}

function renderCodeStatus(raw, context) {
  return renderFieldCard(
    'Code status',
    raw,
    (field) => {
      const value = isKnown(field) ? codeStatusValue(field.value) : null;
      if (value == null || value === '') {
        return `<p class="safety-alert safety-alert--critical" role="alert">${CODE_STATUS_UNKNOWN_TEXT}</p>`;
      }

      const normalized = String(value).trim().toLowerCase().replace(/[_-]+/g, ' ');
      if (normalized === 'full code') {
        return `<p class="safety-neutral">Code status: ${escapeHtml(value)}</p>`;
      }
      return `<p class="safety-alert safety-alert--critical" role="alert"><strong>SAFETY ALERT — CODE STATUS:</strong> ${escapeHtml(value)}</p>`;
    },
    { className: 'safety-field' },
    context,
  );
}

function isolationRequired(value) {
  if (!value || typeof value !== 'object') {
    return String(value || '').toLowerCase() !== 'none';
  }
  if (typeof value.required === 'boolean') return value.required;
  if (typeof value.active === 'boolean') return value.active;
  const status = String(value.status ?? value.state ?? '').toLowerCase();
  return !['', 'none', 'not_required', 'not required', 'inactive'].includes(status);
}

function renderIsolation(raw, context) {
  return renderFieldCard(
    'Isolation precautions',
    raw,
    (field) => {
      if (!isKnown(field)) {
        return '<p class="safety-alert safety-alert--critical" role="alert"><strong>SAFETY ALERT:</strong> Isolation status NOT RECORDED — confirm precautions</p>';
      }
      if (!isolationRequired(field.value)) {
        return '<p class="safety-neutral">Isolation: none recorded</p>';
      }

      const value = typeof field.value === 'object' ? field.value : { type: field.value };
      const type = value.precaution_type ?? value.type ?? value.category ?? value.precaution ?? 'required';
      const status = value.status ?? null;
      const details = [
        `<strong>Isolation required:</strong> ${escapeHtml(type)}`,
        status ? `<strong>Status:</strong> ${escapeHtml(status)}` : null,
      ].filter(Boolean);
      return `<p class="safety-alert safety-alert--critical" role="alert">${details.join(' · ')}</p>`;
    },
    { className: 'safety-field' },
    context,
  );
}

function renderWeight(raw, context) {
  return renderFieldCard(
    'Latest weight',
    raw,
    (field) => {
      if (!isKnown(field)) return '<span class="unavailable">Unavailable</span>';
      const value = typeof field.value === 'object'
        ? field.value.weight_kg ?? field.value.kg ?? field.value.weight ?? field.value.value
        : field.value;
      if (value == null || value === '') return '<span class="unavailable">Unavailable</span>';
      const unit = typeof field.value === 'object' ? field.value.unit ?? 'kg' : 'kg';
      return `<span>${escapeHtml(value)} ${escapeHtml(unit)}</span>`;
    },
    {},
    context,
  );
}

function renderVitals(raw, context) {
  return renderFieldCard(
    'Latest vitals',
    raw,
    (field) => {
      if (!isKnown(field) || typeof field.value !== 'object') {
        return '<span class="unavailable">Unavailable</span>';
      }
      const value = field.value;
      const bp = value.bp ?? (
        value.systolic_bp != null && value.diastolic_bp != null
          ? `${value.systolic_bp}/${value.diastolic_bp}`
          : null
      );
      const parts = [
        bp != null ? `BP ${bp}` : null,
        (value.heart_rate ?? value.hr) != null ? `HR ${value.heart_rate ?? value.hr}` : null,
        (value.respiratory_rate ?? value.rr) != null ? `RR ${value.respiratory_rate ?? value.rr}` : null,
        (value.spo2 ?? value.oxygen_saturation) != null ? `SpO₂ ${value.spo2 ?? value.oxygen_saturation}` : null,
        value.temperature != null ? `Temperature ${value.temperature}` : null,
      ].filter(Boolean);
      return parts.length
        ? `<span>${parts.map(escapeHtml).join(' · ')}</span>`
        : '<span class="unavailable">Unavailable</span>';
    },
    {},
    context,
  );
}

function medicationDescription(item, context) {
  const field = normalizedField(item);
  const value = field.value;
  if (value == null) return null;
  if (typeof value !== 'object') return escapeHtml(value);

  const name = value.medication_name ?? value.name ?? value.label;
  if (name == null || name === '') return null;
  const dose = value.dose ?? value.dosage ?? null;
  const route = value.route ?? null;
  const status = value.status ?? null;
  const dueAt = value.due_at ?? value.scheduled_at ?? value.scheduled_time ?? null;
  const administeredAt = value.administered_at ?? null;
  const details = [
    `<strong>${escapeHtml(name)}</strong>`,
    dose != null ? escapeHtml(dose) : null,
    route != null ? escapeHtml(route) : null,
    status != null ? `Status: ${escapeHtml(status)}` : null,
    dueAt != null ? `Due: ${escapeHtml(formatFacilityLocalTimestamp(dueAt, context.timeZone))}` : null,
    administeredAt != null
      ? `Administered: ${escapeHtml(formatFacilityLocalTimestamp(administeredAt, context.timeZone))}`
      : null,
  ].filter(Boolean);
  return details.join(' · ');
}

function clinicalItemDescription(item) {
  const field = normalizedField(item);
  const value = field.value;
  if (value == null) return null;
  if (typeof value !== 'object') return escapeHtml(value);

  const primary = value.summary
    ?? value.name
    ?? value.label
    ?? value.description
    ?? value.item_name
    ?? value.test_name
    ?? value.member_name
    ?? value.result
    ?? value.code;
  if (primary == null || primary === '') return null;
  const resultValue = clinicalResultValueDescription(
    value.value_snapshot ?? value.result_value ?? null,
  );
  const detail = [
    value.role,
    value.relationship,
    value.priority,
    value.status,
    value.severity,
    resultValue,
  ].filter((entry) => entry != null && entry !== '').map(escapeHtml);
  return [`<strong>${escapeHtml(primary)}</strong>`, ...detail].join(' · ');
}

function clinicalResultValueDescription(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) {
    const entries = value
      .map(clinicalResultValueDescription)
      .filter(Boolean);
    return entries.length ? entries.join(', ') : null;
  }

  const scalar = value.result_value
    ?? value.value
    ?? value.display
    ?? value.text
    ?? value.result
    ?? null;
  if (scalar == null || typeof scalar === 'object') return null;
  const unit = value.unit ?? value.units ?? null;
  return unit == null || unit === ''
    ? String(scalar)
    : `${scalar} ${unit}`;
}

function renderListField(label, raw, itemRenderer, context) {
  return renderFieldCard(
    label,
    raw,
    (field) => {
      if (!isKnown(field)) return '<span class="unavailable">Unavailable</span>';
      const items = (Array.isArray(field.value) ? field.value : [field.value])
        .map((item) => itemRenderer(item, context))
        .filter(Boolean);
      if (!items.length) return '<span>None listed</span>';
      return `<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
    },
    {},
    context,
  );
}

function renderDuration(raw, context) {
  return renderFieldCard(
    'Time in department (TID)',
    raw,
    (field) => {
      if (!isKnown(field)) return '<span class="unavailable">Unavailable</span>';
      if (typeof field.value !== 'object') {
        const suffix = typeof field.value === 'number' ? ' minutes' : '';
        return `<span>${escapeHtml(field.value)}${suffix}</span>`;
      }
      const display = field.value.display ?? field.value.duration ?? field.value.text;
      if (display != null && display !== '') return `<span>${escapeHtml(display)}</span>`;
      const minutes = field.value.minutes ?? field.value.duration_minutes;
      return minutes == null
        ? '<span class="unavailable">Unavailable</span>'
        : `<span>${escapeHtml(minutes)} minutes</span>`;
    },
    {},
    context,
  );
}

function renderCommonPatientFields(patient, context) {
  return `
    ${renderAllergies(patient.allergies, context)}
    ${renderCodeStatus(patient.code_status, context)}
    ${renderIsolation(patient.isolation, context)}
    ${renderLocationField('Location', patient.location, context)}
    ${renderSimpleField('Attending', patient.attending, context)}
    ${renderSimpleField('Diagnosis / reason for care', patient.diagnosis, context)}
    ${renderVitals(patient.latest_vitals, context)}
    ${renderSimpleField('NEWS2', patient.news2, context)}
    ${renderListField('Medications due', patient.medications_due ?? patient.mar_due, medicationDescription, context)}
    ${renderListField(
      'Active medication orders',
      patient.active_medication_orders ?? patient.active_orders,
      medicationDescription,
      context,
    )}
    ${renderListField(
      'Recently administered medications (last 12 hours)',
      patient.recently_administered_medications,
      medicationDescription,
      context,
    )}
    ${renderListField(
      'Unresolved critical results',
      patient.unresolved_critical_results,
      clinicalItemDescription,
      context,
    )}
    ${renderListField('Recent released results', patient.recent_released_results, clinicalItemDescription, context)}
    ${renderListField('Care team', patient.care_team, clinicalItemDescription, context)}`;
}

function renderAreaFields(patient, areaType, context) {
  if (areaType === 'paeds') {
    return renderWeight(patient.latest_weight ?? patient.paeds_weight ?? patient.weight, context);
  }
  if (areaType === 'ed') {
    return `
      ${renderTimestampField('ED arrival', patient.arrival_at, context)}
      ${renderSimpleField('Triage', patient.triage ?? patient.triage_priority, context)}
      ${patient.triage_assessment != null
        ? renderSimpleField('Triage assessment', patient.triage_assessment, context)
        : ''}
      ${renderDuration(patient.time_in_department ?? patient.tid, context)}`;
  }
  if (areaType === 'opd') {
    return `
      ${renderTimestampField('Appointment time', patient.appointment_time, context)}
      ${renderSimpleField('Appointment status', patient.appointment_status, context)}
      ${renderSimpleField('Phone', patient.phone, context)}`;
  }
  if (patient.latest_weight != null || patient.paeds_weight != null) {
    return renderWeight(patient.latest_weight ?? patient.paeds_weight, context);
  }
  return '';
}

function normalizeAreaType(pack) {
  const raw = String(pack.location?.type ?? pack.area_type ?? pack.area ?? '').trim().toLowerCase();
  const profile = String(
    pack.location?.area_profile ?? pack.location?.profile ?? pack.area_profile ?? '',
  ).trim().toLowerCase();
  if (
    ['ward', 'inpatient', 'ipd'].includes(raw)
    && ['paeds', 'paediatric', 'pediatric', 'nicu', 'picu'].includes(profile)
  ) {
    return 'paeds';
  }
  if (['ward', 'inpatient', 'ipd'].includes(raw)) return 'ward';
  if (['paeds', 'paediatric', 'pediatric', 'paediatric_ward', 'pediatric_ward'].includes(raw)) return 'paeds';
  if (['ed', 'ed_board', 'emergency', 'emergency_department'].includes(raw)) return 'ed';
  if (['opd', 'opd_day', 'outpatient', 'outpatient_day'].includes(raw)) return 'opd';
  throw new TypeError(`Unsupported continuity pack area type: ${raw || 'missing'}`);
}

function areaHeading(areaType) {
  return {
    ward: 'WARD CONTINUITY PACK',
    paeds: 'PAEDS CONTINUITY PACK',
    ed: 'ED CONTINUITY PACK',
    opd: 'OPD CONTINUITY PACK',
  }[areaType];
}

function canonicalFreshness(pack, options) {
  if (options.freshness && typeof options.freshness === 'object') return options.freshness;
  if (
    Object.hasOwn(options, 'state')
    && (Object.hasOwn(options, 'ageMs') || Object.hasOwn(options, 'packAccess'))
  ) {
    return options;
  }
  return pack.freshness && typeof pack.freshness === 'object' ? pack.freshness : null;
}

function freshnessState(pack, freshness) {
  const value = freshness?.state ?? pack.freshness_state ?? pack.freshnessState ?? '';
  return String(value).trim().toUpperCase();
}

function freshnessAgeMs(freshness) {
  if (freshness?.ageMs == null) return null;
  const value = Number(freshness.ageMs);
  return Number.isFinite(value) ? value : null;
}

function invalidFreshnessReason(state, freshness) {
  if (!freshness) return null;
  const ageMs = freshnessAgeMs(freshness);
  if (freshness.ageMs != null && (ageMs == null || ageMs < 0)) return 'verification';
  if (freshness.packAccess?.display === false || freshness.packAccess?.print === false) {
    return 'verification';
  }
  if (state && !['CURRENT', 'AGED', 'EXPIRED', 'HARD_EXPIRED', 'CLOCK_UNCERTAIN'].includes(state)) {
    return 'verification';
  }
  if (state === 'CURRENT' && ageMs != null && ageMs > AGE_WARNING_MS) return 'verification';
  if (
    state === 'AGED'
    && ageMs != null
    && (ageMs <= AGE_WARNING_MS || ageMs >= HARD_EXPIRY_MS)
  ) {
    return 'verification';
  }
  return null;
}

function isClockUncertain(pack, options, state) {
  return options.clockTrusted === false
    || pack.clock_uncertain === true
    || pack.clock_trusted === false
    || state === 'CLOCK_UNCERTAIN';
}

function validityTimestamp(pack) {
  return pack.not_valid_after ?? pack.expires_at ?? null;
}

function invalidValidityWindow(pack) {
  const generatedAt = toDate(pack.generated_at);
  const expiresAt = toDate(pack.expires_at);
  if (
    !generatedAt
    || !expiresAt
    || expiresAt.getTime() <= generatedAt.getTime()
    || expiresAt.getTime() - generatedAt.getTime() > HARD_EXPIRY_MS
  ) {
    return true;
  }

  if (pack.not_valid_after != null) {
    const notValidAfter = toDate(pack.not_valid_after);
    if (!notValidAfter || notValidAfter.getTime() !== expiresAt.getTime()) {
      return true;
    }
  }
  return false;
}

function isHardExpired(pack, now, state) {
  if (pack.hard_expired === true || ['EXPIRED', 'HARD_EXPIRED'].includes(state)) {
    return true;
  }
  const expiresAt = toDate(validityTimestamp(pack));
  return expiresAt ? now.getTime() >= expiresAt.getTime() : false;
}

function evaluationTime(pack, options, freshness) {
  const explicit = toDate(options.trustedNow ?? options.now ?? pack.evaluated_at ?? pack.evaluatedAt);
  if (explicit) return explicit;

  const generatedAt = toDate(pack.generated_at);
  const ageMs = freshnessAgeMs(freshness);
  if (generatedAt && ageMs != null && ageMs >= 0) {
    return new Date(generatedAt.getTime() + ageMs);
  }
  throw new TypeError('A trusted current time or canonical freshness age is required');
}

function renderPackAgeBadge(pack, now, state, freshness) {
  const canonicalAgeMs = freshnessAgeMs(freshness);
  if (state === 'CURRENT') return '';
  if (state === 'AGED') {
    return canonicalAgeMs == null
      ? renderAgeBadge(pack.generated_at, now, 'pack')
      : renderAgeBadgeForMs(canonicalAgeMs, 'pack');
  }
  return renderAgeBadge(pack.generated_at, now, 'pack');
}

function documentShell(title, body) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{font:14px/1.45 Arial,Helvetica,sans-serif;margin:24px;color:#111;background:#fff}
  h1{font-size:23px;margin:0 0 4px} h2{font-size:19px;margin:24px 0 8px}
  h3{font-size:13px;margin:0 0 5px;text-transform:uppercase;letter-spacing:.03em}
  p{margin:5px 0} ul{margin:4px 0;padding-left:20px}
  .pack-meta{border:2px solid #111;padding:10px 12px;margin:12px 0 18px}
  .generated-line{font-size:16px;font-weight:700}
  .patient{border-top:4px solid #111;padding-top:12px;margin-top:20px;break-inside:avoid}
  .identity-grid,.clinical-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
  .field-card{border:1px solid #777;padding:7px 9px;break-inside:avoid}
  .field-value{min-height:20px}.field-meta{font-size:11px;color:#333;margin-top:7px}
  .safety-field{border-width:2px}
  .safety-alert{font-weight:700;padding:7px;border:3px solid #7a0017;background:#ffe4e8;color:#52000f}
  .safety-alert--critical{border-style:double}
  .safety-neutral{font-weight:700;padding:7px;border:2px solid #333}
  .age-badge{display:inline-block;margin-left:7px;padding:1px 5px;border:2px solid #7a4800;background:#fff0c2;color:#4a2b00;font-weight:700}
  .unavailable{font-weight:700;text-decoration:underline}
  .clinic-disposal,.refusal{border:4px double #7a0017;padding:14px;font-size:18px;font-weight:700;margin:18px 0}
  @media(max-width:700px){.identity-grid,.clinical-grid{grid-template-columns:1fr}}
  @media print{
    body{margin:10mm;font-size:11pt}
    .patient,.field-card{break-inside:avoid}
    .safety-alert,.age-badge{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  }
</style></head><body>
${body}
</body></html>`;
}

function renderRefusalPage(reason, pack, timeZone) {
  let metadata = '';
  if (reason === 'expired') {
    const generated = formatFacilityLocalTimestamp(pack.generated_at, timeZone);
    const validUntil = formatFacilityLocalTimestamp(validityTimestamp(pack), timeZone);
    metadata = `<p class="generated-line">Generated ${escapeHtml(generated)} — NOT VALID AFTER ${escapeHtml(validUntil)}, then use paper and phone.</p>`;
  }

  const reasonText = {
    clock: 'CLOCK UNCERTAIN — this continuity pack cannot be displayed.',
    expired: 'PACK EXPIRED — this continuity pack cannot be displayed.',
    verification: 'PACK VERIFICATION FAILED — this continuity pack cannot be displayed.',
  }[reason];
  return documentShell(
    'Continuity pack refused',
    `<main aria-labelledby="refusal-heading">
      <h1 id="refusal-heading">CONTINUITY PACK REFUSED</h1>
      <section class="refusal" role="alert">
        <p>${reasonText}</p>
        ${metadata}
        <p>Use paper and phone.</p>
      </section>
    </main>`,
  );
}

function renderPatient(patient, index, areaType, context) {
  return `<article class="patient">
    <h2>Patient ${index + 1}</h2>
    ${renderIdentity(patient, context)}
    <div class="clinical-grid">
      ${renderCommonPatientFields(patient, context)}
      ${renderAreaFields(patient, areaType, context)}
    </div>
  </article>`;
}

/**
 * Render a normalized ward, paediatric, ED, or OPD continuity pack as one
 * self-contained printable HTML document. This function performs no I/O.
 */
export function buildContinuityPackHtml(pack, options = {}) {
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
    throw new TypeError('Normalized continuity pack object is required');
  }

  const timeZone = requireIanaTimeZone(pack.facility?.timezone ?? pack.facility?.time_zone);
  const freshness = canonicalFreshness(pack, options);
  const state = freshnessState(pack, freshness);
  const freshnessFailure = invalidFreshnessReason(state, freshness);

  if (invalidValidityWindow(pack)) return renderRefusalPage('verification', pack, timeZone);
  if (isClockUncertain(pack, options, state)) return renderRefusalPage('clock', pack, timeZone);
  if (['EXPIRED', 'HARD_EXPIRED'].includes(state)) {
    return renderRefusalPage('expired', pack, timeZone);
  }
  if (freshnessFailure) return renderRefusalPage(freshnessFailure, pack, timeZone);

  const now = evaluationTime(pack, options, freshness);
  if (isHardExpired(pack, now, state)) return renderRefusalPage('expired', pack, timeZone);

  const areaType = normalizeAreaType(pack);
  const generatedAt = formatFacilityLocalTimestamp(pack.generated_at, timeZone);
  const validUntil = formatFacilityLocalTimestamp(validityTimestamp(pack), timeZone);
  const patients = Array.isArray(pack.patients) ? pack.patients : [];
  const context = { timeZone, now };
  const patientHtml = patients.map((patient, index) => renderPatient(patient || {}, index, areaType, context)).join('');
  const facilityName = pack.facility?.name ?? pack.facility?.code ?? 'Facility';
  const locationLabel = pack.location?.label ?? pack.location?.name ?? '';

  return documentShell(
    areaHeading(areaType),
    `<main>
      <h1>${areaHeading(areaType)}</h1>
      <p><strong>Facility:</strong> ${escapeHtml(facilityName)}
        ${locationLabel ? `· <strong>Location:</strong> ${escapeHtml(locationLabel)}` : ''}</p>
      <section class="pack-meta" aria-label="Pack validity">
        <p class="generated-line">Generated ${escapeHtml(generatedAt)} — NOT VALID AFTER ${escapeHtml(validUntil)}, then use paper and phone.</p>
        <p>${renderPackAgeBadge(pack, now, state, freshness)}</p>
      </section>
      ${areaType === 'opd' ? '<p class="clinic-disposal" role="alert">Destroy after clinic day</p>' : ''}
      ${patientHtml || '<p>No patients were included in this pack.</p>'}
    </main>`,
  );
}

export default {
  buildContinuityPackHtml,
  formatFacilityLocalTimestamp,
  formatFacilityTimestamp,
};
