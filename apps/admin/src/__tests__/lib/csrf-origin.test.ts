// Tests for the shared CSRF origin helper (lib/csrfOrigin.ts).
//
// This helper consolidates the per-route Origin checks that had drifted across
// the six cookie-mutating auth routes (login, logout, refresh, realtime-ticket,
// and the three MFA legs). It enforces the same strict policy as the reverse
// proxy (SEC-8): unsafe methods REQUIRE a matching Origin or Referer-origin; a
// missing Origin/Referer is rejected, not waved through.

import { NextRequest } from "next/server";

// Pin the allowlist before importing the helper (it resolves env per-call, but
// set it up-front so every test sees a deterministic value).
process.env.NEXT_PUBLIC_ALLOWED_ORIGIN = "https://admin.vhhealth.app";

import {
  assertSameOriginOrAllowed,
  resolveAllowedOrigins,
} from "@/lib/csrfOrigin";

function req(method: string, headers: Record<string, string> = {}): Request {
  return new NextRequest("http://localhost:3001/api/login", {
    method,
    headers,
  });
}

describe("assertSameOriginOrAllowed — strict CSRF policy", () => {
  it("rejects an unsafe POST with NO Origin and NO Referer (fail-closed)", () => {
    const res = assertSameOriginOrAllowed(req("POST"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("rejects POST with a mismatched Origin", () => {
    const res = assertSameOriginOrAllowed(
      req("POST", { origin: "https://evil.example.com" }),
    );
    expect(res!.status).toBe(403);
  });

  it("rejects POST whose Origin is absent but Referer is cross-site", () => {
    const res = assertSameOriginOrAllowed(
      req("POST", { referer: "https://evil.example.com/attack" }),
    );
    expect(res!.status).toBe(403);
  });

  it("rejects POST with an unparseable Referer and no Origin", () => {
    const res = assertSameOriginOrAllowed(
      req("POST", { referer: "::::not-a-url" }),
    );
    expect(res!.status).toBe(403);
  });

  it("allows a matching Origin (returns null → caller proceeds)", () => {
    const res = assertSameOriginOrAllowed(
      req("POST", { origin: "https://admin.vhhealth.app" }),
    );
    expect(res).toBeNull();
  });

  it("allows a same-origin Referer when Origin is omitted", () => {
    const res = assertSameOriginOrAllowed(
      req("POST", { referer: "https://admin.vhhealth.app/login" }),
    );
    expect(res).toBeNull();
  });

  it.each(["GET", "HEAD", "OPTIONS"])(
    "exempts safe method %s even with no Origin",
    (method) => {
      expect(assertSameOriginOrAllowed(req(method))).toBeNull();
    },
  );

  it.each(["PUT", "PATCH", "DELETE"])(
    "gates unsafe method %s on a missing Origin",
    (method) => {
      expect(assertSameOriginOrAllowed(req(method))!.status).toBe(403);
    },
  );

  it("honors a comma-separated allowlist (multiple exact origins)", () => {
    const prev = process.env.NEXT_PUBLIC_ALLOWED_ORIGIN;
    process.env.NEXT_PUBLIC_ALLOWED_ORIGIN =
      "https://admin.vhhealth.app, https://ops.vhhealth.app";
    try {
      expect(
        assertSameOriginOrAllowed(
          req("POST", { origin: "https://ops.vhhealth.app" }),
        ),
      ).toBeNull();
      expect(
        assertSameOriginOrAllowed(
          req("POST", { origin: "https://other.vhhealth.app" }),
        )!.status,
      ).toBe(403);
    } finally {
      process.env.NEXT_PUBLIC_ALLOWED_ORIGIN = prev;
    }
  });
});

describe("resolveAllowedOrigins", () => {
  it("splits + trims a comma-separated value", () => {
    const prev = process.env.NEXT_PUBLIC_ALLOWED_ORIGIN;
    process.env.NEXT_PUBLIC_ALLOWED_ORIGIN = " https://a.app , https://b.app ";
    try {
      expect(resolveAllowedOrigins()).toEqual([
        "https://a.app",
        "https://b.app",
      ]);
    } finally {
      process.env.NEXT_PUBLIC_ALLOWED_ORIGIN = prev;
    }
  });

  it("falls back to localhost outside production when unset", () => {
    const prevOrigin = process.env.NEXT_PUBLIC_ALLOWED_ORIGIN;
    const prevEnv = process.env.NODE_ENV;
    delete process.env.NEXT_PUBLIC_ALLOWED_ORIGIN;
    // NODE_ENV is "test" under jest — not production — so the dev default applies.
    try {
      expect(resolveAllowedOrigins()).toEqual(["http://localhost:3001"]);
    } finally {
      process.env.NEXT_PUBLIC_ALLOWED_ORIGIN = prevOrigin;
      (process.env as { NODE_ENV?: string }).NODE_ENV = prevEnv;
    }
  });
});
