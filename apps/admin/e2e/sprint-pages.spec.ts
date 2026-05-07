import { expect, test } from "@playwright/test";

/**
 * Smoke tests for the new admin pages shipped in sprints 1-10.
 * Authenticated — uses the session cookie from auth.setup.ts.
 *
 * What this validates:
 *   - Page renders past the auth middleware (no /login redirect)
 *   - The page heading is on screen (server didn't 500)
 *   - At least one expected interactive element is reachable
 *
 * What this DOES NOT validate:
 *   - Actual API responses — those need seed data which isn't
 *     wired into the e2e harness yet. The pages all show empty
 *     states gracefully when the backend returns no rows.
 */

test.describe("sprint pages — render past auth", () => {
  test("/dashboard/operations — Sprint 9 daily ops snapshot", async ({ page }) => {
    await page.goto("/dashboard/operations");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(
      page.getByRole("heading", { name: /Daily Operations Snapshot/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Refresh now/i }),
    ).toBeVisible();
  });

  test("/dashboard/or-board — Sprint 6 OR coordinator", async ({ page }) => {
    await page.goto("/dashboard/or-board");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(
      page.getByRole("heading", { name: /^OR Board$/i }),
    ).toBeVisible();
    // Date filter + Today shortcut + room dropdown should all be present.
    await expect(page.getByRole("button", { name: /Today/i })).toBeVisible();
  });

  test("/dashboard/lab — Sprint 3 pathologist + critical alerts", async ({
    page,
  }) => {
    await page.goto("/dashboard/lab");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(
      page.getByRole("heading", { name: /^Laboratory$/i }),
    ).toBeVisible();
    // Both tabs are rendered.
    await expect(
      page.getByRole("button", { name: /Pathologist worklist/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Critical alerts/i }),
    ).toBeVisible();
  });

  test("/dashboard/insurance — Sprint 5 TPA coordinator", async ({ page }) => {
    await page.goto("/dashboard/insurance");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(
      page.getByRole("heading", { name: /Insurance Coordinator/i }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Pre-auth/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Claims$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Policies/i })).toBeVisible();
  });

  test("/dashboard/maternity — Sprint 7 active labour board", async ({ page }) => {
    await page.goto("/dashboard/maternity");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(
      page.getByRole("heading", { name: /^Maternity$/i }),
    ).toBeVisible();
  });

  test("/dashboard/productivity — Sprint 8 phrases + order sets", async ({
    page,
  }) => {
    await page.goto("/dashboard/productivity");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(
      page.getByRole("heading", { name: /Doctor Productivity/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Smart phrases/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Order sets/i }),
    ).toBeVisible();
  });

  test("/dashboard/messaging — Sprint 10 staff inbox", async ({ page }) => {
    await page.goto("/dashboard/messaging");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(
      page.getByRole("heading", { name: /Patient Messages/i }),
    ).toBeVisible();
  });

  test("/dashboard/dashboards — Sprint 9 Metabase picker", async ({ page }) => {
    await page.goto("/dashboard/dashboards");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(
      page.getByRole("heading", { name: /^Dashboards$/i }),
    ).toBeVisible();
  });
});

test.describe("sprint pages — extended existing pages", () => {
  test("/dashboard/billing has Invoices v2 and Payment links tabs", async ({
    page,
  }) => {
    await page.goto("/dashboard/billing");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(
      page.getByRole("button", { name: /Invoices v2/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Payment links/i }),
    ).toBeVisible();
  });

  test("/dashboard/pharmacy has Schedule register and Expiry alerts tabs", async ({
    page,
  }) => {
    await page.goto("/dashboard/pharmacy");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(
      page.getByRole("button", { name: /Schedule register/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Expiry alerts/i }),
    ).toBeVisible();
  });
});
