import { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { CARE_PATHWAY_KEYS, PATHWAY_MODES } from '../pathways/pathwayMode.js';
import { resolvePathwayModeTx } from '../pathways/pathwayRuntimePersistence.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { closeNormalDiagnosticGenerationIfEligible } from './diagnosticResultActionService.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function boundedLimit(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

async function listCandidates(tenantId, limit) {
  return setTenantTx(tenantId, async (tx) => {
    const mode = await resolvePathwayModeTx({
      tx,
      tenantId,
      pathwayKey: CARE_PATHWAY_KEYS.DIAGNOSTICS,
    });
    if (mode !== PATHWAY_MODES.ACTIVE) return { mode, generations: [] };
    const rows = await tx.$queryRawUnsafe(
      `SELECT generation.id
         FROM diagnostic_result_generations AS generation
         JOIN care_pathway_instances AS pathway
           ON pathway.tenant_id = generation.tenant_id
          AND pathway.pathway_key = 'diagnostics_order_to_action'
          AND pathway.source_episode_type = 'diagnostic_result_generation'
          AND pathway.source_episode_id = generation.id::text
          AND pathway.clinical_status IN ('active', 'on_hold')
         JOIN workflow_runs AS run
           ON run.tenant_id = pathway.tenant_id
          AND run.id = pathway.workflow_run_id
          AND run.current_step_key = 'await_normal_release_closure'
        WHERE generation.tenant_id = $1::uuid
          AND generation.classification = 'normal'
          AND NOT EXISTS (
            SELECT 1
              FROM diagnostic_result_generations AS successor
             WHERE successor.tenant_id = generation.tenant_id
               AND successor.predecessor_generation_id = generation.id
          )
          AND NOT EXISTS (
            SELECT 1
              FROM diagnostic_result_actions AS action
             WHERE action.tenant_id = generation.tenant_id
               AND action.generation_id = generation.id
               AND action.action_kind = 'normal_auto_closed'
          )
        ORDER BY generation.signed_at, generation.id
        LIMIT $2::integer`,
      tenantId,
      limit,
    );
    return { mode, generations: rows.map((row) => String(row.id)) };
  });
}

export async function runDiagnosticNormalReleaseSweep({
  tenantId,
  limit = DEFAULT_LIMIT,
  activationEvidenceCapability = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const candidates = await listCandidates(tid, boundedLimit(limit));
  if (candidates.mode !== PATHWAY_MODES.ACTIVE) {
    return Object.freeze({
      tenant_id: tid,
      pathway_mode: candidates.mode,
      candidates: 0,
      closed: 0,
      deferred: 0,
      errors: 0,
    });
  }
  if (!activationEvidenceCapability) {
    return Object.freeze({
      tenant_id: tid,
      pathway_mode: candidates.mode,
      candidates: candidates.generations.length,
      closed: 0,
      deferred: candidates.generations.length,
      errors: 0,
      blocked_reason: 'activation_evidence_unavailable',
    });
  }

  let closed = 0;
  let deferred = 0;
  let errors = 0;
  for (const generationId of candidates.generations) {
    try {
      const outcome = await closeNormalDiagnosticGenerationIfEligible({
        tenantId: tid,
        generationId,
        activationEvidenceCapability,
      });
      if (outcome.action_kind === 'normal_auto_closed') closed += 1;
      else deferred += 1;
    } catch (err) {
      errors += 1;
      logger.error('diagnostic-normal-release-sweep generation failed', {
        tenantId: tid,
        generationId,
        error: err?.message || String(err),
      });
    }
  }
  return Object.freeze({
    tenant_id: tid,
    pathway_mode: candidates.mode,
    candidates: candidates.generations.length,
    closed,
    deferred,
    errors,
  });
}

export default { runDiagnosticNormalReleaseSweep };
