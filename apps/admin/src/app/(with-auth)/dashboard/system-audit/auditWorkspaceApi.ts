import { getJSON, type QueryParams } from "@/lib/api/core";
import type {
  AuditEvent,
  AuditEventDetail,
  AuditEventsResponse,
  AuditAnomalies,
  AuditHealthResponse,
  AuditHealthSource,
  AuditIntegrityHealth,
  AuditResourceCompleteness,
  HighPatientAccessActor,
  AuditWorkspaceFilters,
} from "./auditTypes";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeEvent(value: unknown): AuditEvent {
  const row = record(value);
  return {
    id: String(row.id ?? ""),
    source: String(row.source ?? "unknown"),
    occurred_at: String(row.occurred_at ?? row.created_at ?? ""),
    recorded_at: nullableString(row.recorded_at),
    actor_uid: nullableString(row.actor_uid),
    actor_user_id: nullableString(row.actor_user_id ?? row.user_id),
    actor_name: nullableString(row.actor_name ?? row.user_name),
    actor_role: nullableString(row.actor_role ?? row.user_role),
    department_id: nullableString(row.department_id),
    patient_uid: nullableString(row.patient_uid),
    patient_id: nullableString(row.patient_id),
    patient_name: nullableString(row.patient_name),
    encounter_id: nullableString(row.encounter_id),
    admission_id: nullableString(row.admission_id),
    action: String(row.action ?? "unknown"),
    outcome: nullableString(row.outcome ?? row.action_status),
    category: nullableString(row.category),
    resource_type: nullableString(row.resource_type ?? row.resource_table),
    resource_id: nullableString(row.resource_id),
    request_id: nullableString(row.request_id),
    device_type: nullableString(row.device_type),
    ip_address: nullableString(row.ip_address),
    integrity_status: nullableString(row.integrity_status),
    summary: nullableString(row.summary),
  };
}

function unwrapPayload(value: unknown): UnknownRecord {
  const root = record(value);
  return Object.keys(record(root.data)).length > 0 ? record(root.data) : root;
}

export function normalizeAuditEventsResponse(value: unknown): AuditEventsResponse {
  const payload = unwrapPayload(value);
  const pagination = record(payload.pagination);
  const rawEvents = Array.isArray(payload.events)
    ? payload.events
    : Array.isArray(payload.logs)
      ? payload.logs
      : [];
  const nextCursor = nullableString(
    pagination.next_cursor ?? payload.next_cursor,
  );
  const limit =
    nullableNumber(pagination.limit ?? payload.limit) ?? Math.max(rawEvents.length, 50);
  const explicitHasMore = pagination.has_more ?? payload.has_more;

  return {
    events: rawEvents.map(normalizeEvent),
    pagination: {
      next_cursor: nextCursor,
      has_more:
        typeof explicitHasMore === "boolean"
          ? explicitHasMore
          : nextCursor !== null,
      limit,
    },
    summary: Object.keys(record(payload.summary)).length > 0
      ? record(payload.summary)
      : null,
  };
}

export function buildAuditQuery(
  filters: AuditWorkspaceFilters,
  cursor?: string,
  limit = 50,
): QueryParams {
  return {
    actor_uid: filters.actor_uid || undefined,
    actor_role: filters.actor_role || undefined,
    patient_uid: filters.patient_uid || undefined,
    department_id: filters.department_id || undefined,
    action: filters.action || undefined,
    resource_type: filters.resource_type || undefined,
    outcome: filters.outcome || undefined,
    encounter_id: filters.encounter_id || undefined,
    admission_id: filters.admission_id || undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
    source: filters.source || undefined,
    cursor,
    limit,
  };
}

export async function listAuditEvents(
  filters: AuditWorkspaceFilters,
  cursor?: string,
): Promise<AuditEventsResponse> {
  const response = await getJSON<unknown>(
    "/api/v1/admin/audit/events",
    buildAuditQuery(filters, cursor),
  );
  return normalizeAuditEventsResponse(response);
}

export async function getAuditEventDetail(
  source: string,
  id: string,
): Promise<AuditEventDetail> {
  const response = await getJSON<unknown>(
    `/api/v1/admin/audit/events/${encodeURIComponent(source)}/${encodeURIComponent(id)}`,
  );
  const payload = unwrapPayload(response);
  const event = record(payload.event);
  const detail = Object.keys(event).length > 0 ? event : payload;
  const normalized = normalizeEvent(detail);
  const redactions = Array.isArray(payload.redactions)
    ? payload.redactions.filter((entry): entry is string => typeof entry === "string")
    : [];

  return {
    ...normalized,
    metadata: Object.keys(record(detail.safe_detail ?? detail.metadata)).length > 0
      ? record(detail.safe_detail ?? detail.metadata)
      : null,
    before_state: Object.keys(record(detail.before_state)).length > 0
      ? record(detail.before_state)
      : null,
    after_state: Object.keys(record(detail.after_state)).length > 0
      ? record(detail.after_state)
      : null,
    redactions,
  };
}

function normalizeHealthSources(value: unknown): AuditHealthSource[] {
  if (Array.isArray(value)) {
    return value.map((item) => {
      const source = record(item);
      return {
        source: String(source.source ?? source.name ?? "unknown"),
        status: nullableString(source.status),
        event_count: nullableNumber(source.event_count ?? source.count),
        last_event_at: nullableString(source.last_event_at ?? source.latest_event_at),
        missing_actor_count: nullableNumber(source.missing_actor_count),
        missing_request_id_count: nullableNumber(source.missing_request_id_count),
      };
    });
  }

  return Object.entries(record(value)).map(([name, item]) => {
    const source = record(item);
    return {
      source: name,
      status: nullableString(source.status),
      event_count: nullableNumber(source.event_count ?? source.count ?? item),
      last_event_at: nullableString(source.last_event_at ?? source.latest_event_at),
      missing_actor_count: nullableNumber(source.missing_actor_count),
      missing_request_id_count: nullableNumber(source.missing_request_id_count),
    };
  });
}

function numberValue(value: unknown, fallback = 0): number {
  return nullableNumber(value) ?? fallback;
}

function normalizeIntegrity(value: unknown): AuditIntegrityHealth | null {
  const integrity = record(value);
  if (Object.keys(integrity).length === 0) return null;
  return {
    total_events: numberValue(integrity.total_events),
    missing_hash_count: numberValue(integrity.missing_hash_count),
    hash_mismatch_count: numberValue(integrity.hash_mismatch_count),
    continuity_break_count: numberValue(integrity.continuity_break_count),
    first_problem_seq: nullableNumber(integrity.first_problem_seq),
    first_problem_id: nullableString(integrity.first_problem_id),
    first_missing_hash_id: nullableString(integrity.first_missing_hash_id),
    intact: integrity.intact === true,
  };
}

function normalizeResourceCompleteness(value: unknown): AuditResourceCompleteness[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const resource = record(entry);
    return {
      resource_table: String(resource.resource_table ?? "unknown"),
      resource_rows: numberValue(resource.resource_rows),
      audited_resource_rows: numberValue(resource.audited_resource_rows),
      orphan_resource_rows: numberValue(resource.orphan_resource_rows),
      audit_event_count: numberValue(resource.audit_event_count),
      dangling_audit_events: numberValue(resource.dangling_audit_events),
      coverage_percent: nullableNumber(resource.coverage_percent),
    };
  });
}

function normalizeHighPatientActors(value: unknown): HighPatientAccessActor[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const actor = record(entry);
    return {
      actor_uid: String(actor.actor_uid ?? "unknown"),
      actor_role: nullableString(actor.actor_role),
      distinct_patient_count: numberValue(actor.distinct_patient_count),
      access_event_count: numberValue(actor.access_event_count),
    };
  });
}

function normalizeAnomalies(value: unknown): AuditAnomalies | null {
  const anomalies = record(value);
  if (Object.keys(anomalies).length === 0) return null;
  return {
    denied_attempts: numberValue(anomalies.denied_attempts),
    break_glass_accesses: numberValue(anomalies.break_glass_accesses),
    after_hours_accesses: numberValue(anomalies.after_hours_accesses),
    audit_exports: numberValue(anomalies.audit_exports),
    after_hours_timezone: String(anomalies.after_hours_timezone ?? "Asia/Kolkata"),
    after_hours_window: String(anomalies.after_hours_window ?? "20:00-07:00"),
    high_patient_access_threshold: numberValue(anomalies.high_patient_access_threshold, 20),
    high_patient_access_actors: numberValue(anomalies.high_patient_access_actors),
    high_patient_access_actor_details: normalizeHighPatientActors(
      anomalies.high_patient_access_actor_details,
    ),
  };
}

export function normalizeAuditHealthResponse(value: unknown): AuditHealthResponse {
  const payload = unwrapPayload(value);
  return {
    generated_at: nullableString(payload.generated_at),
    window: Object.keys(record(payload.window)).length > 0
      ? record(payload.window)
      : null,
    sources: normalizeHealthSources(payload.sources),
    completeness: Object.keys(record(payload.completeness)).length > 0
      ? record(payload.completeness)
      : null,
    canonical_write_coverage:
      typeof payload.canonical_write_coverage === "number"
        ? payload.canonical_write_coverage
        : Object.keys(record(payload.canonical_write_coverage)).length > 0
          ? record(payload.canonical_write_coverage)
          : null,
    total_events: nullableNumber(payload.total_events),
    integrity: normalizeIntegrity(payload.integrity),
    resource_completeness: normalizeResourceCompleteness(payload.resource_completeness),
    anomalies: normalizeAnomalies(payload.anomalies),
  };
}

export async function getAuditHealth(): Promise<AuditHealthResponse> {
  const response = await getJSON<unknown>("/api/v1/admin/audit/health");
  return normalizeAuditHealthResponse(response);
}

export async function exportAuditEvents(
  filters: AuditWorkspaceFilters,
): Promise<string> {
  const response = await getJSON<unknown>(
    "/api/v1/admin/audit/export",
    buildAuditQuery(filters, undefined, 500),
  );
  if (typeof response === "string") return response;
  const payload = unwrapPayload(response);
  if (typeof payload.csv === "string") return payload.csv;
  throw new Error("Audit export did not return CSV data");
}
