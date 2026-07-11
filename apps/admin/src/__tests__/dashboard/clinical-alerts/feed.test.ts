import {
  mergeAlerts,
  alertKey,
  codeBlueKey,
  stemiSlaClockStartPending,
  stemiSlaTargetPending,
  stemiTimerName,
  validateStemiActivationPayload,
  ALERT_FEED_CAP,
  type AlertItem,
  type CodeBlueItem,
  type StemiSlaInstance,
} from "@/app/(with-auth)/dashboard/clinical-alerts/feed";

function alert(p: Partial<AlertItem> & { at: string }): AlertItem {
  return {
    kind: "vital-anomaly",
    patientId: "1",
    vitalName: "HR",
    value: 190,
    unit: null,
    severity: "CRITICAL",
    message: "m",
    ...p,
  };
}

describe("mergeAlerts", () => {
  it("sorts newest-first across history + live", () => {
    const history = [alert({ id: 1, at: "2026-06-29T10:00:00.000Z" })];
    const live = [alert({ at: "2026-06-29T10:05:00.000Z" })];
    expect(mergeAlerts(history, live).map((a) => a.at)).toEqual([
      "2026-06-29T10:05:00.000Z",
      "2026-06-29T10:00:00.000Z",
    ]);
  });

  it("dedupes a history row by DB id (live copy of the same id wins, once)", () => {
    const history = [
      alert({ id: 5, at: "2026-06-29T10:00:00.000Z", message: "old" }),
    ];
    const live = [
      alert({ id: 5, at: "2026-06-29T10:00:00.000Z", message: "new" }),
    ];
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
      alert({
        id: i,
        at: `2026-06-29T10:00:${String(i % 60).padStart(2, "0")}.000Z`,
      }),
    );
    expect(mergeAlerts(many, [])).toHaveLength(ALERT_FEED_CAP);
  });
});

describe("keys", () => {
  it("alertKey prefers id, falls back to composite", () => {
    expect(alertKey(alert({ id: 9, at: "t" }))).toBe("id:9");
    expect(alertKey(alert({ at: "2026-06-29T10:00:00.000Z" }))).toBe(
      "live:1|HR|2026-06-29T10:00:00.000Z",
    );
  });
  it("codeBlueKey combines patient + time", () => {
    const c: CodeBlueItem = {
      kind: "code-blue",
      patientId: "7",
      bedNumber: null,
      ward: "3W",
      triggeredBy: null,
      reason: null,
      at: "t",
    };
    expect(codeBlueKey(c)).toBe("7|t");
  });
});

describe("stemiTimerName", () => {
  it.each<[string, string]>([
    ["stemi_door_to_ecg", "Door-to-ECG"],
    ["stemi_door_to_lab", "Door-to-lab"],
    ["stemi_door_to_balloon", "Door-to-balloon"],
    ["owner_defined_clock", "owner defined clock"],
  ])("labels %s as %s", (ruleCode, label) => {
    expect(stemiTimerName(ruleCode)).toBe(label);
  });
});

describe("STEMI SLA pending reasons", () => {
  const sla = (metadata: StemiSlaInstance["metadata"]): StemiSlaInstance => ({
    id: "sla-1",
    rule_code: "stemi_door_to_balloon",
    status: "active",
    metadata,
  });

  it("keeps an owner target pending distinct from a missing door clock", () => {
    expect(stemiSlaTargetPending(sla({ targets_pending: true }))).toBe(true);
    expect(stemiSlaClockStartPending(sla({ targets_pending: true }))).toBe(
      false,
    );

    expect(stemiSlaTargetPending(sla({ clock_start_pending: true }))).toBe(
      false,
    );
    expect(stemiSlaClockStartPending(sla({ clock_start_pending: true }))).toBe(
      true,
    );
  });
});

describe("validateStemiActivationPayload", () => {
  function payload(
    ruleCodes = [
      "stemi_door_to_ecg",
      "stemi_door_to_lab",
      "stemi_door_to_balloon",
    ],
  ) {
    return {
      activations: [
        {
          id: "19",
          patient_uid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          activation_source: "clinician",
          status: "lab_notified",
          activated_at: "2026-07-11T09:56:00.000Z",
          sla_instances: ruleCodes.map((ruleCode, index) => ({
            id: `sla-${index}`,
            rule_code: ruleCode,
            status: "active",
          })),
        },
      ],
      count: 1,
    };
  }

  it("accepts one durable row for each required clock", () => {
    expect(validateStemiActivationPayload(payload()).activations).toHaveLength(
      1,
    );
  });

  it("rejects a successful response without an activation list", () => {
    expect(() => validateStemiActivationPayload({ count: 0 })).toThrow(
      "Invalid Code STEMI activation payload",
    );
  });

  it.each([
    ["missing", ["stemi_door_to_ecg", "stemi_door_to_balloon"]],
    [
      "duplicate",
      [
        "stemi_door_to_ecg",
        "stemi_door_to_lab",
        "stemi_door_to_balloon",
        "stemi_door_to_balloon",
      ],
    ],
    [
      "extra",
      [
        "stemi_door_to_ecg",
        "stemi_door_to_lab",
        "stemi_door_to_balloon",
        "owner_defined_clock",
      ],
    ],
  ])("rejects a %s required clock", (_case, ruleCodes) => {
    expect(() => validateStemiActivationPayload(payload(ruleCodes))).toThrow(
      "Incomplete Code STEMI SLA clock set",
    );
  });
});
