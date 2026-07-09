/**
 * NL12-S8 ABDM/certification evidence cockpit.
 *
 * Read-only aggregation over india_compliance_evidence. The cockpit separates
 * internal cert-ready posture from externally-certified status per ADR-003.
 */

import prisma from '../../lib/prisma.js';
import { requireTenantId } from '../tenant/tenantService.js';

const ACCEPTED_STATUSES = new Set(['verified', 'accepted_exception', 'not_applicable']);

const TRACKS = [
  {
    key: 'abdm_m1',
    stage: 'ABDM M1',
    control_code: 'ABDM_M1_CERTIFICATION_SUITE',
    control_area: 'ABDM',
    control_name: 'ABDM M1 certification suite evidence accepted',
    runbook_uri: 'docs/ABDM_READINESS.md',
    engagement_status: 'owner_credentials_required',
    cert_ready_declaration: 'internal_cert_ready_substrate',
    external_certification_status: 'not_certified',
    blockers: [
      'Owner ABDM sandbox credentials and bridge registration are not attached.',
      'M1 certification-suite booking and result evidence are not accepted.',
    ],
    supporting_controls: ['ABDM_CALLBACK_AUTHENTICITY'],
  },
  {
    key: 'abdm_m2',
    stage: 'ABDM M2',
    control_code: 'ABDM_M2_CERTIFICATION_SUITE',
    control_area: 'ABDM',
    control_name: 'ABDM M2 encrypted HIP data-push certification evidence accepted',
    runbook_uri: 'docs/ABDM_READINESS.md',
    engagement_status: 'sandbox_dry_run_required',
    cert_ready_declaration: 'internal_cert_ready_substrate',
    external_certification_status: 'not_certified',
    blockers: [
      'Encrypted M2 sandbox dry-run evidence is not accepted.',
      'M2 certification-suite run and NHA sign-off are not attached.',
    ],
    supporting_controls: ['ABDM_M2_ENCRYPTED_PUSH'],
  },
  {
    key: 'abdm_m3',
    stage: 'ABDM M3',
    control_code: 'ABDM_M3_CERTIFICATION_SUITE',
    control_area: 'ABDM',
    control_name: 'ABDM M3 HIU consent-flow certification evidence accepted',
    runbook_uri: 'docs/ABDM_READINESS.md',
    engagement_status: 'suite_booking_required',
    cert_ready_declaration: 'internal_cert_ready_substrate',
    external_certification_status: 'not_certified',
    blockers: [
      'HIU consent-flow UAT and certification-suite run are not attached.',
      'External ABDM M3 acceptance evidence is not verified.',
    ],
    supporting_controls: ['ABDM_CALLBACK_AUTHENTICITY'],
  },
  {
    key: 'vapt',
    stage: 'VAPT',
    control_code: 'VAPT_OR_SIGNED_EXCEPTION',
    control_area: 'SECURITY',
    control_name: 'External VAPT report or signed exception accepted',
    runbook_uri: 'docs/PENTEST_READINESS.md',
    engagement_status: 'external_firm_required',
    cert_ready_declaration: 'internal_cert_ready_package',
    external_certification_status: 'not_certified',
    blockers: [
      'External VAPT report, closure evidence, or signed high-risk exception is not accepted.',
    ],
    supporting_controls: ['SIEM_ALERTS_ONCALL'],
  },
  {
    key: 'iso_27001',
    stage: 'ISO 27001',
    control_code: 'ISO_27001_EXTERNAL_AUDIT',
    control_area: 'ISO_SOC2',
    control_name: 'ISO 27001 external audit engagement evidence accepted',
    runbook_uri: 'docs/india-deployment-readiness.md',
    engagement_status: 'auditor_selection_required',
    cert_ready_declaration: 'internal_control_pack_ready',
    external_certification_status: 'not_certified',
    blockers: [
      'ISO 27001 auditor, engagement letter, control owners, and evidence cadence are not accepted.',
    ],
    supporting_controls: ['INDIA_LOG_RETENTION_180D', 'SIEM_ALERTS_ONCALL', 'IMAGE_SIGNATURE_ADMISSION'],
  },
  {
    key: 'soc2',
    stage: 'SOC 2',
    control_code: 'SOC2_TYPE2_EXTERNAL_AUDIT',
    control_area: 'ISO_SOC2',
    control_name: 'SOC 2 Type II external audit engagement evidence accepted',
    runbook_uri: 'docs/india-deployment-readiness.md',
    engagement_status: 'auditor_selection_required',
    cert_ready_declaration: 'internal_control_pack_ready',
    external_certification_status: 'not_certified',
    blockers: [
      'SOC 2 auditor, observation window, trust-services scope, and recurring evidence are not accepted.',
    ],
    supporting_controls: ['INDIA_LOG_RETENTION_180D', 'SIEM_ALERTS_ONCALL', 'IMAGE_SIGNATURE_ADMISSION'],
  },
];

const TRACK_CODES = TRACKS.map((track) => track.control_code);
const SUPPORTING_CODES = [...new Set(TRACKS.flatMap((track) => track.supporting_controls))];
const ALL_CODES = [...new Set([...TRACK_CODES, ...SUPPORTING_CODES])];

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function placeholders(count, offset = 2) {
  return Array.from({ length: count }, (_, index) => `$${index + offset}`).join(', ');
}

async function fetchEvidenceRows(tenantId) {
  try {
    return await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, control_code, control_area, control_name, status,
              evidence_uri, owner_uid, due_at, verified_by, verified_at, notes,
              metadata, created_at, updated_at
         FROM india_compliance_evidence
        WHERE tenant_id = $1::uuid
          AND control_code IN (${placeholders(ALL_CODES.length)})
        ORDER BY control_area, control_code`,
      tenantId,
      ...ALL_CODES,
    );
  } catch (err) {
    if (isMissingSchemaError(err)) return [];
    throw err;
  }
}

function acceptanceIssues(row) {
  if (!row || !ACCEPTED_STATUSES.has(row.status)) return [];
  const issues = [];
  if (!String(row.evidence_uri || '').trim()) issues.push('missing_evidence_uri');
  if (!String(row.verified_by || '').trim()) issues.push('missing_verified_by');
  if (!String(row.verified_at || '').trim()) issues.push('missing_verified_at');
  if ((row.status === 'accepted_exception' || row.status === 'not_applicable') && !String(row.notes || '').trim()) {
    issues.push(`missing_${row.status}_notes`);
  }
  return issues;
}

function supportingStatus(codes, evidenceByCode) {
  return codes.map((code) => {
    const row = evidenceByCode.get(code);
    return {
      control_code: code,
      status: row?.status || 'missing',
      acceptance_state: row && ACCEPTED_STATUSES.has(row.status) && acceptanceIssues(row).length === 0
        ? 'accepted'
        : 'open',
      evidence_uri: row?.evidence_uri || null,
      verified_at: toIso(row?.verified_at),
    };
  });
}

function makeTrack(track, row, evidenceByCode) {
  const metadata = asObject(row?.metadata);
  const cockpitMetadata = asObject(metadata.nl12_s8);
  const issues = acceptanceIssues(row);
  const status = row?.status || 'pending';
  const accepted = Boolean(row && ACCEPTED_STATUSES.has(status) && issues.length === 0);
  const metadataBlockers = Array.isArray(cockpitMetadata.blockers) ? cockpitMetadata.blockers : null;
  const blockers = accepted ? [] : [...(metadataBlockers || track.blockers), ...issues];

  return {
    key: track.key,
    stage: track.stage,
    control_code: track.control_code,
    control_area: row?.control_area || track.control_area,
    control_name: row?.control_name || track.control_name,
    status,
    acceptance_state: accepted ? 'accepted' : 'open',
    cert_ready_declaration: cockpitMetadata.cert_ready_declaration
      || metadata.cert_ready_declaration
      || track.cert_ready_declaration,
    external_certification_status: cockpitMetadata.external_certification_status
      || metadata.external_certification_status
      || track.external_certification_status,
    engagement_status: cockpitMetadata.engagement_status
      || metadata.engagement_status
      || track.engagement_status,
    runbook_uri: cockpitMetadata.runbook_uri || metadata.runbook_uri || track.runbook_uri,
    evidence_uri: row?.evidence_uri || null,
    owner_uid: row?.owner_uid || null,
    due_at: toIso(row?.due_at),
    verified_by: row?.verified_by || null,
    verified_at: toIso(row?.verified_at),
    notes: row?.notes || null,
    updated_at: toIso(row?.updated_at),
    blockers,
    blocker_count: blockers.length,
    supporting_controls: supportingStatus(track.supporting_controls, evidenceByCode),
  };
}

export async function getCertificationCockpit({ tenantId = null } = {}) {
  const tid = requireTenantId(tenantId);
  const rows = await fetchEvidenceRows(tid);
  const evidenceByCode = new Map(rows.map((row) => [row.control_code, row]));
  const tracks = TRACKS.map((track) => makeTrack(track, evidenceByCode.get(track.control_code), evidenceByCode));
  const acceptedTracks = tracks.filter((track) => track.acceptance_state === 'accepted');
  const externallyCertifiedTracks = acceptedTracks.filter((track) =>
    String(track.external_certification_status || '').toLowerCase() === 'externally_certified'
  );
  const certReadyTracks = acceptedTracks.filter((track) => String(track.cert_ready_declaration || '').trim().length > 0);

  return {
    cockpit_version: 'nl12-s8-certification-cockpit-v1',
    tenant_id: tid,
    generated_at: new Date().toISOString(),
    declaration_boundary: {
      cert_ready_label: 'internal cert-ready',
      externally_certified_label: 'externally certified',
      rule: 'Accepted evidence rows do not claim external certification unless external_certification_status is externally_certified.',
    },
    summary: {
      total_tracks: tracks.length,
      accepted_count: acceptedTracks.length,
      open_count: tracks.length - acceptedTracks.length,
      blocker_count: tracks.reduce((sum, track) => sum + track.blocker_count, 0),
      cert_ready_count: certReadyTracks.length,
      externally_certified_count: externallyCertifiedTracks.length,
    },
    tracks,
  };
}

export const __testing__ = {
  ACCEPTED_STATUSES,
  TRACKS,
  ALL_CODES,
  acceptanceIssues,
};

export default { getCertificationCockpit };
