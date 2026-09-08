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

const COHORT_REASON_BY_MARKER = Object.freeze({
  hbsag: 'DIALYSIS_HBSAG_POSITIVE',
  hcv: 'DIALYSIS_HCV_POSITIVE',
  hiv: 'DIALYSIS_HIV_POSITIVE',
});

function datedEvidenceDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const day = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value
    ? day.getTime() : null;
}

async function persistedHcvRnaEvidenceTx({ tenantId, patientUid, db, protocol, decision }) {
  const interval = Number(protocol?.surveillance_intervals_days?.hcv);
  const asOf = new Date(decision.asOf);
  const today = Number.isFinite(asOf.getTime())
    ? datedEvidenceDay(asOf.toISOString().slice(0, 10)) : null;
  const rows = await db.$queryRawUnsafe(
    `SELECT evidence.id, evidence.hcv_pcr, evidence.test_date, evidence.reported_by
       FROM (
         SELECT serology.id, serology.hcv_pcr, serology.test_date::text AS test_date,
                serology.reported_by::text AS reported_by,
                DENSE_RANK() OVER (ORDER BY serology.test_date DESC) AS evidence_rank
           FROM dialysis_serology AS serology
           JOIN dialysis_patients AS patient
             ON patient.id = serology.dialysis_patient_id
            AND patient.tenant_id = serology.tenant_id
          WHERE serology.tenant_id = $1::uuid
            AND patient.patient_uid = $2::uuid
            AND serology.hcv_pcr IS NOT NULL
       ) AS evidence
      WHERE evidence.evidence_rank = 1
      ORDER BY evidence.id`,
    tenantId, patientUid,
  );
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  if (!Number.isInteger(interval) || interval <= 0 || today === null
    || rows.length === 0 || rows.some((row) => {
    const day = datedEvidenceDay(row.test_date);
    const age = day === null ? null : (today - day) / 86400000;
    return row.hcv_pcr !== 'not_detected'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.reported_by ?? '')
      || age === null || age < 0 || age > interval;
    })) return { evidence: null, fingerprint };
  return { evidence: { rna_result: 'not_detected', recorded_independently: true }, fingerprint };
}

function hasCompleteCohortProfile(decision, profile) {
  const markerReasons = Object.entries(COHORT_REASON_BY_MARKER)
    .filter(([marker]) => profile[marker] === 'reactive')
    .map(([, reason]) => reason)
    .sort();
  const restrictingReasons = [...new Set(decision?.reasons ?? [])].sort();
  return (decision?.status === 'restricted') === (markerReasons.length > 0)
    && JSON.stringify(markerReasons) === JSON.stringify(restrictingReasons);
}

function stableDecisionEvidence(decision) {
  return {
    contract_version: decision?.contract_version ?? null,
    status: decision?.status ?? null,
    evidence: decision?.evidence ?? null,
    evidence_dated_on: decision?.evidence_dated_on ?? null,
    reasons: [...new Set(decision?.reasons ?? [])].sort(),
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

export async function reuseEligibilityTx({
  tenantId, patientUid, db, captureDecisionFingerprint, ...context
}) {
  const decision = await isolationDecisionTx({
    tenantId,
    patientUid,
    db,
    includeMarkers: true,
    includeIsolationClass: true,
  });
  const needsHcvRnaEvidence = (context.device?.domain ?? context.protocol?.domain) === 'dialysis'
    && (context.device?.category ?? context.protocol?.category) === 'dialyser'
    && decision.status === 'restricted' && decision.isolation_class === 'hcv'
    && context.protocol?.reuse_matrix?.hcv === 'dedicated_reuse';
  const rnaSource = needsHcvRnaEvidence
    ? await persistedHcvRnaEvidenceTx({ tenantId, patientUid, db, protocol: context.protocol, decision })
    : null;
  const hcvEvidence = rnaSource?.evidence ?? null;
  if (typeof captureDecisionFingerprint === 'function') {
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
      decision: isolationDecisionFingerprint(decision), rna: rnaSource?.fingerprint ?? null,
    })).digest('hex');
    await captureDecisionFingerprint(fingerprint);
  }
  return evaluateReuseEligibility({ ...context, patientUid, decision, hcvEvidence });
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
  if (profiles.some((profile, index) => (
    !hasCompleteCohortProfile(decisions.get(patientUids[index]), profile)
  ))) {
    return { verdict: 'not_established' };
  }
  return { verdict: compatibilityVerdict(profiles) };
}

export const _internal = Object.freeze({ stableDecisionEvidence });

export {
  captureDialyser, captureDialyserTx, deviceEligibilityTx,
  onSessionStartingTx, onSessionEndedTx, onSessionCancelledTx,
  recordPlatformReuseRegisterTx, recordDialyserReprocessingAttempt,
  recordRetrospectiveDialyserUse, readDialyser, reprocessDialysisDevice,
} from './dialysisDeviceLifecycleService.js';
