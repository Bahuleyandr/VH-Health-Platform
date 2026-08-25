// Re-audit lane L class guard, linen half. See the CSSD twin
// (src/__tests__/dashboard/cssd/router-coverage.test.ts) for the reasoning:
// the spec gate only checks that a client path is served, never that a served
// path has a client, which is how a whole router stayed caller-less while
// every other gate was green.

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
  "linen",
  "linenLaundryRoutes.js",
);
const API_MODULE = path.join(ADMIN_SRC, "lib", "api", "linenLaundry.ts");

/**
 * Routes mounted but deliberately without an admin caller, with the reason.
 * Empty on purpose: every linen route has one. An entry added here is a
 * decision someone has to justify in review.
 */
const EXEMPT = new Map<string, string>();

function read(file: string): string {
  expect(fs.existsSync(file)).toBe(true);
  return fs.readFileSync(file, "utf8");
}

function mountedRoutes(): string[] {
  const source = read(ROUTES);
  const routes = [
    ...source.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g),
  ].map(
    ([, verb, route]) =>
      `${verb.toUpperCase()} /linen-laundry${route.replace(/:[A-Za-z0-9_]+/g, "{param}")}`,
  );
  expect(routes.length).toBeGreaterThan(5);
  return [...new Set(routes)];
}

function calledRoutes(): string[] {
  const source = read(API_MODULE);
  const calls = [
    ...source.matchAll(
      /fetchAdminAPI<[^>]*>\(\s*[`"]([^`"]+)[`"]\s*(?:,\s*\{\s*\n?\s*method:\s*"([A-Z]+)")?/g,
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

describe("linen-laundry router coverage", () => {
  it("has an admin caller for every route linenLaundryRoutes.js mounts", () => {
    const called = new Set(calledRoutes());
    const uncovered = mountedRoutes().filter(
      (route) => !called.has(route) && !EXEMPT.has(route),
    );
    expect(uncovered).toEqual([]);
  });

  it("keeps every exemption pointing at a route that still exists", () => {
    const mounted = new Set(mountedRoutes());
    for (const route of EXEMPT.keys()) {
      expect(mounted.has(route)).toBe(true);
    }
  });

  it("sends nothing the router does not mount", () => {
    const mounted = new Set(mountedRoutes());
    const strays = calledRoutes().filter(
      (route) => route.includes(" /linen-laundry") && !mounted.has(route),
    );
    expect(strays).toEqual([]);
  });
});
