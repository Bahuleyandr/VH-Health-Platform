// src/lib/api/migrationToolkit.ts
// Typed client for /api/v1/admin/migration-toolkit (NL11-S1/S9 legacy-data
// migration toolkit). Two-phase contract: REHEARSAL is dry-run only (writes
// nothing outside migration_* toolkit tables, produces a PHI-redacted report);
// COMMIT is a separate explicit call that re-submits the same source files,
// re-validates them, and only then writes authoritative rows under an
// idempotency key. The generated OpenAPI types only expose the generic
// Success envelope for these routes, so the shapes below are hand-written
// against apps/backend/src/services/migrationToolkit/migrationToolkitService.js.

import { getJSON, postJSON, putJSON } from "./core";

/* =========================
 * Enums
 * ========================= */

export const IMPORT_KINDS = [
  "patient",
  "encounter",
  "opening_ar",
  "mixed",
  "hl7_adt",
] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const FILE_KINDS = ["patient", "encounter", "opening_ar"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/* =========================
 * Row shapes
 * ========================= */

export interface MigrationImportJob {
  id: number;
  uid: string;
  tenant_id: string;
  job_name: string;
  source_system: string | null;
  import_kind: ImportKind;
  status: string;
  dry_run_only: boolean;
  authoritative_write_enabled: boolean;
  redaction_mode: string;
  row_counts: Record<string, number> | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  metadata: Record<string, unknown>;
}

export interface MigrationMappingProfile {
  id: number;
  uid: string;
  tenant_id: string;
  profile_name: string;
  source_system: string | null;
  target_kind: FileKind;
  version: number;
  status: string;
  field_map: Record<string, unknown>;
  transform_notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
}

export interface MigrationSourceFile {
  id: number;
  uid: string;
  tenant_id: string;
  job_id: number;
  file_kind: FileKind;
  source_filename: string;
  content_sha256: string;
  mime_type: string;
  byte_size: number;
  row_count: number;
  header_row: string[];
  column_profile: Record<string, unknown>;
  sample_rows_redacted: Array<Record<string, unknown>>;
  storage_contract: Record<string, unknown>;
  created_at: string;
}

export interface MigrationValidationFinding {
  id: number;
  uid: string;
  finding_code: string;
  severity: "info" | "warning" | "error";
  target_kind: FileKind;
  field_name: string | null;
  source_row_number: number | null;
  message_redacted: string;
  remediation_hint: string | null;
  metadata: Record<string, unknown>;
}

export interface RehearsalSummary {
  job_id: number;
  import_kind: ImportKind;
  source_files: Array<{
    id: number;
    file_kind: FileKind;
    source_filename: string;
    content_sha256: string;
    row_count: number;
  }>;
  row_counts: Record<string, number>;
}

export interface RehearsalValidationSummary {
  total: number;
  by_severity: { info: number; warning: number; error: number };
  by_code: Record<string, number>;
}

export interface RehearsalDuplicateSummary {
  duplicate_groups: number;
  duplicate_rows: number;
  existing_patient_candidates: number;
}

export interface RehearsalNoWriteProof {
  dry_run_only: boolean;
  authoritative_write_enabled: boolean;
  authoritative_tables_blocked: string[];
  source_raw_content_persisted: boolean;
  toolkit_tables_written: string[];
}

export interface MigrationRehearsalReport {
  id: number;
  uid: string;
  tenant_id: string;
  job_id: number;
  status: "report_ready" | "blocked" | string;
  phi_redacted: boolean;
  summary: RehearsalSummary;
  validation_summary: RehearsalValidationSummary;
  duplicate_summary: RehearsalDuplicateSummary;
  no_write_proof: RehearsalNoWriteProof;
  generated_by: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface MigrationCommitBatch {
  id: number;
  uid: string;
  tenant_id: string;
  job_id: number;
  status: string;
  idempotency_key: string;
  acceptance_summary: Record<string, unknown> | null;
  opening_balance_totals: Record<string, unknown> | null;
  rollback_plan: Record<string, unknown> | null;
  replay_proof: Record<string, unknown> | null;
  committed_at: string | null;
}

export interface MigrationCommitRecord {
  id: number;
  uid: string;
  tenant_id: string;
  commit_batch_id: number;
  job_id: number;
  import_record_id: number | null;
  target_kind: FileKind;
  source_key: string | null;
  row_hash: string;
  status: string;
  action: string;
  target_table: string | null;
  target_id: string | null;
  target_uid: string | null;
  idempotency_key: string;
  rollback_payload: Record<string, unknown>;
  replay_proof: Record<string, unknown>;
  error_redacted: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface MigrationAcceptanceReport {
  id: number;
  uid: string;
  tenant_id: string;
  job_id: number;
  commit_batch_id: number;
  status: string;
  phi_redacted: boolean;
  report_json: Record<string, unknown>;
  acceptance_summary: {
    total: number;
    by_target_kind: Record<string, number>;
    by_status: Record<string, number>;
    by_action: Record<string, number>;
  };
  opening_balance_totals: Record<string, unknown>;
  rollback_proof: Record<string, unknown>;
  replay_proof: Record<string, unknown>;
  generated_by: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface MigrationHl7AdtBatch {
  id: number;
  uid: string;
  tenant_id: string;
  job_id: number;
  status: string;
  idempotency_key: string;
  summary: Record<string, unknown> | null;
  accepted_count: number | null;
  rejected_count: number | null;
}

/** One inline CSV source file for a rehearsal or commit request. */
export interface MigrationFileInput {
  file_kind: FileKind;
  source_filename: string;
  csv_text: string;
  mime_type?: string;
  mapping_profile_id?: number | null;
  field_map?: Record<string, unknown>;
}

export interface RehearsalResult {
  report: MigrationRehearsalReport;
  files: MigrationSourceFile[];
  findings: MigrationValidationFinding[];
}

export interface CommitResult {
  batch: MigrationCommitBatch;
  report: MigrationAcceptanceReport | null;
  replayed: boolean;
  records: MigrationCommitRecord[];
}

export interface Hl7AdtImportResult extends CommitResult {
  hl7_batch: MigrationHl7AdtBatch;
}

/* =========================
 * Calls
 * ========================= */

const BASE = "/admin/migration-toolkit";

export async function listImportJobs(
  params: { status?: string; import_kind?: string; limit?: number } = {},
) {
  return getJSON<{ jobs: MigrationImportJob[]; count: number }>(
    `${BASE}/jobs`,
    {
      status: params.status,
      import_kind: params.import_kind,
      limit: params.limit,
    },
  );
}

export async function createImportJob(payload: {
  job_name: string;
  source_system?: string | null;
  import_kind?: ImportKind;
  metadata?: Record<string, unknown>;
}) {
  return postJSON<MigrationImportJob>(`${BASE}/jobs`, payload);
}

export async function listMappingProfiles(
  params: { target_kind?: string; status?: string; limit?: number } = {},
) {
  return getJSON<{ profiles: MigrationMappingProfile[]; count: number }>(
    `${BASE}/mapping-profiles`,
    {
      target_kind: params.target_kind,
      status: params.status,
      limit: params.limit,
    },
  );
}

export async function upsertMappingProfile(payload: {
  profile_name: string;
  source_system?: string | null;
  target_kind: FileKind;
  version?: number;
  status?: string;
  field_map?: Record<string, unknown>;
  transform_notes?: string | null;
  metadata?: Record<string, unknown>;
}) {
  return putJSON<MigrationMappingProfile>(`${BASE}/mapping-profiles`, payload);
}

/** Profile a single CSV without rehearsing the whole job. */
export async function profileSourceFile(
  jobId: number,
  payload: {
    file_kind: FileKind;
    source_filename: string;
    csv_text: string;
    mime_type?: string;
  },
) {
  return postJSON<MigrationSourceFile>(
    `${BASE}/jobs/${jobId}/source-files`,
    payload,
  );
}

/**
 * Phase 1 — REHEARSAL. Dry-run only: parses, canonicalizes, validates, and
 * writes a PHI-redacted report to the migration_* toolkit tables. Never
 * touches authoritative tables. Replaces any prior rehearsal rows for the job.
 */
export async function rehearseImportJob(
  jobId: number,
  files: MigrationFileInput[],
) {
  return postJSON<RehearsalResult>(`${BASE}/jobs/${jobId}/rehearsals`, {
    files,
  });
}

/** Latest rehearsal report for a job (404 if none generated yet). */
export async function getRehearsalReport(jobId: number) {
  return getJSON<MigrationRehearsalReport>(`${BASE}/jobs/${jobId}/report`);
}

/**
 * Phase 2 — COMMIT. Re-submits the SAME source files (the backend re-parses
 * and re-validates them; it does not commit previously-rehearsed rows), blocks
 * on any error-severity finding, then writes authoritative rows inside one
 * tenant-scoped transaction. `idempotency_key` is a body field; replaying the
 * same key returns the prior batch + acceptance report with `replayed: true`.
 */
export async function commitImportJob(
  jobId: number,
  payload: { files: MigrationFileInput[]; idempotency_key?: string },
) {
  return postJSON<CommitResult>(`${BASE}/jobs/${jobId}/commits`, payload);
}

/**
 * HL7 ADT batch import. NOTE: single-phase — parsing, validation, and the
 * authoritative commit happen in this one call (guarded by validation blocking
 * and its own idempotency key). There is no separate ADT rehearsal endpoint.
 */
export async function importHl7AdtBatch(
  jobId: number,
  payload: {
    messages: string[];
    source_filename?: string;
    idempotency_key?: string;
  },
) {
  return postJSON<Hl7AdtImportResult>(
    `${BASE}/jobs/${jobId}/hl7-adt-batches`,
    payload,
  );
}

/** Acceptance report for a committed batch. */
export async function getAcceptanceReport(jobId: number, batchId: number) {
  return getJSON<MigrationAcceptanceReport>(
    `${BASE}/jobs/${jobId}/commit-batches/${batchId}/report`,
  );
}
