// Re-audit finding G, round 2 (2026-08-23) — three ways the round-1 proxy
// gate could be walked around, and the vocabulary pin that keeps it real.
//
// 1. CASE VARIANCE (live bypass). The route handler's allowlist admits a
//    gated console on a coarse ancestor prefix ("api/v1/admin/"), whose
//    casing an attacker leaves alone; the gate map matched the FULL prefix
//    ("api/v1/admin/entitlements") with a case-sensitive compare. So
//    "api/v1/admin/Entitlements" passed the allowlist, matched no gate, and
//    was forwarded — and Express sets no `case sensitive routing`, so the
//    backend routed it to the very handler the sentinel exists to protect.
//    Both layers now match on canonicalProxyPath() of the same raw path.
//
// 2. THE SENTINEL WAS NOT A RANK GATE. checkProxyPermission() returned
//    {allowed:true} for every portal role that is neither ADMIN nor
//    SUPER_ADMIN, before the permission was looked at. middleware.ts enforces
//    rank only in its /dashboard branch — its /api/proxy branch admits every
//    role in PORTAL_ROLE_VALUES — so a DOCTOR / IT_ADMIN / NURSING_STAFF
//    token crossed every sentinel gate.
//
// 3. THE MIRROR WAS UNPINNED. GRANTABLE_PERMISSIONS is what makes a sentinel
//    gate unsatisfiable; nothing tied it to the backend catalog that
//    validates writes to admins.permissions. Widen one copy and the sentinel
//    quietly becomes grantable.
//
// Case folding is deliberately NOT a rejection of non-canonical casing: real
// paths carry case-significant segments (the clinical-AI access-policy path
// spells a role name, `.../access-policies/NURSING_STAFF/read`), so a
// "reject any uppercase" rule would 403 legitimate traffic. The upstream URL
// is still built from the original segments; folding is for matching only,
// and the "forwards verbatim" case below pins that.
import {
  GRANTABLE_PERMISSIONS,
  PLATFORM_SUPER_ADMIN,
  __resetPermissionCacheForTests,
  canonicalProxyPath,
  checkProxyPermission,
  requiredProxyPermission,
} from "@/lib/proxyPermissions";
import fs from "fs";
import { NextRequest } from "next/server";
import path from "path";

process.env.NEXT_PUBLIC_ALLOWED_ORIGIN = "https://admin.vhhealth.app";

type Handler = (req: NextRequest) => Promise<Response>;
let GET: Handler;
let POST: Handler;
let fetchMock: jest.SpyInstance;

beforeAll(async () => {
  const route = await import("@/app/api/proxy/[...path]/route");
  GET = route.GET as Handler;
  POST = route.POST as Handler;
});

// Unsigned structural JWT — serverTokenRole falls back to a structural decode
// when JWT_SECRET is unset outside production (NODE_ENV=test here).
function tokenWithRole(role: string): string {
  const b64 = (obj: object) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ role })}.sig`;
}

function profileResponse(permissions: string[]): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({
      success: true,
      data: { admin: { uid: "a-1", permissions } },
    }),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

function upstreamResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    arrayBuffer: async () => new ArrayBuffer(0),
    json: async () => ({}),
  } as unknown as Response;
}

/** Backend that would answer EVERYTHING, so a denial can only come from us. */
function mockBackend(permissions: string[]) {
  fetchMock = jest
    .spyOn(global, "fetch")
    .mockImplementation(async (input: RequestInfo | URL) =>
      String(input).includes("/api/v1/auth/admin/profile")
        ? profileResponse(permissions)
        : upstreamResponse(),
    );
}

/** `proxyPath` is the full path after /api/proxy/, casing preserved. */
function request(proxyPath: string, token: string, method = "GET") {
  return new NextRequest(`http://localhost:3001/api/proxy/${proxyPath}`, {
    method,
    headers: {
      cookie: `auth_token=${token}`,
      ...(method === "GET" ? {} : { origin: "https://admin.vhhealth.app" }),
    },
  });
}

function forwarded(): string[] {
  return fetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => !u.includes("/api/v1/auth/admin/profile"));
}

function profileLookups(): string[] {
  return fetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.includes("/api/v1/auth/admin/profile"));
}

const EVERY_GRANTABLE_FLAG = [...GRANTABLE_PERMISSIONS];

afterEach(() => {
  jest.restoreAllMocks();
  __resetPermissionCacheForTests();
});

describe("finding G round 2 — path spelling cannot walk around the proxy gate", () => {
  describe("case variance resolves to the same gate", () => {
    it.each([
      ["api/v1/admin/Entitlements/tenants/t-1", PLATFORM_SUPER_ADMIN],
      ["api/v1/admin/Feature-Flags", PLATFORM_SUPER_ADMIN],
      ["api/v1/admin/Encryption-Keys/rotate", PLATFORM_SUPER_ADMIN],
      ["api/v1/admin/SMART-FHIR/apps", PLATFORM_SUPER_ADMIN],
      ["api/v1/admin/Migration-Toolkit/jobs", PLATFORM_SUPER_ADMIN],
      ["api/v1/admin/Database/tables", PLATFORM_SUPER_ADMIN],
      ["api/v1/admin/Tenants", PLATFORM_SUPER_ADMIN],
      ["api/v1/admin/Integration-Gates", PLATFORM_SUPER_ADMIN],
      [
        "api/v1/admin/devices/Continuity-Facility-Context/grants",
        PLATFORM_SUPER_ADMIN,
      ],
      ["api/v1/GDPR/erase", PLATFORM_SUPER_ADMIN],
      ["api/v1/ADMIN/entitlements", PLATFORM_SUPER_ADMIN],
      ["api/v1/auth/Admin/list", "adminManagement"],
      ["api/v1/rbac/Admin/audit-log", "adminManagement"],
      ["api/v1/notifications/Admin/send", "notificationManagement"],
      ["api/v1/Users", "userManagement"],
      ["api/v1/prescriptions/All", "appointmentManagement"],
    ])("%s still requires %s", (candidate, permission) => {
      expect(requiredProxyPermission(candidate, "GET")).toBe(permission);
    });

    it("denies the most privileged ADMIN there can be at a case-varied sentinel path", async () => {
      mockBackend(["*", ...EVERY_GRANTABLE_FLAG]);

      const res = await GET(
        request(
          "api/v1/admin/Entitlements/tenants/t-1",
          tokenWithRole("ADMIN"),
        ),
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        message: `Forbidden: missing ${PLATFORM_SUPER_ADMIN} permission`,
      });
      expect(forwarded()).toHaveLength(0);
    });

    it("catches the case-varied spelling AT THE GATE, not at the allowlist", async () => {
      // The distinction is the whole bug: "Proxy path not allowed" would mean
      // the allowlist happened to reject it, leaving the gate still blind.
      // The permission message proves the path reached — and failed — the
      // gate, i.e. that both layers read it the same way.
      mockBackend(["*"]);

      const res = await GET(
        request(
          "api/v1/admin/devices/Continuity-Facility-Context/grants",
          tokenWithRole("ADMIN"),
        ),
      );

      expect(await res.json()).toEqual({
        message: `Forbidden: missing ${PLATFORM_SUPER_ADMIN} permission`,
      });
      expect(res.status).toBe(403);
      expect(forwarded()).toHaveLength(0);
    });

    it("gates a case-varied flag prefix for a scoped-down ADMIN", async () => {
      mockBackend(["appointmentManagement"]);

      const res = await GET(
        request("api/v1/Users?limit=10", tokenWithRole("ADMIN")),
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        message: "Forbidden: missing userManagement permission",
      });
      expect(forwarded()).toHaveLength(0);
    });
  });

  describe("percent escapes fold the same way for both layers", () => {
    it("decodes an ordinary escape when matching", () => {
      expect(canonicalProxyPath("api/v1/admin/%65ntitlements")).toBe(
        "api/v1/admin/entitlements",
      );
      expect(requiredProxyPermission("api/v1/admin/%65ntitlements")).toBe(
        PLATFORM_SUPER_ADMIN,
      );
    });

    it("never lets a decoded separator invent a segment boundary", () => {
      // Decoding %2F would turn one segment into two and change which prefix
      // the path appears to sit under, so the segment stays encoded.
      const canonical = canonicalProxyPath("api/v1/admin/a%2Fb");
      expect(canonical).toBe("api/v1/admin/a%2fb");
      expect(canonical!.split("/")).toHaveLength(4);
    });

    it("treats an undecodable path as gated, never as ungated", () => {
      expect(canonicalProxyPath("api/v1/users/%zz")).toBeNull();
      expect(requiredProxyPermission("api/v1/users/%zz")).toBe(
        PLATFORM_SUPER_ADMIN,
      );
    });

    it("rejects an undecodable path at the proxy with 400 and forwards nothing", async () => {
      mockBackend([]);

      const res = await GET(
        request("api/v1/users/%zz/profile", tokenWithRole("SUPER_ADMIN")),
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ message: "Invalid path" });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("a non-SUPER_ADMIN portal token cannot cross a sentinel gate", () => {
    // middleware.ts's /api/proxy branch accepts every role in
    // PORTAL_ROLE_VALUES, so these tokens really do arrive here.
    it.each([
      "DOCTOR",
      "IT_ADMIN",
      "NURSING_STAFF",
      "RECEPTIONIST",
      "HR_STAFF",
    ])("%s is denied the feature-flags console", async (role) => {
      mockBackend([]);

      const res = await GET(
        request("api/v1/admin/feature-flags", tokenWithRole(role)),
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        message: `Forbidden: missing ${PLATFORM_SUPER_ADMIN} permission`,
      });
      // Not even a profile lookup: the rank decision is local.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("denies a lower tier the case-varied spelling too", async () => {
      mockBackend([]);

      const res = await GET(
        request("api/v1/admin/Feature-Flags", tokenWithRole("DOCTOR")),
      );

      expect(res.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("denies a lower tier the erasure endpoint", async () => {
      mockBackend([]);

      const res = await POST(
        request("api/v1/gdpr/erase", tokenWithRole("NURSING_STAFF"), "POST"),
      );

      expect(res.status).toBe(403);
      expect(forwarded()).toHaveLength(0);
    });

    it("denies a bearer whose role claim cannot be read", async () => {
      // The pre-existing dev/test permissiveness for an unreadable role claim
      // must not extend to a rank gate, in any environment.
      await expect(
        checkProxyPermission("t", null, PLATFORM_SUPER_ADMIN),
      ).resolves.toEqual({
        allowed: false,
        message: `Forbidden: missing ${PLATFORM_SUPER_ADMIN} permission`,
      });
    });

    it("still lets SUPER_ADMIN through", async () => {
      mockBackend([]);

      const res = await GET(
        request("api/v1/admin/feature-flags", tokenWithRole("SUPER_ADMIN")),
      );

      expect(res.status).toBe(200);
      expect(forwarded()).toHaveLength(1);
      expect(profileLookups()).toHaveLength(0);
    });
  });

  describe("no lockout: lower tiers keep the endpoints they use today", () => {
    it("every allowlist entry is already canonical", () => {
      // The allowlist is now matched against canonicalProxyPath() output, so
      // an entry carrying an uppercase letter or a percent escape would match
      // nothing and silently 403 a whole route family — the prefix-mount
      // lockout class. Parsed from source: the list is module-private.
      const ROUTE = path.join(
        __dirname,
        "..",
        "..",
        "app",
        "api",
        "proxy",
        "[...path]",
        "route.ts",
      );
      expect(fs.existsSync(ROUTE)).toBe(true);
      const block = /const ALLOWED_PATH_PREFIXES = \[([\s\S]*?)\n\];/.exec(
        fs.readFileSync(ROUTE, "utf8"),
      );
      expect(block).not.toBeNull();
      const entries = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      expect(entries.length).toBeGreaterThan(50);
      expect(entries.filter((e) => canonicalProxyPath(e) !== e)).toEqual([]);
    });

    it.each([
      ["DOCTOR", "api/v1/appointments/list"],
      ["RECEPTIONIST", "api/v1/appointments/queue/today"],
      ["PHARMACY_STAFF", "api/v1/pharmacy/orders"],
      ["NURSING_STAFF", "api/v1/doctors"],
      ["HR_STAFF", "api/v1/users"],
    ])(
      "%s still reaches %s (backend RBAC decides)",
      async (role, proxyPath) => {
        mockBackend([]);

        const res = await GET(request(proxyPath, tokenWithRole(role)));

        expect(res.status).toBe(200);
        expect(forwarded()).toHaveLength(1);
      },
    );

    it("forwards a legitimate uppercase-bearing path with its casing intact", async () => {
      // Real admin path: `role` is interpolated into the URL by
      // src/lib/api/clinicalAiModules.ts. Folding is for matching only — the
      // upstream request must keep the segment the backend needs.
      mockBackend(["*"]);
      const proxyPath =
        "api/v1/admin/clinical-ai/knowledge-bases/7/access-policies/NURSING_STAFF/read";

      const res = await GET(request(proxyPath, tokenWithRole("ADMIN")));

      expect(res.status).toBe(200);
      expect(forwarded()).toHaveLength(1);
      expect(forwarded()[0]).toContain("/access-policies/NURSING_STAFF/read");
    });

    it("keeps segment-boundary lookalikes out of the sentinel gates", () => {
      // Case folding must not widen a prefix. The STAFF-rank device registry
      // and the ADMIN-level own-tenant chrome read stay ungated.
      expect(requiredProxyPermission("api/v1/Admin/Devices", "GET")).toBeNull();
      expect(
        requiredProxyPermission("api/v1/admin/Tenant-Context", "GET"),
      ).toBeNull();
      expect(requiredProxyPermission("api/v1/GDPR-Exports", "GET")).toBeNull();
    });
  });

  describe("a rank-gate denial costs no backend round-trip", () => {
    it("denies an ADMIN at a sentinel gate without fetching the profile", async () => {
      mockBackend(["*"]);

      const res = await GET(
        request("api/v1/admin/encryption-keys", tokenWithRole("ADMIN")),
      );

      expect(res.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("still fetches the profile for a grantable gate", async () => {
      // The hoist must not have skipped flag enforcement along the way.
      mockBackend(["userManagement"]);

      const res = await GET(request("api/v1/users", tokenWithRole("ADMIN")));

      expect(res.status).toBe(200);
      expect(profileLookups()).toHaveLength(1);
      expect(forwarded()).toHaveLength(1);
    });
  });

  describe("the grantable vocabulary mirrors the backend catalog", () => {
    const CATALOG = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "..",
      "backend",
      "src",
      "config",
      "adminPermissionsCatalog.js",
    );

    function catalogSource(): string {
      expect(fs.existsSync(CATALOG)).toBe(true);
      return fs.readFileSync(CATALOG, "utf8");
    }

    function backendGrantable(): string[] {
      const block =
        /export const GRANTABLE_ADMIN_PERMISSIONS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(
          catalogSource(),
        );
      expect(block).not.toBeNull();
      const entries = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
      // A regex that silently matched nothing would make every assertion
      // below vacuous.
      expect(entries.length).toBeGreaterThan(0);
      return entries;
    }

    it("holds exactly the flags the backend will accept on a write", () => {
      // assertValidAdminPermissions() rejects anything outside this list, so
      // a flag the admin copy gates on but the backend refuses to store is
      // unsatisfiable, and a flag the backend stores but the admin copy omits
      // silently turns a flag gate into a rank gate.
      expect([...GRANTABLE_PERMISSIONS].sort()).toEqual(
        backendGrantable().sort(),
      );
    });

    it("agrees with the backend on the sentinel string", () => {
      const sentinel =
        /export const PLATFORM_SUPER_ADMIN_SENTINEL = '([^']+)'/.exec(
          catalogSource(),
        );
      expect(sentinel).not.toBeNull();
      expect(sentinel![1]).toBe(PLATFORM_SUPER_ADMIN);
    });

    it("never lists the sentinel or the wildcard as grantable", () => {
      // Either one inside the vocabulary would make every sentinel gate
      // crossable by an ordinary ADMIN.
      expect(backendGrantable()).not.toContain(PLATFORM_SUPER_ADMIN);
      expect(GRANTABLE_PERMISSIONS.has(PLATFORM_SUPER_ADMIN)).toBe(false);
      expect(GRANTABLE_PERMISSIONS.has("*")).toBe(false);
    });
  });
});
