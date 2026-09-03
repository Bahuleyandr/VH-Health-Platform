import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

const APP_ROOT = path.resolve(__dirname, "../src/app/(with-auth)");
const PAGE_FILE = "page.tsx";
const ROUTE_SETTLE_MS = Number(process.env.ADMIN_ROUTE_CRAWL_SETTLE_MS || 1200);

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (entry.isFile() && entry.name === PAGE_FILE) {
      files.push(fullPath);
    }
  }

  return files;
}

function routeForPage(filePath: string): string | null {
  const relative = path.relative(APP_ROOT, path.dirname(filePath));
  const segments = relative
    .split(path.sep)
    .filter(Boolean)
    .filter((segment) => !segment.startsWith("(") && !segment.startsWith("@"));

  if (segments.some((segment) => segment.includes("["))) return null;
  return `/${segments.join("/")}`.replace(/\/+/g, "/") || "/dashboard";
}

function discoverDashboardRoutes(): string[] {
  return [
    ...new Set(walk(APP_ROOT).map(routeForPage).filter(Boolean) as string[]),
  ].sort((a, b) => a.localeCompare(b));
}

// Deliberate dark-gate contracts, not failures. While the C-D14 activation
// gate is compile-closed (CLINICAL_CONTINUITY_C_D14_APPROVED = false in
// apps/backend/src/config/downtimeConfig.js), the continuity facility-context
// endpoints answer 503 CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE by design,
// and continuity-facility-context.spec.ts pins that typed-absence response as
// the expected SUPER_ADMIN experience. The crawl must not re-flag it here.
const EXPECTED_DARK_GATE_RESPONSES: Array<{
  method: string;
  status: number;
  pathIncludes: string;
  bodyCode: string;
}> = [
  {
    method: "GET",
    status: 503,
    pathIncludes: "/api/v1/admin/devices/continuity-facility-context/grants",
    bodyCode: "CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE",
  },
  // PR #897 dark-gated the facility asset register fail-closed behind
  // FACILITY_ASSETS_ENABLED (default off): every /api/v1/facility/assets*
  // endpoint answers 503 FACILITY_ASSETS_NOT_ENABLED by design while the env
  // switch is off. The /dashboard/facility-assets page still fires its list +
  // custodian GETs on load; both match this one entry. The crawl must not
  // re-flag the intended dark response.
  {
    method: "GET",
    status: 503,
    pathIncludes: "/api/v1/facility/assets",
    bodyCode: "FACILITY_ASSETS_NOT_ENABLED",
  },
];

function isExpectedDarkGateResponse(
  method: string,
  status: number,
  url: string,
  body: string,
): boolean {
  return EXPECTED_DARK_GATE_RESPONSES.some(
    (expected) =>
      expected.method === method &&
      expected.status === status &&
      url.includes(expected.pathIncludes) &&
      body.includes(expected.bodyCode),
  );
}

const routes = discoverDashboardRoutes();
const routeCrawlTimeoutMs = Number(
  process.env.ADMIN_ROUTE_CRAWL_TIMEOUT_MS ||
    Math.max(120_000, routes.length * (ROUTE_SETTLE_MS + 2500)),
);

test.describe("authenticated — dashboard route crawl", () => {
  test("every static dashboard route renders without backend/proxy errors", async ({
    context,
  }) => {
    test.setTimeout(routeCrawlTimeoutMs);

    expect(
      routes.length,
      "dashboard route discovery returned no routes",
    ).toBeGreaterThan(0);

    // Every broken route, not just the alphabetically first one (audit row
    // OPEN-24). This loop used to assert inside each step, and a failing expect
    // propagates out of an awaited test.step and ends the run - so the crawl
    // reported exactly ONE route however many were broken, and because routes
    // are crawled in sorted order the masking was systematic rather than
    // random. /dashboard/mar sorts before /dashboard/pharmacy, so when the MAR
    // authority defect was fixed the crawl immediately surfaced a pharmacy
    // failure that had been present and invisible behind it. Every prior
    // reading of "Smoke E2E is red" as a single defect was an artefact of this
    // loop.
    //
    // Findings are now collected per route and asserted once at the end. The
    // per-route step still throws, so a broken route is still marked failed in
    // the Playwright report; the throw is caught HERE so the crawl carries on.
    const routeFailures: Array<{ route: string; problems: string[] }> = [];

    for (const route of routes) {
      try {
        await test.step(route, async () => {
          const page = await context.newPage();
          const pageErrors: string[] = [];
          const consoleErrors: string[] = [];
          const failedResponses: string[] = [];
          const failedResponseReads: Array<Promise<void>> = [];

          page.on("pageerror", (error) => {
            pageErrors.push(error.message);
          });
          page.on("console", (message) => {
            if (message.type() === "error") {
              const text = message.text();
              if (!text.includes("Failed to load resource")) {
                consoleErrors.push(text);
              }
            }
          });
          page.on("response", (response) => {
            const url = response.url();
            const isBackendSurface =
              url.includes("/api/proxy/") ||
              url.includes("/api/login") ||
              url.includes("/api/refresh") ||
              url.includes("/api/realtime-ticket");
            if (isBackendSurface && response.status() >= 400) {
              failedResponseReads.push(
                (async () => {
                  const body = await response.text().catch(() => "");
                  const method = response.request().method();
                  if (
                    isExpectedDarkGateResponse(
                      method,
                      response.status(),
                      url,
                      body,
                    )
                  ) {
                    return;
                  }
                  const bodySnippet = body.replace(/\s+/g, " ").slice(0, 240);
                  failedResponses.push(
                    `${method} ${response.status()} ${url}${bodySnippet ? ` :: ${bodySnippet}` : ""}`,
                  );
                })(),
              );
            }
          });

          const problems: string[] = [];
          // Each check is recorded rather than thrown, so one finding on a
          // route does not hide the others on the SAME route either. The
          // web-first assertions keep their retry semantics by staying inside
          // expect() and being caught individually.
          const record = async (
            label: string,
            assertion: () => Promise<void>,
          ) => {
            try {
              await assertion();
            } catch (error) {
              const first = String((error as Error)?.message ?? error).split(
                "\n",
              )[0];
              problems.push(`${label} (${first})`);
            }
          };

          try {
            await page.goto(route, { waitUntil: "domcontentloaded" });
            await record("redirected to login", () =>
              expect(page).not.toHaveURL(/\/login/),
            );
            await page.waitForTimeout(ROUTE_SETTLE_MS);
            await Promise.all(failedResponseReads);

            const failureText = page.getByText(
              /page not found|cannot get|socketexception|clientexception|request failed|failed to load|something went wrong|http 404|http 500/i,
            );
            await record("renders a visible error", () =>
              expect(failureText.first()).toHaveCount(0),
            );

            if (pageErrors.length > 0) {
              problems.push(`page errors: ${pageErrors.join(" / ")}`);
            }
            if (consoleErrors.length > 0) {
              problems.push(`console errors: ${consoleErrors.join(" / ")}`);
            }
            if (failedResponses.length > 0) {
              problems.push(
                `failed backend responses: ${failedResponses.join(" / ")}`,
              );
            }

            if (problems.length > 0) {
              routeFailures.push({ route, problems });
              // Thrown so this step is marked failed in the report; caught at
              // the loop so the crawl continues to the next route.
              throw new Error(`${route}: ${problems.join(" | ")}`);
            }
          } finally {
            await page.close();
          }
        });
      } catch {
        // Recorded in routeFailures by the step itself. Swallowed so one broken
        // route cannot hide the rest - the assertion after this loop is what
        // fails the test, and it names every route at once.
      }
    }

    expect(
      routeFailures,
      `${routeFailures.length} of ${routes.length} dashboard route(s) failed:\n` +
        routeFailures
          .map(
            ({ route, problems }) =>
              `  ${route}\n${problems.map((p) => `    - ${p}`).join("\n")}`,
          )
          .join("\n"),
    ).toEqual([]);
  });
});
