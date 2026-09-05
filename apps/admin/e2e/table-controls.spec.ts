import { expect, test, type Page } from "@playwright/test";

type TableRoute = {
  route: string;
  expectsSearch?: boolean;
  expectsPageSize?: boolean;
  expectsEdit?: boolean;
  /**
   * This surface is facility-scoped and THIS actor holds no custody, so the
   * correct render is a scope notice rather than a table. Mutually exclusive
   * with expectsPageSize: a page with no table has no paginator to assert.
   */
  expectsFacilityScopeNotice?: boolean;
};

const TABLE_ROUTES: TableRoute[] = [
  {
    route: "/dashboard/users",
    expectsSearch: true,
    expectsPageSize: true,
    expectsEdit: true,
  },
  {
    route: "/dashboard/doctors",
    expectsSearch: true,
    expectsPageSize: true,
    expectsEdit: true,
  },
  {
    route: "/dashboard/appointments",
    expectsSearch: true,
    expectsPageSize: true,
  },
  {
    route: "/dashboard/admin-management",
    expectsSearch: true,
    expectsPageSize: true,
  },
  {
    route: "/dashboard/departments",
    expectsSearch: true,
    expectsPageSize: true,
  },
  {
    route: "/dashboard/notifications",
    expectsSearch: true,
    expectsPageSize: true,
  },
  {
    route: "/dashboard/system-logs",
    expectsSearch: true,
    expectsPageSize: true,
  },
  // NOT expectsPageSize, and do not "fix" it back. This suite authenticates as
  // a row in the `admins` table, which is a SEPARATE IDENTITY REALM from
  // `users` — see the comment at services/auth/loginSessionHelper.js#54.
  // Pharmacy custody is resolved out of `users` plus an active row in
  // pharmacy_staff_facility_grants, so a platform admin correctly holds none,
  // and /orders/facility-authority answers a typed absence. The page then
  // renders FACILITY_SCOPE_NOTICE (PR #996) instead of a table, so there is no
  // paginator to find.
  //
  // Granting this actor custody would NOT restore the paginator either: the
  // rows-per-page select lives inside ClientTablePagination, which OrdersTab
  // renders only in its `orders.length > 0` branch, and the smoke database
  // seeds no pharmacy_orders. Custody alone just swaps one empty state for
  // another. Restoring expectsPageSize here needs BOTH a granted actor and
  // seeded orders.
  {
    route: "/dashboard/pharmacy",
    expectsSearch: true,
    expectsFacilityScopeNotice: true,
  },
  {
    route: "/dashboard/investigations",
    expectsSearch: true,
    expectsPageSize: true,
  },
  { route: "/dashboard/attendance", expectsSearch: true },
  { route: "/dashboard/staff-roster", expectsSearch: true },
];

async function expectNoVisibleCrash(page: Page, route: string) {
  await expect(page, `${route} should stay in dashboard`).toHaveURL(
    /\/dashboard/,
  );
  const visibleFailure = page.getByText(
    /page not found|doctor not found|user not found|cannot get|socketexception|clientexception|request failed|failed to load|something went wrong|http 404|http 500/i,
  );
  await expect(
    visibleFailure.first(),
    `${route} should not render a visible crash`,
  ).toHaveCount(0);
}

async function findSearchBox(page: Page) {
  return page
    .locator(
      'input[type="search"], input[placeholder*="Search"], input[placeholder*="search"]',
    )
    .first();
}

async function hasRowsPerPageSelect(page: Page) {
  return page
    .locator("select", { has: page.locator('option[value="50"]') })
    .first();
}

async function openPrimaryTableSurface(page: Page, route: string) {
  const tabByRoute: Record<string, RegExp> = {
    "/dashboard/appointments": /all appointments/i,
    "/dashboard/pharmacy": /orders/i,
    "/dashboard/investigations": /all investigations/i,
    "/dashboard/notifications": /history/i,
  };
  const tabName = tabByRoute[route];
  if (tabName) {
    const tab = page.getByRole("button", { name: tabName }).first();
    if (await tab.isVisible().catch(() => false)) {
      await tab.click();
      await page.waitForTimeout(900);
    }
  }

  if (route === "/dashboard/system-logs") {
    const filters = page.getByRole("button", { name: /filters/i }).first();
    if (await filters.isVisible().catch(() => false)) {
      await filters.click();
      await page.waitForTimeout(300);
    }
  }
}

test.describe("authenticated — admin table controls", () => {
  for (const config of TABLE_ROUTES) {
    test(`${config.route} exposes stable table controls`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(config.route, { waitUntil: "domcontentloaded" });
      await expect(page).not.toHaveURL(/\/login/);
      await page.waitForTimeout(1200);
      await openPrimaryTableSurface(page, config.route);
      await expectNoVisibleCrash(page, config.route);

      if (config.expectsSearch) {
        const search = await findSearchBox(page);
        await expect(
          search,
          `${config.route} should expose search`,
        ).toBeVisible();
        await search.fill("zz-smoke-no-match");
        await expect(search).toHaveValue("zz-smoke-no-match");
        await search.fill("");
      }

      if (config.expectsFacilityScopeNotice) {
        // Assert the notice FIRST. It is the only assertion here that can fail
        // on a blank or crashed page, so the absence check below is meaningful
        // only once this one has resolved.
        //
        // Matched on a distinctive clause rather than the whole literal: the
        // constant is assembled from two string parts in a "use client" module
        // (components/useFacilityAuthority.ts), and no spec in this directory
        // imports app source. Deliberately avoids route-crawl's visible-failure
        // vocabulary — this is a scope notice, not a fault.
        const notice = page.getByText(/scoped to a pharmacy facility/i).first();
        await expect(
          notice,
          `${config.route} should explain the missing facility scope`,
        ).toBeVisible();

        // And the paginator must be ABSENT, not merely unasserted. If this
        // actor is ever granted custody AND the smoke seeds orders, this line
        // fails and forces a deliberate decision — rather than the route
        // quietly keeping a weaker test than the others.
        const pageSize = await hasRowsPerPageSelect(page);
        await expect(
          pageSize,
          `${config.route} should expose no paginator while it has no table`,
        ).toHaveCount(0);
      }

      if (config.expectsPageSize) {
        const pageSize = await hasRowsPerPageSelect(page);
        await expect(
          pageSize,
          `${config.route} should expose 10/50/100 rows-per-page`,
        ).toBeVisible();
        await pageSize.selectOption("50");
        await expect(pageSize).toHaveValue("50");

        const next = page.getByRole("button", { name: /next page/i }).first();
        if (await next.isVisible().catch(() => false)) {
          await expect(
            next,
            `${config.route} next-page control should be reachable`,
          )
            .toBeEnabled({ timeout: 1000 })
            .catch(() => undefined);
        }
      }

      if (config.expectsEdit) {
        const edit = page
          .getByRole("link", { name: /^edit$/i })
          .or(page.getByRole("button", { name: /^edit$/i }))
          .first();
        if (await edit.isVisible().catch(() => false)) {
          await edit.click();
          await page.waitForTimeout(800);
          await expectNoVisibleCrash(page, `${config.route} edit`);
        }
      }
    });
  }

  test("primary table actions remain reachable at narrow desktop widths", async ({
    page,
  }) => {
    const routes = [
      "/dashboard/users",
      "/dashboard/doctors",
      "/dashboard/pharmacy",
      "/dashboard/investigations",
    ];
    for (const route of routes) {
      await test.step(route, async () => {
        await page.setViewportSize({ width: 768, height: 900 });
        await page.goto(route, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(1200);
        await expectNoVisibleCrash(page, route);

        const tableScroller = page.locator(".overflow-x-auto").first();
        if (await tableScroller.isVisible().catch(() => false)) {
          await tableScroller.evaluate((node) => {
            node.scrollLeft = node.scrollWidth;
          });
        }

        const action = page
          .getByRole("link", { name: /^edit$|view|confirm|dispatch|update/i })
          .or(
            page.getByRole("button", {
              name: /^edit$|view|confirm|dispatch|update/i,
            }),
          )
          .first();
        if (await action.isVisible().catch(() => false)) {
          await expect(
            action,
            `${route} should keep a reachable action after horizontal scroll`,
          ).toBeInViewport();
        }
      });
    }
  });
});
