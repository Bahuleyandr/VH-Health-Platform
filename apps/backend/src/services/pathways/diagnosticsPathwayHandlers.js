function generationIdFromContext(context) {
  if (context.instance?.source_episode_type !== 'diagnostic_result_generation') return null;
  return String(context.instance?.source_episode_id || '').trim().toLowerCase() || null;
}

export async function loadDiagnosticGenerationEvidence({ tx, tenantId, instance }) {
  const generationId = generationIdFromContext({ instance });
  if (!generationId) return { generation_found: false };
  const rows = await tx.$queryRawUnsafe(
    `SELECT generation.id,
            generation.classification,
            generation.snapshot_sha256,
            generation.owner_source,
            generation.ordering_owner_uid,
            NOT EXISTS (
              SELECT 1
                FROM diagnostic_result_generations AS successor
               WHERE successor.tenant_id = generation.tenant_id
                 AND successor.predecessor_generation_id = generation.id
            ) AS is_current
       FROM diagnostic_result_generations AS generation
      WHERE generation.tenant_id = $1::uuid
        AND generation.id = $2::uuid
      LIMIT 1`,
    tenantId,
    generationId,
  );
  const generation = rows[0] || null;
  return generation ? {
    generation_found: true,
    generation_id: String(generation.id),
    classification: generation.classification,
    snapshot_sha256: generation.snapshot_sha256,
    owner_source: generation.owner_source,
    ordering_owner_uid: generation.ordering_owner_uid,
    is_current: generation.is_current === true,
    reopened_action_id: instance.metadata?.reopened_action_id || null,
  } : { generation_found: false };
}

export async function loadNormalClosureEvidence({ tx, tenantId, instance }) {
  const generationId = generationIdFromContext({ instance });
  if (!generationId) return { normal_closure_found: false };
  const rows = await tx.$queryRawUnsafe(
    `SELECT action.id, action.action_kind, action.request_sha256,
            action.superseding_generation_id
       FROM diagnostic_result_actions AS action
      WHERE action.tenant_id = $1::uuid
        AND action.generation_id = $2::uuid
        AND action.action_kind IN ('normal_auto_closed', 'generation_superseded')
      ORDER BY CASE WHEN action.action_kind = 'generation_superseded' THEN 0 ELSE 1 END
      LIMIT 1`,
    tenantId,
    generationId,
  );
  return rows[0] ? {
    normal_closure_found: true,
    action_id: String(rows[0].id),
    action_kind: rows[0].action_kind,
    superseding_generation_id: rows[0].superseding_generation_id
      ? String(rows[0].superseding_generation_id)
      : null,
    request_sha256: rows[0].request_sha256,
  } : { normal_closure_found: false };
}

export async function loadDoctorActionEvidence({ tx, tenantId, instance }) {
  const generationId = generationIdFromContext({ instance });
  if (!generationId) return { doctor_action_found: false };
  const rows = await tx.$queryRawUnsafe(
    `SELECT action.id, action.action_kind, action.disposition, action.signature_id,
            action.request_sha256, action.superseding_generation_id
       FROM diagnostic_result_actions AS action
      WHERE action.tenant_id = $1::uuid
        AND action.generation_id = $2::uuid
        AND action.action_kind IN ('doctor_disposition', 'generation_superseded')
        AND (
          action.pathway_instance_id = $3::uuid
          OR action.action_kind = 'generation_superseded'
        )
      ORDER BY CASE WHEN action.action_kind = 'generation_superseded' THEN 0 ELSE 1 END
      LIMIT 1`,
    tenantId,
    generationId,
    instance.id,
  );
  return rows[0] ? {
    doctor_action_found: true,
    action_id: String(rows[0].id),
    action_kind: rows[0].action_kind,
    disposition: rows[0].disposition,
    signature_id: rows[0].signature_id ? String(rows[0].signature_id) : null,
    superseding_generation_id: rows[0].superseding_generation_id
      ? String(rows[0].superseding_generation_id)
      : null,
    request_sha256: rows[0].request_sha256,
  } : { doctor_action_found: false };
}

export const DIAGNOSTIC_PATHWAY_RUNTIME_HANDLERS = Object.freeze({
  routeGeneration: Object.freeze({
    stepKinds: Object.freeze(['wait']),
    decisionCodes: Object.freeze([
      'blocked',
      'satisfied',
      'doctor_action_required',
      'generation_superseded',
    ]),
    loadEvidence: loadDiagnosticGenerationEvidence,
    async evaluate({ loadedEvidence }) {
      if (!loadedEvidence.generation_found || loadedEvidence.is_current !== true) {
        return {
          decision: loadedEvidence.generation_found
            ? 'generation_superseded'
            : 'blocked',
          evidence: loadedEvidence,
        };
      }
      if (
        loadedEvidence.classification === 'normal'
        && !loadedEvidence.reopened_action_id
      ) {
        return { decision: 'satisfied', evidence: loadedEvidence };
      }
      if (
        ['critical', 'abnormal', 'indeterminate'].includes(loadedEvidence.classification)
        || (
          loadedEvidence.classification === 'normal'
          && Boolean(loadedEvidence.reopened_action_id)
        )
      ) {
        return { decision: 'doctor_action_required', evidence: loadedEvidence };
      }
      return { decision: 'blocked', evidence: loadedEvidence };
    },
  }),
  normalClosure: Object.freeze({
    stepKinds: Object.freeze(['wait']),
    decisionCodes: Object.freeze(['blocked', 'normal_closed', 'generation_superseded']),
    loadEvidence: loadNormalClosureEvidence,
    async evaluate({ loadedEvidence }) {
      return {
        decision: loadedEvidence.action_kind === 'generation_superseded'
          ? 'generation_superseded'
          : loadedEvidence.normal_closure_found
            ? 'normal_closed'
            : 'blocked',
        evidence: loadedEvidence,
      };
    },
  }),
  doctorAction: Object.freeze({
    stepKinds: Object.freeze(['task']),
    decisionCodes: Object.freeze(['blocked', 'satisfied']),
    loadEvidence: loadDoctorActionEvidence,
    async evaluate({ loadedEvidence, tasks, slas }) {
      const task = tasks[0] || null;
      const sla = slas.find(
        (candidate) => String(candidate.id) === String(task?.workflow_sla_instance_id || ''),
      ) || null;
      const evidence = {
        ...loadedEvidence,
        task_id: task?.id || null,
        task_completed: task?.status === 'completed',
        sla_completed: Boolean(sla?.completed_at),
      };
      return {
        decision: evidence.doctor_action_found
          && evidence.task_completed
          && evidence.sla_completed
          ? 'satisfied'
          : 'blocked',
        evidence,
      };
    },
  }),
  finalize: Object.freeze({
    stepKinds: Object.freeze(['automation']),
    async execute({ instance }) {
      return {
        finalized: true,
        source_episode_type: instance.source_episode_type,
        source_episode_id: instance.source_episode_id,
      };
    },
  }),
});

export default DIAGNOSTIC_PATHWAY_RUNTIME_HANDLERS;
