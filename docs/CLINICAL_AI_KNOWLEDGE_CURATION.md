# Clinical-AI Knowledge Curation

**Workstream:** WS5 B5.5 — clinical-AI knowledge layer: formulary / antibiogram /
protocol import + curation + refresh.

This document records what the curated clinical-AI knowledge corpus contains,
where it comes from, **who signs it off**, how often it refreshes, and the
decision-support-only stance that governs it.

> **Decision support only.** Curated knowledge is retrieved to *augment* a
> clinical-AI prompt (RAG). It is **never** the authority of record. Every
> retrieved chunk traces back to a document + source row so a reviewer can
> verify it, and nothing here auto-prescribes, auto-orders, or overrides a
> clinician.

## Sources (all hospital-owned, in-our-control)

| Source | System of record | KB type | Imported by |
|---|---|---|---|
| **Formulary** | `pharmacy_catalog` (active rows; loaded by `scripts/import-hospital-medicine-list.mjs`) | `formulary` | `importFormularyToKb` |
| **Antibiogram** | `antibiogram_90d` view (rolling 90-day susceptibility, small-sample-suppressed; read via `microbiologyService.antibiogram90d`) | `antibiotic_policy` | `importAntibiogramToKb` |
| **Clinical protocols** | `clinical_protocols` table (seeded by the protocol owner) | `clinical_guideline` | `importProtocolsToKb` |

All three are owned by the hospital and live in our own database — this is **not**
a licensed third-party knowledge base. (Contrast the drug KB in migration 277,
whose licensed import is an owner-side procurement action.)

## The pipeline

```
source row  →  render to compact text  →  SHA-256 file_hash (dedup)  →
  createInlineDocument(source_type='imported', curation_status='pending')  →
    chunk + embed (ragService, Ollama 768-dim; degrades to 'embed_unavailable')  →
      knowledge_chunks (pgvector)
```

* **Bridge service:** `src/services/ai/knowledgeCurationService.js`
  (`importFormularyToKb` / `importAntibiogramToKb` / `importProtocolsToKb` /
  `importSource`). Returns per-source `{ processed, inserted, skipped, failed }`.
* **CLI:** `scripts/knowledge-curation-import.mjs`
  (`--source formulary|antibiogram|protocols|all --tenant <uuid> [--kb <id>] [--dry-run]`).
  Uses `DATABASE_URL`. `--dry-run` renders + dedup-probes + counts without writing.
* **Provenance:** every run writes a `knowledge_import_batches` row
  (tenant-scoped, RLS) with source, row counts, status, and `dry_run`.
* **Idempotent:** a document's `file_hash` is the SHA-256 of its rendered text
  (reusing `idx_knowledge_documents_tenant_hash`). A re-run skips any row whose
  rendered content is unchanged, so re-importing is cheap and safe.
* **Graceful degradation:** when the Ollama embedder is down, documents are
  still inserted (`curation_status='pending'`) and chunking degrades to
  `embed_unavailable`. Re-run, or call the document reindex endpoint, once the
  embedder is back to produce embeddings.

## Curation sign-off — who owns it

Imported documents land **`curation_status='pending'`** and are **dark to
retrieval** (`knowledgeRetrievalService` filters `curation_status='approved'`)
until a human domain owner signs them off. Manual inline/upload documents keep
the column default `'approved'` so existing behaviour is unchanged.

| Source | Sign-off owner |
|---|---|
| Formulary | **Pharmacy** (chief pharmacist / formulary committee) |
| Antibiogram | **Microbiology + Infection Control** (antimicrobial stewardship lead) |
| Clinical protocols | The **protocol owner** (e.g. medical director / specialty lead for that protocol) |

Sign-off endpoint (mirrors the `decide*` curation pattern):

```
PATCH /knowledge-bases/:id/documents/:documentId/curation
  { "decision": "approved" | "rejected", "note": "..." }
```

Backed by `decideKnowledgeDocument({ documentId, decision, reviewerUid, note })`,
which stamps `reviewed_by` / `reviewed_at` and writes a
`CLINICAL_AI_KNOWLEDGE_DOCUMENT_CURATED` clinical-AI audit row. The pending
queue is `GET /knowledge-bases/:id/documents?curation_status=pending`.

* **Approve** → the document becomes retrievable.
* **Reject** → the document stays suppressed (kept for audit, never retrieved).

## Refresh cadence

* **Weekly** — `knowledge-corpus-refresh` cron in `src/utils/scheduler.js`
  (default `15 3 * * 1` = Monday 03:15; override with
  `KNOWLEDGE_CORPUS_REFRESH_CRON`). It loops active tenants, auto-discovers each
  tenant's active KB per source by `kb_type`, and re-runs the imports.
* The **antibiogram** is the driver for the weekly cadence: it is a rolling
  90-day window, so weekly refresh keeps the curated susceptibility summaries
  current. New/changed rows are re-imported as **pending** — the refresh
  **never auto-approves**; the stewardship/pharmacy owner re-signs.

## Starter dataset

Migration `311_knowledge_curation.sql` seeds a small, **clearly-flagged sample**
(`metadata.is_starter = true`, `metadata.sample = true`) under the default
tenant: a "Sample Formulary (starter)" KB and a "Sample Antibiogram Policy
(starter)" KB, each with one sample document. This makes the import/curation
pipeline demonstrable green in CI without the pilot hospital's live data
(analogous to migration 277's drug-KB starter and the B4.5 ICD-11 starter).
Replace it with a real import once the hospital's `pharmacy_catalog` /
microbiology data is loaded.

## Schema (migration 311)

* `knowledge_documents.curation_status` (`pending` | `approved` | `rejected`,
  default `approved`), `reviewed_by`, `reviewed_at`.
* `knowledge_import_batches` — tenant-scoped (RLS) import-run provenance,
  mirroring `terminology_import_batches`.
