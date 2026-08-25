// Re-audit lane L class guard, CSSD half.
//
// The defect was not "one endpoint lost its caller" — it was a whole router
// mounted, specced, role-gated and never called, so the console rendered a
// board production could never fill. Fixing the thirteen instances leaves the
// CLASS open: the next endpoint added to cssdRoutes.js would repeat it
// silently, because the spec gate only checks the other direction (that a
// client path is served), never that a served path has a client.
//
// So this walks cssdRoutes.js and requires a caller in src/lib/api/cssd.ts for
// every route it mounts. An endpoint that genuinely should not have one is
// exempted BY NAME with the reason, so an unwired route cannot hide behind a
// blanket allowance.

import fs from "fs";
import path from "path";

const ADMIN_SRC = path.join(__dirname, "..", "..", "..");
const ROUTES = path.join(
  ADMIN_SRC,
  "..",
  "..",
  "backend",
  "src",
  "routes",
  "cssd",
  "cssdRoutes.js",
);
const API_MODULE = path.join(ADMIN_SRC, "lib", "api", "cssd.ts");

/**
 * Routes that are mounted but deliberately have no admin caller, with the
 * reason. Adding an entry here is a decision someone has to justify in review.
 */
const EXEMPT = new Map<string, string>([
  [
    "GET /cssd/theatre/{param}/warnings",
    "theatreService.getTodaySchedule() calls getOtSterilityWarnings() in-process " +
      "and returns the same payload inline as cssd_warnings on GET /theatre/today, " +
      "which is what dashboard/theatre renders.",
  ],
]);

function read(file: string): string {
  expect(fs.existsSync(file)).toBe(true);
  return fs.readFileSync(file, "utf8");
}

/** `router.post('/issues/:id/return', …)` → `POST /cssd/issues/{param}/return`. */
function mountedRoutes(): string[] {
  const source = read(ROUTES);
  const routes = [
    ...source.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g),
  ].map(
    ([, verb, route]) =>
      `${verb.toUpperCase()} /cssd${route.replace(/:[A-Za-z0-9_]+/g, "{param}")}`,
  );
  // A regex that matched nothing would make the whole file vacuous.
  expect(routes.length).toBeGreaterThan(5);
  return [...new Set(routes)];
}

/**
 * Every path the admin api module sends, as `VERB /cssd/...`. `fetchAdminAPI`
 * defaults to GET, so a call with no `method` counts as one.
 */
function calledRoutes(): string[] {
  const source = read(API_MODULE);
  const calls = [
    ...source.matchAll(
      /fetchAdminAPI<[^>]*>\(\s*[`"]([^`"]+)[`"]\s*(?:,\s*\{\s*method:\s*"([A-Z]+)")?/g,
    ),
  ].map(([, literal, method]) => {
    const route = literal
      // `${suffix}` is the optional query string. Drop it BEFORE path params
      // collapse to {param}, or every list read would read as a path segment.
      .replace(/\$\{suffix\}/g, "")
      .replace(/\$\{[^}]*\}/g, "{param}")
      .split("?")[0]
      .replace(/\/$/, "");
    return `${method ?? "GET"} ${route}`;
  });
  expect(calls.length).toBeGreaterThan(5);
  return [...new Set(calls)];
}

describe("CSSD router coverage", () => {
  it("has an admin caller for every route cssdRoutes.js mounts", () => {
    const called = new Set(calledRoutes());
    const uncovered = mountedRoutes().filter(
      (route) => !called.has(route) && !EXEMPT.has(route),
    );
    expect(uncovered).toEqual([]);
  });

  it("keeps every exemption pointing at a route that still exists", () => {
    const mounted = new Set(mountedRoutes());
    for (const route of EXEMPT.keys()) {
      // A stale exemption would silently widen the guard.
      expect(mounted.has(route)).toBe(true);
    }
  });

  it("sends nothing the router does not mount", () => {
    const mounted = new Set(mountedRoutes());
    // /theatre/today is the one cross-module read and lives on another router.
    const strays = calledRoutes().filter(
      (route) => route.includes(" /cssd") && !mounted.has(route),
    );
    expect(strays).toEqual([]);
  });
});
