import crypto from 'node:crypto';
import {
  resolveDialysisIsolation,
  resolveDialysisIsolationForPatient,
} from './dialysisIsolationAdapter.js';
import {
  compatibilityVerdict,
  deriveIsolationProfile,
  evaluateReuseEligibility,
} from './reprocessableDeviceRules.js';
import { AppError } from '../../utils/AppError.js';

function stableDecisionEvidence(decision) {
  return {
    contract_version: decision?.contract_version ?? null,
    status: decision?.status ?? null,
    evidence: decision?.evidence ?? null,
    evidence_dated_on: decision?.evidence_dated_on ?? null,
    markers: (decision?.markers ?? []).map((marker) => ({
      marker: marker.marker,
      result: marker.result,
      tested_on: marker.tested_on,
      marker_row_id: marker.marker_row_id,
      source: marker.source,
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  };
}

export function isolationDecisionFingerprint(decision) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableDecisionEvidence(decision)))
    .digest('hex');
}

export async function isolationDecisionTx({
  tenantId,
  patientUid,
  db,
  includeMarkers = false,
  includeIsolationClass = false,
}) {
  return resolveDialysisIsolationForPatient({
    tenantId,
    patientUid,
    db,
    includeMarkers,
    includeIsolationClass,
  });
}

export async function assessIsolationTx({ tenantId, patientUid, db }) {
  return isolationDecisionTx({
    tenantId,
    patientUid,
    db,
    includeIsolationClass: true,
  });
}

export async function reuseEligibilityTx({ tenantId, patientUid, db, ...context }) {
  const decision = await isolationDecisionTx({
    tenantId,
    patientUid,
    db,
    includeMarkers: true,
    includeIsolationClass: true,
  });
  return evaluateReuseEligibility({ ...context, patientUid, decision });
}

export async function cohortCompatibilityTx({
  tenantId,
  patientUid,
  cohortPatientUids = [],
  machine,
  db,
}) {
  if (!(machine?.active === true || machine?.status === 'active')) {
    throw AppError.conflict('The selected dialysis machine is inactive', 'DIALYSIS_MACHINE_INACTIVE');
  }
  const patientUids = [...new Set([patientUid, ...cohortPatientUids].map(
    (value) => String(value).toLowerCase(),
  ))];
  const decisions = await resolveDialysisIsolation({
    tenantId,
    patientUids,
    db,
    includeMarkers: true,
    includeIsolationClass: false,
  });
  if (decisions.size !== patientUids.length) {
    throw AppError.internal(
      'Dialysis cohort decision population was incomplete',
      'RPD_ISOLATION_DECISION_INVALID',
    );
  }
  const profiles = patientUids.map((uid) => deriveIsolationProfile(decisions.get(uid)));
  return { verdict: compatibilityVerdict(profiles) };
}

export const _internal = Object.freeze({ stableDecisionEvidence });
