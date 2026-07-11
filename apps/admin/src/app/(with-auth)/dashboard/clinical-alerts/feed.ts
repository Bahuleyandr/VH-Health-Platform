export const CLINICAL_ALERTS_CHANNEL = "staff:clinical-alerts";
export const CODE_BLUE_CHANNEL = "staff:code-blue";
export const CODE_STEMI_CHANNEL = "staff:code-stemi";
export const ALERT_FEED_CAP = 200;
export const CODE_BLUE_WINDOW_MS = 15 * 60 * 1000;

export type AlertItem = {
  kind: "vital-anomaly";
  id?: number;
  patientId: string | null;
  vitalName: string | null;
  value: number | null;
  unit: string | null;
  severity: string | null;
  message: string | null;
  acknowledged?: boolean;
  at: string;
};

export type CodeBlueItem = {
  kind: "code-blue";
  patientId: string | null;
  bedNumber: string | null;
  ward: string | null;
  triggeredBy: string | null;
  reason: string | null;
  eventId?: number | null;
  at: string;
};

// Persisted resuscitation event (NL-14 P2) — the durable source of truth the
// dashboard hydrates on load/reconnect. Unlike the live-only banner, these
// rows keep ward/bed/reason context.
export type ResusEventItem = {
  id: number;
  patient_uid: string | null;
  event_kind: string | null;
  trigger_source: string | null;
  ward_snapshot: string | null;
  bed_snapshot: string | null;
  reason: string | null;
  is_drill?: boolean;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  status: string | null;
};

export type StemiSlaInstance = {
  id: string | number;
  rule_code: string;
  status: string;
  started_at?: string | null;
  due_at?: string | null;
  completed_at?: string | null;
  targets_pending?: boolean;
  metadata?: {
    targets_pending?: boolean;
    clock_start_pending?: boolean;
    [key: string]: unknown;
  } | null;
};

export type StemiActivationItem = {
  id: string | number;
  patient_uid: string | null;
  activation_source: string | null;
  status: string;
  activated_at: string;
  door_time_at?: string | null;
  ecg_at?: string | null;
  cath_case_id?: string | number | null;
  targets_pending?: boolean;
  sla_instances: StemiSlaInstance[];
};

export type StemiActivationPayload = {
  activations: StemiActivationItem[];
  count?: number;
};

export const REQUIRED_STEMI_SLA_RULE_CODES = [
  "stemi_door_to_ecg",
  "stemi_door_to_lab",
  "stemi_door_to_balloon",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasIdentifier(value: unknown): boolean {
  return (
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.trim().length > 0)
  );
}

export function validateStemiActivationPayload(
  value: unknown,
): StemiActivationPayload {
  if (!isRecord(value) || !Array.isArray(value.activations)) {
    throw new Error("Invalid Code STEMI activation payload");
  }

  for (const activation of value.activations) {
    if (
      !isRecord(activation) ||
      !hasIdentifier(activation.id) ||
      typeof activation.status !== "string" ||
      typeof activation.activated_at !== "string" ||
      !Array.isArray(activation.sla_instances)
    ) {
      throw new Error("Invalid Code STEMI activation row");
    }

    const ruleCounts = new Map<string, number>();
    for (const sla of activation.sla_instances) {
      if (
        !isRecord(sla) ||
        !hasIdentifier(sla.id) ||
        typeof sla.rule_code !== "string" ||
        typeof sla.status !== "string"
      ) {
        throw new Error("Invalid Code STEMI SLA row");
      }
      ruleCounts.set(sla.rule_code, (ruleCounts.get(sla.rule_code) ?? 0) + 1);
    }

    if (
      activation.sla_instances.length !==
        REQUIRED_STEMI_SLA_RULE_CODES.length ||
      REQUIRED_STEMI_SLA_RULE_CODES.some(
        (ruleCode) => ruleCounts.get(ruleCode) !== 1,
      )
    ) {
      throw new Error("Incomplete Code STEMI SLA clock set");
    }
  }

  return value as StemiActivationPayload;
}

export function stemiTimerName(ruleCode: string): string {
  if (ruleCode === "stemi_door_to_ecg") return "Door-to-ECG";
  if (ruleCode === "stemi_door_to_lab") return "Door-to-lab";
  if (ruleCode === "stemi_door_to_balloon") return "Door-to-balloon";
  return ruleCode.replaceAll("_", " ");
}

export function stemiSlaTargetPending(sla: StemiSlaInstance): boolean {
  return (
    sla.targets_pending === true ||
    sla.metadata?.targets_pending === true ||
    sla.status === "targets_pending"
  );
}

export function stemiSlaClockStartPending(sla: StemiSlaInstance): boolean {
  return sla.metadata?.clock_start_pending === true;
}

export function resusEventKey(e: ResusEventItem): string {
  return `resus:${e.id}`;
}

// Stable de-dup key: prefer the DB id (history rows); live WS events have no
// id, so fall back to a patient|vital|at composite.
export function alertKey(a: AlertItem): string {
  return a.id != null
    ? `id:${a.id}`
    : `live:${a.patientId}|${a.vitalName}|${a.at}`;
}

export function codeBlueKey(c: CodeBlueItem): string {
  return `${c.patientId}|${c.at}`;
}

// Merge live (newest, first-seen wins) ahead of history, dedupe by alertKey,
// sort by `at` descending, cap at ALERT_FEED_CAP.
export function mergeAlerts(
  history: AlertItem[],
  live: AlertItem[],
): AlertItem[] {
  const byKey = new Map<string, AlertItem>();
  for (const a of [...live, ...history]) {
    const k = alertKey(a);
    if (!byKey.has(k)) byKey.set(k, a);
  }
  return [...byKey.values()]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, ALERT_FEED_CAP);
}
