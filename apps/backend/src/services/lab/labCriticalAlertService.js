import { setTenantTx } from '../../lib/prisma.js';
import { lockResultsInboxResourceTx } from '../results/resultsInboxResourceLock.js';
import {
  enqueueCriticalResultTask,
  ensureCriticalResultTaskOpen,
} from '../results/resultsInboxService.js';
import { supersedeAcknowledgementTaskFromTrustedWorkflow } from '../workflow/taskService.js';

const CORRECTIVE_DECISIONS = new Set(['corrected', 'amended']);
const ALERT_STATES = new Set([
  'critical',
  'within_active_critical_thresholds',
  'threshold_unavailable',
  'legacy_unclassified',
]);

function normalizeAssessment(assessment) {
  if (!assessment || typeof assessment !== 'object') {
    throw new Error('Lab criticality assessment is required');
  }
  const breached = assessment.breached === true;
  const matched = assessment.matched === true;
  const breachedSide = breached ? String(assessment.breachedSide || '').trim() : null;
  const breachedValue = breached ? Number(assessment.breachedValue) : null;
  const evaluatedValue = assessment.evaluatedValue == null
    ? null
    : Number(assessment.evaluatedValue);
  if (breached && !['low', 'high'].includes(breachedSide)) {
    throw new Error('Critical lab assessment requires a low/high breached side');
  }
  if (breached && !Number.isFinite(breachedValue)) {
    throw new Error('Critical lab assessment requires a numeric breached threshold');
  }
  if (evaluatedValue != null && !Number.isFinite(evaluatedValue)) {
    throw new Error('Critical lab assessment evaluated value is invalid');
  }
  return {
    ...assessment,
    breached,
    matched,
    breachedSide,
    breachedValue,
    evaluatedValue,
  };
}

function stateForAssessment(assessment) {
  if (assessment.breached) return 'critical';
  return assessment.matched
    ? 'within_active_critical_thresholds'
    : 'threshold_unavailable';
}

function describeAssessment(assessment) {
  if (assessment.breached) {
    return `current value breaches the active ${assessment.breachedSide} critical threshold ${assessment.breachedValue}`;
  }
  if (assessment.matched) {
    return 'current value does not breach the active critical thresholds; prior critical alert superseded';
  }
  return 'current criticality could not be classified against an active threshold; prior critical alert superseded';
}

export async function supersedeCriticalAlertWithDiagnosticGenerationTx({
  tx,
  tenantId,
  resultId,
  patientUid,
  signoffId,
  diagnosticGenerationId,
  supersededByActorUid,
  criticality,
} = {}) {
  await lockResultsInboxResourceTx({
    tx,
    tenantId,
    resourceType: 'lab_result',
    resourceId: String(resultId),
  });
  const rows = await tx.$queryRawUnsafe(
    `SELECT alert.id, alert.patient_uid, alert.acknowledged_at,
            alert.acknowledgement_task_id, alert.superseded_at,
            alert.superseded_by_diagnostic_generation_id,
            task.status AS task_status,
            task.workflow_sla_instance_id,
            sla.completed_at AS sla_completed_at
       FROM lab_critical_alerts AS alert
       LEFT JOIN tasks AS task
         ON task.tenant_id = alert.tenant_id
        AND task.id = alert.acknowledgement_task_id
       LEFT JOIN workflow_sla_instances AS sla
         ON sla.tenant_id = task.tenant_id
        AND sla.id = task.workflow_sla_instance_id
      WHERE alert.tenant_id = $1::uuid
        AND alert.result_id = $2::int
        AND alert.patient_uid = $3::uuid
        AND (
          alert.superseded_at IS NULL
          OR alert.superseded_by_diagnostic_generation_id = $4::uuid
        )
      ORDER BY alert.id DESC
      LIMIT 1
      FOR UPDATE OF alert`,
    tenantId,
    Number(resultId),
    patientUid,
    diagnosticGenerationId,
  );
  const alert = rows[0] || null;
  const resultRows = await tx.$queryRawUnsafe(
    `SELECT id, patient_uid, loinc_code, test_code, value_text,
            value_numeric, unit
       FROM lab_results
      WHERE tenant_id = $1::uuid
        AND id = $2::integer
        AND patient_uid = $3::uuid
      LIMIT 1`,
    tenantId,
    Number(resultId),
    patientUid,
  );
  const result = resultRows[0];
  if (!result) throw new Error('Corrected lab result is unavailable for supersession');
  const assessment = normalizeAssessment(criticality);
  if (assessment.breached) {
    throw new Error('A critical corrected result cannot use diagnostic supersession');
  }
  const receipt = await persistNoAlertCorrectiveReceipt({
    tx,
    tenantId,
    result,
    signoff: { id: Number(signoffId) },
    source: 'diagnostic_generation_supersession',
    assessment,
  });
  if (!alert) return { superseded: false, alert: null, task: null, receipt };
  if (alert.superseded_at) {
    if (String(alert.superseded_by_diagnostic_generation_id) !== String(diagnosticGenerationId)) {
      throw new Error('Critical alert was superseded by a different diagnostic generation');
    }
    return { superseded: true, alert, task: null, receipt, replayed: true };
  }

  let task = null;
  if (
    !alert.acknowledged_at
    && alert.acknowledgement_task_id
    && ['open', 'blocked', 'overdue', 'in_progress'].includes(alert.task_status)
    && !alert.sla_completed_at
  ) {
    task = await supersedeAcknowledgementTaskFromTrustedWorkflow({
      tenantId,
      id: alert.acknowledgement_task_id,
      relatedResourceType: 'lab_result',
      relatedResourceId: String(resultId),
      workflowSlaInstanceId: alert.workflow_sla_instance_id,
      supersededByActorUid,
      supersedingDiagnosticGenerationId: diagnosticGenerationId,
      tx,
    });
  }

  const updated = await tx.$queryRawUnsafe(
    `UPDATE lab_critical_alerts
        SET superseded_at = GREATEST(
              NOW(),
              fired_at + INTERVAL '1 microsecond',
              (SELECT signed_at
                 FROM lab_pathologist_signoffs
                WHERE tenant_id = $1::uuid
                  AND id = $5::int)
            ),
            superseded_by_alert_id = NULL,
            superseded_by_signoff_id = $5::int,
            superseded_by_diagnostic_generation_id = $4::uuid
      WHERE tenant_id = $1::uuid
        AND id = $2::int
        AND patient_uid = $3::uuid
        AND superseded_at IS NULL
      RETURNING *`,
    tenantId,
    Number(alert.id),
    patientUid,
    diagnosticGenerationId,
    Number(signoffId),
  );
  if (!updated[0]) throw new Error('Critical alert supersession changed concurrently');
  return { superseded: true, alert: updated[0], task, receipt, replayed: false };
}

async function resolveOrderingClinician({ tx, tenantId, result, orderingClinicianUid }) {
  if (orderingClinicianUid) return String(orderingClinicianUid);
  if (result.investigation_id == null) return null;
  const rows = await tx.$queryRawUnsafe(
    `SELECT requested_by
       FROM investigations
      WHERE tenant_id = $1::uuid
        AND id = $2::int
      LIMIT 1`,
    tenantId,
    Number(result.investigation_id),
  );
  return rows[0]?.requested_by || null;
}

async function validateBoundTask({ tx, tenantId, result, taskId }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT task.id,
            task.assigned_to_uid,
            task.assigned_to_role,
            task.workflow_sla_instance_id,
            sla.id AS sla_id
       FROM tasks AS task
       JOIN workflow_sla_instances AS sla
         ON sla.tenant_id = task.tenant_id
        AND sla.id = task.workflow_sla_instance_id
      WHERE task.tenant_id = $1::uuid
        AND task.id = $2::int
        AND task.patient_uid = $3::uuid
        AND task.related_resource_type = 'lab_result'
        AND task.related_resource_id = $4::text
        AND task.sla_completion_semantics = 'acknowledgement'
        AND task.status IN ('open', 'blocked', 'overdue')
        AND sla.rule_code = 'critical_result_ack'
        AND sla.source_table = 'lab_result'
        AND sla.source_id = $4::text
        AND sla.patient_uid = $3::uuid
        AND sla.status IN ('active', 'breached', 'escalated')
        AND sla.completed_at IS NULL
      LIMIT 1`,
    tenantId,
    Number(taskId),
    result.patient_uid,
    String(result.id),
  );
  if (!rows[0]) {
    throw new Error('Critical lab alert has no exact active acknowledgement task/SLA binding');
  }
  return rows[0];
}

async function persistNoAlertCorrectiveReceipt({
  tx,
  tenantId,
  result,
  signoff,
  source,
  assessment,
}) {
  const outcome = assessment.matched
    ? 'within_active_critical_thresholds'
    : 'no_active_critical_threshold';
  const evidence = {
    evaluator: 'labCriticalThresholdService',
    matched: assessment.matched,
    breached: assessment.breached,
    lookup_test_code: result.test_code || null,
    lookup_loinc_code: result.loinc_code || null,
  };
  const inserted = await tx.$queryRawUnsafe(
    `INSERT INTO lab_critical_alert_reconciliation_receipts
       (tenant_id, result_id, patient_uid, signoff_id, signoff_decision,
        signoff_signed_at, outcome, source, result_value_text,
        result_value_numeric, result_unit, evaluated_value, threshold_id,
        threshold_test_code, threshold_loinc_code, threshold_low,
        threshold_high, threshold_unit, threshold_applies_to,
        threshold_conversion, evidence)
     SELECT $1::uuid, $2::int, $3::uuid, $4::int, signoff.decision,
            signoff.signed_at, $5, $6, $7, $8::numeric, $9, $10::numeric,
            $11::int, $12, $13, $14::numeric, $15::numeric, $16, $17,
            $18, $19::jsonb
       FROM lab_pathologist_signoffs AS signoff
      WHERE signoff.tenant_id = $1::uuid
        AND signoff.id = $4::int
        AND signoff.patient_uid = $3::uuid
        AND $2::int = ANY(signoff.result_ids)
     ON CONFLICT (tenant_id, result_id, signoff_id) DO NOTHING
     RETURNING *`,
    tenantId,
    Number(result.id),
    result.patient_uid,
    Number(signoff.id),
    outcome,
    source,
    result.value_text,
    result.value_numeric,
    result.unit,
    assessment.evaluatedValue,
    assessment.thresholdId ?? null,
    assessment.thresholdTestCode ?? null,
    assessment.thresholdLoincCode ?? null,
    assessment.criticalLow ?? null,
    assessment.criticalHigh ?? null,
    assessment.thresholdUnit ?? null,
    assessment.thresholdAppliesTo ?? null,
    assessment.conversion ?? null,
    JSON.stringify(evidence),
  );
  if (inserted[0]) return inserted[0];
  const existing = await tx.$queryRawUnsafe(
    `SELECT *
       FROM lab_critical_alert_reconciliation_receipts
      WHERE tenant_id = $1::uuid
        AND result_id = $2::int
        AND signoff_id = $3::int
      LIMIT 1`,
    tenantId,
    Number(result.id),
    Number(signoff.id),
  );
  if (!existing[0]) throw new Error('Corrective no-alert evidence could not be persisted');
  return existing[0];
}

/**
 * Atomically materialize one current lab-alert generation and its exact
 * acknowledgement task/SLA binding. Notifications and realtime fan-out remain
 * post-commit responsibilities of the caller.
 */
export async function materializeLabCriticalAlertGeneration({
  tx: callerTx = null,
  tenantId,
  resultId,
  expectedPatientUid = null,
  criticality = null,
  evaluateCriticality = null,
  orderingClinicianUid = null,
  source = 'lab_result',
  taskTitle = null,
  taskSummary = null,
  generationSignoffId = null,
  generationDecision = null,
  generationActorUid = null,
  reconciledLegacySignoffIds = null,
} = {}) {
  const numericResultId = Number(resultId);
  if (!Number.isSafeInteger(numericResultId) || numericResultId <= 0) {
    throw new Error('Lab result id is invalid');
  }
  const numericSignoffId = generationSignoffId == null ? null : Number(generationSignoffId);
  if (
    numericSignoffId != null
    && (!Number.isSafeInteger(numericSignoffId) || numericSignoffId <= 0)
  ) {
    throw new Error('Corrective lab sign-off id is invalid');
  }
  const decision = generationDecision == null
    ? null
    : String(generationDecision).trim().toLowerCase();
  if (numericSignoffId != null && !CORRECTIVE_DECISIONS.has(decision)) {
    throw new Error('Corrective alert generation requires a corrected/amended decision');
  }
  if ((numericSignoffId == null) !== (decision == null)) {
    throw new Error('Corrective alert generation sign-off provenance is incomplete');
  }
  const reconciledSignoffIds = reconciledLegacySignoffIds == null
    ? null
    : [...new Set(reconciledLegacySignoffIds.map(Number))].sort((a, b) => a - b);
  if (
    reconciledSignoffIds
    && (
      numericSignoffId == null
      || reconciledSignoffIds.length === 0
      || !reconciledSignoffIds.includes(numericSignoffId)
      || reconciledSignoffIds.some(
        (id) => !Number.isSafeInteger(id) || id <= 0 || id > numericSignoffId,
      )
    )
  ) {
    throw new Error('Legacy corrective sign-off reconciliation provenance is invalid');
  }

  const produce = async (tx) => {
    await lockResultsInboxResourceTx({
      tx,
      tenantId,
      resourceType: 'lab_result',
      resourceId: String(numericResultId),
    });

    const resultRows = await tx.$queryRawUnsafe(
      `SELECT id, patient_uid, investigation_id, loinc_code, test_code,
              test_name, value_text, value_numeric, unit, is_critical
         FROM lab_results
        WHERE tenant_id = $1::uuid
          AND id = $2::int
          AND ($3::uuid IS NULL OR patient_uid = $3::uuid)
        LIMIT 1
        FOR UPDATE`,
      tenantId,
      numericResultId,
      expectedPatientUid || null,
    );
    const result = resultRows[0];
    if (!result) throw new Error('Lab result is no longer available for critical-alert materialization');

    const currentRows = await tx.$queryRawUnsafe(
      `SELECT id, result_id, patient_uid, threshold_breached, threshold_value,
              fired_at, acknowledged_at, generation_signoff_id,
              acknowledgement_task_id, generation_metadata
         FROM lab_critical_alerts
        WHERE tenant_id = $1::uuid
          AND result_id = $2::int
          AND patient_uid = $3::uuid
          AND superseded_at IS NULL
        ORDER BY id DESC
        LIMIT 1`,
      tenantId,
      numericResultId,
      result.patient_uid,
    );
    const predecessor = currentRows[0] || null;

    let signoff = null;
    if (numericSignoffId != null) {
      const signoffRows = await tx.$queryRawUnsafe(
        `SELECT id, patient_uid, decision, signed_off_by, signed_at
           FROM lab_pathologist_signoffs
          WHERE tenant_id = $1::uuid
            AND patient_uid = $2::uuid
            AND $3::int = ANY(result_ids)
            AND decision IN ('corrected', 'amended')
          ORDER BY id DESC
          LIMIT 1`,
        tenantId,
        result.patient_uid,
        numericResultId,
      );
      signoff = signoffRows[0] || null;
      if (
        !signoff
        || Number(signoff.id) !== numericSignoffId
        || String(signoff.decision).toLowerCase() !== decision
      ) {
        return {
          created: false,
          skippedReason: 'stale_corrective_signoff',
          alert: predecessor,
          task: null,
          state: predecessor?.generation_metadata?.corrected_state || null,
          criticality: null,
        };
      }
      if (
        generationActorUid
        && String(signoff.signed_off_by).toLowerCase() !== String(generationActorUid).toLowerCase()
      ) {
        throw new Error('Corrective alert generation actor does not match the sign-off');
      }
      if (
        predecessor?.generation_signoff_id != null
        && Number(predecessor.generation_signoff_id) >= numericSignoffId
      ) {
        return {
          created: false,
          skippedReason: 'corrective_signoff_already_materialized',
          alert: predecessor,
          task: null,
          state: predecessor?.generation_metadata?.corrected_state || null,
          criticality: null,
        };
      }
    } else if (predecessor) {
      if (predecessor.acknowledged_at) {
        return {
          created: false,
          skippedReason: 'alert_already_acknowledged',
          alert: predecessor,
          task: null,
          state: predecessor?.generation_metadata?.corrected_state || 'critical',
          criticality: null,
        };
      }
      let boundTask = null;
      let repairedLegacyBinding = false;
      if (predecessor.acknowledgement_task_id != null) {
        boundTask = await validateBoundTask({
          tx,
          tenantId,
          result,
          taskId: predecessor.acknowledgement_task_id,
        });
      } else {
        const resolvedOrderingClinicianUid = await resolveOrderingClinician({
          tx,
          tenantId,
          result,
          orderingClinicianUid,
        });
        const repaired = await enqueueCriticalResultTask({
          tenantId,
          patientUid: result.patient_uid,
          source: `${source}_legacy_binding_repair`,
          resourceType: 'lab_result',
          resourceId: numericResultId,
          severity: 'critical',
          title: taskTitle || `Critical lab: ${result.test_name}`,
          summary: taskSummary
            || `${result.test_name} = ${result.value_text}${result.unit ? ` ${result.unit}` : ''}; acknowledgement required.`,
          orderingClinicianUid: resolvedOrderingClinicianUid,
          tx,
          strict: true,
        });
        if (!repaired?.taskId) {
          throw new Error('Unbound critical lab alert could not materialize an exact task/SLA');
        }
        const taskRows = await tx.$queryRawUnsafe(
          `UPDATE tasks
              SET metadata = (
                    COALESCE(metadata, '{}'::jsonb)
                      - 'lab_alert_generation_signoff_id'
                  ) || jsonb_build_object(
                    'lab_critical_alert_id', $3::int,
                    'lab_alert_generation_state', 'critical'
                  ),
                  updated_at = NOW()
            WHERE tenant_id = $1::uuid
              AND id = $2::int
              AND status IN ('open', 'blocked', 'overdue')
            RETURNING id`,
          tenantId,
          Number(repaired.taskId),
          Number(predecessor.id),
        );
        if (!taskRows[0]) throw new Error('Unbound critical lab task could not be alert-bound');
        const alertRows = await tx.$queryRawUnsafe(
          `UPDATE lab_critical_alerts
              SET acknowledgement_task_id = $3::int,
                  generation_metadata = jsonb_build_object(
                    'kind', 'initial_result_generation',
                    'source', $4::text,
                    'acknowledgement_task_id', $3::int,
                    'corrected_state', 'critical',
                    'legacy_repair', true
                  )
            WHERE tenant_id = $1::uuid
              AND id = $2::int
              AND acknowledged_at IS NULL
              AND superseded_at IS NULL
              AND acknowledgement_task_id IS NULL
            RETURNING *`,
          tenantId,
          Number(predecessor.id),
          Number(repaired.taskId),
          source,
        );
        if (!alertRows[0]) throw new Error('Unbound critical lab alert changed during repair');
        predecessor.acknowledgement_task_id = Number(repaired.taskId);
        predecessor.generation_metadata = alertRows[0].generation_metadata;
        repairedLegacyBinding = true;
        await tx.$executeRawUnsafe(
          `UPDATE lab_results
              SET is_critical = true,
                  updated_at = NOW()
            WHERE tenant_id = $1::uuid
              AND id = $2::int`,
          tenantId,
          numericResultId,
        );
        boundTask = await validateBoundTask({
          tx,
          tenantId,
          result,
          taskId: repaired.taskId,
        });
      }
      return {
        created: false,
        skippedReason: repairedLegacyBinding
          ? 'legacy_alert_binding_repaired'
          : 'alert_generation_already_current',
        alert: predecessor,
        task: {
          taskId: Number(boundTask.id),
          slaInstanceId: boundTask.sla_id,
          assignedToUid: boundTask.assigned_to_uid || null,
          assignedToRole: boundTask.assigned_to_role || null,
        },
        state: predecessor?.generation_metadata?.corrected_state || 'critical',
        criticality: null,
      };
    }

    const assessment = normalizeAssessment(
      typeof evaluateCriticality === 'function'
        ? await evaluateCriticality({ tx, result })
        : criticality,
    );
    if (!predecessor && !assessment.breached) {
      await tx.$executeRawUnsafe(
        `UPDATE lab_results
            SET is_critical = false,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = $2::int`,
        tenantId,
        numericResultId,
      );
      const receipt = numericSignoffId == null
        ? null
        : await persistNoAlertCorrectiveReceipt({
          tx,
          tenantId,
          result,
          signoff,
          source,
          assessment,
        });
      return {
        created: false,
        skippedReason: 'not_critical_without_alert_history',
        alert: null,
        task: null,
        receipt,
        state: stateForAssessment(assessment),
        criticality: assessment,
      };
    }

    const state = stateForAssessment(assessment);
    if (!ALERT_STATES.has(state)) throw new Error('Critical alert generation state is invalid');
    const assessmentSummary = describeAssessment(assessment);
    const resolvedOrderingClinicianUid = await resolveOrderingClinician({
      tx,
      tenantId,
      result,
      orderingClinicianUid,
    });
    const title = taskTitle || (numericSignoffId != null
      ? (assessment.breached
        ? `Critical lab (${decision}): ${result.test_name}`
        : `Corrected lab result review: ${result.test_name}`)
      : `Critical lab: ${result.test_name}`);
    const summary = taskSummary
      || `${result.test_name} = ${result.value_text}${result.unit ? ` ${result.unit}` : ''} — ${assessmentSummary}; acknowledgement required.`;

    const taskMaterialization = numericSignoffId != null
      ? await ensureCriticalResultTaskOpen({
        tenantId,
        patientUid: result.patient_uid,
        source,
        resourceType: 'lab_result',
        resourceId: numericResultId,
        severity: 'critical',
        title,
        summary,
        orderingClinicianUid: resolvedOrderingClinicianUid,
        reason: `lab_signoff_${decision}`,
        supersededByActorUid: generationActorUid ? String(generationActorUid) : null,
        forceNewAcknowledgementWindow: true,
        tx,
        strict: true,
      })
      : await enqueueCriticalResultTask({
        tenantId,
        patientUid: result.patient_uid,
        source,
        resourceType: 'lab_result',
        resourceId: numericResultId,
        severity: 'critical',
        title,
        summary,
        orderingClinicianUid: resolvedOrderingClinicianUid,
        tx,
        strict: true,
      });
    if (!taskMaterialization?.taskId) {
      throw new Error('Critical lab alert did not materialize an acknowledgement task');
    }

    const reservedIds = await tx.$queryRawUnsafe(
      `SELECT nextval(pg_get_serial_sequence('lab_critical_alerts', 'id'))::int AS id`,
    );
    const alertId = Number(reservedIds[0]?.id);
    if (!Number.isSafeInteger(alertId) || alertId <= 0) {
      throw new Error('Critical lab alert id could not be reserved');
    }
    const taskMetadata = {
      lab_critical_alert_id: alertId,
      lab_alert_generation_state: state,
      ...(numericSignoffId == null
        ? {}
        : { lab_alert_generation_signoff_id: numericSignoffId }),
    };
    const taskUpdates = await tx.$queryRawUnsafe(
      `UPDATE tasks
          SET title = $3,
              description = $4,
              metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::int
          AND status IN ('open', 'blocked', 'overdue')
        RETURNING id, assigned_to_uid, assigned_to_role,
                  workflow_sla_instance_id`,
      tenantId,
      Number(taskMaterialization.taskId),
      title,
      summary,
      JSON.stringify(taskMetadata),
    );
    if (!taskUpdates[0]) {
      throw new Error('Critical lab acknowledgement task could not be generation-bound');
    }
    const boundTask = await validateBoundTask({
      tx,
      tenantId,
      result,
      taskId: taskMaterialization.taskId,
    });

    const updatedResults = await tx.$queryRawUnsafe(
      `UPDATE lab_results
          SET is_critical = $3::boolean,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::int
        RETURNING id`,
      tenantId,
      numericResultId,
      assessment.breached,
    );
    if (!updatedResults[0]) throw new Error('Lab result critical state could not be updated');

    const generationMetadata = {
      kind: numericSignoffId == null
        ? 'initial_result_generation'
        : 'corrected_result_generation',
      source,
      acknowledgement_task_id: Number(taskMaterialization.taskId),
      corrected_state: state,
      active_threshold_low: assessment.criticalLow ?? null,
      active_threshold_high: assessment.criticalHigh ?? null,
      active_threshold_id: assessment.thresholdId ?? null,
      active_threshold_test_code: assessment.thresholdTestCode ?? null,
      active_threshold_loinc_code: assessment.thresholdLoincCode ?? null,
      active_threshold_unit: assessment.thresholdUnit ?? null,
      active_threshold_applies_to: assessment.thresholdAppliesTo ?? null,
      threshold_evaluated_value: assessment.evaluatedValue,
      threshold_value_conversion: assessment.conversion ?? null,
      ...(numericSignoffId == null ? {} : {
        decision,
        signoff_id: numericSignoffId,
        supersedes_alert_id: predecessor ? Number(predecessor.id) : null,
        prior_threshold_breached: predecessor?.threshold_breached || null,
        prior_threshold_value: predecessor?.threshold_value == null
          ? null
          : Number(predecessor.threshold_value),
        ...(reconciledSignoffIds == null ? {} : {
          rolling_reconciliation: true,
          rolling_reconciled_signoff_ids: reconciledSignoffIds,
        }),
      }),
    };
    const firedAtRows = await tx.$queryRawUnsafe(
      `SELECT GREATEST(
          clock_timestamp(),
          COALESCE($1::timestamptz + INTERVAL '1 microsecond', '-infinity'::timestamptz),
          COALESCE($2::timestamptz + INTERVAL '1 microsecond', '-infinity'::timestamptz)
        ) AS fired_at`,
      signoff?.signed_at || null,
      predecessor?.fired_at || null,
    );
    const firedAt = firedAtRows[0]?.fired_at;
    if (!firedAt) throw new Error('Critical lab alert generation time could not be resolved');

    if (predecessor) {
      const superseded = await tx.$queryRawUnsafe(
        `UPDATE lab_critical_alerts
            SET superseded_at = $4::timestamptz,
                superseded_by_alert_id = $5::int,
                superseded_by_signoff_id = $6::int
          WHERE tenant_id = $1::uuid
            AND id = $2::int
            AND result_id = $3::int
            AND superseded_at IS NULL
          RETURNING id`,
        tenantId,
        Number(predecessor.id),
        numericResultId,
        firedAt,
        alertId,
        numericSignoffId,
      );
      if (!superseded[0]) throw new Error('Prior critical alert generation changed concurrently');
    }

    const alerts = await tx.$queryRawUnsafe(
      `INSERT INTO lab_critical_alerts
        (id, tenant_id, result_id, patient_uid, test_name, value_text,
         value_numeric, unit, threshold_breached, threshold_value, fired_at,
         generation_signoff_id, acknowledgement_task_id, generation_metadata)
       VALUES ($1::int, $2::uuid, $3::int, $4::uuid, $5, $6, $7::numeric,
               $8, $9, $10::numeric, $11::timestamptz, $12::int, $13::int,
               $14::jsonb)
       RETURNING *`,
      alertId,
      tenantId,
      numericResultId,
      result.patient_uid,
      result.test_name,
      result.value_text,
      result.value_numeric,
      result.unit,
      assessment.breachedSide,
      assessment.breachedValue,
      firedAt,
      numericSignoffId,
      Number(taskMaterialization.taskId),
      JSON.stringify(generationMetadata),
    );
    if (!alerts[0]) throw new Error('Critical lab alert generation was not created');

    return {
      created: true,
      skippedReason: null,
      alert: alerts[0],
      task: {
        taskId: Number(boundTask.id),
        slaInstanceId: boundTask.sla_id,
        assignedToUid: boundTask.assigned_to_uid || null,
        assignedToRole: boundTask.assigned_to_role || null,
      },
      state,
      criticality: assessment,
    };
  };

  return callerTx ? produce(callerTx) : setTenantTx(tenantId, produce);
}

export default { materializeLabCriticalAlertGeneration };
