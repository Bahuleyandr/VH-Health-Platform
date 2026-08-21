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

    for (const route of routes) {
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

        try {
          await page.goto(route, { waitUntil: "domcontentloaded" });
          await expect(
            page,
            `${route} should not redirect to login`,
          ).not.toHaveURL(/\/login/);
          await page.waitForTimeout(ROUTE_SETTLE_MS);
          await Promise.all(failedResponseReads);

          const failureText = page.getByText(
            /page not found|cannot get|socketexception|clientexception|request failed|failed to load|something went wrong|http 404|http 500/i,
          );
          await expect(
            failureText.first(),
            `${route} should not render a visible error`,
          ).toHaveCount(0);

          expect(pageErrors, `${route} page errors`).toEqual([]);
          expect(consoleErrors, `${route} console errors`).toEqual([]);
          expect(failedResponses, `${route} failed backend responses`).toEqual(
            [],
          );
        } finally {
          await page.close();
        }
      });
    }
  });
});
