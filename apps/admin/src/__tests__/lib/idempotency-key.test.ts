import {
  assertIdempotencyKey,
  createAttemptKeyStore,
  IDEMPOTENCY_KEY_PATTERN,
  isValidIdempotencyKey,
  newAttemptId,
  payloadIdentity,
} from "@/lib/idempotencyKey";

describe("idempotency key validation", () => {
  it("accepts the backend's charset and rejects everything else", () => {
    expect(isValidIdempotencyKey("payroll-run:3f2504e0-4f89")).toBe(true);
    expect(isValidIdempotencyKey("a.b_c-d:e")).toBe(true);
    // Rejected: empty, over-length, and characters outside [A-Za-z0-9_-:.]
    expect(isValidIdempotencyKey("")).toBe(false);
    expect(isValidIdempotencyKey("x".repeat(201))).toBe(false);
    expect(isValidIdempotencyKey("has space")).toBe(false);
    expect(isValidIdempotencyKey("has/slash")).toBe(false);
    expect(isValidIdempotencyKey(undefined)).toBe(false);
  });

  it("accepts exactly 200 characters — the backend's inclusive bound", () => {
    expect(isValidIdempotencyKey("x".repeat(200))).toBe(true);
  });

  it("throws before the request leaves the browser rather than let the server 400", () => {
    expect(() => assertIdempotencyKey("")).toThrow(TypeError);
    expect(() => assertIdempotencyKey("bad key")).toThrow(
      /valid Idempotency-Key is required/,
    );
    expect(assertIdempotencyKey("ok-1")).toBe("ok-1");
  });

  it("mints attempt ids inside the accepted charset", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(IDEMPOTENCY_KEY_PATTERN.test(newAttemptId())).toBe(true);
    }
  });
});

describe("createAttemptKeyStore", () => {
  it("returns the SAME key while the identity is unchanged", () => {
    const store = createAttemptKeyStore("payroll-run");
    const first = store.keyFor("month=7,year=2099");
    const second = store.keyFor("month=7,year=2099");
    const third = store.keyFor("month=7,year=2099");

    // This is the whole point: a double-click and a transport retry must carry
    // one key so the backend replays instead of running payroll again.
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("mints a NEW key when the identity changes", () => {
    const store = createAttemptKeyStore("payroll-run");
    const july = store.keyFor("month=7,year=2099");
    const august = store.keyFor("month=8,year=2099");

    expect(august).not.toBe(july);
  });

  it("mints a NEW key after reset — a deliberate re-run is not a replay", () => {
    const store = createAttemptKeyStore("payroll-run");
    const first = store.keyFor("month=7,year=2099");
    store.reset();
    const second = store.keyFor("month=7,year=2099");

    expect(second).not.toBe(first);
  });

  it("does not resurrect an old key when the identity comes back", () => {
    const store = createAttemptKeyStore("payroll-run");
    const july = store.keyFor("month=7,year=2099");
    store.keyFor("month=8,year=2099");
    const julyAgain = store.keyFor("month=7,year=2099");

    // Returning to July is a fresh attempt, not a resumption of the first one —
    // otherwise an operator who flipped the month and back would be replayed
    // the earlier run's response instead of running July again.
    expect(julyAgain).not.toBe(july);
  });

  it("produces keys the backend will accept, prefixed by the scope", () => {
    const store = createAttemptKeyStore("payroll-run");
    const key = store.keyFor("month=7,year=2099");

    expect(key.startsWith("payroll-run:")).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test(key)).toBe(true);
  });

  it("sanitizes a scope containing characters the backend rejects", () => {
    const store = createAttemptKeyStore("billing/payment links");
    expect(IDEMPOTENCY_KEY_PATTERN.test(store.keyFor("x"))).toBe(true);
  });

  it("reports the open attempt through peek()", () => {
    const store = createAttemptKeyStore("payroll-run");
    expect(store.peek()).toBeNull();
    const key = store.keyFor("id");
    expect(store.peek()).toBe(key);
    store.reset();
    expect(store.peek()).toBeNull();
  });
});

describe("payloadIdentity", () => {
  it("is stable across key ordering so a re-render is not a new attempt", () => {
    expect(payloadIdentity({ month: 7, year: 2099 })).toBe(
      payloadIdentity({ year: 2099, month: 7 }),
    );
  });

  it("changes when a value changes — the server would 422 a stale key", () => {
    expect(payloadIdentity({ month: 7, year: 2099 })).not.toBe(
      payloadIdentity({ month: 8, year: 2099 }),
    );
  });

  it("normalizes nested objects too", () => {
    expect(payloadIdentity({ a: { x: 1, y: 2 } })).toBe(
      payloadIdentity({ a: { y: 2, x: 1 } }),
    );
  });

  it("preserves array order — a reordered list is a different request", () => {
    expect(payloadIdentity({ ids: [1, 2] })).not.toBe(
      payloadIdentity({ ids: [2, 1] }),
    );
  });
});
