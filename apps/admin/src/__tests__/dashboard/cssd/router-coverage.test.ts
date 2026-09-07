// Re-audit lane L class guard, CSSD half.
//
// The defect was not "one endpoint lost its caller" — it was a whole router
// mounted, specced, role-gated and never called, so the console rendered a
// board production could never fill. Fixing the thirteen instances leaves the
// CLASS open: the next endpoint added to cssdRoutes.js would repeat it
// silently, because the spec gate only checks the other direction (that a
// client path is served), never that a served path has a client.
//
// So this walks cssdRoutes.js and requires a caller in the admin api modules
// that serve it for every route it mounts. An endpoint that genuinely should
// not have one is exempted BY NAME with the reason, so an unwired route cannot
// hide behind a blanket allowance.
//
// TWO client modules, because the router serves two audiences. The instrument-
// set console calls through `fetchAdminAPI` (api/cssd.ts). The reprocessable
// cath-device queue added under `/devices` cannot: every transition there is
// mounted with `requireIdempotencyKey({ required: true })` and fetchAdminAPI
// carries no header, so api/cathDevices.ts goes through the core.ts helpers
// instead. Both are scanned — a device route with no caller must fail here just
// as loudly as a set route with none.

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
const DEVICE_API_MODULE = path.join(ADMIN_SRC, "lib", "api", "cathDevices.ts");

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

/** `/api/v1/cssd/devices/${id}/receive` → `/cssd/devices/{param}/receive`. */
function normalizeLiteral(literal: string): string {
  return (
    literal
      // `${suffix}` is the optional query string. Drop it BEFORE path params
      // collapse to {param}, or every list read would read as a path segment.
      .replace(/\$\{suffix\}/g, "")
      .replace(/\$\{[^}]*\}/g, "{param}")
      .split("?")[0]
      .replace(/^\/api\/v1/, "")
      .replace(/\/$/, "")
  );
}

/**
 * Every path api/cssd.ts sends, as `VERB /cssd/...`. `fetchAdminAPI` defaults
 * to GET, so a call with no `method` counts as one.
 */
function fetchAdminApiRoutes(): string[] {
  const source = read(API_MODULE);
  const calls = [
    ...source.matchAll(
      /fetchAdminAPI<[^>]*>\(\s*[`"]([^`"]+)[`"]\s*(?:,\s*\{\s*method:\s*"([A-Z]+)")?/g,
    ),
  ].map(
    ([, literal, method]) => `${method ?? "GET"} ${normalizeLiteral(literal)}`,
  );
  expect(calls.length).toBeGreaterThan(5);
  return calls;
}

/**
 * Every path api/cathDevices.ts sends through the core.ts helpers. The endpoint
 * is either an inline literal or one of the module's exported path constants,
 * so the constants are resolved from the same source rather than duplicated
 * here — a renamed constant must not be able to make this scan silently empty.
 */
function coreHelperRoutes(): string[] {
  const source = read(DEVICE_API_MODULE);
  const constants = devicePathConstants(source);
  const verbs: Record<string, string> = {
    getJSON: "GET",
    postJSON: "POST",
    putJSON: "PUT",
  };
  const calls = [
    ...source.matchAll(
      /\b(getJSON|postJSON|putJSON)<[^>]*>\(\s*(?:([A-Z][A-Z0-9_]*)|[`"]([^`"]+)[`"])/g,
    ),
  ].map(([, helper, constName, literal]) => {
    const endpoint = constName ? constants.get(constName) : literal;
    // An unresolvable constant would quietly drop a call from the census.
    expect(endpoint).toBeDefined();
    return `${verbs[helper]} ${normalizeLiteral(endpoint as string)}`;
  });
  expect(calls.length).toBeGreaterThan(5);
  return calls;
}

/** The module's exported path constants, resolved from its own source. */
function devicePathConstants(source: string): Map<string, string> {
  return new Map(
    [
      ...source.matchAll(
        /export const ([A-Z][A-Z0-9_]*) =\s*"([^"]+)" as const;/g,
      ),
    ].map(([, name, value]) => [name, value]),
  );
}

/**
 * Paths the module hands to the BROWSER as a URL rather than fetching. The
 * device label answers a binary PDF, so the console opens it through the
 * portal proxy (`window.open`) and never sends it through core.ts — but a URL
 * builder is still a caller, and a label route with no control behind it is
 * exactly the defect this file exists to catch.
 */
function proxyUrlRoutes(): string[] {
  const source = read(DEVICE_API_MODULE);
  const constants = devicePathConstants(source);
  const urls = [
    ...source.matchAll(/`\/api\/proxy\$\{([A-Z][A-Z0-9_]*)\}([^`]*)`/g),
  ].map(([, constName, rest]) => {
    const base = constants.get(constName);
    // An unresolvable constant would quietly drop the URL from the census.
    expect(base).toBeDefined();
    // A URL opened in a tab is a GET.
    return `GET ${normalizeLiteral(`${base as string}${rest}`)}`;
  });
  expect(urls.length).toBeGreaterThan(0);
  return urls;
}

/** The union of both client modules, fetches and opened URLs alike. */
function calledRoutes(): string[] {
  return [
    ...new Set([
      ...fetchAdminApiRoutes(),
      ...coreHelperRoutes(),
      ...proxyUrlRoutes(),
    ]),
  ];
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
