/**
 * Checkpoint stores for the workflow graph runner.
 *
 * Two implementations:
 *
 *   * createDbCheckpointStore() — production. Persists runs to the
 *     clinical_ai_workflow_runs table (migration 109). Survives crash;
 *     enables resume; tenant-scoped via the table's RLS policy. Each
 *     transition is its own statement (not a single transaction) — node
 *     work has already happened by the time we record the checkpoint, so
 *     wrapping in a transaction would just enlarge the lock window
 *     without buying atomicity.
 *
 *   * createMemoryCheckpointStore() — tests. In-process Map-backed
 *     implementation with the same interface; no DB dependency.
 *
 * Store interface (every implementation must satisfy):
 *   createRun({ tenantId, workflowKey, moduleKey, patientUid, admissionId, state, metadata, startedBy })
 *     -> { id, status, current_node, state, result, ... }
 *   getRun(runId) -> row | null
 *   advance(runId, state, completedNode) -> void
 *   recordCheckpoint(runId, checkpointEntry) -> void
 *   markPaused(runId, state, { reason, pausedAtNode }) -> void
 *   markRunning(runId) -> void
 *   markCompleted(runId, state, result, extra?) -> void
 *   markFailed(runId, state, { node, message }) -> void
 *   listPaused({ tenantId, pauseReason?, limit? }) -> rows[]   (for resume schedulers)
 */

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(
    String(err?.message || '')
  );
}

function truncate(value, max = 500) {
  if (value == null) return null;
  const text = String(value);
  return text.length > max ? text.slice(0, max) : text;
}

// ---------- DB-backed store ---------------------------------------------

export function createDbCheckpointStore() {
  return {
    async createRun({
      tenantId,
      workflowKey,
      moduleKey = null,
      patientUid = null,
      admissionId = null,
      state = {},
      metadata = {},
      startedBy = null,
    }) {
      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO clinical_ai_workflow_runs
           (tenant_id, workflow_key, module_key, patient_uid, admission_id,
            status, state, metadata, started_by, started_at, updated_at)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5,
                 'running', $6::jsonb, $7::jsonb, $8::uuid, NOW(), NOW())
         RETURNING id, tenant_id, workflow_key, module_key, patient_uid, admission_id,
                   status, current_node, pause_reason, state, result, error_node,
                   error_message, checkpoints, metadata, started_by, started_at,
                   paused_at, completed_at, failed_at, updated_at`,
        tenantId,
        workflowKey,
        moduleKey,
        patientUid,
        admissionId,
        JSON.stringify(state || {}),
        JSON.stringify(metadata || {}),
        startedBy
      );
      return rows[0];
    },

    async getRun(runId) {
      try {
        const rows = await prisma.$queryRawUnsafe(
          `SELECT id, tenant_id, workflow_key, module_key, patient_uid, admission_id,
                  status, current_node, pause_reason, state, result, error_node,
                  error_message, checkpoints, metadata, started_by, started_at,
                  paused_at, completed_at, failed_at, updated_at
           FROM clinical_ai_workflow_runs
           WHERE id = $1
           LIMIT 1`,
          Number.parseInt(runId, 10)
        );
        return rows[0] || null;
      } catch (err) {
        if (isMissingSchemaError(err)) return null;
        throw err;
      }
    },

    async advance(runId, state, completedNode) {
      await prisma.$queryRawUnsafe(
        `UPDATE clinical_ai_workflow_runs
         SET state = $2::jsonb,
             current_node = $3,
             status = 'running',
             updated_at = NOW()
         WHERE id = $1`,
        Number.parseInt(runId, 10),
        JSON.stringify(state || {}),
        completedNode
      );
    },

    async recordCheckpoint(runId, entry) {
      // Append entry to the checkpoints jsonb array. We prefer a single
      // statement (||) over read-modify-write to avoid the race when two
      // resume calls land at once on the same run.
      await prisma.$queryRawUnsafe(
        `UPDATE clinical_ai_workflow_runs
         SET checkpoints = checkpoints || $2::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        Number.parseInt(runId, 10),
        JSON.stringify([entry])
      );
    },

    async markPaused(runId, state, { reason, pausedAtNode }) {
      await prisma.$queryRawUnsafe(
        `UPDATE clinical_ai_workflow_runs
         SET state = $2::jsonb,
             status = 'paused',
             pause_reason = $3,
             paused_at = NOW(),
             metadata = metadata || $4::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        Number.parseInt(runId, 10),
        JSON.stringify(state || {}),
        truncate(reason, 120),
        JSON.stringify({ paused_at_node: pausedAtNode })
      );
    },

    async markRunning(runId) {
      await prisma.$queryRawUnsafe(
        `UPDATE clinical_ai_workflow_runs
         SET status = 'running',
             pause_reason = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        Number.parseInt(runId, 10)
      );
    },

    async markCompleted(runId, state, result, extra = {}) {
      await prisma.$queryRawUnsafe(
        `UPDATE clinical_ai_workflow_runs
         SET state = $2::jsonb,
             result = $3::jsonb,
             status = 'completed',
             completed_at = NOW(),
             metadata = metadata || $4::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        Number.parseInt(runId, 10),
        JSON.stringify(state || {}),
        JSON.stringify(result ?? null),
        JSON.stringify({ last_node: extra.lastNode || null })
      );
    },

    async markFailed(runId, state, { node, message }) {
      await prisma.$queryRawUnsafe(
        `UPDATE clinical_ai_workflow_runs
         SET state = $2::jsonb,
             status = 'failed',
             error_node = $3,
             error_message = $4,
             failed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        Number.parseInt(runId, 10),
        JSON.stringify(state || {}),
        truncate(node, 80),
        truncate(message, 4000)
      );
    },

    async listPaused({ tenantId, pauseReason = null, limit = 50 } = {}) {
      try {
        const rows = await prisma.$queryRawUnsafe(
          `SELECT id, tenant_id, workflow_key, module_key, patient_uid, admission_id,
                  status, current_node, pause_reason, state, paused_at, started_at
           FROM clinical_ai_workflow_runs
           WHERE tenant_id = $1::uuid
             AND status = 'paused'
             AND ($2::text IS NULL OR pause_reason = $2)
           ORDER BY paused_at DESC NULLS LAST
           LIMIT $3`,
          tenantId,
          pauseReason,
          Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)
        );
        return rows;
      } catch (err) {
        if (isMissingSchemaError(err)) return [];
        logger.warn('listPaused workflow runs failed', { error: err.message });
        return [];
      }
    },
  };
}

// ---------- Memory-backed store (tests) ---------------------------------

export function createMemoryCheckpointStore() {
  const runs = new Map();
  let nextId = 1;

  function clone(value) {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
  }

  function update(runId, patch) {
    const id = Number.parseInt(runId, 10);
    const run = runs.get(id);
    if (!run) throw new Error(`Memory store: run ${id} not found`);
    const next = { ...run, ...patch, updated_at: new Date().toISOString() };
    runs.set(id, next);
    return next;
  }

  return {
    async createRun({ tenantId, workflowKey, moduleKey = null, patientUid = null, admissionId = null, state = {}, metadata = {}, startedBy = null }) {
      const id = nextId++;
      const row = {
        id,
        tenant_id: tenantId,
        workflow_key: workflowKey,
        module_key: moduleKey,
        patient_uid: patientUid,
        admission_id: admissionId,
        status: 'running',
        current_node: null,
        pause_reason: null,
        state: clone(state) || {},
        result: null,
        error_node: null,
        error_message: null,
        checkpoints: [],
        metadata: clone(metadata) || {},
        started_by: startedBy,
        started_at: new Date().toISOString(),
        paused_at: null,
        completed_at: null,
        failed_at: null,
        updated_at: new Date().toISOString(),
      };
      runs.set(id, row);
      return clone(row);
    },

    async getRun(runId) {
      const row = runs.get(Number.parseInt(runId, 10));
      return row ? clone(row) : null;
    },

    async advance(runId, state, completedNode) {
      update(runId, {
        state: clone(state),
        current_node: completedNode,
        status: 'running',
      });
    },

    async recordCheckpoint(runId, entry) {
      const id = Number.parseInt(runId, 10);
      const run = runs.get(id);
      if (!run) throw new Error(`Memory store: run ${id} not found`);
      run.checkpoints = [...run.checkpoints, clone(entry)];
      run.updated_at = new Date().toISOString();
    },

    async markPaused(runId, state, { reason, pausedAtNode }) {
      update(runId, {
        state: clone(state),
        status: 'paused',
        pause_reason: String(reason || '').slice(0, 120),
        paused_at: new Date().toISOString(),
        metadata: { ...(runs.get(Number.parseInt(runId, 10)).metadata || {}), paused_at_node: pausedAtNode },
      });
    },

    async markRunning(runId) {
      update(runId, { status: 'running', pause_reason: null });
    },

    async markCompleted(runId, state, result, extra = {}) {
      update(runId, {
        state: clone(state),
        result: clone(result),
        status: 'completed',
        completed_at: new Date().toISOString(),
        metadata: { ...(runs.get(Number.parseInt(runId, 10)).metadata || {}), last_node: extra.lastNode || null },
      });
    },

    async markFailed(runId, state, { node, message }) {
      update(runId, {
        state: clone(state),
        status: 'failed',
        error_node: node ? String(node).slice(0, 80) : null,
        error_message: message ? String(message).slice(0, 4000) : null,
        failed_at: new Date().toISOString(),
      });
    },

    async listPaused({ tenantId, pauseReason = null, limit = 50 } = {}) {
      const rows = [...runs.values()].filter((row) =>
        row.tenant_id === tenantId
        && row.status === 'paused'
        && (pauseReason === null || row.pause_reason === pauseReason)
      );
      rows.sort((a, b) => (b.paused_at || '').localeCompare(a.paused_at || ''));
      return rows.slice(0, limit).map(clone);
    },

    // Test-only helpers
    _all() {
      return [...runs.values()].map(clone);
    },
    _reset() {
      runs.clear();
      nextId = 1;
    },
  };
}

/**
 * A resilient store: tries the DB-backed store first; on a missing-schema
 * error (migration 109 not applied yet) it transparently degrades to a
 * fresh in-memory store and stays there for the rest of the process. The
 * tradeoff: the workflow run itself completes successfully, but pause/
 * resume/list-paused are no-ops because there's no persistent row. This
 * is the right default for production code paths that exist in code
 * before the migration lands in every environment.
 */
export function createResilientCheckpointStore() {
  const db = createDbCheckpointStore();
  let active = db;
  let degraded = false;

  function degrade(reason) {
    if (degraded) return;
    degraded = true;
    active = createMemoryCheckpointStore();
    logger.warn('Workflow checkpoint store degraded to memory', { reason });
  }

  async function tryOrDegrade(fn) {
    try {
      return await fn(active);
    } catch (err) {
      if (!degraded && isMissingSchemaError(err)) {
        degrade(err.message);
        return fn(active);
      }
      throw err;
    }
  }

  return {
    async createRun(args) { return tryOrDegrade((store) => store.createRun(args)); },
    async getRun(id) { return tryOrDegrade((store) => store.getRun(id)); },
    async advance(id, state, node) { return tryOrDegrade((store) => store.advance(id, state, node)); },
    async recordCheckpoint(id, entry) { return tryOrDegrade((store) => store.recordCheckpoint(id, entry)); },
    async markPaused(id, state, info) { return tryOrDegrade((store) => store.markPaused(id, state, info)); },
    async markRunning(id) { return tryOrDegrade((store) => store.markRunning(id)); },
    async markCompleted(id, state, result, extra) { return tryOrDegrade((store) => store.markCompleted(id, state, result, extra)); },
    async markFailed(id, state, info) { return tryOrDegrade((store) => store.markFailed(id, state, info)); },
    async listPaused(args) { return tryOrDegrade((store) => store.listPaused(args)); },
    isDegraded() { return degraded; },
  };
}

let defaultStore = null;
export function getDefaultCheckpointStore() {
  if (!defaultStore) defaultStore = createResilientCheckpointStore();
  return defaultStore;
}

// Test-only: reset the cached default. Call between tests if you need a
// fresh store.
export function _resetDefaultCheckpointStore() {
  defaultStore = null;
}

export default {
  createDbCheckpointStore,
  createMemoryCheckpointStore,
  getDefaultCheckpointStore,
};
