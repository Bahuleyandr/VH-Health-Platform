import {
  mergeAlerts, alertKey, codeBlueKey, ALERT_FEED_CAP,
  type AlertItem, type CodeBlueItem,
} from "@/app/(with-auth)/dashboard/clinical-alerts/feed";

function alert(p: Partial<AlertItem> & { at: string }): AlertItem {
  return {
    kind: "vital-anomaly", patientId: "1", vitalName: "HR", value: 190,
    unit: null, severity: "CRITICAL", message: "m", at: p.at, ...p,
  };
}

describe("mergeAlerts", () => {
  it("sorts newest-first across history + live", () => {
    const history = [alert({ id: 1, at: "2026-06-29T10:00:00.000Z" })];
    const live = [alert({ at: "2026-06-29T10:05:00.000Z" })];
    expect(mergeAlerts(history, live).map((a) => a.at)).toEqual([
      "2026-06-29T10:05:00.000Z", "2026-06-29T10:00:00.000Z",
    ]);
  });

  it("dedupes a history row by DB id (live copy of the same id wins, once)", () => {
    const history = [alert({ id: 5, at: "2026-06-29T10:00:00.000Z", message: "old" })];
    const live = [alert({ id: 5, at: "2026-06-29T10:00:00.000Z", message: "new" })];
    const out = mergeAlerts(history, live);
    expect(out).toHaveLength(1);
    expect(out[0].message).toBe("new");
  });

  it("dedupes id-less live events by patient|vital|at", () => {
    const a = alert({ at: "2026-06-29T10:00:00.000Z" });
    expect(mergeAlerts([], [a, { ...a }])).toHaveLength(1);
  });

  it("caps at ALERT_FEED_CAP", () => {
    const many = Array.from({ length: ALERT_FEED_CAP + 50 }, (_, i) =>
      alert({ id: i, at: `2026-06-29T10:00:${String(i % 60).padStart(2, "0")}.000Z` }));
    expect(mergeAlerts(many, [])).toHaveLength(ALERT_FEED_CAP);
  });
});

describe("keys", () => {
  it("alertKey prefers id, falls back to composite", () => {
    expect(alertKey(alert({ id: 9, at: "t" }))).toBe("id:9");
    expect(alertKey(alert({ at: "2026-06-29T10:00:00.000Z" }))).toBe("live:1|HR|2026-06-29T10:00:00.000Z");
  });
  it("codeBlueKey combines patient + time", () => {
    const c: CodeBlueItem = { kind: "code-blue", patientId: "7", bedNumber: null, ward: "3W", triggeredBy: null, reason: null, at: "t" };
    expect(codeBlueKey(c)).toBe("7|t");
  });
});
