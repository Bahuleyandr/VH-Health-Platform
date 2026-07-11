/**
 * Discharge package compose workflow.
 *
 * The first concrete consumer of the workflow graph runner's subgraph
 * composition primitive (migrations 109 + 110, services
 * workflowGraphRunner.js + workflowCheckpointStore.js). It orchestrates
 * four child admission_ai_draft subgraphs into a unified discharge
 * package and demonstrates:
 *
 *   * Subgraph spawn with parent_run_id linkage — each child is its own
 *     clinical_ai_workflow_runs row, queryable as a tree from the
 *     parent.
 *   * Result merge — each spawn returns a state delta into the parent
 *     under a named resultKey, so assemble_compose_result can read
 *     all four drafts uniformly.
 *   * Optional governance pause — the assemble + persist nodes can
 *     park the run for human approval before publishing. The pattern
 *     is wired in here as the canonical demonstration; a future
 *     scheduler that polls store.listPaused({ pause_reason: 'await_governance' })
 *     completes the loop.
 *   * Idempotent resume — if the parent crashes mid-workflow (e.g.
 *     after med_rec but before aftercare), resumeWorkflow rediscovers
 *     the completed children via state.__subgraphs and skips re-running
 *     them.
 *
 * Each child draft remains independently reviewable through the
 * existing clinical_ai_reviews flow (each child's
 * createReviewPlaceholder runs as before). The parent persists a single
 * roll-up generation row tied to the children via
 * metadata.child_generation_ids so dashboards can show the tree.
 *
 * Safety contract: same as everything else in clinical AI services.
 * The compose graph is rules-authoritative — the assemble node does
 * NO inference of its own; it only composes what the children produced.
 * If any child draft hit a CRITICAL safety flag, that bubbles up into
 * the parent's overall_safety_band.
 */

import crypto from 'node:crypto';
import logger from '../../logging/logger.js';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { canOpenCathViewer } from '../../utils/roleHelpers.js';
import { publishEvent } from '../events/eventOutboxService.js';
import {
  ADMISSION_MODULES,
  getAdmissionAiDraftGraph,
  requireEnabledModule,
  resolveTenantId,
} from './clinicalAiWorkflowService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { WorkflowGraph, runWorkflow, pauseRun } from './workflowGraphRunner.js';
import { getDefaultCheckpointStore } from './workflowCheckpointStore.js';
import { buildViewerUrl, getPacsConfig } from '../radiology/pacsService.js';
import { recordClinicalAuditEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { materializeDischargeComposeSections } from '../discharge/dischargeService.js';

const COMPOSE_MODULE_KEY = 'discharge_summary_compose';

const DEFAULT_COMPOSE_CHILDREN = [
  'medication_reconciliation',
  'patient_aftercare_instructions',
  'discharge_readiness',
  'clinical_coding_assist',
];

// Mapping: compose-child module key -> parent state key under which the
// child's result will be stored. Kept stable as a contract — the
// assemble_compose_result node reads these by exact name. Renaming a
// child requires re-running paused parent runs that captured the old key.
const RESULT_KEYS = {
  medication_reconciliation: 'med_rec_draft',
  patient_aftercare_instructions: 'aftercare_draft',
  discharge_readiness: 'readiness_draft',
  clinical_coding_assist: 'coding_draft',
};

const SAFETY_BAND_PRIORITY = ['ok', 'low', 'medium', 'high', 'critical'];

const CATH_SECTION_KEY = 'cath_lab_procedures';
const DICOM_STUDY_UID_RE = /^[0-9]+(?:\.[0-9]+)+$/;
const CATH_CODED_FIELD_KEYS = {
  angiogram: [
    'vessels',
    'lesions',
    'coronary_findings',
    'hemodynamics',
    'hemodynamic_references',
    'pressures',
  ],
  ptca: [
    'vessels_treated',
    'vessels',
    'lesions',
    'stents',
    'stents_deployed',
    'stent_details',
    'hemodynamics',
    'hemodynamic_references',
  ],
  ppi: [
    'device_model',
    'generator_model',
    'device',
    'lead_parameters',
    'leads',
    'hemodynamics',
  ],
  device_implant: [
    'device_model',
    'generator_model',
    'device',
    'lead_parameters',
    'leads',
  ],
  ep_study: [
    'measurements',
    'induced_rhythms',
    'findings',
    'pathway',
    'ablation_sites',
    'hemodynamics',
  ],
};

function highestBand(bands) {
  let best = 'ok';
  for (const band of bands) {
    if (SAFETY_BAND_PRIORITY.indexOf(band) > SAFETY_BAND_PRIORITY.indexOf(best)) best = band;
  }
  return best;
}

function bandFromSafetyFlags(flags) {
  if (!Array.isArray(flags) || flags.length === 0) return 'ok';
  const severities = flags.map((flag) => String(flag.severity || '').toLowerCase());
  if (severities.includes('critical')) return 'critical';
  if (severities.includes('high')) return 'high';
  if (severities.includes('medium')) return 'medium';
  if (severities.includes('low')) return 'low';
  return 'ok';
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cloneJson(value, fallback) {
  if (value === undefined || value === null) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function asObject(value) {
  const cloned = cloneJson(value, {});
  return cloned && typeof cloned === 'object' && !Array.isArray(cloned) ? cloned : {};
}

function isoTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function readableValue(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function findingsText(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object') return null;
  for (const key of ['body', 'text', 'value', 'content', 'summary']) {
    const candidate = readableValue(value[key]);
    if (candidate) return candidate;
  }
  return null;
}

function extractFindingsSummary(narrativeSections, fallback = null) {
  const sections = cloneJson(narrativeSections, null);
  if (Array.isArray(sections)) {
    const finding = sections.find((section) => {
      const key = String(section?.key || section?.section_key || section?.title || '').toLowerCase();
      return key.includes('finding') || key === 'result' || key === 'impression';
    });
    const value = findingsText(finding);
    if (value) return value;
  } else if (sections && typeof sections === 'object') {
    for (const key of ['findings', 'findings_summary', 'result', 'impression']) {
      const value = findingsText(sections[key]);
      if (value) return value;
    }
  }
  return readableValue(fallback);
}

function extractCathKeyCodedFields(reportType, codedFields) {
  const fields = asObject(codedFields);
  const preferred = CATH_CODED_FIELD_KEYS[String(reportType || '').toLowerCase()] || [];
  const selected = {};
  for (const key of preferred) {
    if (fields[key] !== undefined && fields[key] !== null && fields[key] !== '') {
      selected[key] = cloneJson(fields[key], fields[key]);
    }
  }
  return Object.keys(selected).length ? selected : fields;
}

function resolveCathViewer(row, env = process.env) {
  const candidates = [row.viewer_study_accession, row.device_viewer_accession]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const storedAccession = candidates[0] || null;
  const config = getPacsConfig(env);
  if (!config.enabled) {
    return {
      viewer_study_accession: storedAccession,
      viewer_url: null,
      viewer_status: 'pacs_not_configured',
    };
  }
  if (!config.viewer_url) {
    return {
      viewer_study_accession: storedAccession,
      viewer_url: null,
      viewer_status: 'viewer_not_configured',
    };
  }

  if (candidates.length === 0) {
    return { viewer_study_accession: null, viewer_url: null, viewer_status: 'study_not_linked' };
  }
  const studyUid = candidates.find((value) => DICOM_STUDY_UID_RE.test(value));
  if (!studyUid) {
    return {
      viewer_study_accession: candidates[0],
      viewer_url: null,
      viewer_status: 'invalid_study_uid',
    };
  }
  const viewerUrl = buildViewerUrl(studyUid, env);
  return {
    viewer_study_accession: studyUid,
    viewer_url: viewerUrl,
    viewer_status: viewerUrl ? 'available' : 'viewer_not_configured',
  };
}

function operatorLabel(operator) {
  if (typeof operator === 'string') return operator.trim();
  if (!operator || typeof operator !== 'object') return '';
  return String(
    operator.name
      || operator.display_name
      || operator.operator_name
      || operator.staff_name
      || operator.uid
      || '',
  ).trim();
}

function formatCathSectionBody(reports) {
  return reports.map((report) => {
    const lines = [
      `${String(report.report_type || 'other').toUpperCase()} — ${report.procedure_date || 'date not documented'}`,
    ];
    const operators = asArray(report.operators).map(operatorLabel).filter(Boolean);
    if (operators.length) lines.push(`Operator(s): ${operators.join(', ')}`);
    if (report.signer?.name || report.signer?.uid) {
      lines.push(`Signer: ${report.signer.name || report.signer.uid}`);
    }
    if (report.findings_summary) lines.push(`Findings: ${report.findings_summary}`);
    const coded = Object.entries(report.key_coded_fields || {})
      .map(([key, value]) => `${key}: ${readableValue(value)}`)
      .filter((value) => !value.endsWith(': null'));
    if (coded.length) lines.push(`Key coded fields: ${coded.join('; ')}`);
    lines.push(`Full report: ${report.report_reference.href}`);
    if (report.viewer_url) lines.push(`Images: ${report.viewer_url}`);
    return lines.join('\n');
  }).join('\n\n');
}

function buildCathComposeSnapshot(reportRows = [], pendingRows = [], {
  env = process.env,
  now = new Date(),
  viewerAccessAuthorized = false,
} = {}) {
  const reports = asArray(reportRows)
    .filter((row) => String(row?.status || '').toLowerCase() === 'signed')
    .map((row) => {
      const reportId = Number(row.id);
      const viewer = viewerAccessAuthorized
        ? resolveCathViewer(row, env)
        : {
            viewer_study_accession: null,
            viewer_url: null,
            viewer_status: 'access_denied',
          };
      const guardedViewer = viewer.viewer_url
        ? {
            ...viewer,
            viewer_url: `/api/v1/cath-lab/cases/${Number(row.case_id)}/viewer-link`,
          }
        : viewer;
      return {
        report_id: reportId,
        case_id: Number(row.case_id),
        procedure_log_id: row.procedure_log_id == null ? null : Number(row.procedure_log_id),
        report_type: String(row.report_type || 'other').toLowerCase(),
        procedure_date: isoTimestamp(
          row.procedure_ended_at
            || row.procedure_started_at
            || row.case_actual_end_at
            || row.case_actual_start_at
            || row.signed_at,
        ),
        operators: cloneJson(row.operators, []),
        signer: {
          uid: row.signed_by || null,
          name: row.signed_by_name || null,
          signed_at: isoTimestamp(row.signed_at),
        },
        findings_summary: extractFindingsSummary(
          row.narrative_sections,
          row.report_findings_summary || row.procedure_findings_summary,
        ),
        key_coded_fields: extractCathKeyCodedFields(row.report_type, row.coded_fields),
        report_reference: {
          resource_type: 'cath_procedure_report',
          resource_id: String(reportId),
          href: `/api/v1/cath-lab/reports/${reportId}`,
        },
        ...guardedViewer,
      };
    });

  const pending = asArray(pendingRows).map((row) => ({
    case_id: Number(row.case_id),
    procedure_log_id: Number(row.procedure_log_id || row.id),
    procedure_type: row.procedure_type || 'Cath-lab procedure',
    procedure_date: isoTimestamp(row.ended_at || row.started_at),
    procedure_status: row.status || null,
  }));
  const completenessWarnings = pending.length
    ? [{
        severity: 'high',
        code: 'CATH_REPORT_PENDING',
        message: `Cath report pending for ${pending.length} procedure log(s); a signed report is required before discharge summary sign-off.`,
        pending_procedures: pending,
      }]
    : [];
  const snapshotAt = isoTimestamp(now) || new Date().toISOString();
  const section = reports.length
    ? {
        section_key: CATH_SECTION_KEY,
        section_title: 'Cath Lab Procedures',
        body: formatCathSectionBody(reports),
        structured_data: { reports },
        auto_populated: true,
        clinician_editable: true,
        source: 'signed_cath_procedure_reports',
        source_snapshot_at: snapshotAt,
        sync_policy: 'compose_snapshot_only',
      }
    : null;

  return {
    section,
    completenessWarnings,
    sourceSnapshot: {
      captured_at: snapshotAt,
      signed_report_ids: reports.map((report) => report.report_id),
      pending_procedure_log_ids: pending.map((row) => row.procedure_log_id),
      post_issue_sync: false,
    },
  };
}

function buildCathViewerAuditInput({
  reportRow,
  report,
  admissionId,
  requestedBy = null,
  requestContext = {},
  runId,
}) {
  return {
    tenantId: reportRow.tenant_id,
    patientUid: reportRow.patient_uid,
    encounterId: reportRow.encounter_id,
    action: 'cath_lab.viewer_link_resolved',
    actionStatus: report.viewer_status === 'access_denied' ? 'denied' : 'success',
    actorUid: requestedBy,
    actorRole: requestContext.requested_by_role || null,
    resourceType: 'cath_report_viewer_link',
    resourceTable: 'cath_procedure_reports',
    resourceId: String(report.report_id),
    requestId: requestContext.request_id || null,
    metadata: {
      admission_id: Number(admissionId),
      case_id: report.case_id,
      procedure_log_id: report.procedure_log_id,
      compose_run_id: runId,
      view: 'discharge_compose',
      viewer_access_authorized: report.viewer_status !== 'access_denied',
      viewer_status: report.viewer_status,
      viewer_study_accession: report.viewer_study_accession,
    },
    idempotencyKey:
      `cath_procedure_reports:${report.report_id}:audit:viewer_resolved:compose:${runId}:${requestContext.request_id || 'no-request'}`,
  };
}

function buildCathReportViewAuditInput({
  reportRow,
  report,
  admissionId,
  requestedBy = null,
  requestContext = {},
  runId,
}) {
  return {
    tenantId: reportRow.tenant_id,
    patientUid: reportRow.patient_uid,
    encounterId: reportRow.encounter_id,
    action: 'cath_lab.report_viewed',
    actionStatus: 'success',
    actorUid: requestedBy,
    actorRole: requestContext.requested_by_role || null,
    resourceType: 'cath_report',
    resourceTable: 'cath_procedure_reports',
    resourceId: String(report.report_id),
    requestId: requestContext.request_id || null,
    metadata: {
      admission_id: Number(admissionId),
      case_id: report.case_id,
      procedure_log_id: report.procedure_log_id,
      compose_run_id: runId,
      report_type: report.report_type,
      report_status: 'signed',
      view: 'discharge_compose',
    },
    idempotencyKey:
      `cath_procedure_reports:${report.report_id}:audit:report_viewed:compose:${runId}:${requestContext.request_id || 'no-request'}`,
  };
}

async function loadCathReportingSnapshot({
  admissionId,
  tenantId,
  requestedBy = null,
  requestContext = {},
  runId,
}) {
  const { signedReports, pendingProcedures } = await setTenantTx(tenantId, async (tx) => {
    const signedReports = await tx.$queryRawUnsafe(
    `WITH admission_scope AS (
       SELECT a.id, a.tenant_id, a.patient_uid, a.encounter_id
         FROM admissions a
        WHERE a.tenant_id = $1::uuid
          AND a.id = $2::int
     ), scoped_cases AS (
       SELECT c.id, c.tenant_id, c.patient_uid, c.encounter_id,
              c.actual_start_at, c.actual_end_at
         FROM cath_lab_cases c
         JOIN patient_encounters pe
           ON pe.id = c.encounter_id
          AND pe.tenant_id = c.tenant_id
         JOIN admission_scope a
           ON a.tenant_id = c.tenant_id
          AND a.patient_uid = c.patient_uid
          AND (
            pe.admission_id = a.id
            OR pe.admission_encounter_id = a.encounter_id
            OR pe.id = a.encounter_id
          )
     )
     SELECT r.id, r.tenant_id, r.patient_uid,
            COALESCE(r.encounter_id, c.encounter_id) AS encounter_id,
            r.case_id, r.procedure_log_id, r.report_type, r.status,
            r.narrative_sections, r.coded_fields,
            r.findings_summary AS report_findings_summary,
            r.signed_by, r.signed_at,
            r.viewer_study_accession,
            c.actual_start_at AS case_actual_start_at,
            c.actual_end_at AS case_actual_end_at,
            p.started_at AS procedure_started_at,
            p.ended_at AS procedure_ended_at,
            p.operators,
            p.findings_summary AS procedure_findings_summary,
            signer.name AS signed_by_name,
            viewer.external_accession_id AS device_viewer_accession
       FROM cath_procedure_reports r
       JOIN scoped_cases c
         ON c.id = r.case_id
        AND c.tenant_id = r.tenant_id
       LEFT JOIN LATERAL (
         SELECT pl.id, pl.started_at, pl.ended_at, pl.operators, pl.findings_summary
           FROM cath_procedure_logs pl
          WHERE pl.tenant_id = r.tenant_id
            AND pl.case_id = r.case_id
            AND (r.procedure_log_id IS NULL OR pl.id = r.procedure_log_id)
          ORDER BY CASE WHEN pl.id = r.procedure_log_id THEN 0 ELSE 1 END,
                   pl.ended_at DESC NULLS LAST, pl.id DESC
          LIMIT 1
       ) p ON TRUE
       LEFT JOIN users signer
         ON signer.uid = r.signed_by
        AND signer.tenant_id = r.tenant_id
       LEFT JOIN LATERAL (
         SELECT l.external_accession_id
           FROM cath_device_links l
          WHERE l.tenant_id = r.tenant_id
            AND l.case_id = r.case_id
            AND l.link_type = 'angiography_accession'
          ORDER BY l.attached_at DESC, l.id DESC
          LIMIT 1
       ) viewer ON TRUE
      WHERE r.tenant_id = $1::uuid
        AND r.status = 'signed'
      ORDER BY COALESCE(p.ended_at, p.started_at, c.actual_end_at, c.actual_start_at, r.signed_at), r.id`,
    tenantId,
    Number(admissionId),
  );

    const pendingProcedures = await tx.$queryRawUnsafe(
    `WITH admission_scope AS (
       SELECT a.id, a.tenant_id, a.patient_uid, a.encounter_id
         FROM admissions a
        WHERE a.tenant_id = $1::uuid
          AND a.id = $2::int
     ), scoped_cases AS (
       SELECT c.id, c.tenant_id
         FROM cath_lab_cases c
         JOIN patient_encounters pe
           ON pe.id = c.encounter_id
          AND pe.tenant_id = c.tenant_id
         JOIN admission_scope a
           ON a.tenant_id = c.tenant_id
          AND a.patient_uid = c.patient_uid
          AND (
            pe.admission_id = a.id
            OR pe.admission_encounter_id = a.encounter_id
            OR pe.id = a.encounter_id
          )
     )
     SELECT pl.id AS procedure_log_id, pl.case_id, pl.procedure_type,
            pl.status, pl.started_at, pl.ended_at
       FROM cath_procedure_logs pl
       JOIN scoped_cases c
         ON c.id = pl.case_id
        AND c.tenant_id = pl.tenant_id
      WHERE pl.tenant_id = $1::uuid
        AND NOT EXISTS (
          SELECT 1
            FROM cath_procedure_reports r
           WHERE r.tenant_id = pl.tenant_id
             AND r.case_id = pl.case_id
             AND r.status = 'signed'
             AND r.procedure_log_id = pl.id
        )
      ORDER BY COALESCE(pl.ended_at, pl.started_at, pl.created_at), pl.id`,
    tenantId,
    Number(admissionId),
    );

    return { signedReports, pendingProcedures };
  }, { isolationLevel: 'RepeatableRead' });

  const requestedRoles = [
    requestContext.requested_by_raw_role,
    requestContext.requested_by_role,
    ...asArray(requestContext.requested_by_roles),
  ].filter(Boolean);
  const snapshot = buildCathComposeSnapshot(signedReports, pendingProcedures, {
    viewerAccessAuthorized: requestedRoles.some((role) => canOpenCathViewer(role)),
  });
  for (const report of asArray(snapshot.section?.structured_data?.reports)) {
    const reportRow = signedReports.find((row) => Number(row.id) === report.report_id);
    if (!reportRow) continue;
    const reportViewAudit = await recordClinicalAuditEvent(buildCathReportViewAuditInput({
      reportRow,
      report,
      admissionId,
      requestedBy,
      requestContext,
      runId,
    }));
    if (!reportViewAudit?.id) {
      throw AppError.internal(
        'Failed to audit cath report view during discharge compose',
        'CATH_REPORT_VIEW_AUDIT_FAILED',
      );
    }
    const viewerAudit = await recordClinicalAuditEvent(buildCathViewerAuditInput({
      reportRow,
      report,
      admissionId,
      requestedBy,
      requestContext,
      runId,
    }));
    if (!viewerAudit?.id) {
      throw AppError.internal(
        'Failed to audit cath viewer-link resolution',
        'CATH_VIEWER_AUDIT_FAILED',
      );
    }
  }
  return snapshot;
}

// ---------- Governance approval predicate -------------------------------

/**
 * Returns true when a clinical_ai_approvals row exists for the given
 * compose_generation_id whose status is 'approved'.
 *
 * Used by the await_governance_approval graph node (resume-aware check)
 * to detect whether approval has already been granted before deciding to
 * pause. Returns false on any error or when composeGenerationId is null
 * so first-run calls always pause safely.
 *
 * NOTE: This is intentionally inlined here rather than imported from
 * workflowResumeScheduler.js (isGovernanceApproved). The scheduler
 * imports getComposeGraph from this file at module load, so importing
 * back from the scheduler would create a circular dependency. The query
 * body is kept in sync by comment reference.
 */
async function isComposeGovernanceApproved({ tenantId, composeGenerationId }) {
  if (!composeGenerationId) return false;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, status, decided_at
       FROM clinical_ai_approvals
       WHERE tenant_id = $1::uuid
         AND status = 'approved'
         AND payload @> jsonb_build_object('compose_generation_id', $2::int)
       ORDER BY decided_at DESC NULLS LAST
       LIMIT 1`,
      tenantId,
      Number.parseInt(composeGenerationId, 10)
    );
    return Boolean(rows[0]);
  } catch (err) {
    logger.warn('dischargeComposeService: governance approval lookup failed', {
      composeGenerationId,
      error: err.message,
    });
    return false;
  }
}

// ---------- Graph nodes -------------------------------------------------

const COMPOSE_GRAPH_NODES = {
  /**
   * Validate that every child module the operator selected is in
   * ADMISSION_MODULES (i.e. supported by admission_ai_draft) and that
   * the module is enabled for this tenant. Halt early with a structured
   * result if any precondition fails — this avoids spawning children
   * that we know will reject.
   */
  precheck_children: async (state) => {
    const requested = state.composeChildren || DEFAULT_COMPOSE_CHILDREN;
    const unsupported = requested.filter((key) => !ADMISSION_MODULES.has(key));
    if (unsupported.length) {
      throw AppError.badRequest(
        `Unsupported compose child module(s): ${unsupported.join(', ')}`,
        'COMPOSE_CHILD_UNSUPPORTED'
      );
    }
    // Tests inject a pre-loaded childModules map to skip the DB lookup;
    // production callers leave it unset and we fetch from
    // clinical_ai_modules. Either way the rest of the graph reads
    // state.childModules.
    let modules = state.childModules || null;
    const skippedChildren = [];
    if (!modules) {
      modules = {};
      for (const key of requested) {
        try {
          modules[key] = await requireEnabledModule(key, { tenantId: state.tenantId });
        } catch (err) {
          // A child module disabled for this tenant (e.g. the patient-facing
          // aftercare-instructions module, OFF by policy) must NOT fail the
          // whole discharge package. Degrade gracefully: skip the disabled
          // child and compose the rest. requireEnabledModule throws
          // AppError.forbidden (403) for a disabled module; rethrow anything
          // else (not-found, schema) so genuine errors still surface.
          if (err?.statusCode === 403) {
            skippedChildren.push(key);
            logger.info('dischargeCompose: skipping disabled child module', {
              module: key,
              tenantId: state.tenantId,
            });
          } else {
            throw err;
          }
        }
      }
    }
    const activeChildren = requested.filter((key) => modules[key]);
    if (activeChildren.length === 0) {
      throw AppError.badRequest(
        'No enabled compose child modules for this tenant',
        'COMPOSE_NO_ENABLED_CHILDREN'
      );
    }
    return { activeChildren, childModules: modules, skippedChildren };
  },

  load_cath_reporting: async (state, ctx) => ({
    cathReportingSnapshot: await loadCathReportingSnapshot({
      admissionId: state.admissionId,
      tenantId: state.tenantId,
      requestedBy: state.requestedBy,
      requestContext: state.requestContext,
      runId: ctx.runId,
    }),
  }),

  spawn_med_rec: async (state, ctx) => spawnIfRequested(state, ctx, 'medication_reconciliation'),
  spawn_aftercare: async (state, ctx) => spawnIfRequested(state, ctx, 'patient_aftercare_instructions'),
  spawn_readiness: async (state, ctx) => spawnIfRequested(state, ctx, 'discharge_readiness'),
  spawn_coding: async (state, ctx) => spawnIfRequested(state, ctx, 'clinical_coding_assist'),

  /**
   * Combine the four child outputs into a single discharge-package
   * shape. Pure composition: no AI call, no chart re-fetch. Reads the
   * resultKey-named fields populated by the spawn nodes.
   */
  assemble_compose_result: async (state) => {
    const components = {};
    const safetyBands = [];
    const childGenerationIds = [];
    const childCriticalFlags = [];

    for (const childKey of state.activeChildren) {
      const draft = state[RESULT_KEYS[childKey]] || null;
      if (!draft) continue;
      components[childKey] = {
        draft: draft.draft,
        review_id: draft.review_id || null,
        generation_id: draft.draft_generation_id || null,
        review_status: draft.review_status || 'pending',
        safety_flags: draft.safety_flags || [],
      };
      const band = bandFromSafetyFlags(draft.safety_flags);
      safetyBands.push(band);
      if (draft.draft_generation_id) childGenerationIds.push(draft.draft_generation_id);
      childCriticalFlags.push(
        ...asArray(draft.safety_flags).filter((flag) => String(flag.severity).toLowerCase() === 'critical')
      );
    }

    const cathSnapshot = state.cathReportingSnapshot || {
      section: null,
      completenessWarnings: [],
      sourceSnapshot: {
        captured_at: null,
        signed_report_ids: [],
        pending_procedure_log_ids: [],
        post_issue_sync: false,
      },
    };
    const completenessWarnings = asArray(cathSnapshot.completenessWarnings);
    if (completenessWarnings.length) {
      safetyBands.push(highestBand(completenessWarnings.map((warning) => warning.severity)));
      const readiness = components.discharge_readiness;
      if (readiness) {
        const existingDraft = readiness.draft && typeof readiness.draft === 'object'
          ? readiness.draft
          : {};
        readiness.draft = {
          ...existingDraft,
          ready: false,
          blockers: [
            ...asArray(existingDraft.blockers),
            ...completenessWarnings.map((warning) => ({
              type: 'cath_report_pending',
              label: warning.message,
              pending_procedures: warning.pending_procedures,
            })),
          ],
          checklist: {
            ...(existingDraft.checklist && typeof existingDraft.checklist === 'object'
              ? existingDraft.checklist
              : {}),
            cath_reports_signed: false,
          },
        };
        readiness.safety_flags = [
          ...asArray(readiness.safety_flags),
          ...completenessWarnings,
        ];
      }
    } else if (components.discharge_readiness?.draft?.checklist) {
      components.discharge_readiness.draft.checklist.cath_reports_signed = true;
    }

    const overall = highestBand(safetyBands);
    const composeDraft = {
      admission_id: state.admissionId,
      generated_at: new Date().toISOString(),
      components,
      builder_sections: cathSnapshot.section ? [cathSnapshot.section] : [],
      completeness_warnings: completenessWarnings,
      cath_reporting_source_snapshot: cathSnapshot.sourceSnapshot,
      overall_safety_band: overall,
      child_generation_ids: childGenerationIds,
      compose_children: state.activeChildren,
      // Children requested but skipped because they are disabled for this
      // tenant (degrade-and-skip; the package composes what IS enabled).
      skipped_children: asArray(state.skippedChildren),
      // Bubble up critical flags so reviewers see them at the parent
      // level too — they're the single thing that should block release
      // of the package.
      critical_safety_flags: childCriticalFlags,
    };

    return { composeDraft, overallSafetyBand: overall };
  },

  /**
   * Persist a single parent generation row in clinical_ai_generations
   * with task_type/module_key='discharge_summary_compose'. Citations are
   * the union of the children's citations; metadata records the
   * child_generation_ids for traversal. The row uses provider='compose'
   * + used_ai=false because this layer doesn't itself call an LLM.
   */
  persist_compose_generation: async (state) => {
    const status = state.overallSafetyBand === 'critical' ? 'failed' : 'draft';
    const failureReason = status === 'failed' ? 'critical_child_safety_flag' : null;
    const composeDraft = state.composeDraft;

    try {
      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO clinical_ai_generations
           (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model,
            prompt_version, source_hash, status, used_ai, safety_flags, citations, draft,
            generated_by, prompt_tokens, completion_tokens, total_tokens, estimated_cost_minor,
            latency_ms, provider_request_id, finish_reason, metadata, created_at, updated_at)
         VALUES
           ($1::uuid, $2::uuid, $3, $4, $4, 'compose', 'subgraph_orchestration',
            'compose-v1', $5, $6, false, $7::jsonb, $8::jsonb, $9::jsonb,
            $10::uuid, 0, 0, 0, NULL,
            NULL, NULL, NULL, $11::jsonb, NOW(), NOW())
         RETURNING id, status, created_at`,
        state.tenantId,
        state.patientUid,
        state.admissionId,
        COMPOSE_MODULE_KEY,
        // Stable over the child generations + cath-report snapshot identity;
        // captured_at is deliberately excluded so equivalent reruns dedupe.
        crypto.createHash('sha256').update(JSON.stringify({
          child_generation_ids: composeDraft.child_generation_ids,
          cath_report_ids:
            composeDraft.cath_reporting_source_snapshot?.signed_report_ids || [],
          cath_pending_procedure_log_ids:
            composeDraft.cath_reporting_source_snapshot?.pending_procedure_log_ids || [],
        })).digest('hex'),
        status,
        JSON.stringify(composeDraft.critical_safety_flags),
        JSON.stringify([]),
        JSON.stringify(composeDraft),
        state.requestedBy,
        JSON.stringify({
          request_id: state.requestContext?.request_id || null,
          tenant_region: state.requestContext?.tenant_region || null,
          compose_children: state.activeChildren,
          child_generation_ids: composeDraft.child_generation_ids,
          cath_report_ids: composeDraft.cath_reporting_source_snapshot?.signed_report_ids || [],
          cath_report_pending_count:
            composeDraft.cath_reporting_source_snapshot?.pending_procedure_log_ids?.length || 0,
          overall_safety_band: state.overallSafetyBand,
          failure_reason: failureReason,
        })
      );
      return { composeGeneration: rows[0] };
    } catch (err) {
      logger.error('Failed to persist compose generation', {
        admissionId: state.admissionId,
        error: err.message,
      });
      throw err;
    }
  },

  /**
   * Optional governance pause. Gated by the module's
   * settings.requireGovernanceApproval. When set, parks the run; the
   * workflowResumeScheduler detects the matching clinical_ai_approvals
   * row transitioning to 'approved' and resumes via resumeWorkflow().
   *
   * Resume-aware: on re-entry (after the scheduler resumes the run) the
   * node checks whether approval already exists and proceeds immediately
   * if so. Without this check the node would unconditionally re-pause on
   * every resume, causing an infinite loop (the scheduler resumes → node
   * pauses again → scheduler resumes → ...).
   *
   * Predicate mirrors workflowResumeScheduler.isGovernanceApproved() but
   * is inlined here to avoid a circular import: workflowResumeScheduler
   * imports getComposeGraph from this file at module load, so importing
   * back from the scheduler would create a cycle.
   */
  await_governance_approval: async (state) => {
    if (!state.composeModule?.settings?.requireGovernanceApproval) {
      return {}; // pass through; no pause
    }
    const generationId = state.composeGeneration?.id || null;
    if (generationId && await isComposeGovernanceApproved({ tenantId: state.tenantId, composeGenerationId: generationId })) {
      return {}; // already approved → proceed
    }
    return pauseRun('await_governance', {
      pendingApproval: {
        compose_generation_id: generationId,
        admission_id: state.admissionId,
      },
    });
  },

  publish_compose_event: async (state) => {
    await materializeDischargeComposeSections({
      tenantId: state.tenantId,
      admissionId: state.admissionId,
      composeResult: state.composeDraft,
      actorUid: state.requestedBy,
    });
    await publishEvent({
      eventType: 'clinical_ai.discharge_compose_generated',
      aggregateType: 'clinical_ai_generation',
      aggregateId: state.composeGeneration?.id || null,
      patientUid: state.patientUid,
      payload: {
        tenant_id: state.tenantId,
        admission_id: state.admissionId,
        compose_children: state.activeChildren,
        child_generation_ids: state.composeDraft.child_generation_ids,
        overall_safety_band: state.overallSafetyBand,
      },
    });
    return {};
  },

  build_response: async (state) => ({
    result: {
      module_key: COMPOSE_MODULE_KEY,
      admission_id: state.admissionId,
      compose_generation_id: state.composeGeneration?.id || null,
      overall_safety_band: state.overallSafetyBand,
      compose_children: state.activeChildren,
      components: state.composeDraft.components,
      builder_sections: state.composeDraft.builder_sections,
      completeness_warnings: state.composeDraft.completeness_warnings,
      cath_reporting_source_snapshot: state.composeDraft.cath_reporting_source_snapshot,
      child_generation_ids: state.composeDraft.child_generation_ids,
      critical_safety_flags: state.composeDraft.critical_safety_flags,
      requires_signoff: true,
    },
  }),
};

/**
 * Common helper invoked by the per-child spawn nodes. If the child
 * module is on the active list, spawn the admission_ai_draft graph as a
 * subgraph; otherwise pass through. Idempotent re-entry is handled
 * inside ctx.runSubgraph (see workflowGraphRunner.js).
 *
 * The admission graph is read from ctx.admissionGraph if present —
 * tests pass a stubbed graph that returns synthetic drafts via the
 * runWorkflow `ctx` parameter (which is not persisted with state, so
 * its class instances + functions survive). Production callers leave
 * it unset, which falls back to getAdmissionAiDraftGraph().
 */
async function spawnIfRequested(state, ctx, childModuleKey) {
  if (!state.activeChildren?.includes(childModuleKey)) {
    return {}; // child disabled by tenant config
  }
  const childModule = state.childModules?.[childModuleKey];
  if (!childModule) {
    throw AppError.internal(
      `Compose child module '${childModuleKey}' was not pre-loaded`,
      'COMPOSE_CHILD_MODULE_MISSING'
    );
  }
  const admissionGraph = ctx.admissionGraph || getAdmissionAiDraftGraph();
  return ctx.runSubgraph({
    graph: admissionGraph,
    initialState: {
      admissionId: state.admissionId,
      moduleKey: childModuleKey,
      requestedBy: state.requestedBy,
      requestContext: state.requestContext,
      module: childModule,
      tenantId: state.tenantId,
    },
    resultKey: RESULT_KEYS[childModuleKey],
    metadata: {
      module_key: childModuleKey,
      admission_id: state.admissionId,
      composed_under: COMPOSE_MODULE_KEY,
    },
  });
}

let _composeGraph = null;
/**
 * Returns the (lazily-built) WorkflowGraph for discharge_summary_compose.
 * Public so callers like the resume route can pass it to resumeWorkflow
 * without re-importing the private constants. Idempotent — the graph is
 * built once per process.
 */
export function getComposeGraph() {
  if (!_composeGraph) {
    _composeGraph = new WorkflowGraph({
      key: COMPOSE_MODULE_KEY,
      nodes: COMPOSE_GRAPH_NODES,
      start: 'precheck_children',
    });
  }
  return _composeGraph;
}

// ---------- Public entry point -----------------------------------------

/**
 * Compose a discharge package for an admission. Spawns up to four
 * admission_ai_draft subgraphs, assembles their results, and persists a
 * parent generation row tying them together.
 *
 * Returns the standard response shape (final node is build_response).
 * Throws AppError on validation failure or unrecoverable child failure.
 *
 * Idempotent on resume: if a previous invocation crashed or paused, the
 * caller can re-invoke with the same admissionId — no, wait, that would
 * start a new top-level run. To resume the prior, call resumeWorkflow
 * with the prior runId. composeDischargePackage always starts a fresh
 * top-level run; the children inside are idempotent on resume of the
 * parent.
 */
export async function composeDischargePackage(admissionId, requestedBy, req = null) {
  if (!Number.isFinite(Number(admissionId))) {
    throw AppError.badRequest('Invalid admission id', 'INVALID_ADMISSION_ID');
  }
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const composeModule = await getClinicalAiModule(COMPOSE_MODULE_KEY, { tenantId });
  if (!composeModule.enabled) {
    throw AppError.forbidden(
      `Discharge compose module is disabled for this tenant`,
      'COMPOSE_MODULE_DISABLED'
    );
  }

  const composeChildren = composeModule.settings?.composeChildren?.length
    ? composeModule.settings.composeChildren
    : DEFAULT_COMPOSE_CHILDREN;

  const requestContext = {
    request_id: req?.id || null,
    tenant_region: req?.tenant?.region || null,
    requested_by_raw_role: req?.user?.rawRole || null,
    requested_by_role: req?.user?.role || null,
    requested_by_roles: asArray(req?.user?.roles),
  };

  const patientUid = await resolvePatientUid(admissionId, tenantId);

  const outcome = await runWorkflow({
    graph: getComposeGraph(),
    initialState: {
      admissionId,
      requestedBy,
      requestContext,
      tenantId,
      patientUid,
      composeChildren,
      composeModule,
    },
    store: getDefaultCheckpointStore(),
    tenantId,
    startedBy: requestedBy,
    workflowMetadata: {
      module_key: COMPOSE_MODULE_KEY,
      admission_id: admissionId,
      request_id: requestContext.request_id,
    },
  });

  if (outcome.status === 'failed') {
    const node = outcome.error?.node || 'unknown';
    const message = outcome.error?.message || 'Workflow failed';
    logger.error('Discharge compose workflow failed', { admissionId, node, message });
    throw AppError.internal('Failed to compose discharge package', 'DISCHARGE_COMPOSE_FAILED');
  }

  if (outcome.status === 'paused') {
    return {
      module_key: COMPOSE_MODULE_KEY,
      admission_id: admissionId,
      run_id: outcome.runId,
      status: 'paused',
      pause_reason: outcome.pauseReason,
      message: 'Discharge compose is awaiting external action; resume via resumeWorkflow with this run_id.',
    };
  }

  return outcome.result;
}

async function resolvePatientUid(admissionId, tenantId = null) {
  try {
    // Tenant-scope the lookup so a compose can never resolve an admission
    // outside the caller's tenant (intra-/cross-tenant IDOR hardening). When
    // tenantId is unknown (legacy callers), fall back to the unscoped lookup.
    const rows = tenantId
      ? await prisma.$queryRawUnsafe(
          `SELECT patient_uid FROM admissions WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
          Number.parseInt(admissionId, 10),
          tenantId,
        )
      : await prisma.$queryRawUnsafe(
          `SELECT patient_uid FROM admissions WHERE id = $1 LIMIT 1`,
          Number.parseInt(admissionId, 10),
        );
    return rows[0]?.patient_uid || null;
  } catch (err) {
    logger.warn('Failed to resolve patient_uid for compose', { admissionId, error: err.message });
    return null;
  }
}

// Public constant — useful for callers that want the canonical key
// (e.g. listing compose runs filtered by workflow_key).
export const DISCHARGE_COMPOSE_WORKFLOW_KEY = COMPOSE_MODULE_KEY;

// Test-only exports. The runtime exports above (composeDischargePackage,
// getComposeGraph, DISCHARGE_COMPOSE_WORKFLOW_KEY) are the documented
// public API. Anything in __testing__ is implementation detail used by
// the unit suite and is liable to change.
export const __testing__ = {
  COMPOSE_MODULE_KEY,
  COMPOSE_GRAPH_NODES,
  RESULT_KEYS,
  DEFAULT_COMPOSE_CHILDREN,
  bandFromSafetyFlags,
  highestBand,
  isComposeGovernanceApproved,
  buildCathComposeSnapshot,
  extractCathKeyCodedFields,
  extractFindingsSummary,
  resolveCathViewer,
  loadCathReportingSnapshot,
  buildCathReportViewAuditInput,
  buildCathViewerAuditInput,
};

export default {
  composeDischargePackage,
  getComposeGraph,
};
