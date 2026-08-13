// src/lib/idempotencyKey.ts
//
// Attempt-scoped `Idempotency-Key` minting for admin mutations.
//
// WHY THIS EXISTS
// ---------------
// A growing set of backend routes mount
// `requireIdempotencyKey({ required: true, ... })` and hard-400 any request
// that arrives without the header (see
// `apps/backend/src/middleware/idempotencyMiddleware.js`). The admin client had
// no way to send one from `postJSON`, so those buttons were dead on arrival.
//
// KEY IDENTITY — the part that is easy to get wrong
// -------------------------------------------------
// A fresh random key per click is worse than useless: it defeats the whole
// mechanism, because a double-click or a network-level retry then mints a
// *second* key and the server happily runs the operation twice. The key must be
//
//   * STABLE across every retry of one logical attempt (double-click, TanStack
//     Query retry, the 401→refresh→replay path in `api/core.ts`), so the
//     backend replays its cached response instead of re-executing; and
//   * DIFFERENT across genuinely separate attempts (a deliberate second payroll
//     run for the same month), so the second one actually runs.
//
// So the key is `<scope>:<attempt-id>` where the attempt id is minted once and
// held for the life of the attempt. `createAttemptKeyStore` decides when an
// attempt ends: the identity string changes (the operator edited the form), or
// the caller explicitly `reset()`s after the attempt concluded.
//
// The identity string should be the *natural identity of the operation* — for a
// payroll run that is month + year, carried as the serialized request payload.
// It must include everything in the request body: the server hashes the body
// and answers 422 `Idempotency-Key reused with a different request body` when a
// key is replayed against a changed payload
// (`idempotencyService.claimIdempotencyKey`).
//
// Tenant and user are deliberately NOT part of the client key. The backend's
// uniqueness scope is `(tenant_id, user_uid, request_key, request_path)`
// (migration 130), so both are already server-side facts; embedding a
// browser-side guess would only add a way to be wrong.

/**
 * The backend's accepted shape: 1–200 chars from `[A-Za-z0-9_-:.]`.
 * Mirrors `isValidIdempotencyKey` in
 * `apps/backend/src/services/idempotency/idempotencyService.js`.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_\-:.]{1,200}$/;

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_KEY_PATTERN.test(value);
}

/**
 * Throw before the request leaves the browser rather than let the backend
 * answer 400. A malformed key is a programming error at the call site, and a
 * 400 from the server is indistinguishable from "the header was never sent".
 */
export function assertIdempotencyKey(value: unknown): string {
  if (!isValidIdempotencyKey(value)) {
    throw new TypeError(
      "A valid Idempotency-Key is required (1-200 chars of [A-Za-z0-9_-:.])",
    );
  }
  return value;
}

/** Characters that are legal in a key but not produced by `randomUUID`. */
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  const webCrypto =
    typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(buf);
  } else {
    // Non-browser/legacy fallback. The key only needs to be collision-resistant
    // within (tenant, user, path) — it is not a security token.
    for (let i = 0; i < buf.length; i += 1) {
      buf[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Mint the random half of a key. UUID characters (hex + `-`) are already inside
 * the backend's allowed set, so no escaping is needed.
 */
export function newAttemptId(): string {
  const webCrypto =
    typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (typeof webCrypto?.randomUUID === "function") {
    return webCrypto.randomUUID();
  }
  return randomHex(16);
}

/** Strip anything outside the backend charset so a scope label is always safe. */
function sanitizeScope(scope: string): string {
  const cleaned = scope.replace(/[^A-Za-z0-9_\-.]/g, "-").slice(0, 60);
  return cleaned || "admin";
}

export interface AttemptKeyStore {
  /**
   * Return the key for an attempt whose logical identity is `identity`.
   * Repeated calls with the same `identity` return the SAME key — that is what
   * makes a double-click or a transport retry replay instead of re-run. A
   * changed `identity` starts a new attempt and mints a new key.
   */
  keyFor(identity: string): string;
  /**
   * End the current attempt. The next `keyFor` mints a fresh key even for an
   * unchanged identity. Call this once the attempt has concluded (on success,
   * or when the operator deliberately starts over) so that a genuinely separate
   * run of the same month/year is not swallowed as a replay of the first.
   */
  reset(): void;
  /** Current key without starting an attempt; `null` when none is open. */
  peek(): string | null;
}

/**
 * Create a scope-local store of attempt keys.
 *
 * Pure and framework-free on purpose so it can be unit-tested without React;
 * `useIdempotencyKey` is the thin hook wrapper components use.
 */
export function createAttemptKeyStore(scope: string): AttemptKeyStore {
  const prefix = sanitizeScope(scope);
  let current: { identity: string; key: string } | null = null;

  return {
    keyFor(identity: string): string {
      if (current === null || current.identity !== identity) {
        current = { identity, key: `${prefix}:${newAttemptId()}` };
      }
      return current.key;
    },
    reset(): void {
      current = null;
    },
    peek(): string | null {
      return current?.key ?? null;
    },
  };
}

/**
 * Canonical identity string for a request payload. Uses sorted keys so that a
 * re-render which happens to reorder object literals does not look like a new
 * attempt (and, worse, does not produce a 422 body-hash mismatch against a key
 * the server already holds).
 */
export function payloadIdentity(payload: unknown): string {
  return JSON.stringify(payload, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const source = value as Record<string, unknown>;
      return Object.keys(source)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = source[key];
          return acc;
        }, {});
    }
    return value as unknown;
  });
}
