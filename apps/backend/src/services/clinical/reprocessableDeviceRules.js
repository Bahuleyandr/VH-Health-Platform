import { AppError } from '../../utils/AppError.js';
import {
  RPD_BIOLOGICAL_HOLD_ADJUDICATION_ROUTE_ROLES,
  RPD_ROUTINE_HOLD_RELEASE_ROUTE_ROLES,
} from '../../config/routeRolePolicy.js';

export const HCV_RNA_NOT_DETECTED_REPRESENTATION =
  'No evidence of current HCV infection on the available RNA evidence';

export const ISOLATION_GROUP_DENY_WORDS = Object.freeze([
  'hiv', 'hbv', 'hbs', 'hbsag', 'hcv', 'hep', 'hepatitis', 'aids',
  'positive', 'reactive', 'sero', 'infect', 'cjd', 'prion',
]);

export const DEVICE_STATUSES = Object.freeze([
  'awaiting_reprocessing', 'in_cssd', 'available', 'in_case', 'quarantined', 'discarded',
]);

export const DEVICE_ACTIONS = Object.freeze({
  reserve: Object.freeze({ from: ['available'], to: 'in_case' }),
  return: Object.freeze({ from: ['in_case'], to: 'awaiting_reprocessing' }),
  receive: Object.freeze({ from: ['awaiting_reprocessing'], to: 'in_cssd' }),
  quarantine: Object.freeze({
    from: ['available', 'awaiting_reprocessing', 'in_cssd'], to: 'quarantined',
  }),
  release_hold: Object.freeze({ from: ['quarantined'], to: 'awaiting_reprocessing' }),
  release_processing: Object.freeze({
    from: ['awaiting_reprocessing', 'in_cssd', 'quarantined'], to: 'available',
  }),
  restore_unused: Object.freeze({ from: ['in_case'], to: 'available' }),
  discard: Object.freeze({
    from: ['available', 'awaiting_reprocessing', 'in_cssd', 'in_case', 'quarantined'],
    to: 'discarded',
  }),
});

const DIALYSIS_MATRIX_KEYS = Object.freeze(['hbsag', 'hcv', 'hiv', 'isolation_mixed']);
const CORE_MARKERS = Object.freeze(['hbsag', 'hcv', 'hiv']);
const COHORT_RESULT_PRECEDENCE = Object.freeze({
  reactive: 4, indeterminate: 3, pending: 2, non_reactive: 1,
});
const BASES = new Set(['manufacturer_ifu', 'national_guideline', 'institutional']);
const AGENTS = new Set(['peracetic_acid', 'formaldehyde', 'glutaraldehyde', 'renalin', 'other']);
const ADMINISTRATIVE_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);
const BIOLOGICAL_HOLDS = new Set(['bloodborne_exposure', 'prion_exposure']);
const ROUTINE_HOLDS = new Set([
  'sterilization_failed', 'load_invalidated', 'cycle_type_not_allowed',
  'inspection_failed', 'release_pending_processing',
]);

function badRequest(message, code, details = null) {
  throw AppError.badRequest(message, code, details);
}

function requireObject(value, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    badRequest(`${label} must be an object`, code);
  }
  return value;
}

function positiveNumber(value, label, code) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) badRequest(`${label} must be positive`, code);
  return parsed;
}

function positiveInteger(value, label, code) {
  const parsed = positiveNumber(value, label, code);
  if (!Number.isSafeInteger(parsed)) badRequest(`${label} must be an integer`, code);
  return parsed;
}

function normalizedToken(value) {
  return String(value ?? '').trim().toLowerCase();
}

function calendarDate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const text = String(value ?? '').trim();
  const match = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(text);
  return match?.[1] ?? null;
}

function daysBetween(later, earlier) {
  const laterDate = calendarDate(later);
  const earlierDate = calendarDate(earlier);
  if (!laterDate || !earlierDate) return null;
  return Math.floor((Date.parse(`${laterDate}T00:00:00.000Z`)
    - Date.parse(`${earlierDate}T00:00:00.000Z`)) / 86_400_000);
}

function assertExactMatrix(matrix) {
  requireObject(matrix, 'RPD_PROTOCOL_REUSE_MATRIX_INVALID', 'reuse_matrix');
  const keys = Object.keys(matrix).sort();
  if (keys.length !== DIALYSIS_MATRIX_KEYS.length
    || keys.some((key, index) => key !== [...DIALYSIS_MATRIX_KEYS].sort()[index])) {
    badRequest('Dialysis reuse_matrix must contain exactly four supported cells',
      'RPD_PROTOCOL_REUSE_MATRIX_INVALID');
  }
  if (matrix.hbsag !== 'no_reuse'
    || matrix.hiv !== 'no_reuse'
    || matrix.isolation_mixed !== 'no_reuse'
    || !['no_reuse', 'dedicated_reuse'].includes(matrix.hcv)) {
    badRequest('Dialysis reuse_matrix violates the locked conservative policy',
      'RPD_PROTOCOL_REUSE_MATRIX_INVALID');
  }
}

function validateHcvProtocol(protocol) {
  if (protocol.reuse_matrix.hcv !== 'dedicated_reuse') return null;
  const hcv = requireObject(
    protocol.hcv_protocol,
    'RPD_HCV_PROTOCOL_INCOMPLETE',
    'hcv_protocol',
  );
  const required = [
    'separated_processing_arrangements',
    'rna_evidence_rule',
    'infection_treatment_history_rule',
  ];
  if (required.some((key) => String(hcv[key] ?? '').trim() === '')
    || hcv.rna_evidence_rule !== 'independently_recorded'
    || hcv.infection_treatment_history_rule !== 'documented_separately') {
    badRequest('HCV dedicated reuse requires complete RNA, history, and processing terms',
      'RPD_HCV_PROTOCOL_INCOMPLETE');
  }
  return Object.freeze({ ...hcv });
}

export function validateProtocol(input) {
  const protocol = requireObject(input, 'RPD_PROTOCOL_INVALID', 'protocol');
  const domain = normalizedToken(protocol.domain);
  const category = normalizedToken(protocol.category);
  if (!['dialysis', 'ot'].includes(domain)) {
    badRequest('Protocol domain is invalid', 'RPD_PROTOCOL_INVALID');
  }
  if (domain === 'dialysis' ? category !== 'dialyser' : category === 'dialyser') {
    badRequest('Protocol category does not belong to its domain', 'RPD_PROTOCOL_INVALID');
  }
  if (protocol.status && protocol.status !== 'active') {
    badRequest('Only an active protocol may be used', 'RPD_PROTOCOL_INACTIVE');
  }
  if (!BASES.has(protocol.basis)) {
    badRequest('Protocol basis is invalid', 'RPD_PROTOCOL_INVALID');
  }
  if (String(protocol.reference ?? '').trim() === '') {
    badRequest('Protocol reference is required', 'RPD_PROTOCOL_INVALID');
  }

  let reuseMatrix = null;
  if (domain === 'dialysis') {
    assertExactMatrix(protocol.reuse_matrix);
    reuseMatrix = Object.freeze({ ...protocol.reuse_matrix });
  } else if (protocol.reuse_matrix !== null && protocol.reuse_matrix !== undefined) {
    badRequest('OT protocols must not carry a dialysis reuse matrix',
      'RPD_PROTOCOL_REUSE_MATRIX_INVALID');
  }

  const tcv = protocol.tcv_min_pct == null ? null : Number(protocol.tcv_min_pct);
  if (tcv != null && (domain !== 'dialysis' || !Number.isInteger(tcv) || tcv < 80 || tcv > 100)) {
    badRequest('Protocol TCV threshold must be an integer from 80 to 100',
      'RPD_PROTOCOL_TCV_INVALID');
  }

  const agents = protocol.agents ?? [];
  if (!Array.isArray(agents) || agents.length === 0) {
    badRequest('Protocol agents must be a non-empty array', 'RPD_PROTOCOL_AGENT_INVALID');
  }
  const normalizedAgents = agents.map((entry) => {
    requireObject(entry, 'RPD_PROTOCOL_AGENT_INVALID', 'agent');
    const agent = normalizedToken(entry.agent);
    const minimum = positiveNumber(
      entry.min_concentration_pct, 'min_concentration_pct', 'RPD_PROTOCOL_AGENT_INVALID',
    );
    const maximum = positiveNumber(
      entry.max_concentration_pct, 'max_concentration_pct', 'RPD_PROTOCOL_AGENT_INVALID',
    );
    const contact = positiveInteger(
      entry.min_contact_minutes, 'min_contact_minutes', 'RPD_PROTOCOL_AGENT_INVALID',
    );
    if (!AGENTS.has(agent) || minimum > maximum) {
      badRequest('Protocol agent bounds are invalid', 'RPD_PROTOCOL_AGENT_INVALID');
    }
    return Object.freeze({
      agent,
      min_concentration_pct: minimum,
      max_concentration_pct: maximum,
      min_contact_minutes: contact,
    });
  });

  const intervals = protocol.surveillance_intervals_days ?? {};
  if (domain === 'dialysis') {
    if (tcv == null
      || typeof protocol.baseline_tcv_required !== 'boolean'
      || typeof protocol.residual_test_required !== 'boolean'
      || typeof protocol.integrity_test_required !== 'boolean') {
      badRequest('Dialysis release criteria must be explicit', 'RPD_PROTOCOL_RELEASE_CRITERIA_INVALID');
    }
    requireObject(intervals, 'RPD_PROTOCOL_SURVEILLANCE_INVALID', 'surveillance_intervals_days');
    for (const marker of CORE_MARKERS) {
      positiveInteger(intervals[marker], `${marker} surveillance interval`,
        'RPD_PROTOCOL_SURVEILLANCE_INVALID');
    }
  }
  if (protocol.prion_rule != null && !['discard', 'ic_pathway'].includes(protocol.prion_rule)) {
    badRequest('Protocol prion rule is invalid', 'RPD_PROTOCOL_INVALID');
  }

  const normalized = {
    ...protocol,
    domain,
    category,
    tcv_min_pct: tcv,
    agents: Object.freeze(normalizedAgents),
    reuse_matrix: reuseMatrix,
    surveillance_intervals_days: Object.freeze({ ...intervals }),
  };
  const hcvProtocol = domain === 'dialysis' ? validateHcvProtocol(normalized) : null;
  if (hcvProtocol) normalized.hcv_protocol = hcvProtocol;
  return Object.freeze(normalized);
}

export function validateProtocolDeviceScope(input, protocol) {
  const scope = requireObject(input, 'RPD_PROTOCOL_SCOPE_INVALID', 'protocol device scope');
  const validatedProtocol = validateProtocol(protocol);
  const category = normalizedToken(scope.category);
  if (category !== validatedProtocol.category
    || String(scope.manufacturer ?? '').trim() === ''
    || String(scope.model_name ?? '').trim() === ''
    || String(scope.ifu_reference ?? '').trim() !== String(validatedProtocol.reference).trim()
    || scope.single_use !== false) {
    badRequest('Protocol device scope is invalid or declares a single-use device',
      'RPD_PROTOCOL_SCOPE_INVALID');
  }
  const nominal = scope.nominal_tcv_ml == null ? null
    : positiveNumber(scope.nominal_tcv_ml, 'nominal_tcv_ml', 'RPD_PROTOCOL_SCOPE_INVALID');
  return Object.freeze({ ...scope, category, nominal_tcv_ml: nominal });
}

export function validateIsolationSettingRevision(input) {
  const revision = requireObject(input, 'RPD_ISOLATION_REVISION_INVALID', 'isolation revision');
  if (revision.vocabulary_approved_role !== 'INFECTION_CONTROL_OFFICER'
    || revision.mapping_approved_role !== 'INFECTION_CONTROL_OFFICER'
    || !revision.vocabulary_approved_by
    || !revision.mapping_approved_by
    || !revision.vocabulary_approved_at
    || !revision.mapping_approved_at) {
    badRequest('Isolation vocabulary and mapping require independent infection-control approval',
      'RPD_ISOLATION_APPROVAL_REQUIRED');
  }
  if (!Array.isArray(revision.approved_isolation_groups)
    || revision.approved_isolation_groups.length === 0) {
    badRequest('At least one isolation group is required', 'RPD_ISOLATION_REVISION_INVALID');
  }
  const groups = revision.approved_isolation_groups.map((value) => String(value).trim());
  for (const group of groups) {
    const tokens = group.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (!group || group.length > 40 || tokens.some((token) => ISOLATION_GROUP_DENY_WORDS.includes(token))) {
      badRequest('Isolation group contains a restricted clinical token',
        'RPD_ISOLATION_GROUP_DISCLOSURE');
    }
  }
  requireObject(revision.isolation_groups, 'RPD_ISOLATION_REVISION_INVALID', 'isolation_groups');
  const mappingKeys = Object.keys(revision.isolation_groups).sort();
  const expectedKeys = [...DIALYSIS_MATRIX_KEYS].sort();
  if (mappingKeys.length !== expectedKeys.length
    || mappingKeys.some((key, index) => key !== expectedKeys[index])
    || Object.values(revision.isolation_groups).some((group) => !groups.includes(group))) {
    badRequest('Isolation mapping must cover all four classes with approved labels',
      'RPD_ISOLATION_REVISION_INVALID');
  }
  return Object.freeze({
    ...revision,
    approved_isolation_groups: Object.freeze(groups),
    isolation_groups: Object.freeze({ ...revision.isolation_groups }),
  });
}

export function deviceTransition(status, action) {
  const rule = DEVICE_ACTIONS[action];
  return rule && rule.from.includes(status)
    ? { ok: true, to: rule.to, allowedFrom: rule.from }
    : { ok: false, to: rule?.to ?? null, allowedFrom: rule?.from ?? [] };
}

export function accountableRoleForHold(holdType) {
  if (holdType === 'bloodborne_exposure') return 'INFECTION_CONTROL_OFFICER';
  if (holdType === 'prion_exposure') return 'CONSULTANT';
  if (holdType === 'inspection_failed') return 'OT_INCHARGE';
  if (ROUTINE_HOLDS.has(holdType)) return 'QUALITY_OFFICER';
  return null;
}

export function assertHoldReleaseAuthority({ holdType, actorRole, approverRole }) {
  const accountableRole = accountableRoleForHold(holdType);
  if (!accountableRole) {
    badRequest('Hold type has no release authority in this pathway', 'RPD_HOLD_RELEASE_FORBIDDEN');
  }
  const allowedRoles = BIOLOGICAL_HOLDS.has(holdType)
    ? RPD_BIOLOGICAL_HOLD_ADJUDICATION_ROUTE_ROLES
    : RPD_ROUTINE_HOLD_RELEASE_ROUTE_ROLES;
  if (!allowedRoles.includes(actorRole)) {
    throw AppError.forbidden('Role cannot release this hold type', 'RPD_HOLD_RELEASE_FORBIDDEN');
  }
  if (approverRole !== accountableRole) {
    throw AppError.conflict(
      'The accountable clinical approval is required before this hold can be released',
      'RPD_ACCOUNTABLE_APPROVAL_REQUIRED',
      { accountable_role: accountableRole },
    );
  }
  return {
    accountableRole,
    administrativeApplication: ADMINISTRATIVE_ROLES.has(actorRole),
  };
}

export function evaluateReleaseCriteria({ protocol, scope, evidence = {} }) {
  const missing = [];
  if (!scope || scope.single_use !== false
    || String(scope.ifu_reference ?? '').trim() !== String(protocol?.reference ?? '').trim()) {
    missing.push('device_scope');
  }
  if (protocol?.baseline_tcv_required
    && (!(Number(evidence.baseline_tcv_ml) > 0)
      || !['pre_use', 'validated_model_manufacturer'].includes(evidence.baseline_tcv_source))) {
    missing.push('baseline_tcv');
  }
  if (protocol?.integrity_test_required && evidence.integrity_test_result !== 'pass') {
    missing.push('integrity_test');
  }
  if (protocol?.residual_test_required && evidence.residual_test_result !== 'negative') {
    missing.push('residual_test');
  }
  const minimumTcv = Math.max(80, Number(protocol?.tcv_min_pct ?? 80));
  const measured = Number(evidence.measured_tcv_ml);
  const baseline = Number(evidence.baseline_tcv_ml);
  if (!Number.isFinite(measured) || !Number.isFinite(baseline)
    || !(measured > 0) || !(baseline > 0) || (measured / baseline) * 100 < minimumTcv) {
    missing.push('tcv_threshold');
  }
  const agent = protocol?.agents?.find((entry) => entry.agent === evidence.reprocessing_agent);
  const concentration = Number(evidence.disinfectant_concentration_pct);
  const contactMinutes = Number(evidence.disinfectant_contact_minutes);
  if (!agent
    || !Number.isFinite(concentration) || concentration <= 0
    || !Number.isFinite(contactMinutes) || contactMinutes <= 0
    || concentration < agent.min_concentration_pct
    || concentration > agent.max_concentration_pct
    || contactMinutes < agent.min_contact_minutes) {
    missing.push('process_parameters');
  }
  const uniqueMissing = [...new Set(missing)];
  return uniqueMissing.length > 0
    ? { verdict: 'not_established', missing_evidence: uniqueMissing }
    : { verdict: 'released', missing_evidence: [] };
}

export function evaluateDeviceEligibility({ action, device, activeHolds = [], obligations = [] }) {
  if (!['use', 'reprocess'].includes(action)) {
    badRequest('Device eligibility action must be use or reprocess', 'RPD_ELIGIBILITY_ACTION_REQUIRED');
  }
  if (!device || device.status === 'discarded') {
    return { verdict: 'ineligible', reason_codes: ['RPD_DEVICE_UNAVAILABLE'] };
  }
  if (activeHolds.some((hold) => hold.status === 'active')) {
    return { verdict: 'ineligible', reason_codes: ['RPD_ACTIVE_HOLD'] };
  }
  if (action === 'use' && device.status !== 'available') {
    return { verdict: 'ineligible', reason_codes: ['RPD_DEVICE_NOT_READY'] };
  }
  if (action === 'reprocess' && obligations.length > 0) {
    return { verdict: 'not_established', reason_codes: ['RPD_OUTSTANDING_OBLIGATIONS'] };
  }
  if (action === 'reprocess'
    && device.max_cycles_snapshot !== null
    && device.max_cycles_snapshot !== undefined
    && Number(device.cycle_count) >= Number(device.max_cycles_snapshot)) {
    return { verdict: 'ineligible', reason_codes: ['RPD_MAX_CYCLES_REACHED'] };
  }
  return { verdict: 'eligible', reason_codes: [] };
}

function latestMarkerDate(decision, markerClass) {
  const dates = (decision.markers ?? [])
    .filter((marker) => marker.marker === markerClass)
    .map((marker) => calendarDate(marker.tested_on))
    .filter(Boolean)
    .sort();
  return dates.at(-1) ?? calendarDate(decision.evidence_dated_on);
}

export function evaluateReuseEligibility({
  protocol,
  decision,
  device,
  patientUid,
  dedicatedPatientUid,
  activeHolds = [],
  asOf,
  hcvEvidence = null,
  prionExposure = false,
}) {
  if (activeHolds.some((hold) => hold.status === 'active')) {
    return { verdict: 'ineligible', reason_codes: ['RPD_ACTIVE_HOLD'] };
  }
  const lifecycle = evaluateDeviceEligibility({ action: 'reprocess', device, activeHolds });
  if (lifecycle.verdict !== 'eligible') return lifecycle;
  if (prionExposure) {
    return protocol?.prion_rule === 'ic_pathway'
      ? { verdict: 'not_established', reason_codes: ['RPD_PRION_PATHWAY_REQUIRED'] }
      : { verdict: 'ineligible', reason_codes: ['RPD_PRION_DISCARD_REQUIRED'] };
  }
  if (device?.domain !== 'dialysis' || device?.category !== 'dialyser') {
    return { verdict: 'eligible', reason_codes: [] };
  }
  if (!decision || !['restricted', 'unknown', 'clear'].includes(decision.status)) {
    return { verdict: 'not_established', reason_codes: ['RPD_SEROLOGY_NOT_ESTABLISHED'] };
  }
  if (decision.status === 'unknown') {
    return { verdict: 'not_established', reason_codes: ['RPD_SEROLOGY_NOT_ESTABLISHED'] };
  }
  if (decision.status === 'restricted') {
    const matrixCell = protocol?.reuse_matrix?.[decision.isolation_class];
    if (matrixCell !== 'dedicated_reuse') {
      return { verdict: 'ineligible', reason_codes: ['RPD_REUSE_MATRIX_NO_REUSE'] };
    }
    if (typeof patientUid !== 'string' || !patientUid.trim()
      || typeof dedicatedPatientUid !== 'string' || !dedicatedPatientUid.trim()
      || patientUid.toLowerCase() !== dedicatedPatientUid.toLowerCase()) {
      return { verdict: 'ineligible', reason_codes: ['RPD_DIALYSER_DEDICATION_MISMATCH'] };
    }
    if (decision.isolation_class !== 'hcv'
      || hcvEvidence?.rna_result !== 'not_detected'
      || hcvEvidence?.recorded_independently !== true) {
      return { verdict: 'not_established', reason_codes: ['RPD_REUSE_EVIDENCE_REQUIRED'] };
    }
  }
  if (protocol?.surveillance_overdue_blocks_reuse !== false) {
    const markerClass = decision.isolation_class === 'hcv' ? 'hcv' : null;
    const evidenceDate = markerClass ? latestMarkerDate(decision, markerClass) : decision.evidence_dated_on;
    const interval = markerClass
      ? Number(protocol?.surveillance_intervals_days?.[markerClass])
      : Math.min(...CORE_MARKERS.map((marker) => Number(
        protocol?.surveillance_intervals_days?.[marker] ?? Number.MAX_SAFE_INTEGER,
      )));
    const age = daysBetween(asOf, evidenceDate);
    if (age === null || !Number.isFinite(interval) || age > interval) {
      return { verdict: 'not_established', reason_codes: ['RPD_SURVEILLANCE_OVERDUE'] };
    }
  }
  return { verdict: 'eligible', reason_codes: [] };
}

export function deriveIsolationProfile(decision) {
  const latest = new Map();
  for (const marker of decision?.markers ?? []) {
    if (!CORE_MARKERS.includes(marker.marker)) continue;
    const existing = latest.get(marker.marker);
    if (existing?.result === 'reactive') continue;
    const markerDate = calendarDate(marker.tested_on) ?? '';
    const existingDate = calendarDate(existing?.tested_on) ?? '';
    if (!existing || marker.result === 'reactive' || markerDate > existingDate
      || (markerDate === existingDate
        && COHORT_RESULT_PRECEDENCE[marker.result] > COHORT_RESULT_PRECEDENCE[existing.result])) {
      latest.set(marker.marker, marker);
    }
  }
  const values = Object.fromEntries(CORE_MARKERS.map((marker) => [
    marker,
    latest.get(marker)?.result ?? 'unknown',
  ]));
  return Object.freeze(values);
}

export function compatibilityVerdict(profiles) {
  if (!Array.isArray(profiles) || profiles.length === 0) return 'not_established';
  if (profiles.some((profile) => CORE_MARKERS.some((marker) => (
    !['reactive', 'non_reactive'].includes(profile[marker])
  )))) {
    return 'not_established';
  }
  const signatures = profiles.map((profile) => CORE_MARKERS
    .filter((marker) => profile[marker] === 'reactive')
    .join('|'));
  return signatures.every((signature) => signature === signatures[0])
    ? 'compatible'
    : 'incompatible';
}

export const _internal = Object.freeze({ calendarDate, daysBetween, latestMarkerDate });
