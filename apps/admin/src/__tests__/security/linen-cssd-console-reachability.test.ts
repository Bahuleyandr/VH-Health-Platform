// Re-audit lane L reachability pin.
//
// The defect this lane fixed was two consoles rendering a board nothing could
// populate. The way to re-introduce it is to wire a control the portal itself
// refuses — this train has already shipped three of those. There are three
// layers between a button and the backend, and all three have to admit the
// call:
//
//   1. middleware/routePolicy — may the caller open the page at all;
//   2. the proxy allowlist (ALLOWED_PATH_PREFIXES) — is the path forwardable;
//   3. PERMISSION_GATES — does a per-admin flag scope an ADMIN out of it.
//
// The backend role gate is the fourth and is not testable from here; it is
// recorded in the header of src/lib/api/{cssd,linenLaundry}.ts (one
// requireRole at the mount for the whole router, no per-route re-gate), which
// is why "the board loads" implies "the actions are reachable" for these two.
//
// This drives the REAL proxy handler for every path these consoles call. The
// cath device-reuse governance mount joined them on the same reasoning: its
// editor lives on the quality console, and its own audience gate is a fourth
// layer this cannot see.

import { requiredProxyPermission } from "@/lib/proxyPermissions";
import { ROUTE_POLICY, STAFF } from "@/lib/routePolicy";
import { NextRequest } from "next/server";

process.env.NEXT_PUBLIC_ALLOWED_ORIGIN = "https://admin.vhhealth.app";

type Handler = (req: NextRequest) => Promise<Response>;
const handlers: Record<string, Handler> = {};
let fetchMock: jest.SpyInstance;

beforeAll(async () => {
  const route = await import("@/app/api/proxy/[...path]/route");
  handlers.GET = route.GET as Handler;
  handlers.POST = route.POST as Handler;
  handlers.PUT = route.PUT as Handler;
  handlers.PATCH = route.PATCH as Handler;
});

beforeEach(() => {
  fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response);
});

afterEach(() => fetchMock.mockRestore());

function call(method: string, path: string) {
  const request = new NextRequest(
    `http://localhost:3001/api/proxy/api/v1/${path}`,
    {
      method,
      headers: {
        cookie: "auth_token=test-token",
        origin: "https://admin.vhhealth.app",
        "content-type": "application/json",
      },
      ...(method === "GET" ? {} : { body: "{}" }),
    },
  );
  return handlers[method](request);
}

// Every path/verb pair the two consoles send, taken from
// src/lib/api/linenLaundry.ts and src/lib/api/cssd.ts.
const LINEN_CALLS: [string, string][] = [
  ["GET", "linen-laundry/board?limit=25"],
  ["GET", "linen-laundry/item-types?active=true"],
  ["POST", "linen-laundry/item-types"],
  ["PUT", "linen-laundry/par-levels"],
  ["GET", "linen-laundry/cycles/41"],
  ["POST", "linen-laundry/cycles"],
  ["POST", "linen-laundry/cycles/41/collect"],
  ["POST", "linen-laundry/cycles/41/laundry"],
  ["POST", "linen-laundry/cycles/41/return"],
  ["POST", "linen-laundry/cycles/41/reconcile"],
  ["POST", "linen-laundry/cycles/41/cancel"],
];

const CSSD_CALLS: [string, string][] = [
  ["GET", "cssd/board"],
  ["GET", "cssd/sets?limit=200"],
  ["POST", "cssd/sets"],
  ["GET", "cssd/sets/5/label"],
  ["GET", "cssd/loads?limit=100"],
  ["POST", "cssd/loads"],
  ["PATCH", "cssd/loads/71/status"],
  ["GET", "cssd/issues?limit=200"],
  ["POST", "cssd/issues"],
  ["POST", "cssd/issues/31/theatre-use"],
  ["POST", "cssd/issues/31/return"],
  ["POST", "cssd/issues/31/decontaminate"],
  ["POST", "cssd/issues/31/cancel"],
];

// Cath device-reuse governance, from src/lib/api/cathDevices.ts. Its own mount
// with its own audience (CATH_REPROCESSING_POLICY_ROUTE_ROLES — quality,
// infection control, admin), reached from the quality console's Reprocessing
// policy tab. The device transitions themselves sit under the `cssd/` prefix
// already covered above.
const CATH_REPROCESSING_CALLS: [string, string][] = [
  ["GET", "cath-reprocessing/settings"],
  ["PUT", "cath-reprocessing/settings"],
  ["GET", "cath-reprocessing/policies"],
  ["PUT", "cath-reprocessing/policies"],
  // The pre-cath lab readiness policy — a later tenant of the same mount and
  // the same audience, edited from the Lab readiness tab beside it.
  ["GET", "cath-reprocessing/lab-readiness-settings"],
  ["PUT", "cath-reprocessing/lab-readiness-settings"],
  // The mount's one PHI read (it writes a hipaa_access_log row per patient in
  // the answer). No console control calls it yet; pinned so that narrowing the
  // allowlist to /settings and /policies is a failure here rather than a
  // device-history view that renders and cannot load.
  ["GET", "cath-reprocessing/devices/41/history"],
];

describe("linen + CSSD console reachability through the portal proxy", () => {
  it.each([...LINEN_CALLS, ...CSSD_CALLS, ...CATH_REPROCESSING_CALLS])(
    "forwards %s /api/v1/%s",
    async (method, path) => {
      const response = await call(method, path);

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain(`/api/v1/${path}`);
    },
  );

  it.each([...LINEN_CALLS, ...CSSD_CALLS, ...CATH_REPROCESSING_CALLS])(
    "needs no per-admin permission flag for %s /api/v1/%s",
    (method, path) => {
      // A gate here would let a flag-scoped ADMIN see the board and be refused
      // every action on it — a control that cannot fire for that account.
      expect(
        requiredProxyPermission(`api/v1/${path.split("?")[0]}`, method),
      ).toBeNull();
    },
  );

  it("keeps segment-boundary lookalikes blocked", async () => {
    for (const path of [
      "cssd-internal/board",
      "linen-laundry-internal/board",
    ]) {
      fetchMock.mockClear();
      const response = await call("GET", path);
      expect(response.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("admits STAFF-rank roles to the three dashboard segments", () => {
    // Housekeeping, nursing, OT and stores roles all rank STAFF in the portal;
    // if any entry were raised the pages would redirect and every control
    // above would be unreachable for the people who do the work. `quality`
    // carries the reprocessing-policy editor, whose audience is the quality and
    // infection-control officers rather than administrators.
    expect(ROUTE_POLICY["linen-laundry"]).toEqual({ minRank: STAFF });
    expect(ROUTE_POLICY.cssd).toEqual({ minRank: STAFF });
    expect(ROUTE_POLICY.quality).toEqual({ minRank: STAFF });
  });
});

describe("the two supporting reads that sit outside those gates", () => {
  // Both consoles need one list from another module to name a foreign key.
  // Neither is on the linen/CSSD gate, so record what they actually require —
  // the dialogs surface the backend's refusal instead of an empty picker.
  it("GET /wards is scoped by the departmentManagement admin flag", () => {
    expect(requiredProxyPermission("api/v1/wards", "GET")).toBe(
      "departmentManagement",
    );
  });

  it("GET /theatre/today carries no per-admin flag", () => {
    expect(requiredProxyPermission("api/v1/theatre/today", "GET")).toBeNull();
  });
});
