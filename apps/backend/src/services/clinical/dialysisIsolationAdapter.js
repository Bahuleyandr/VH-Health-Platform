import { AppError } from '../../utils/AppError.js';

export const SUPPORTED_CONTRACT_VERSION = 2;

const STATUSES = new Set(['restricted', 'unknown', 'clear']);
const EVIDENCE_TYPES = new Set(['marker', 'legacy_declaration', 'none']);
const ISOLATION_CLASSES = new Set(['hbsag', 'hcv', 'hiv', 'isolation_mixed']);
const MARKER_RESULTS = new Set(['reactive', 'non_reactive', 'pending', 'indeterminate']);
const MARKER_SOURCES = new Set(['lab_result', 'external_report', 'clinical_declaration', 'dialysis_serology']);
const BASE_DECISION_KEYS = Object.freeze([
  'asOf',
  'contract_version',
  'evidence',
  'evidence_dated_on',
  'reasons',
  'status',
]);

const loadResolver = () => import('./dialysisIsolationResolver.js');

function unavailable() {
  return AppError.serviceUnavailable(
    'Dialysis isolation resolver is unavailable',
    'RPD_ISOLATION_RESOLVER_UNAVAILABLE',
  );
}

function unsupported() {
  return AppError.serviceUnavailable(
    'Dialysis isolation resolver contract version is unsupported',
    'RPD_ISOLATION_CONTRACT_VERSION_UNSUPPORTED',
  );
}

function invalidDecision(message) {
  return AppError.internal(message, 'RPD_ISOLATION_DECISION_INVALID');
}

function validDate(value) {
  return value === null || /^\d{4}-\d{2}-\d{2}$/.test(String(value));
}

function validRequiredDate(value) {
  return value !== null && /^\d{4}-\d{2}-\d{2}$/.test(String(value));
}

function hasExactlyKeys(value, expected) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function assertMarker(marker) {
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    throw invalidDecision('Dialysis isolation resolver returned an invalid marker');
  }
  if (!hasExactlyKeys(marker, ['marker', 'marker_row_id', 'result', 'source', 'tested_on'])
    || !['hbsag', 'hcv', 'hiv'].includes(marker.marker)
    || !MARKER_RESULTS.has(marker.result)
    || !validRequiredDate(marker.tested_on)
    || !(marker.marker_row_id === null
      || (Number.isSafeInteger(marker.marker_row_id) && marker.marker_row_id > 0))
    || !MARKER_SOURCES.has(marker.source)) {
    throw invalidDecision('Dialysis isolation resolver returned an invalid marker');
  }
}

function assertDecision(decision, { includeMarkers, includeIsolationClass }) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    throw invalidDecision('Dialysis isolation resolver returned an invalid decision');
  }
  const expectedKeys = [...BASE_DECISION_KEYS];
  if (includeMarkers) expectedKeys.push('markers');
  if (includeIsolationClass) expectedKeys.push('isolation_class');
  expectedKeys.sort();
  if (!hasExactlyKeys(decision, expectedKeys)) {
    throw invalidDecision('Dialysis isolation resolver returned an unexpected decision shape');
  }
  if (decision.contract_version !== SUPPORTED_CONTRACT_VERSION) throw unsupported();
  if (!STATUSES.has(decision.status)
    || !EVIDENCE_TYPES.has(decision.evidence)
    || !Array.isArray(decision.reasons)
    || !decision.reasons.every((reason) => typeof reason === 'string')
    || Number.isNaN(Date.parse(decision.asOf))
    || !validDate(decision.evidence_dated_on)
    || (decision.evidence === 'none' && decision.evidence_dated_on !== null)
    || (decision.evidence === 'marker' && decision.evidence_dated_on === null)) {
    throw invalidDecision('Dialysis isolation resolver returned an invalid decision');
  }

  if (includeMarkers) {
    if (!Array.isArray(decision.markers)) {
      throw invalidDecision('Dialysis isolation resolver omitted requested marker detail');
    }
    decision.markers.forEach(assertMarker);
  } else if (Object.hasOwn(decision, 'markers')) {
    throw invalidDecision('Dialysis isolation resolver returned unrequested marker detail');
  }

  if (includeIsolationClass) {
    const validClass = decision.status === 'restricted'
      ? ISOLATION_CLASSES.has(decision.isolation_class)
      : decision.isolation_class === null;
    if (!validClass) throw invalidDecision('Dialysis isolation resolver returned an invalid isolation class');
  } else if (Object.hasOwn(decision, 'isolation_class')) {
    throw invalidDecision('Dialysis isolation resolver returned an unrequested isolation class');
  }
}

function createAdapter(loader = loadResolver) {
  return async function resolveDialysisIsolation({
    tenantId,
    patientUids,
    db,
    includeMarkers = false,
    includeIsolationClass = false,
  } = {}) {
    let resolver;
    try {
      resolver = await loader();
    } catch {
      throw unavailable();
    }
    if (typeof resolver?.resolveDialysisIsolation !== 'function') throw unavailable();
    if (resolver.CONTRACT_VERSION !== SUPPORTED_CONTRACT_VERSION) throw unsupported();

    const decisions = await resolver.resolveDialysisIsolation({
      tenantId,
      patientUids,
      db,
      contractVersion: SUPPORTED_CONTRACT_VERSION,
      includeMarkers,
      includeIsolationClass,
    });
    if (!(decisions instanceof Map)) {
      throw invalidDecision('Dialysis isolation resolver did not return a Map');
    }

    const expectedUids = [...new Set((patientUids || []).map((uid) => String(uid).toLowerCase()))];
    if (decisions.size !== expectedUids.length) {
      throw invalidDecision('Dialysis isolation resolver returned an incomplete population');
    }
    for (const uid of expectedUids) {
      if (!decisions.has(uid)) {
        throw invalidDecision('Dialysis isolation resolver returned an incomplete population');
      }
      assertDecision(decisions.get(uid), { includeMarkers, includeIsolationClass });
    }
    return decisions;
  };
}

export const resolveDialysisIsolation = createAdapter();

export async function resolveDialysisIsolationForPatient({ patientUid, ...options } = {}) {
  const decisions = await resolveDialysisIsolation({ ...options, patientUids: [patientUid] });
  return decisions.get(String(patientUid).toLowerCase());
}

export const _internal = Object.freeze({ createAdapter, assertDecision });
