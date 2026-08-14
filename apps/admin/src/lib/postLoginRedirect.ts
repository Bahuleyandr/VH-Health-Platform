// src/lib/postLoginRedirect.ts
//
// The middleware stamps `?redirect=<pathname>` on the /login URL when an
// unauthenticated request hits a dashboard route (src/middleware.ts). The
// login success paths consume it here so a deep link survives the login
// round-trip — but ONLY after strict validation, because a query parameter
// that feeds a post-login navigation is a classic open-redirect sink.
//
// Policy: accept nothing but a same-origin relative path inside the
// dashboard tree (`/dashboard` or `/dashboard/...`). Everything else —
// absolute URLs, protocol-relative `//host`, backslash tricks, encoded
// slashes, dot-segment escapes, control characters — falls back to
// DEFAULT_POST_LOGIN_PATH.

export const DEFAULT_POST_LOGIN_PATH = "/dashboard";

/**
 * Validate a raw `redirect` value and return a safe in-app path.
 * Returns DEFAULT_POST_LOGIN_PATH unless the value is a same-origin
 * relative path within /dashboard.
 */
export function sanitizePostLoginRedirect(
  raw: string | null | undefined,
): string {
  if (typeof raw !== "string" || raw === "") return DEFAULT_POST_LOGIN_PATH;

  // Backslashes are treated as slashes by browsers/WHATWG URL parsing in
  // enough places that `/\evil.com` behaves like `//evil.com`. Reject early.
  if (raw.includes("\\")) return DEFAULT_POST_LOGIN_PATH;

  // Control characters and whitespace (tab/newline are stripped by URL
  // parsers, which can splice `//` back together). Reject early.
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) return DEFAULT_POST_LOGIN_PATH;

  // Must be a relative path: absolute URLs (`https://…`), schemes
  // (`javascript:`), and still-encoded values (`%2F%2Fevil.com`) don't start
  // with "/"; protocol-relative URLs start with "//".
  if (!raw.startsWith("/") || raw.startsWith("//")) {
    return DEFAULT_POST_LOGIN_PATH;
  }

  // Parse against a fixed dummy origin. Anything that smuggles in a host or
  // scheme changes the origin; dot segments (`/dashboard/../login`) are
  // normalized away by the parser before the prefix check below.
  let parsed: URL;
  try {
    parsed = new URL(raw, "https://admin.invalid");
  } catch {
    return DEFAULT_POST_LOGIN_PATH;
  }
  if (parsed.origin !== "https://admin.invalid") return DEFAULT_POST_LOGIN_PATH;
  if (parsed.username !== "" || parsed.password !== "") {
    return DEFAULT_POST_LOGIN_PATH;
  }

  const path = parsed.pathname;
  if (path !== "/dashboard" && !path.startsWith("/dashboard/")) {
    return DEFAULT_POST_LOGIN_PATH;
  }

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * Read the `redirect` query parameter from the current browser location and
 * return the sanitized destination. Safe to call from any success path —
 * outside the browser (SSR) it returns the default.
 */
export function resolvePostLoginRedirect(): string {
  if (typeof window === "undefined") return DEFAULT_POST_LOGIN_PATH;
  try {
    const raw = new URLSearchParams(window.location.search).get("redirect");
    return sanitizePostLoginRedirect(raw);
  } catch {
    return DEFAULT_POST_LOGIN_PATH;
  }
}
