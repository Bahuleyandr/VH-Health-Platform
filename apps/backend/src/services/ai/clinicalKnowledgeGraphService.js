/**
 * Clinical Knowledge Graph.
 *
 * Lightweight generic clinical knowledge graph over 9 node types (patient,
 * diagnosis, medication, lab, procedure, provider, encounter, payer,
 * organization) and ~14 edge types (has_diagnosis, prescribed, ordered,
 * performed_by, administered_to, attributed_to, covered_by, affiliated_with,
 * belongs_to_encounter, treats, contraindicates, indicates, related_to,
 * caused_by). Stores nodes, edges, and periodic health reports. Health
 * reports classify graph completeness + anomalies (orphan nodes, missing
 * critical edges, contradictions, stale nodes). Review-only — a data
 * engineer approves health improvements; the graph itself is never
 * modified by this service (ingest happens upstream).
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { generateClinicalText } from './localLlmClient.js';

const MODULE_KEY = 'clinical_knowledge_graph';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt:
    'You support the clinical knowledge graph health review. Rules are authoritative. Return JSON only and never propose changes to individual nodes or edges — a data engineer approves health-report fixes and ingest is the only path that changes the graph.',
  user_prompt_template:
    'Given the knowledge-graph snapshot and detected anomalies plus the rule-based overall_health, severity, and signals, return keys: summary, recommended_actions, source_citations, safety_flags. Do not override the rule-based overall_health or severity.',
};

// ---------- Constants (exported) ----------------------------------------

export const NODE_TYPES = new Set([
  'patient',
  'diagnosis',
  'medication',
  'lab',
  'procedure',
  'provider',
  'encounter',
  'payer',
  'organization',
]);

export const EDGE_TYPES = new Set([
  'has_diagnosis',
  'prescribed',
  'ordered',
  'performed_by',
  'administered_to',
  'attributed_to',
  'covered_by',
  'affiliated_with',
  'belongs_to_encounter',
  'treats',
  'contraindicates',
  'indicates',
  'related_to',
  'caused_by',
]);

export const HEALTH_STATES = new Set(['healthy', 'watch', 'degraded', 'critical', 'unknown']);
// Priority: higher index = higher priority (worst at the end).
export const HEALTH_PRIORITY = ['unknown', 'healthy', 'watch', 'degraded', 'critical'];

export const SEVERITIES = new Set(['low', 'moderate', 'high', 'critical', 'unknown']);
export const SEVERITY_PRIORITY = ['unknown', 'low', 'moderate', 'high', 'critical'];

export const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);
export const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);

/**
 * Critical-edge expectation rules used by computeMissingCriticalEdges.
 *  - context: optional attribute-level filter on the anchor node
 *  - required_for_to: every to_type node must have at least one matching
 *    incoming edge of edge_type
 *  - required_for_from: every from_type node must have at least one
 *    matching outgoing edge of edge_type
 */
export const CRITICAL_EDGE_RULES = [
  // Patient admissions should record at least one diagnosis.
  {
    label: 'admission_patient_has_diagnosis',
    from_type: 'patient',
    edge_type: 'has_diagnosis',
    to_type: 'diagnosis',
    context: 'admission',
  },
  // Every medication node must have a prescribed edge from a provider.
  {
    label: 'medication_has_prescribing_provider',
    from_type: 'provider',
    edge_type: 'prescribed',
    to_type: 'medication',
    required_for_to: true,
  },
  // Every encounter must belong to a patient.
  {
    label: 'encounter_belongs_to_patient',
    from_type: 'encounter',
    edge_type: 'belongs_to_encounter',
    to_type: 'patient',
    required_for_from: true,
  },
];

const REVIEW_DISCLAIMER =
  'Data engineer review required — decision support only; the graph itself is never modified by this service.';

const ANCHOR_NODE_TYPES = new Set(['patient', 'provider']);

// ---------- Small helpers ------------------------------------------------

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(
    String(err?.message || '')
  );
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalInt(value, fieldName = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function sourceHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex');
}

function safeJsonParse(text, fallback) {
  if (!text) return fallback;
  const cleaned = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function uniqueCitations(citations) {
  const seen = new Set();
  return asArray(citations).filter((citation) => {
    if (!citation) return false;
    const key = `${citation.source_type}:${citation.source_id}:${citation.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

// ---------- Pure helpers (exported) --------------------------------------

/**
 * Lowercase + trim the node_type input; throw if not in NODE_TYPES.
 */
export function normalizeNodeType(value) {
  const normalized = cleanText(value).toLowerCase();
  if (!NODE_TYPES.has(normalized)) {
    throw AppError.badRequest(`node_type must be one of: ${Array.from(NODE_TYPES).join(', ')}`);
  }
  return normalized;
}

/**
 * Lowercase + trim the edge_type input; throw if not in EDGE_TYPES.
 */
export function normalizeEdgeType(value) {
  const normalized = cleanText(value).toLowerCase();
  if (!EDGE_TYPES.has(normalized)) {
    throw AppError.badRequest(`edge_type must be one of: ${Array.from(EDGE_TYPES).join(', ')}`);
  }
  return normalized;
}

/**
 * Stable dedupe key for a node: "${node_type}:${node_key}".
 */
export function nodeMatchKey(node) {
  if (!node) return '';
  const t = cleanText(node.node_type).toLowerCase();
  const k = cleanText(node.node_key);
  return `${t}:${k}`;
}

/**
 * A node is orphaned if it has no edge (as either from or to). Patient
 * and provider nodes are always considered anchors (never orphan). Returns
 * { orphan_nodes: [{ id, node_type, node_key, display_name }], count }.
 */
export function computeOrphanNodes({ nodes = [], edges = [] } = {}) {
  const connected = new Set();
  for (const edge of asArray(edges)) {
    if (!edge) continue;
    if (edge.from_node_id !== null && edge.from_node_id !== undefined) {
      connected.add(toNumber(edge.from_node_id, null));
    }
    if (edge.to_node_id !== null && edge.to_node_id !== undefined) {
      connected.add(toNumber(edge.to_node_id, null));
    }
  }
  const orphans = [];
  for (const node of asArray(nodes)) {
    if (!node) continue;
    const nodeType = cleanText(node.node_type).toLowerCase();
    if (ANCHOR_NODE_TYPES.has(nodeType)) continue;
    const id = toNumber(node.id, null);
    if (id === null) continue;
    if (!connected.has(id)) {
      orphans.push({
        id,
        node_type: nodeType,
        node_key: cleanText(node.node_key),
        display_name: node.display_name || null,
      });
    }
  }
  return { orphan_nodes: orphans, count: orphans.length };
}

/**
 * Apply CRITICAL_EDGE_RULES against the supplied node + edge arrays.
 *
 *   - required_for_to: every to_type node needs at least one matching edge
 *     of edge_type ending at it.
 *   - required_for_from: every from_type node needs at least one matching
 *     edge of edge_type starting from it.
 *   - context: when set, filter anchor nodes by node.attributes.context
 *     === context (case-insensitive compare).
 *   - default (no required_for_*): treat as "at least one matching edge
 *     between any from_type node and any to_type node must exist".
 *
 * Returns { missing_edges, count }.
 */
export function computeMissingCriticalEdges({ nodes = [], edges = [] } = {}) {
  const nodeList = asArray(nodes).filter(Boolean);
  const edgeList = asArray(edges).filter(Boolean);
  const nodeById = new Map();
  for (const node of nodeList) {
    const id = toNumber(node.id, null);
    if (id !== null) nodeById.set(id, node);
  }

  const missing = [];

  for (const rule of CRITICAL_EDGE_RULES) {
    const fromType = cleanText(rule.from_type).toLowerCase();
    const toType = cleanText(rule.to_type).toLowerCase();
    const edgeType = cleanText(rule.edge_type).toLowerCase();
    const ruleLabel = rule.label || `${fromType}_${edgeType}_${toType}`;
    const context = rule.context ? cleanText(rule.context).toLowerCase() : null;

    // Filter helper: anchor nodes that match the context (when set).
    const matchesContext = (node) => {
      if (!context) return true;
      const attr = node?.attributes;
      if (!attr || typeof attr !== 'object') return false;
      const ctxValue = attr.context;
      if (ctxValue === null || ctxValue === undefined) return false;
      return cleanText(ctxValue).toLowerCase() === context;
    };

    // Matching edges for this rule (edge_type + endpoint types).
    const matchingEdges = edgeList.filter((e) => {
      if (cleanText(e.edge_type).toLowerCase() !== edgeType) return false;
      const fromNode = nodeById.get(toNumber(e.from_node_id, null));
      const toNode = nodeById.get(toNumber(e.to_node_id, null));
      if (!fromNode || !toNode) return false;
      const ft = cleanText(fromNode.node_type).toLowerCase();
      const tt = cleanText(toNode.node_type).toLowerCase();
      return ft === fromType && tt === toType;
    });

    if (rule.required_for_to) {
      // Every to_type node needs an incoming matching edge.
      const satisfied = new Set(
        matchingEdges.map((e) => toNumber(e.to_node_id, null)).filter((v) => v !== null)
      );
      for (const node of nodeList) {
        if (cleanText(node.node_type).toLowerCase() !== toType) continue;
        if (!matchesContext(node)) continue;
        const id = toNumber(node.id, null);
        if (id === null) continue;
        if (!satisfied.has(id)) {
          missing.push({
            rule_label: ruleLabel,
            missing_for_node_id: id,
            missing_for_type: toType,
            missing_for_key: cleanText(node.node_key),
          });
        }
      }
      continue;
    }

    if (rule.required_for_from) {
      // Every from_type node needs an outgoing matching edge.
      const satisfied = new Set(
        matchingEdges.map((e) => toNumber(e.from_node_id, null)).filter((v) => v !== null)
      );
      for (const node of nodeList) {
        if (cleanText(node.node_type).toLowerCase() !== fromType) continue;
        if (!matchesContext(node)) continue;
        const id = toNumber(node.id, null);
        if (id === null) continue;
        if (!satisfied.has(id)) {
          missing.push({
            rule_label: ruleLabel,
            missing_for_node_id: id,
            missing_for_type: fromType,
            missing_for_key: cleanText(node.node_key),
          });
        }
      }
      continue;
    }

    // Context-scoped rule without required_for_*: every context-matching
    // from_type node needs at least one outgoing matching edge.
    if (context) {
      const satisfied = new Set(
        matchingEdges.map((e) => toNumber(e.from_node_id, null)).filter((v) => v !== null)
      );
      for (const node of nodeList) {
        if (cleanText(node.node_type).toLowerCase() !== fromType) continue;
        if (!matchesContext(node)) continue;
        const id = toNumber(node.id, null);
        if (id === null) continue;
        if (!satisfied.has(id)) {
          missing.push({
            rule_label: ruleLabel,
            missing_for_node_id: id,
            missing_for_type: fromType,
            missing_for_key: cleanText(node.node_key),
          });
        }
      }
      continue;
    }

    // Default: at least one matching edge must exist anywhere.
    if (matchingEdges.length === 0) {
      missing.push({
        rule_label: ruleLabel,
        missing_for_node_id: null,
        missing_for_type: fromType,
        missing_for_key: null,
      });
    }
  }

  return { missing_edges: missing, count: missing.length };
}

/**
 * Detect contradictions among the supplied edges.
 *   - A (medication contraindicates diagnosis) alongside a
 *     (provider prescribed medication) for the same medication → clinical
 *     contradiction.
 *   - Two edges between the same (from, to) pair with opposing semantic
 *     types (treats vs contraindicates) → direct contradiction.
 *
 * Returns { contradictions: [{ edge_a_id, edge_b_id, reason }], count }.
 */
export function detectContradictions({ edges = [] } = {}) {
  const edgeList = asArray(edges).filter(Boolean);
  const contradictions = [];
  const seenPairs = new Set();

  // Direct contradiction: same (from, to) with treats + contraindicates.
  const byPair = new Map();
  for (const edge of edgeList) {
    const key = `${toNumber(edge.from_node_id, 0)}->${toNumber(edge.to_node_id, 0)}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(edge);
  }
  for (const pairEdges of byPair.values()) {
    const treats = pairEdges.filter((e) => cleanText(e.edge_type).toLowerCase() === 'treats');
    const contra = pairEdges.filter(
      (e) => cleanText(e.edge_type).toLowerCase() === 'contraindicates'
    );
    for (const t of treats) {
      for (const c of contra) {
        const pairKey = `${Math.min(toNumber(t.id, 0), toNumber(c.id, 0))}:${Math.max(toNumber(t.id, 0), toNumber(c.id, 0))}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        contradictions.push({
          edge_a_id: toNumber(t.id, null),
          edge_b_id: toNumber(c.id, null),
          reason:
            'Opposing relationships on the same pair: one edge says treats while another says contraindicates.',
        });
      }
    }
  }

  // Clinical contradiction: medication prescribed by a provider while the
  // same medication contraindicates a diagnosis. This surfaces medication
  // nodes that appear on both sides of a prescribed/contraindicates pair.
  const contraEdgesByMed = new Map();
  const prescribedEdgesByMed = new Map();
  for (const edge of edgeList) {
    const et = cleanText(edge.edge_type).toLowerCase();
    if (et === 'contraindicates') {
      const medId = toNumber(edge.from_node_id, null);
      if (medId === null) continue;
      if (!contraEdgesByMed.has(medId)) contraEdgesByMed.set(medId, []);
      contraEdgesByMed.get(medId).push(edge);
    } else if (et === 'prescribed') {
      const medId = toNumber(edge.to_node_id, null);
      if (medId === null) continue;
      if (!prescribedEdgesByMed.has(medId)) prescribedEdgesByMed.set(medId, []);
      prescribedEdgesByMed.get(medId).push(edge);
    }
  }
  for (const [medId, contraEdges] of contraEdgesByMed.entries()) {
    const prescribed = prescribedEdgesByMed.get(medId);
    if (!prescribed || !prescribed.length) continue;
    for (const c of contraEdges) {
      for (const p of prescribed) {
        const pairKey = `${Math.min(toNumber(c.id, 0), toNumber(p.id, 0))}:${Math.max(toNumber(c.id, 0), toNumber(p.id, 0))}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        contradictions.push({
          edge_a_id: toNumber(p.id, null),
          edge_b_id: toNumber(c.id, null),
          reason:
            'Medication is prescribed while also marked as contraindicating a diagnosis in the graph.',
        });
      }
    }
  }

  return { contradictions, count: contradictions.length };
}

/**
 * Nodes whose updated_at is older than `stalenessDays` relative to `today`
 * (or now if null). Patient and provider node types are excluded — people
 * don't go stale the same way as clinical concepts.
 */
export function detectStaleNodes({ nodes = [], today = null, stalenessDays = 365 } = {}) {
  const reference = today ? new Date(today) : new Date();
  if (Number.isNaN(reference.getTime())) {
    return { stale_nodes: [], count: 0 };
  }
  const days = toNumber(stalenessDays, 365);
  const thresholdMs = reference.getTime() - days * 24 * 60 * 60 * 1000;
  const stale = [];
  for (const node of asArray(nodes)) {
    if (!node) continue;
    const nodeType = cleanText(node.node_type).toLowerCase();
    if (ANCHOR_NODE_TYPES.has(nodeType)) continue;
    const updatedAt = node.updated_at ? new Date(node.updated_at) : null;
    if (!updatedAt || Number.isNaN(updatedAt.getTime())) continue;
    if (updatedAt.getTime() < thresholdMs) {
      stale.push({
        id: toNumber(node.id, null),
        node_type: nodeType,
        node_key: cleanText(node.node_key),
        updated_at: node.updated_at,
      });
    }
  }
  return { stale_nodes: stale, count: stale.length };
}

/**
 * Graph completeness as a percentage (0..100). Formula:
 *   penalties = missingCriticalEdgeCount * 2 + orphanNodeCount
 *   pct = max(0, 100 - (penalties / max(1, nodeCount)) * 100), 2dp
 *   nodeCount === 0 → 100
 */
export function computeCompleteness({
  nodeCount,
  edgeCount,
  missingCriticalEdgeCount,
  orphanNodeCount,
} = {}) {
  const nc = toNumber(nodeCount, 0);
  // edgeCount is not used directly in the penalty formula but is kept in
  // the signature so callers can pass the full snapshot without slicing.
  void edgeCount;
  if (nc <= 0) return 100;
  const penalties = toNumber(missingCriticalEdgeCount, 0) * 2 + toNumber(orphanNodeCount, 0);
  const pct = 100 - (penalties / Math.max(1, nc)) * 100;
  const clamped = Math.max(0, pct);
  return round2(clamped);
}

/**
 * Rules-authoritative graph-health classifier. First match wins.
 *
 * Returns { overall_health, severity, signals: [{ code, detail? }] }.
 */
export function classifyGraphHealth({
  nodeCount = 0,
  edgeCount = 0,
  orphanNodeCount = 0,
  missingCriticalEdgeCount = 0,
  contradictionCount = 0,
  staleNodeCount = 0,
  completenessPct = 100,
} = {}) {
  const nc = toNumber(nodeCount, 0);
  const ec = toNumber(edgeCount, 0);
  const orphan = toNumber(orphanNodeCount, 0);
  const missing = toNumber(missingCriticalEdgeCount, 0);
  const contra = toNumber(contradictionCount, 0);
  const stale = toNumber(staleNodeCount, 0);
  const pct = toNumber(completenessPct, 100);

  // Rule 1: contradictions or a flood of missing critical edges.
  if (contra >= 1 || missing >= 10) {
    return {
      overall_health: 'critical',
      severity: 'critical',
      signals: [
        {
          code: 'CONTRADICTIONS_OR_MASSIVE_MISSING_EDGES',
          detail: `contradictions=${contra}, missing_critical_edges=${missing}`,
        },
      ],
    };
  }

  // Rule 2: severely incomplete graph or large stale set.
  if (pct < 60 || missing >= 5 || stale >= 50) {
    return {
      overall_health: 'degraded',
      severity: 'high',
      signals: [
        {
          code: 'DEGRADED_GRAPH',
          detail: `completeness_pct=${pct}, missing_critical_edges=${missing}, stale_nodes=${stale}`,
        },
      ],
    };
  }

  // Rule 3: watch-level issues.
  if (pct < 80 || orphan >= 10 || missing >= 1) {
    return {
      overall_health: 'watch',
      severity: 'moderate',
      signals: [
        {
          code: 'WATCH_GRAPH',
          detail: `completeness_pct=${pct}, orphan_nodes=${orphan}, missing_critical_edges=${missing}`,
        },
      ],
    };
  }

  // Rule 4: empty graph.
  if (nc === 0) {
    return {
      overall_health: 'unknown',
      severity: 'unknown',
      signals: [{ code: 'EMPTY_GRAPH', detail: 'no nodes recorded yet' }],
    };
  }

  // Rule 5: healthy default.
  return {
    overall_health: 'healthy',
    severity: 'low',
    signals: [
      {
        code: 'HEALTHY_GRAPH',
        detail: `nodes=${nc}, edges=${ec}, completeness_pct=${pct}`,
      },
    ],
  };
}

/**
 * Escalate a list of overall-health values per HEALTH_PRIORITY.
 */
export function escalateGraphHealth(list) {
  const arr = asArray(list);
  if (!arr.length) return 'unknown';
  let best = 'unknown';
  let bestIdx = HEALTH_PRIORITY.indexOf('unknown');
  for (const state of arr) {
    const normalized = HEALTH_STATES.has(state) ? state : 'unknown';
    const idx = HEALTH_PRIORITY.indexOf(normalized);
    if (idx > bestIdx) {
      best = normalized;
      bestIdx = idx;
    }
  }
  return best;
}

/**
 * Escalate a list of severities per SEVERITY_PRIORITY.
 */
export function escalateSeverity(list) {
  const arr = asArray(list);
  if (!arr.length) return 'unknown';
  let best = 'unknown';
  let bestIdx = SEVERITY_PRIORITY.indexOf('unknown');
  for (const sev of arr) {
    const normalized = SEVERITIES.has(sev) ? sev : 'unknown';
    const idx = SEVERITY_PRIORITY.indexOf(normalized);
    if (idx > bestIdx) {
      best = normalized;
      bestIdx = idx;
    }
  }
  return best;
}

/**
 * Build reviewer-facing action lines. Always ends with the data-engineer
 * disclaimer string.
 */
export function buildGraphActions({ overallHealth, severity, signals = [] } = {}) {
  const actions = [];
  const seen = new Set();
  const push = (line) => {
    const text = cleanText(line);
    if (!text || seen.has(text)) return;
    seen.add(text);
    actions.push(text);
  };

  const state = HEALTH_STATES.has(overallHealth) ? overallHealth : 'unknown';
  const sev = SEVERITIES.has(severity) ? severity : 'unknown';

  switch (state) {
    case 'critical':
      push('Open a data-engineering incident — the graph has contradictions or many missing critical edges; halt downstream consumers that depend on these relationships until resolved.');
      push('Review each contradiction with the ingest owner and determine which source is authoritative before the graph is used for any decision support.');
      break;
    case 'degraded':
      push('Schedule a data-quality review — completeness is below acceptable or many critical edges are missing.');
      push('Trace the missing-edge rules to their ingest sources and patch the upstream pipeline so the graph can be re-populated.');
      break;
    case 'watch':
      push('Investigate the watch-level signals — completeness is below the healthy threshold or orphan nodes and missing critical edges are accumulating.');
      push('Prioritize the top ingest gaps so the graph does not drift further before the next review.');
      break;
    case 'unknown':
      push('Graph is empty — confirm the ingest pipeline has produced at least one node before expecting any health-report signal.');
      break;
    case 'healthy':
    default:
      push('No action required — graph completeness and anomaly counts are within healthy thresholds.');
      break;
  }

  for (const signal of asArray(signals)) {
    const code = signal?.code;
    if (!code) continue;
    if (code === 'CONTRADICTIONS_OR_MASSIVE_MISSING_EDGES') {
      push('Log each contradiction with its edge IDs and route to the ingest owner for reconciliation.');
    } else if (code === 'DEGRADED_GRAPH') {
      push('Compare the completeness percentage against the prior healthy report to pinpoint the regression window.');
    } else if (code === 'WATCH_GRAPH') {
      push('Add targeted ingest backfills for the most common missing-edge rule before the situation degrades further.');
    } else if (code === 'EMPTY_GRAPH') {
      push('Confirm the ingest job ran and wrote to clinical_ai_kg_nodes — the graph currently has no nodes.');
    }
  }

  // Severity-specific tail action.
  if (sev === 'critical') {
    push('Notify the on-call data engineer immediately — this report is severity:critical.');
  } else if (sev === 'high') {
    push('Schedule remediation within the current sprint — this report is severity:high.');
  }

  push(REVIEW_DISCLAIMER);
  return actions;
}

/**
 * One-sentence human summary of the graph health report.
 */
export function summarizeGraphHealth({
  nodeCount,
  edgeCount,
  overallHealth,
  severity,
  completenessPct,
} = {}) {
  const nc = toNumber(nodeCount, 0);
  const ec = toNumber(edgeCount, 0);
  const state = HEALTH_STATES.has(overallHealth) ? overallHealth : 'unknown';
  const sev = SEVERITIES.has(severity) ? severity : 'unknown';
  const pct = toNumber(completenessPct, 0);
  return `Clinical knowledge graph is ${state} (${sev}) — ${nc} nodes, ${ec} edges, completeness ${pct}%.`;
}

// ---------- DB helpers --------------------------------------------------

async function getActivePrompt(tenantId) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT version, system_prompt, user_prompt_template
       FROM clinical_ai_prompts
       WHERE tenant_id = $1::uuid
         AND module_key = $2
       ORDER BY active DESC, activated_at DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      tenantId,
      MODULE_KEY
    );
    return (rows && rows[0]) || DEFAULT_PROMPT;
  } catch (err) {
    if (isMissingSchemaError(err)) return DEFAULT_PROMPT;
    throw err;
  }
}

function normalizeNodeRow(row) {
  if (!row) return row;
  return { ...row };
}

function normalizeEdgeRow(row) {
  if (!row) return row;
  return {
    ...row,
    from_node_id: row.from_node_id !== null && row.from_node_id !== undefined
      ? toNumber(row.from_node_id, null)
      : null,
    to_node_id: row.to_node_id !== null && row.to_node_id !== undefined
      ? toNumber(row.to_node_id, null)
      : null,
  };
}

function normalizeReportRow(row) {
  if (!row) return row;
  return {
    ...row,
    generation_id: row.generation_id !== null && row.generation_id !== undefined
      ? toNumber(row.generation_id, null)
      : null,
    node_count: toNumber(row.node_count, 0),
    edge_count: toNumber(row.edge_count, 0),
    orphan_node_count: toNumber(row.orphan_node_count, 0),
    missing_critical_edge_count: toNumber(row.missing_critical_edge_count, 0),
    contradiction_count: toNumber(row.contradiction_count, 0),
    stale_node_count: toNumber(row.stale_node_count, 0),
    completeness_pct: toNumber(row.completeness_pct, 0),
  };
}

async function loadAllNodes(tenantId, limit = 10000) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, node_type, node_key, display_name, source,
              source_ref, valid_from, valid_to, attributes, metadata,
              created_at, updated_at
       FROM clinical_ai_kg_nodes
       WHERE tenant_id = $1::uuid
       ORDER BY created_at DESC
       LIMIT $2`,
      tenantId,
      limit
    );
    return asArray(rows).map(normalizeNodeRow);
  } catch (err) {
    if (isMissingSchemaError(err)) return [];
    throw err;
  }
}

async function loadAllEdges(tenantId, limit = 10000) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, edge_type, from_node_id, to_node_id, source,
              source_ref, valid_from, valid_to, attributes, metadata,
              created_at, updated_at
       FROM clinical_ai_kg_edges
       WHERE tenant_id = $1::uuid
       ORDER BY created_at DESC
       LIMIT $2`,
      tenantId,
      limit
    );
    return asArray(rows).map(normalizeEdgeRow);
  } catch (err) {
    if (isMissingSchemaError(err)) return [];
    throw err;
  }
}

async function insertGeneration({
  tenantId,
  sourceHashValue,
  draft,
  citations,
  safetyFlags,
  requestedBy,
  aiResult,
  prompt,
  metadata,
}) {
  const usage = aiResult?.usage || {};
  const hasCritical = asArray(safetyFlags).some((flag) => flag?.severity === 'critical');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_generations
         (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model,
          prompt_version, source_hash, status, used_ai, safety_flags, citations, draft,
          generated_by, prompt_tokens, completion_tokens, total_tokens,
          estimated_cost_minor, metadata, created_at, updated_at)
       VALUES ($1::uuid, NULL, NULL, $2, $2, $3, $4,
               $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb,
               $12::uuid, $13, $14, $15, $16, $17::jsonb, NOW(), NOW())
       RETURNING id, status, created_at`,
      tenantId,
      MODULE_KEY,
      aiResult?.provider || 'template',
      aiResult?.model || null,
      prompt?.version || 'v1',
      sourceHashValue,
      hasCritical ? 'failed' : 'draft',
      Boolean(aiResult?.usedAi),
      JSON.stringify(safetyFlags || []),
      JSON.stringify(citations || []),
      JSON.stringify(draft || {}),
      requestedBy,
      usage.prompt_tokens || 0,
      usage.completion_tokens || 0,
      usage.total_tokens || 0,
      aiResult?.estimatedCostMinor ?? 0,
      JSON.stringify(metadata || {})
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Clinical knowledge graph generation persist failed', { error: err.message });
    }
    return null;
  }
}

async function createReviewPlaceholder({ tenantId, generationId, module, reportContext }) {
  if (!generationId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_reviews
         (tenant_id, generation_id, module_key, patient_uid, admission_id, decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, NULL, NULL, 'pending', $4::jsonb, NOW(), NOW())
       RETURNING id, decision`,
      tenantId,
      generationId,
      MODULE_KEY,
      JSON.stringify({
        review_roles: module?.settings?.reviewRoles || ['ADMIN', 'AI_EVAL_LEAD', 'DATA_ENGINEER'],
        source: 'clinical_knowledge_graph',
        overall_health: reportContext?.overall_health || null,
        severity: reportContext?.severity || null,
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Clinical knowledge graph review placeholder failed', { error: err.message });
    }
    return null;
  }
}

// ---------- Public API --------------------------------------------------

/**
 * Upsert a knowledge-graph node by (tenant_id, node_type, node_key). This
 * is a thin write surface — real ingest happens upstream; the service is
 * review-only for the health-report portion.
 */
export async function upsertNode({
  tenantId = null,
  nodeType,
  nodeKey,
  displayName = null,
  source = null,
  sourceRef = null,
  validFrom = null,
  validTo = null,
  attributes = {},
  metadata = {},
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const type = normalizeNodeType(nodeType);
  const key = cleanText(nodeKey);
  if (!key) throw AppError.badRequest('node_key is required');

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_kg_nodes
         (tenant_id, node_type, node_key, display_name, source, source_ref,
          valid_from, valid_to, attributes, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz,
               $9::jsonb, $10::jsonb, NOW(), NOW())
       ON CONFLICT (tenant_id, node_type, node_key)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         source = EXCLUDED.source,
         source_ref = EXCLUDED.source_ref,
         valid_from = EXCLUDED.valid_from,
         valid_to = EXCLUDED.valid_to,
         attributes = EXCLUDED.attributes,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING id, tenant_id, node_type, node_key, display_name, source,
                 source_ref, valid_from, valid_to, attributes, metadata,
                 created_at, updated_at`,
      tid,
      type,
      key,
      displayName ? cleanText(displayName) : null,
      source ? cleanText(source) : null,
      sourceRef ? cleanText(sourceRef) : null,
      validFrom || null,
      validTo || null,
      JSON.stringify(attributes || {}),
      JSON.stringify(metadata || {})
    );
    return normalizeNodeRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

/**
 * List knowledge-graph nodes for the tenant. Filter by node_type + source.
 * Limit 1..200, ORDER BY created_at DESC.
 */
export async function listNodes({
  tenantId = null,
  nodeType = null,
  source = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedType = nodeType && NODE_TYPES.has(cleanText(nodeType).toLowerCase())
    ? cleanText(nodeType).toLowerCase()
    : null;
  const normalizedSource = source ? cleanText(source) : null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, node_type, node_key, display_name, source,
              source_ref, valid_from, valid_to, attributes, metadata,
              created_at, updated_at
       FROM clinical_ai_kg_nodes
       WHERE tenant_id = $1::uuid
         AND ($2::text IS NULL OR node_type = $2)
         AND ($3::text IS NULL OR source = $3)
       ORDER BY created_at DESC
       LIMIT $4`,
      tid,
      normalizedType,
      normalizedSource,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizeNodeRow);
    return { nodes: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { nodes: [], count: 0 };
    throw err;
  }
}

/**
 * Upsert a knowledge-graph edge by (tenant_id, edge_type, from_node_id,
 * to_node_id).
 */
export async function upsertEdge({
  tenantId = null,
  edgeType,
  fromNodeId,
  toNodeId,
  source = null,
  sourceRef = null,
  validFrom = null,
  validTo = null,
  attributes = {},
  metadata = {},
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const type = normalizeEdgeType(edgeType);
  const fromId = optionalInt(fromNodeId, 'from_node_id');
  const toId = optionalInt(toNodeId, 'to_node_id');

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_kg_edges
         (tenant_id, edge_type, from_node_id, to_node_id, source, source_ref,
          valid_from, valid_to, attributes, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz,
               $9::jsonb, $10::jsonb, NOW(), NOW())
       ON CONFLICT (tenant_id, edge_type, from_node_id, to_node_id)
       DO UPDATE SET
         source = EXCLUDED.source,
         source_ref = EXCLUDED.source_ref,
         valid_from = EXCLUDED.valid_from,
         valid_to = EXCLUDED.valid_to,
         attributes = EXCLUDED.attributes,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING id, tenant_id, edge_type, from_node_id, to_node_id, source,
                 source_ref, valid_from, valid_to, attributes, metadata,
                 created_at, updated_at`,
      tid,
      type,
      fromId,
      toId,
      source ? cleanText(source) : null,
      sourceRef ? cleanText(sourceRef) : null,
      validFrom || null,
      validTo || null,
      JSON.stringify(attributes || {}),
      JSON.stringify(metadata || {})
    );
    return normalizeEdgeRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

/**
 * List knowledge-graph edges for the tenant. Filter by edge_type,
 * from_node_id, to_node_id. Limit 1..500.
 */
export async function listEdges({
  tenantId = null,
  edgeType = null,
  fromNodeId = null,
  toNodeId = null,
  limit = 100,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
  const normalizedType = edgeType && EDGE_TYPES.has(cleanText(edgeType).toLowerCase())
    ? cleanText(edgeType).toLowerCase()
    : null;
  const normalizedFrom = fromNodeId ? optionalInt(fromNodeId, 'from_node_id') : null;
  const normalizedTo = toNodeId ? optionalInt(toNodeId, 'to_node_id') : null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, edge_type, from_node_id, to_node_id, source,
              source_ref, valid_from, valid_to, attributes, metadata,
              created_at, updated_at
       FROM clinical_ai_kg_edges
       WHERE tenant_id = $1::uuid
         AND ($2::text IS NULL OR edge_type = $2)
         AND ($3::int IS NULL OR from_node_id = $3)
         AND ($4::int IS NULL OR to_node_id = $4)
       ORDER BY created_at DESC
       LIMIT $5`,
      tid,
      normalizedType,
      normalizedFrom,
      normalizedTo,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizeEdgeRow);
    return { edges: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { edges: [], count: 0 };
    throw err;
  }
}

/**
 * Evaluate the graph and produce a rules-authoritative health report.
 * This is the core review-only entry point — it never mutates nodes or
 * edges, only inserts a clinical_ai_generation + clinical_ai_kg_health_reports
 * row and a review placeholder.
 */
export async function evaluateGraphHealth({ req = null, today = null, stalenessDays = 365 } = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const nodes = await loadAllNodes(tenantId, 10000);
  const edges = await loadAllEdges(tenantId, 10000);

  const orphanResult = computeOrphanNodes({ nodes, edges });
  const missingResult = computeMissingCriticalEdges({ nodes, edges });
  const contradictionResult = detectContradictions({ edges });
  const staleResult = detectStaleNodes({ nodes, today, stalenessDays });

  const nodeCount = nodes.length;
  const edgeCount = edges.length;
  const orphanCount = orphanResult.count;
  const missingCount = missingResult.count;
  const contradictionCount = contradictionResult.count;
  const staleCount = staleResult.count;

  const completenessPct = computeCompleteness({
    nodeCount,
    edgeCount,
    missingCriticalEdgeCount: missingCount,
    orphanNodeCount: orphanCount,
  });

  const classification = classifyGraphHealth({
    nodeCount,
    edgeCount,
    orphanNodeCount: orphanCount,
    missingCriticalEdgeCount: missingCount,
    contradictionCount,
    staleNodeCount: staleCount,
    completenessPct,
  });

  const summary = summarizeGraphHealth({
    nodeCount,
    edgeCount,
    overallHealth: classification.overall_health,
    severity: classification.severity,
    completenessPct,
  });

  const recommendedActions = buildGraphActions({
    overallHealth: classification.overall_health,
    severity: classification.severity,
    signals: classification.signals,
  });

  // Anomaly breakdown (bounded for payload size).
  const anomalies = [
    { type: 'orphan_nodes', count: orphanCount, items: orphanResult.orphan_nodes.slice(0, 50) },
    { type: 'missing_critical_edges', count: missingCount, items: missingResult.missing_edges.slice(0, 50) },
    { type: 'contradictions', count: contradictionCount, items: contradictionResult.contradictions.slice(0, 50) },
    { type: 'stale_nodes', count: staleCount, items: staleResult.stale_nodes.slice(0, 50) },
  ];

  // Citations — always include the rules reference.
  const citations = [
    {
      source_type: 'kg_rules',
      source_id: MODULE_KEY,
      label: 'Clinical knowledge graph rules reference',
      timestamp: null,
    },
  ];
  const finalCitations = uniqueCitations(citations);

  // Safety flags.
  const safetyFlags = [];
  if (classification.severity === 'critical') {
    safetyFlags.push({
      severity: 'critical',
      code: 'KG_HEALTH_CRITICAL',
      message: `Graph health is ${classification.overall_health} — immediate data-engineer attention required.`,
    });
  }
  if (!finalCitations.length) {
    safetyFlags.push({
      severity: 'medium',
      code: 'NO_CITATIONS',
      message: 'Health report has no source citations.',
    });
  }
  if (nodeCount === 0) {
    safetyFlags.push({
      severity: 'medium',
      code: 'EMPTY_GRAPH',
      message: 'No nodes present — health-report metrics cannot be interpreted.',
    });
  }

  const fallbackDraft = {
    module_key: MODULE_KEY,
    node_count: nodeCount,
    edge_count: edgeCount,
    orphan_node_count: orphanCount,
    missing_critical_edge_count: missingCount,
    contradiction_count: contradictionCount,
    stale_node_count: staleCount,
    completeness_pct: completenessPct,
    overall_health: classification.overall_health,
    severity: classification.severity,
    signals: classification.signals,
    anomalies,
    summary,
    recommended_actions: recommendedActions,
    source_citations: finalCitations,
    safety_flags: safetyFlags,
    rules_authoritative: true,
    decision_support_only: true,
  };

  // Optional AI narrative (decorative).
  let draft = fallbackDraft;
  let aiResult = null;
  const prompt = await getActivePrompt(tenantId);
  try {
    aiResult = await generateClinicalText({
      taskType: MODULE_KEY,
      systemPrompt: prompt.system_prompt,
      userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify({
        snapshot: {
          node_count: nodeCount,
          edge_count: edgeCount,
          orphan_node_count: orphanCount,
          missing_critical_edge_count: missingCount,
          contradiction_count: contradictionCount,
          stale_node_count: staleCount,
          completeness_pct: completenessPct,
        },
        rule_based_evaluation: {
          overall_health: classification.overall_health,
          severity: classification.severity,
          signals: classification.signals,
        },
      })}`,
      tenantRegion: req?.tenant?.region || null,
      tenantId,
    });
    const parsed = safeJsonParse(aiResult?.text, {});
    if (parsed && typeof parsed === 'object') {
      draft = {
        ...fallbackDraft,
        summary: cleanText(parsed.summary) || fallbackDraft.summary,
        source_citations: uniqueCitations([
          ...asArray(fallbackDraft.source_citations),
          ...asArray(parsed.source_citations),
        ]),
      };
    }
  } catch (err) {
    logger.debug('Clinical knowledge graph AI narrative unavailable; using template fallback', {
      error: err?.message,
    });
  }

  // Merge with output defenses.
  const combinedFlags = [
    ...safetyFlags,
    ...runOutputDefenses({
      draft,
      module,
      context: {
        graph: {
          node_count: nodeCount,
          edge_count: edgeCount,
        },
      },
      citations: draft.source_citations,
    }),
  ];
  draft.safety_flags = combinedFlags;
  draft.source_citations = uniqueCitations(asArray(draft.source_citations));

  // Persist generation.
  const generation = await insertGeneration({
    tenantId,
    sourceHashValue: sourceHash({
      tenant_id: tenantId,
      node_count: nodeCount,
      edge_count: edgeCount,
      orphan_node_count: orphanCount,
      missing_critical_edge_count: missingCount,
      contradiction_count: contradictionCount,
      stale_node_count: staleCount,
      completeness_pct: completenessPct,
      overall_health: classification.overall_health,
    }),
    draft,
    citations: draft.source_citations,
    safetyFlags: combinedFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    prompt,
    metadata: {
      overall_health: classification.overall_health,
      severity: classification.severity,
      signal_codes: asArray(classification.signals).map((s) => s?.code).filter(Boolean),
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  // Persist health-report row.
  let reportRow = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_kg_health_reports
         (tenant_id, generation_id, node_count, edge_count,
          orphan_node_count, missing_critical_edge_count, contradiction_count,
          stale_node_count, completeness_pct, overall_health, severity,
          anomalies, signals, summary, recommended_actions,
          source_citations, safety_flags, reviewer_decision, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4,
               $5, $6, $7,
               $8, $9, $10, $11,
               $12::jsonb, $13::jsonb, $14, $15::jsonb,
               $16::jsonb, $17::jsonb, 'pending', $18::jsonb,
               NOW(), NOW())
       RETURNING id, tenant_id, generation_id, node_count, edge_count,
                 orphan_node_count, missing_critical_edge_count, contradiction_count,
                 stale_node_count, completeness_pct, overall_health, severity,
                 anomalies, signals, summary, recommended_actions,
                 source_citations, safety_flags, reviewer_decision, reviewed_by,
                 reviewed_at, reviewer_note, metadata, created_at, updated_at,
                 retention_until`,
      tenantId,
      generation?.id || null,
      nodeCount,
      edgeCount,
      orphanCount,
      missingCount,
      contradictionCount,
      staleCount,
      completenessPct,
      HEALTH_STATES.has(classification.overall_health) ? classification.overall_health : 'unknown',
      SEVERITIES.has(classification.severity) ? classification.severity : 'unknown',
      JSON.stringify(anomalies),
      JSON.stringify(asArray(classification.signals)),
      draft.summary,
      JSON.stringify(asArray(recommendedActions)),
      JSON.stringify(asArray(draft.source_citations)),
      JSON.stringify(asArray(combinedFlags)),
      JSON.stringify({
        rules_authoritative: true,
        decision_support_only: true,
        staleness_days: toNumber(stalenessDays, 365),
      })
    );
    reportRow = normalizeReportRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return {
        report_id: null,
        generation_id: generation?.id || null,
        clinical_review_id: null,
        draft,
        report: null,
        overall_health: classification.overall_health,
        severity: classification.severity,
        completeness_pct: completenessPct,
        node_count: nodeCount,
        edge_count: edgeCount,
        orphan_node_count: orphanCount,
        missing_critical_edge_count: missingCount,
        contradiction_count: contradictionCount,
        stale_node_count: staleCount,
        anomalies,
        signals: classification.signals,
        source_citations: draft.source_citations,
        safety_flags: combinedFlags,
        module_key: MODULE_KEY,
        prompt_version: prompt?.version || 'v1',
        review_status: 'schema_unavailable',
        reason: 'clinical_ai_kg_health_reports_unavailable',
        requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
        ai_metadata: {
          provider: aiResult?.provider || 'template',
          model: aiResult?.model || null,
          used_ai: Boolean(aiResult?.usedAi),
          usage: aiResult?.usage || {},
        },
        rules_authoritative: true,
        decision_support_only: true,
      };
    }
    throw err;
  }

  // Review placeholder.
  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    module,
    reportContext: {
      overall_health: classification.overall_health,
      severity: classification.severity,
    },
  });

  // Event publish.
  try {
    await publishEvent({
      eventType: 'clinical_ai.kg_health_evaluated',
      aggregateType: 'clinical_ai_kg_health_report',
      aggregateId: reportRow.id,
      patientUid: null,
      payload: {
        tenant_id: tenantId,
        report_id: reportRow.id,
        generation_id: generation?.id || null,
        overall_health: classification.overall_health,
        severity: classification.severity,
        node_count: nodeCount,
        edge_count: edgeCount,
        completeness_pct: completenessPct,
        signal_codes: asArray(classification.signals).map((s) => s?.code).filter(Boolean),
      },
    });
  } catch (err) {
    logger.warn('Clinical knowledge graph event publish failed', { error: err?.message });
  }

  return {
    report_id: reportRow.id,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    report: reportRow,
    overall_health: classification.overall_health,
    severity: classification.severity,
    completeness_pct: completenessPct,
    node_count: nodeCount,
    edge_count: edgeCount,
    orphan_node_count: orphanCount,
    missing_critical_edge_count: missingCount,
    contradiction_count: contradictionCount,
    stale_node_count: staleCount,
    anomalies,
    signals: classification.signals,
    source_citations: draft.source_citations,
    safety_flags: combinedFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt?.version || 'v1',
    review_status: clinicalReview?.decision || reportRow.reviewer_decision || 'pending',
    requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
    ai_metadata: {
      provider: aiResult?.provider || 'template',
      model: aiResult?.model || null,
      used_ai: Boolean(aiResult?.usedAi),
      usage: aiResult?.usage || {},
    },
    rules_authoritative: true,
    decision_support_only: true,
  };
}

/**
 * List graph-health report rows for the tenant. Severity-sorted
 * (critical first), then created_at DESC.
 */
export async function listGraphHealthReports({
  tenantId = null,
  overallHealth = null,
  severity = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedHealth = overallHealth
    && HEALTH_STATES.has(cleanText(overallHealth).toLowerCase())
    ? cleanText(overallHealth).toLowerCase()
    : null;
  const normalizedSeverity = severity
    && SEVERITIES.has(cleanText(severity).toLowerCase())
    ? cleanText(severity).toLowerCase()
    : null;
  const normalizedDecision = reviewerDecision
    && DECISIONS.has(cleanText(reviewerDecision).toLowerCase())
    ? cleanText(reviewerDecision).toLowerCase()
    : null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT r.id, r.tenant_id, r.generation_id, r.node_count, r.edge_count,
              r.orphan_node_count, r.missing_critical_edge_count, r.contradiction_count,
              r.stale_node_count, r.completeness_pct, r.overall_health, r.severity,
              r.anomalies, r.signals, r.summary, r.recommended_actions,
              r.source_citations, r.safety_flags, r.reviewer_decision, r.reviewed_by,
              r.reviewed_at, r.reviewer_note, r.metadata, r.created_at, r.updated_at,
              r.retention_until
       FROM clinical_ai_kg_health_reports r
       WHERE r.tenant_id = $1::uuid
         AND ($2::text IS NULL OR r.overall_health = $2)
         AND ($3::text IS NULL OR r.severity = $3)
         AND ($4::text IS NULL OR r.reviewer_decision = $4)
       ORDER BY
         CASE r.severity
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'moderate' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         r.created_at DESC
       LIMIT $5`,
      tid,
      normalizedHealth,
      normalizedSeverity,
      normalizedDecision,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizeReportRow);
    return { reports: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { reports: [], count: 0 };
    throw err;
  }
}

/**
 * Record a data-engineer decision on a graph health report row.
 */
export async function decideGraphHealthReport({
  tenantId = null,
  reportId,
  decision,
  reviewerUid = null,
  note = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = cleanText(decision).toLowerCase();
  if (!FINAL_DECISIONS.has(normalized)) {
    throw AppError.badRequest('decision must be accepted, deferred, rejected, or edited');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_kg_health_reports
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, tenant_id, generation_id, node_count, edge_count,
               orphan_node_count, missing_critical_edge_count, contradiction_count,
               stale_node_count, completeness_pct, overall_health, severity,
               anomalies, signals, summary, recommended_actions,
               source_citations, safety_flags, reviewer_decision, reviewed_by,
               reviewed_at, reviewer_note, metadata, created_at, updated_at,
               retention_until`,
    optionalInt(reportId, 'report_id'),
    normalized,
    reviewerUid || null,
    note ? cleanText(note) : null,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('Graph health report not found');
  return normalizeReportRow(rows[0]);
}

export default {
  NODE_TYPES,
  EDGE_TYPES,
  HEALTH_STATES,
  HEALTH_PRIORITY,
  SEVERITIES,
  SEVERITY_PRIORITY,
  DECISIONS,
  FINAL_DECISIONS,
  CRITICAL_EDGE_RULES,
  normalizeNodeType,
  normalizeEdgeType,
  nodeMatchKey,
  computeOrphanNodes,
  computeMissingCriticalEdges,
  detectContradictions,
  detectStaleNodes,
  computeCompleteness,
  classifyGraphHealth,
  escalateGraphHealth,
  escalateSeverity,
  buildGraphActions,
  summarizeGraphHealth,
  upsertNode,
  listNodes,
  upsertEdge,
  listEdges,
  evaluateGraphHealth,
  listGraphHealthReports,
  decideGraphHealthReport,
};
