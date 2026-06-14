/**
 * Curated knowledge-base grounding for the clinical-AI generation path
 * (WS5 B5.5).
 *
 * Today the curated KB (`knowledge_chunks`, migration 113) is reachable in
 * generation only through this helper. The generation services
 * (clinicalAiWorkflowService, antimicrobialStewardshipService,
 * pathwayBundleComplianceService, opdClinicalAssistService via
 * patientExplainersService) call `groundWithKnowledgeBases` to pull
 * curation-approved formulary / antibiogram / protocol / guideline chunks
 * into the prompt context + the citation set, UNIONed with the existing
 * chart-packet / RAG citations.
 *
 * This grounding is strictly ADDITIVE and GRACEFUL:
 *   - Per-module gate: only modules whose registry `settings.knowledgeBases`
 *     declares one or more kb_types pull curated chunks. Every other module
 *     no-ops (returns empty), so non-gated behaviour is unchanged.
 *   - If the embedder / KB is unavailable, returns nothing, never throws —
 *     generation proceeds exactly as before.
 *   - It NEVER becomes a hard precondition: the existing citation
 *     fail-close (requiresCitations) must still be satisfiable from the
 *     chart packet alone, so callers UNION these citations in rather than
 *     replacing their own.
 *
 * The curation gate (`curation_status='approved'`) is enforced inside
 * retrieveFromKnowledgeBases — only signed-off documents ever reach a
 * prompt. This helper only chooses WHICH kb_types to ask for, per the
 * module's declarative gate.
 */

import logger from '../../logging/logger.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { retrieveFromKnowledgeBases } from './knowledgeRetrievalService.js';

// Conservative per-kb_type top-K so a single module call does not pull a
// large amount of reference text into the prompt. The chart packet stays
// the primary grounding; KB chunks are supplementary.
const DEFAULT_TOP_K_PER_TYPE = 3;
const MAX_GROUNDING_CHUNKS = 12;
// Curated reference material is a tighter match by design (formulary /
// antibiogram entries are short + specific), so a slightly higher floor
// than the corpus default keeps low-signal chunks out of the prompt.
const DEFAULT_MIN_SCORE = 0.6;
// Grounding queries default to a clinician-equivalent role for the KB
// access-policy gate. Callers can override (e.g. the actual reviewer role).
const DEFAULT_GROUNDING_ROLE = 'DOCTOR';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Read the declarative per-module KB gate. Returns the de-duplicated,
 * lower-cased list of kb_types this module is allowed to ground against,
 * or [] when the module opts out (no `settings.knowledgeBases`).
 */
export function knowledgeBaseTypesForModule(module) {
  const declared = asArray(module?.settings?.knowledgeBases);
  const seen = new Set();
  const types = [];
  for (const raw of declared) {
    const kbType = String(raw || '').trim().toLowerCase();
    if (!kbType || seen.has(kbType)) continue;
    seen.add(kbType);
    types.push(kbType);
  }
  return types;
}

/**
 * True when the module declares at least one curated KB type. Cheap gate
 * callers can use to skip building a grounding query string entirely.
 */
export function moduleUsesKnowledgeGrounding(module) {
  return knowledgeBaseTypesForModule(module).length > 0;
}

function chunkCitation(chunk) {
  const score = Number(chunk?.similarity);
  const scoreLabel = Number.isFinite(score) ? ` (sim ${score.toFixed(2)})` : '';
  const title = chunk?.document_title || chunk?.kb_name || 'Curated knowledge';
  return {
    source_type: 'knowledge_chunk',
    source_id: chunk?.chunk_id === null || chunk?.chunk_id === undefined
      ? null
      : String(chunk.chunk_id),
    label: `${title}${scoreLabel}`,
    timestamp: null,
    // Extra provenance kept on the citation so a reviewer / regulator can
    // trace the exact KB + document the chunk came from. uniqueCitations()
    // keys only on source_type:source_id:label, so these are inert there.
    knowledge_base_id: chunk?.knowledge_base_id ?? null,
    document_id: chunk?.document_id ?? null,
    kb_type: chunk?.kb_type ?? null,
  };
}

function groundingChunk(chunk) {
  return {
    chunk_id: chunk?.chunk_id ?? null,
    knowledge_base_id: chunk?.knowledge_base_id ?? null,
    kb_name: chunk?.kb_name ?? null,
    kb_type: chunk?.kb_type ?? null,
    document_id: chunk?.document_id ?? null,
    document_title: chunk?.document_title ?? null,
    similarity: Number.isFinite(Number(chunk?.similarity)) ? Number(chunk.similarity) : null,
    content: String(chunk?.content ?? '').slice(0, 1200),
  };
}

/**
 * Pull curated KB chunks for a module's declared kb_types and shape them
 * into grounding context + citations.
 *
 * @returns {Promise<{
 *   used: boolean,                 // module is gated AND ≥1 chunk returned
 *   gated: boolean,               // module declares any kb_types at all
 *   kbTypes: string[],            // declared kb_types asked for
 *   groundingChunks: Array<{...}>, // for the prompt context
 *   citations: Array<{...}>,       // to UNION into the caller's citations
 *   sources: Record<string,string>, // per-kb_type retrieval source code
 * }>}
 *
 * Never throws. On any infrastructure failure it logs at debug/warn and
 * returns an empty (used:false) result so generation proceeds unchanged.
 */
export async function groundWithKnowledgeBases({
  module,
  tenantId = null,
  queryText,
  role = null,
  retrievedBy = null,
  moduleKey = null,
  topKPerType = DEFAULT_TOP_K_PER_TYPE,
  minScore = DEFAULT_MIN_SCORE,
  maxChunks = MAX_GROUNDING_CHUNKS,
} = {}) {
  const kbTypes = knowledgeBaseTypesForModule(module);
  const key = moduleKey || module?.module_key || null;
  const empty = {
    used: false,
    gated: kbTypes.length > 0,
    kbTypes,
    groundingChunks: [],
    citations: [],
    sources: {},
  };

  // Per-module gate: module did not opt in → no curated grounding.
  if (!kbTypes.length) return empty;

  const text = String(queryText || '').trim();
  if (!text) return empty;

  const tid = tenantId || DEFAULT_TENANT_ID;
  const groundingRole = role ? String(role).toUpperCase() : DEFAULT_GROUNDING_ROLE;

  const chunks = [];
  const sources = {};
  for (const kbType of kbTypes) {
    let result;
    try {
      // retrieveFromKnowledgeBases is itself graceful (degrades to empty
      // on embed/schema/query failure) but we still guard the call so one
      // bad kb_type never aborts grounding for the rest, and grounding
      // never aborts generation.
      result = await retrieveFromKnowledgeBases({
        tenantId: tid,
        queryText: text,
        role: groundingRole,
        kbType,
        moduleKey: key,
        retrievedBy,
        topK: topKPerType,
        minScore,
      });
    } catch (err) {
      logger.warn('Knowledge grounding retrieval failed (non-fatal)', {
        module_key: key,
        kb_type: kbType,
        error: err?.message,
      });
      sources[kbType] = 'grounding_error';
      continue;
    }
    sources[kbType] = result?.source || 'unknown';
    for (const row of asArray(result?.results)) {
      chunks.push(row);
    }
  }

  if (!chunks.length) {
    return { ...empty, used: false, sources };
  }

  // Best chunks first, then cap so the prompt stays bounded regardless of
  // how many kb_types the module declared.
  chunks.sort((a, b) => Number(b?.similarity || 0) - Number(a?.similarity || 0));
  const seenChunkIds = new Set();
  const capped = [];
  for (const chunk of chunks) {
    const id = chunk?.chunk_id ?? `${chunk?.document_id}:${chunk?.content?.slice(0, 24)}`;
    if (seenChunkIds.has(id)) continue;
    seenChunkIds.add(id);
    capped.push(chunk);
    if (capped.length >= maxChunks) break;
  }

  return {
    used: capped.length > 0,
    gated: true,
    kbTypes,
    groundingChunks: capped.map(groundingChunk),
    citations: capped.map(chunkCitation),
    sources,
  };
}

export const __testing__ = {
  DEFAULT_TOP_K_PER_TYPE,
  DEFAULT_MIN_SCORE,
  MAX_GROUNDING_CHUNKS,
  DEFAULT_GROUNDING_ROLE,
  chunkCitation,
  groundingChunk,
};

export default {
  groundWithKnowledgeBases,
  knowledgeBaseTypesForModule,
  moduleUsesKnowledgeGrounding,
};
