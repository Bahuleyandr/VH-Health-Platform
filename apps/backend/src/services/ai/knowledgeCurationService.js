/**
 * Knowledge curation bridge — WS5 B5.5.
 *
 * Imports hospital-owned, in-our-control clinical reference data into the RAG
 * knowledge-base substrate (migration 113) as curation-PENDING documents, so a
 * human domain owner signs them off before they can feed a clinical-AI prompt:
 *
 *   - importFormularyToKb     pharmacy_catalog (active rows)  → kb_type formulary
 *   - importAntibiogramToKb   antibiogram_90d  (90-day view)  → kb_type antibiotic_policy
 *   - importProtocolsToKb     clinical_protocols (active)      → kb_type clinical_guideline
 *
 * Each source row is rendered to a compact text document and ingested through
 * knowledgeDocumentService.createInlineDocument (which chunks + embeds via
 * ragService, degrading to 'embed_unavailable' when Ollama is down). Imports
 * are IDEMPOTENT: a document's file_hash is the SHA-256 of its rendered text
 * (reusing idx_knowledge_documents_tenant_hash), so a re-run skips any row
 * whose rendered content is unchanged. New imported docs land
 * curation_status='pending' — dark to retrieval until decideKnowledgeDocument
 * approves them.
 *
 * Tenant isolation: knowledge_* and knowledge_import_batches are RLS tables.
 * Every write runs inside the tenant context (createInlineDocument threads
 * tenant_id into its SQL; the import-batch provenance row is written via
 * setTenant so its RLS WITH CHECK is satisfied). pharmacy_catalog /
 * antibiogram_90d / clinical_protocols are read on the tenant-scoped path too
 * (antibiogram_90d carries tenant_id; pharmacy_catalog / clinical_protocols are
 * global reference tables but are read inside the tenant context for
 * consistency).
 *
 * Decision-support only: curated knowledge augments AI prompts; it is never the
 * authority of record. See docs/CLINICAL_AI_KNOWLEDGE_CURATION.md for who owns
 * sign-off (pharmacy / microbiology-infection-control) and the refresh cadence.
 */

import crypto from 'crypto';

import prisma, { setTenant } from '../../lib/prisma.js';
import { runInTenantContext } from '../../lib/tenantContext.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { antibiogram90d } from '../lab/microbiologyService.js';
import { getKnowledgeBase } from './knowledgeBaseService.js';
import { createInlineDocument, findDocumentByHash } from './knowledgeDocumentService.js';

const VALID_SOURCES = ['formulary', 'antibiogram', 'protocols', 'all'];
const FORMULARY_PAGE_SIZE = 200;
const FORMULARY_MAX_ROWS = 20_000; // safety ceiling on a single import run
const TITLE_MAX = 255;

const KB_TYPE_FOR_SOURCE = {
  formulary: 'formulary',
  antibiogram: 'antibiotic_policy',
  protocols: 'clinical_guideline',
};

function resolveTenantId(tenantId) {
  return tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist|column .* does not exist/i.test(
    String(err?.message || ''),
  );
}

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function emptyCounts() {
  return { processed: 0, inserted: 0, skipped: 0, failed: 0 };
}

// ---------------------------------------------------------------------------
// Render-to-text — pure, unit-tested directly.
// ---------------------------------------------------------------------------

/**
 * Render one active pharmacy_catalog row to a compact formulary document.
 * Stable line order so the file_hash only changes when the content does.
 */
export function renderFormularyRow(row = {}) {
  const name = clean(row.name);
  const lines = [
    `Formulary entry: ${name || 'Unnamed medicine'}`,
    `Generic: ${clean(row.generic_name) || 'n/a'}`,
    `Category: ${clean(row.category) || 'n/a'}`,
    `Manufacturer: ${clean(row.manufacturer) || 'n/a'}`,
    `Pack size: ${clean(row.pack_size) || 'n/a'}`,
    `Prescription required: ${row.requires_prescription ? 'Yes (Rx-only)' : 'No (OTC)'}`,
  ];
  return lines.join('\n');
}

function formularyTitle(row = {}) {
  const name = clean(row.name) || 'Unnamed medicine';
  return name.slice(0, TITLE_MAX);
}

/**
 * Render one organism's antibiogram_90d susceptibility rows to a per-organism
 * policy summary. `rows` are the antibiogram_90d rows for a single organism
 * (already small-sample-suppressed by microbiologyService.antibiogram90d).
 * Antibiotics are sorted by descending susceptibility so the most-active agent
 * leads.
 */
export function renderAntibiogramOrganism(organismName, rows = []) {
  const organism = clean(organismName) || 'Unknown organism';
  const sorted = [...rows].sort(
    (a, b) => Number(b.susceptible_pct ?? -1) - Number(a.susceptible_pct ?? -1),
  );
  const totalTested = sorted.reduce(
    (max, r) => Math.max(max, Number(r.total_tested) || 0),
    0,
  );
  const lines = [
    `Antibiogram (rolling 90-day susceptibility) — ${organism}`,
    `Isolates tested (max across panel): ${totalTested}`,
  ];
  for (const r of sorted) {
    const pct = r.susceptible_pct === null || r.susceptible_pct === undefined
      ? 'n/a'
      : `${Number(r.susceptible_pct)}%`;
    const abx = clean(r.antibiotic_name) || clean(r.antibiotic_code) || 'unknown agent';
    lines.push(`${abx}: ${pct} susceptible (${Number(r.susceptible_count) || 0}/${Number(r.total_tested) || 0})`);
  }
  lines.push('Note: small-sample organisms (<5 isolates) are suppressed; decision support only — confirm against current local policy.');
  return lines.join('\n');
}

function antibiogramTitle(organismName) {
  const organism = clean(organismName) || 'Unknown organism';
  return `Antibiogram (90-day) — ${organism}`.slice(0, TITLE_MAX);
}

/**
 * Render one clinical_protocols row to a clinical-guideline document.
 * trigger_conditions / recommendations are JSONB; flatten deterministically.
 */
export function renderProtocolRow(row = {}) {
  const name = clean(row.name) || 'Unnamed protocol';
  const lines = [
    `Clinical protocol: ${name}`,
    `Category: ${clean(row.category) || 'n/a'}`,
    `Priority: ${clean(row.priority) || 'n/a'}`,
  ];
  const triggers = flattenJsonish(row.trigger_conditions);
  if (triggers.length) {
    lines.push('Trigger conditions:');
    for (const t of triggers) lines.push(`- ${t}`);
  }
  const recs = flattenJsonish(row.recommendations);
  if (recs.length) {
    lines.push('Recommendations:');
    for (const r of recs) lines.push(`- ${r}`);
  }
  return lines.join('\n');
}

function protocolTitle(row = {}) {
  return (clean(row.name) || 'Unnamed protocol').slice(0, TITLE_MAX);
}

// Flatten a JSONB value (object / array / scalar / json-string) to a stable,
// deduped list of "key: value" / scalar strings for deterministic rendering.
function flattenJsonish(value) {
  let v = value;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { v = JSON.parse(trimmed); } catch { /* keep as string */ }
    }
  }
  const out = [];
  const push = (s) => {
    const t = clean(s);
    if (t && !out.includes(t)) out.push(t);
  };
  if (v === null || v === undefined) return out;
  if (Array.isArray(v)) {
    for (const item of v) {
      if (item && typeof item === 'object') {
        for (const [k, val] of Object.entries(item)) push(`${k}: ${stringifyScalar(val)}`);
      } else {
        push(stringifyScalar(item));
      }
    }
  } else if (typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      if (Array.isArray(val)) push(`${k}: ${val.map(stringifyScalar).join(', ')}`);
      else push(`${k}: ${stringifyScalar(val)}`);
    }
  } else {
    push(stringifyScalar(v));
  }
  return out;
}

function stringifyScalar(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Import-batch provenance (knowledge_import_batches) — tenant-scoped.
// ---------------------------------------------------------------------------

async function openImportBatch({ tenantId, knowledgeBaseId, source, sourceRef, dryRun, runBy }) {
  try {
    const rows = await setTenant(tenantId, (tx) => tx.$queryRawUnsafe(
      `INSERT INTO knowledge_import_batches
         (tenant_id, knowledge_base_id, source, source_ref, status, dry_run,
          started_at, run_by, metadata)
       VALUES ($1::uuid, $2, $3, $4, 'running', $5, NOW(), $6::uuid, $7::jsonb)
       RETURNING id`,
      tenantId, knowledgeBaseId || null, source, sourceRef || null, Boolean(dryRun),
      runBy || null, JSON.stringify({ dry_run: Boolean(dryRun) }),
    ));
    return rows[0]?.id || null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    logger.warn('knowledge_import_batches open failed', { error: err.message, source });
    return null;
  }
}

async function closeImportBatch({ tenantId, batchId, status, counts, errorDetail = null }) {
  if (!batchId) return;
  try {
    await setTenant(tenantId, (tx) => tx.$queryRawUnsafe(
      `UPDATE knowledge_import_batches
       SET status = $2, rows_processed = $3, rows_inserted = $4,
           rows_skipped = $5, rows_failed = $6, error_detail = $7,
           finished_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND tenant_id = $8::uuid`,
      batchId, status, counts.processed, counts.inserted, counts.skipped,
      counts.failed, errorDetail, tenantId,
    ));
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('knowledge_import_batches close failed', { error: err.message, batchId });
    }
  }
}

// ---------------------------------------------------------------------------
// Shared document-upsert path: render → dedup on file_hash → ingest pending.
// ---------------------------------------------------------------------------

/**
 * Ingest one rendered document idempotently. Returns 'inserted' | 'skipped' |
 * 'failed'. dryRun renders + dedups but never writes.
 */
async function ingestRendered({
  tenantId, knowledgeBaseId, title, rawText, kind, source, sourceId, dryRun,
}) {
  // file_hash must match what createInlineDocument stores. It hashes the
  // NORMALIZED text (CRLF→LF, trimmed, sliced to 200k). Rendered docs here are
  // already \n-joined, trimmed, and short, so normalization is a no-op and the
  // two hashes agree — keep renders that way (no \r, no leading/trailing space)
  // or the dedup probe will miss and re-insert on every run.
  const fileHash = sha256(rawText);
  // Idempotency: skip when an identical-content doc already exists in this KB.
  const existing = await findDocumentByHash({ tenantId, knowledgeBaseId, fileHash });
  if (existing) return 'skipped';
  if (dryRun) return 'inserted'; // would-insert; counted as inserted in dry-run

  try {
    await createInlineDocument({
      tenantId,
      knowledgeBaseId,
      title,
      rawText,
      sourceType: 'imported',
      curationStatus: 'pending',
      metadata: {
        kind,
        source,
        source_id: sourceId === null || sourceId === undefined ? null : String(sourceId),
        imported_at: new Date().toISOString(),
      },
    });
    return 'inserted';
  } catch (err) {
    logger.warn('knowledge curation document ingest failed', {
      error: err.message, source, sourceId, knowledgeBaseId,
    });
    return 'failed';
  }
}

// file_hash for a rendered document. Matches the digest
// knowledgeDocumentService uses internally (sha256 hex of the raw text), so the
// importer's dedup probe and the document's stored file_hash agree exactly.
function sha256(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

// ---------------------------------------------------------------------------
// Source importers
// ---------------------------------------------------------------------------

/**
 * Import active pharmacy_catalog rows into the given KB as pending formulary
 * documents. Paged to bound memory. Returns per-source counts.
 */
export async function importFormularyToKb({
  tenantId = null,
  knowledgeBaseId,
  dryRun = false,
  runBy = null,
} = {}) {
  const tid = resolveTenantId(tenantId);
  const kbId = normalizeKbId(knowledgeBaseId);
  await assertKbType({ tenantId: tid, knowledgeBaseId: kbId, source: 'formulary' });

  return runInTenantContext(tid, async () => {
    const counts = emptyCounts();
    const batchId = await openImportBatch({
      tenantId: tid, knowledgeBaseId: kbId, source: 'formulary',
      sourceRef: 'pharmacy_catalog', dryRun, runBy,
    });
    try {
      let offset = 0;
      for (;;) {
        let rows;
        try {
          rows = await prisma.$queryRawUnsafe(
            `SELECT id, name, generic_name, category, manufacturer, pack_size,
                    requires_prescription
             FROM pharmacy_catalog
             WHERE is_active = true
             ORDER BY id ASC
             LIMIT $1 OFFSET $2`,
            FORMULARY_PAGE_SIZE, offset,
          );
        } catch (err) {
          if (isMissingSchemaError(err)) break;
          throw err;
        }
        if (!rows.length) break;
        for (const row of rows) {
          counts.processed += 1;
          const rawText = renderFormularyRow(row);
          const outcome = await ingestRendered({
            tenantId: tid, knowledgeBaseId: kbId,
            title: formularyTitle(row), rawText,
            kind: 'formulary', source: 'pharmacy_catalog', sourceId: row.id, dryRun,
          });
          counts[outcome] += 1;
        }
        offset += rows.length;
        if (rows.length < FORMULARY_PAGE_SIZE) break;
        if (offset >= FORMULARY_MAX_ROWS) {
          logger.warn('formulary import hit row ceiling', { ceiling: FORMULARY_MAX_ROWS });
          break;
        }
      }
      await closeImportBatch({
        tenantId: tid, batchId,
        status: counts.failed > 0 ? 'partial' : 'completed', counts,
      });
      return counts;
    } catch (err) {
      await closeImportBatch({
        tenantId: tid, batchId, status: 'failed', counts,
        errorDetail: String(err.message || err).slice(0, 1000),
      });
      throw err;
    }
  });
}

/**
 * Import the antibiogram_90d view into the given KB as per-organism pending
 * antibiotic-policy documents. Honors microbiologyService.antibiogram90d's
 * small-sample suppression (total_tested >= 5). Returns per-source counts.
 */
export async function importAntibiogramToKb({
  tenantId = null,
  knowledgeBaseId,
  dryRun = false,
  runBy = null,
} = {}) {
  const tid = resolveTenantId(tenantId);
  const kbId = normalizeKbId(knowledgeBaseId);
  await assertKbType({ tenantId: tid, knowledgeBaseId: kbId, source: 'antibiogram' });

  return runInTenantContext(tid, async () => {
    const counts = emptyCounts();
    const batchId = await openImportBatch({
      tenantId: tid, knowledgeBaseId: kbId, source: 'antibiogram',
      sourceRef: 'antibiogram_90d', dryRun, runBy,
    });
    try {
      let abxRows = [];
      try {
        // Reuse the lab service's suppressed 90-day view read. Generous limit:
        // the view is already per-tenant + small-sample-suppressed.
        abxRows = await antibiogram90d({ tenantId: tid, limit: 5000 });
      } catch (err) {
        if (!isMissingSchemaError(err)) throw err;
        abxRows = [];
      }

      // Group rows by organism for one document per organism.
      const byOrganism = new Map();
      for (const row of abxRows) {
        const key = clean(row.organism_name) || 'unknown';
        if (!byOrganism.has(key)) byOrganism.set(key, []);
        byOrganism.get(key).push(row);
      }

      for (const [organism, rows] of byOrganism) {
        counts.processed += 1;
        const rawText = renderAntibiogramOrganism(organism, rows);
        const outcome = await ingestRendered({
          tenantId: tid, knowledgeBaseId: kbId,
          title: antibiogramTitle(organism), rawText,
          kind: 'antibiogram', source: 'antibiogram_90d', sourceId: organism, dryRun,
        });
        counts[outcome] += 1;
      }

      await closeImportBatch({
        tenantId: tid, batchId,
        status: counts.failed > 0 ? 'partial' : 'completed', counts,
      });
      return counts;
    } catch (err) {
      await closeImportBatch({
        tenantId: tid, batchId, status: 'failed', counts,
        errorDetail: String(err.message || err).slice(0, 1000),
      });
      throw err;
    }
  });
}

/**
 * Import active clinical_protocols rows into the given KB as pending
 * clinical-guideline documents. Returns per-source counts.
 */
export async function importProtocolsToKb({
  tenantId = null,
  knowledgeBaseId,
  dryRun = false,
  runBy = null,
} = {}) {
  const tid = resolveTenantId(tenantId);
  const kbId = normalizeKbId(knowledgeBaseId);
  await assertKbType({ tenantId: tid, knowledgeBaseId: kbId, source: 'protocols' });

  return runInTenantContext(tid, async () => {
    const counts = emptyCounts();
    const batchId = await openImportBatch({
      tenantId: tid, knowledgeBaseId: kbId, source: 'protocols',
      sourceRef: 'clinical_protocols', dryRun, runBy,
    });
    try {
      let rows = [];
      try {
        rows = await prisma.$queryRawUnsafe(
          `SELECT id, name, category, priority, trigger_conditions, recommendations
           FROM clinical_protocols
           WHERE is_active = true
           ORDER BY id ASC`,
        );
      } catch (err) {
        if (!isMissingSchemaError(err)) throw err;
        rows = [];
      }

      for (const row of rows) {
        counts.processed += 1;
        const rawText = renderProtocolRow(row);
        const outcome = await ingestRendered({
          tenantId: tid, knowledgeBaseId: kbId,
          title: protocolTitle(row), rawText,
          kind: 'protocol', source: 'clinical_protocols', sourceId: row.id, dryRun,
        });
        counts[outcome] += 1;
      }

      await closeImportBatch({
        tenantId: tid, batchId,
        status: counts.failed > 0 ? 'partial' : 'completed', counts,
      });
      return counts;
    } catch (err) {
      await closeImportBatch({
        tenantId: tid, batchId, status: 'failed', counts,
        errorDetail: String(err.message || err).slice(0, 1000),
      });
      throw err;
    }
  });
}

/**
 * Convenience dispatcher used by the CLI + refresh cron. Runs one or all
 * sources against their respective KBs. `kbIds` maps source → knowledgeBaseId.
 * Returns { [source]: counts }.
 */
export async function importSource({
  tenantId = null,
  source,
  kbIds = {},
  dryRun = false,
  runBy = null,
} = {}) {
  const normalized = String(source || '').trim().toLowerCase();
  if (!VALID_SOURCES.includes(normalized)) {
    throw AppError.badRequest(`source must be one of: ${VALID_SOURCES.join(', ')}`);
  }
  const sources = normalized === 'all' ? ['formulary', 'antibiogram', 'protocols'] : [normalized];
  const result = {};
  for (const src of sources) {
    const kbId = kbIds[src];
    if (!kbId) {
      throw AppError.badRequest(`knowledgeBaseId for source '${src}' is required (pass kbIds.${src})`);
    }
    if (src === 'formulary') {
      result.formulary = await importFormularyToKb({ tenantId, knowledgeBaseId: kbId, dryRun, runBy });
    } else if (src === 'antibiogram') {
      result.antibiogram = await importAntibiogramToKb({ tenantId, knowledgeBaseId: kbId, dryRun, runBy });
    } else if (src === 'protocols') {
      result.protocols = await importProtocolsToKb({ tenantId, knowledgeBaseId: kbId, dryRun, runBy });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeKbId(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest('knowledgeBaseId must be a positive integer');
  }
  return parsed;
}

// Confirm the target KB exists, belongs to the tenant, and is the expected
// kb_type for the source (a soft check: warn-but-continue on mismatch so an
// operator can deliberately route into a 'general' KB, but block a completely
// missing KB which would 404 every insert).
async function assertKbType({ tenantId, knowledgeBaseId, source }) {
  const kb = await getKnowledgeBase({ tenantId, id: knowledgeBaseId });
  const expected = KB_TYPE_FOR_SOURCE[source];
  if (expected && kb.kb_type !== expected && kb.kb_type !== 'general') {
    logger.warn('knowledge curation import target kb_type mismatch', {
      knowledgeBaseId, expected, actual: kb.kb_type, source,
    });
  }
  return kb;
}

export const __testing__ = {
  VALID_SOURCES,
  KB_TYPE_FOR_SOURCE,
  flattenJsonish,
  sha256,
};

export default {
  importFormularyToKb,
  importAntibiogramToKb,
  importProtocolsToKb,
  importSource,
  renderFormularyRow,
  renderAntibiogramOrganism,
  renderProtocolRow,
};
