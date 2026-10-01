// Case-directory access is independent of instrument-set write authorization.
// Theatre warnings remain served by the theatre page's existing schedule contract.

import { fetchAdminAPI } from "@/lib/api";
import { z } from "zod";

/** Mirror of SET_STATUSES in apps/backend/src/services/cssd/cssdService.js. */
export const CSSD_SET_STATUSES = [
  "available",
  "issued",
  "in_theatre",
  "returned",
  "decontamination",
  "sterilization_pending",
  "sterilized",
  "unusable",
  "retired",
] as const;

/** Mirror of LOAD_STATUSES. */
export const CSSD_LOAD_STATUSES = [
  "planned",
  "running",
  "completed",
  "passed",
  "failed",
  "cancelled",
] as const;

/** Mirror of LOAD_CYCLE_TYPES. */
export const CSSD_CYCLE_TYPES = [
  "steam",
  "eto",
  "plasma",
  "dry_heat",
  "chemical",
  "other",
] as const;

/** Mirror of INDICATOR_RESULTS. */
export const CSSD_INDICATOR_RESULTS = [
  "not_required",
  "pending",
  "passed",
  "failed",
] as const;

/** Mirror of RETURN_CONDITIONS. */
export const CSSD_RETURN_CONDITIONS = [
  "intact",
  "missing_item",
  "damaged",
  "contaminated",
] as const;

export type CssdIndicatorResult = (typeof CSSD_INDICATOR_RESULTS)[number];

/**
 * Mirror of ISSUE_TRANSITIONS in cssdService.js. transitionIssue() throws
 * AppError.invalidTransition for anything not listed, so offering a control for
 * an unlisted transition would be a button that can only ever 409. Pinned
 * against the backend source by
 * src/__tests__/dashboard/cssd/transition-contract.test.ts.
 */
export const CSSD_ISSUE_TRANSITIONS: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  issued: ["in_theatre", "returned", "cancelled"],
  in_theatre: ["returned"],
  returned: ["awaiting_sterilization"],
  awaiting_sterilization: [],
  sterilized: [],
  sterilization_failed: [],
  cancelled: [],
});

/** The route each issue transition is reached through (cssdRoutes.js). */
export const CSSD_ISSUE_TRANSITION_ACTIONS: Readonly<
  Record<
    string,
    {
      label: string;
      run: (id: number, body: CssdIssuePatch) => Promise<CssdIssue>;
    }
  >
> = Object.freeze({
  in_theatre: {
    label: "Mark in theatre",
    run: (id, body) => markCssdTheatreUse(id, body),
  },
  returned: {
    label: "Record return",
    run: (id, body) => returnCssdIssue(id, body),
  },
  awaiting_sterilization: {
    label: "Mark decontaminated",
    run: (id, body) => decontaminateCssdIssue(id, body),
  },
  cancelled: {
    label: "Cancel issue",
    run: (id, body) => cancelCssdIssue(id, body),
  },
});

export function cssdIssueTransitions(status?: string): readonly string[] {
  return CSSD_ISSUE_TRANSITIONS[String(status || "").toLowerCase()] ?? [];
}

export type CssdSetContent = {
  item_code?: string | null;
  name: string;
  quantity: number;
  category?: string | null;
  critical?: boolean;
};

export type CssdInstrumentSet = {
  id: number;
  set_code: string;
  barcode: string;
  display_name: string;
  set_type?: string | null;
  specialty?: string | null;
  storage_location?: string | null;
  contents?: CssdSetContent[] | null;
  status: string;
  usable: boolean;
  requires_reprocessing: boolean;
  last_sterilized_at?: string | null;
  last_issued_at?: string | null;
  last_returned_at?: string | null;
  last_passed_load_id?: number | null;
  notes?: string | null;
  updated_at?: string;
};

export type CssdSetLabel = {
  instrument_set_id: number;
  set_code: string;
  display_name: string;
  barcode: string;
  barcode_symbology: string;
  svg: string;
  generated_at: string;
};

export type CssdLoad = {
  id: number;
  load_code: string;
  status: string;
  cycle_type?: string;
  sterilizer_name?: string | null;
  biological_indicator_result?: string;
  chemical_indicator_result?: string;
  mechanical_indicator_result?: string;
  failure_reason?: string | null;
  set_ids?: number[] | null;
  started_at?: string | null;
  completed_at?: string | null;
  released_at?: string | null;
  created_at?: string;
};

export type CssdIssue = {
  id: number;
  issue_code: string;
  status: string;
  instrument_set_id: number;
  ot_schedule_id: number;
  set_code?: string;
  set_name?: string;
  procedure_name?: string;
  ot_room?: string;
  scheduled_date?: string;
  issued_at?: string | null;
  return_due_at?: string | null;
  return_condition?: string | null;
  issue_warning_codes?: string[];
};

export type CssdBoard = {
  summary: {
    total_sets?: number;
    available_sets?: number;
    sets_in_circulation?: number;
    sets_requiring_reprocessing?: number;
    open_loads?: number;
    failed_loads?: number;
    overdue_returns?: number;
  };
  active_issues: CssdIssue[];
  recent_loads: CssdLoad[];
};

export type CssdIssuePatch = {
  return_condition?: string;
  contamination_notes?: string;
  notes?: string;
};

export type OtScheduleOption = {
  id: number;
  scheduled_date: string;
  scheduled_time: string | null;
};

export function getCssdBoard(params?: { limit?: number }) {
  const query = new URLSearchParams();
  if (params?.limit) query.set("limit", String(params.limit));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return fetchAdminAPI<CssdBoard>(`/cssd/board${suffix}`);
}

export function listInstrumentSets(params?: {
  status?: string;
  usable?: boolean;
  q?: string;
  limit?: number;
}) {
  const query = new URLSearchParams();
  if (params?.status) query.set("status", params.status);
  if (params?.usable !== undefined) query.set("usable", String(params.usable));
  if (params?.q) query.set("q", params.q);
  if (params?.limit) query.set("limit", String(params.limit));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return fetchAdminAPI<CssdInstrumentSet[]>(`/cssd/sets${suffix}`);
}

/**
 * POST /cssd/sets. `barcode` is deliberately not exposed: the service accepts a
 * caller-supplied one verbatim, while a derived one is filtered to the Code 39
 * charset — and GET /sets/{id}/label throws on anything code39Runs() cannot
 * encode. Letting the backend derive it from set_code keeps every set
 * printable.
 */
export function createInstrumentSet(body: {
  set_code?: string;
  display_name: string;
  set_type?: string;
  specialty?: string;
  storage_location?: string;
  contents?: CssdSetContent[];
  notes?: string;
}) {
  return fetchAdminAPI<CssdInstrumentSet>("/cssd/sets", {
    method: "POST",
    body,
  });
}

/** GET /cssd/sets/{id}/label — also stamps label_printed_at on the set. */
export function getInstrumentSetLabel(id: number) {
  return fetchAdminAPI<CssdSetLabel>(`/cssd/sets/${id}/label`);
}

export function listSterilizationLoads(params?: {
  status?: string;
  limit?: number;
}) {
  const query = new URLSearchParams();
  if (params?.status) query.set("status", params.status);
  if (params?.limit) query.set("limit", String(params.limit));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return fetchAdminAPI<CssdLoad[]>(`/cssd/loads${suffix}`);
}

export function createSterilizationLoad(body: {
  load_code?: string;
  set_ids: number[];
  cycle_type: string;
  sterilizer_name?: string;
  started_at?: string;
  completed_at?: string;
  biological_indicator_result?: CssdIndicatorResult;
  chemical_indicator_result?: CssdIndicatorResult;
  mechanical_indicator_result?: CssdIndicatorResult;
  failure_reason?: string;
  notes?: string;
}) {
  return fetchAdminAPI<CssdLoad & { affected_set_ids: number[] }>(
    "/cssd/loads",
    {
      method: "POST",
      body,
    },
  );
}

export function transitionSterilizationLoad(
  id: number,
  body: {
    status?: string;
    biological_indicator_result?: CssdIndicatorResult;
    chemical_indicator_result?: CssdIndicatorResult;
    mechanical_indicator_result?: CssdIndicatorResult;
    completed_at?: string;
    failure_reason?: string;
    notes?: string;
  },
) {
  return fetchAdminAPI<CssdLoad & { affected_set_ids: number[] }>(
    `/cssd/loads/${id}/status`,
    { method: "PATCH", body },
  );
}

export function listCssdIssues(params?: {
  ot_schedule_id?: number;
  status?: string;
  limit?: number;
}) {
  const query = new URLSearchParams();
  if (params?.ot_schedule_id)
    query.set("ot_schedule_id", String(params.ot_schedule_id));
  if (params?.status) query.set("status", params.status);
  if (params?.limit) query.set("limit", String(params.limit));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return fetchAdminAPI<CssdIssue[]>(`/cssd/issues${suffix}`);
}

export function issueInstrumentSet(body: {
  instrument_set_id: number;
  ot_schedule_id: number;
  return_due_at?: string;
  notes?: string;
}) {
  return fetchAdminAPI<
    CssdIssue & { warnings?: { code: string; message: string }[] }
  >("/cssd/issues", { method: "POST", body });
}

export function markCssdTheatreUse(id: number, body: CssdIssuePatch = {}) {
  return fetchAdminAPI<CssdIssue>(`/cssd/issues/${id}/theatre-use`, {
    method: "POST",
    body,
  });
}

export function returnCssdIssue(id: number, body: CssdIssuePatch = {}) {
  return fetchAdminAPI<CssdIssue>(`/cssd/issues/${id}/return`, {
    method: "POST",
    body,
  });
}

export function decontaminateCssdIssue(id: number, body: CssdIssuePatch = {}) {
  return fetchAdminAPI<CssdIssue>(`/cssd/issues/${id}/decontaminate`, {
    method: "POST",
    body,
  });
}

export function cancelCssdIssue(id: number, body: CssdIssuePatch = {}) {
  return fetchAdminAPI<CssdIssue>(`/cssd/issues/${id}/cancel`, {
    method: "POST",
    body,
  });
}

const theatrePageSchema = z.object({
  items: z.array(z.object({
    id: z.number().int().positive(),
    scheduled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    scheduled_time: z.string().regex(/^(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?|24:00:00)$/).nullable(),
  }).strict()).max(200),
  next_cursor: z.string().min(1).max(2048).nullable(),
}).strict();

export type CssdTheatrePage = z.infer<typeof theatrePageSchema>;

export async function listOtSchedulesForDate(
  date: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<CssdTheatrePage> {
  signal?.throwIfAborted();
  const query = new URLSearchParams({ date });
  if (cursor) query.set("cursor", cursor);
  const payload = await fetchAdminAPI<unknown>(`/cssd/theatre-options?${query}`);
  signal?.throwIfAborted();
  const parsed = theatrePageSchema.safeParse(payload);
  if (!parsed.success || parsed.data.items.some(item => item.scheduled_date !== date)) {
    throw new Error("Could not read the case directory");
  }
  return parsed.data;
}
