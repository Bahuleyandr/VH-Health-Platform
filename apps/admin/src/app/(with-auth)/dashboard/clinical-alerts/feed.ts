export const CLINICAL_ALERTS_CHANNEL = "staff:clinical-alerts";
export const CODE_BLUE_CHANNEL = "staff:code-blue";
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
  at: string;
};

// Stable de-dup key: prefer the DB id (history rows); live WS events have no
// id, so fall back to a patient|vital|at composite.
export function alertKey(a: AlertItem): string {
  return a.id != null ? `id:${a.id}` : `live:${a.patientId}|${a.vitalName}|${a.at}`;
}

export function codeBlueKey(c: CodeBlueItem): string {
  return `${c.patientId}|${c.at}`;
}

// Merge live (newest, first-seen wins) ahead of history, dedupe by alertKey,
// sort by `at` descending, cap at ALERT_FEED_CAP.
export function mergeAlerts(history: AlertItem[], live: AlertItem[]): AlertItem[] {
  const byKey = new Map<string, AlertItem>();
  for (const a of [...live, ...history]) {
    const k = alertKey(a);
    if (!byKey.has(k)) byKey.set(k, a);
  }
  return [...byKey.values()]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, ALERT_FEED_CAP);
}
