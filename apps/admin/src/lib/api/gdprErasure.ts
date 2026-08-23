// src/lib/api/gdprErasure.ts
// GDPR data erasure (right to be forgotten) console API.
//
// Backend: apps/backend/src/routes/gdprRoutes.js, mounted at
// /api/v1/gdpr (NOT under /admin — but both routes are admin-gated via
// requireRole(...ADMIN_ROUTE_ROLES)). The generated OpenAPI spec types
// these operations only as the generic `Success` envelope, so payloads
// are hand-typed against the route + dataErasureService.js.
//
// Surface notes (verified against the routes):
// - POST /gdpr/erase body { uid?, phone?, reason } — uid or phone is
//   required, reason is ALWAYS required (400 otherwise). An active
//   legal hold returns 403 with details.code = LEGAL_HOLD_ACTIVE and
//   the human message in the envelope.
// - GET /gdpr/erasure-log?limit=&offset= — data is a BARE ARRAY of log
//   rows (no {logs,count} wrapper). limit clamps to 1..100, default 20.
//   Rows are tenant-filtered via an EXISTS against users.uid, so
//   erasures whose user row was hard-deleted (and phone-only erasures,
//   which store uid = NULL) do not appear in the listing.

import { APIError, getJSON, postJSON } from "./core";

export const LEGAL_HOLD_ACTIVE = "LEGAL_HOLD_ACTIVE";

export interface ErasureLogRow {
  id: number;
  uid: string | null;
  phone_hash: string | null;
  requested_by: string | null;
  reason: string;
  tables_processed: number | null;
  completed_at: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface ErasureTableOutcome {
  action: string; // 'deleted' | 'anonymized'
  count: number;
}

export interface ErasureResult {
  success: boolean;
  uid: string | null;
  erasedAt: string;
  duration_ms: number;
  tables: Record<string, ErasureTableOutcome>;
}

export interface ExecuteErasurePayload {
  uid?: string;
  phone?: string;
  reason: string;
}

export async function getErasureLog(
  params: { limit?: number; offset?: number } = {},
) {
  const query: Record<string, number> = {};
  if (params.limit !== undefined) query.limit = params.limit;
  if (params.offset !== undefined) query.offset = params.offset;
  return getJSON<ErasureLogRow[]>("/gdpr/erasure-log", query);
}

/** Execute a GDPR erasure. Destructive and irreversible — the caller
 * UI must run its own explicit confirmation before invoking this. */
export async function executeErasure(payload: ExecuteErasurePayload) {
  return postJSON<ErasureResult>("/gdpr/erase", payload);
}

/* =========================
 * Error unwrapping
 * ========================= */

export interface GdprApiErrorInfo {
  message: string;
  code: string | null;
  requestId: string | null;
  status: number | null;
}

/**
 * Pull the backend envelope message/code out of an APIError. core.ts
 * collapses 403s to the literal "Forbidden", but the legal-hold refusal
 * puts its human message in the envelope and its code under
 * details.code — surface both verbatim.
 */
export function describeGdprApiError(err: unknown): GdprApiErrorInfo {
  if (err instanceof APIError) {
    const payload = (err.data ?? null) as {
      message?: unknown;
      requestId?: unknown;
      code?: unknown;
      details?: { code?: unknown } | null;
    } | null;
    const message =
      typeof payload?.message === "string" && payload.message
        ? payload.message
        : err.message;
    const code =
      typeof payload?.code === "string"
        ? payload.code
        : typeof payload?.details?.code === "string"
          ? payload.details.code
          : null;
    const requestId =
      typeof payload?.requestId === "string" ? payload.requestId : null;
    return { message, code, requestId, status: err.status };
  }
  return {
    message: err instanceof Error ? err.message : "Request failed",
    code: null,
    requestId: null,
    status: null,
  };
}

export function isLegalHoldError(err: unknown): boolean {
  return describeGdprApiError(err).code === LEGAL_HOLD_ACTIVE;
}
