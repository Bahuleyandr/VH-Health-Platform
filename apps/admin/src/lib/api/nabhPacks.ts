// src/lib/api/nabhPacks.ts
// NABH accreditation indicator packs (backend:
// apps/backend/src/routes/quality/nabhRoutes.js, mounted at
// /api/v1/quality/nabh).
//
// Contract notes:
// - GET /indicators and both /period-pack verbs REQUIRE from+to (400
//   NABH_PERIOD_REQUIRED; inverted range -> NABH_PERIOD_INVERTED).
// - GET /period-pack 404s with NABH_PERIOD_PACK_NOT_FROZEN until
//   POST /period-pack has frozen that exact from/to pair — the UI treats
//   that as an informational empty state, not an error.
// - Access is further gated in-route to admin/leadership/quality roles;
//   other clinical staff receive 403.

import { apiFetch } from "../api-fetch";
import { getJSON, postJSON } from "./core";

export interface NabhIndicatorDefinition {
  chapter?: string;
  source_tables?: string[];
  numerator?: string | null;
  denominator?: string | null;
  assessor_note?: string | null;
}

export interface NabhIndicator {
  code: string;
  label: string;
  unit: string | null;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  available: boolean;
  definition?: NabhIndicatorDefinition;
  details: Record<string, unknown>;
  computed_at?: string;
}

export interface NabhExportContract {
  pack_type: string;
  canonical_format_status: string;
  evidence_control_code: string;
  supported_formats: string[];
  phi_policy: string;
  acceptance_boundary: string;
}

/** Live computation result from GET /quality/nabh/indicators. */
export interface NabhIndicatorPack {
  period: { from: string; to: string };
  export_contract: NabhExportContract;
  indicator_dictionary: Record<string, NabhIndicatorDefinition>;
  indicators: NabhIndicator[];
}

/** Frozen pack from POST/GET /quality/nabh/period-pack. */
export interface NabhFrozenPeriodPack extends NabhIndicatorPack {
  pack_type: string;
  status: string;
  tenant_id: string;
  frozen_at: string | null;
  generated_at: string;
  evidence_attachment: {
    control_code: string;
    status: string;
    evidence_table: string;
    attach_files: string[];
    note: string;
  };
  indicator_count: number;
  expected_indicator_count: number;
  missing_indicator_codes: string[];
  /** Present on the POST (freeze) response only. */
  snapshot_saved?: number;
}

export interface NabhSnapshotRow {
  period_start: string;
  period_end: string;
  indicator_code: string;
  label: string;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  unit: string | null;
  details: Record<string, unknown>;
  computed_at: string;
}

export interface NabhSnapshotList {
  snapshots: NabhSnapshotRow[];
  count: number;
}

export interface NabhPeriod {
  from: string;
  to: string;
}

export function getNabhIndicators(period: NabhPeriod) {
  return getJSON<NabhIndicatorPack>("/quality/nabh/indicators", {
    from: period.from,
    to: period.to,
  });
}

/** Freeze (snapshot + return) the assessor pack for a period. Upserts per indicator. */
export function freezeNabhPeriodPack(period: NabhPeriod) {
  return postJSON<NabhFrozenPeriodPack>("/quality/nabh/period-pack", period);
}

export function getFrozenNabhPeriodPack(period: NabhPeriod) {
  return getJSON<NabhFrozenPeriodPack>("/quality/nabh/period-pack", {
    from: period.from,
    to: period.to,
  });
}

/** Persist an indicator snapshot without the frozen-pack read-back. */
export function saveNabhSnapshot(period: NabhPeriod) {
  return postJSON<NabhIndicatorPack & { snapshot_saved: number }>(
    "/quality/nabh/snapshots",
    period,
  );
}

export function listNabhSnapshots(params: { from?: string; to?: string } = {}) {
  return getJSON<NabhSnapshotList>("/quality/nabh/snapshots", {
    from: params.from || undefined,
    to: params.to || undefined,
  });
}

async function downloadBlob(endpoint: string, filename: string) {
  const res = await apiFetch(endpoint);
  if (!res.ok) {
    throw new Error(`Export failed with HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Download the frozen period pack in the assessor CSV or PDF format. */
export function downloadNabhPeriodPack(
  period: NabhPeriod,
  format: "csv" | "pdf",
) {
  const search = new URLSearchParams({
    from: period.from,
    to: period.to,
    format,
  });
  return downloadBlob(
    `/api/v1/quality/nabh/period-pack?${search.toString()}`,
    `nabh-period-pack-${period.from}-${period.to}.${format}`,
  );
}

/** Download the live (unfrozen) indicator computation as CSV. */
export function downloadNabhIndicatorsCsv(period: NabhPeriod) {
  const search = new URLSearchParams({
    from: period.from,
    to: period.to,
    format: "csv",
  });
  return downloadBlob(
    `/api/v1/quality/nabh/indicators?${search.toString()}`,
    `nabh-indicators-${period.from}-${period.to}.csv`,
  );
}
