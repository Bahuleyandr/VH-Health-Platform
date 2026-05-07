import { expect, test } from "@playwright/test";

/**
 * Data-bearing Playwright tests for sprint pages. Where smoke tests
 * verified "page renders past auth", these assert that specific
 * seeded rows (from
 * apps/backend/scripts/seed-sprint-fixtures.mjs) actually surface in
 * the UI.
 *
 * Precondition: run the seed first.
 *   cd apps/backend && \
 *     DATABASE_URL=postgresql://... \
 *     VH_ALLOW_NON_TEST_DATA_SEED=true \
 *     node scripts/seed-sprint-fixtures.mjs
 *
 * The seed inserts (idempotently):
 *   - patient UID 11111111-1111-4111-8111-111111111111
 *   - billing invoice E2E-INV-001 (₹1180 total, ₹680 due, PARTIAL)
 *   - payment link E2ETESTTOKEN1234… (created)
 *   - 3 lab results incl. signed-off Hemoglobin + critical low K
 *   - insurance policy E2E-POL-001 + preauth PA-E2E-0001 + claim CL-E2E-0001
 *   - OR case "E2E Lap Appendectomy" today
 *   - active labour admission with 3 partograph entries (1 on alert line)
 *   - patient message thread "E2E test thread" awaiting staff
 *
 * If the seed hasn't run, tests will fail noisy with "row not found"
 * — that's the intended behaviour; we want loud failures so the
 * developer is reminded to re-seed.
 */

const SEED_NOT_FOUND_HINT =
  "If this fails, check that scripts/seed-sprint-fixtures.mjs has been run.";

test.describe("sprint data — invoices + payment links", () => {
  test("billing v2 invoice list shows the seeded E2E-INV-001 row", async ({
    page,
  }) => {
    await page.goto("/dashboard/billing");
    await page.getByRole("button", { name: /Invoices v2/i }).click();
    // The row should appear with our invoice number.
    const row = page.getByText("E2E-INV-001", { exact: false });
    await expect(row, SEED_NOT_FOUND_HINT).toBeVisible();
    // Status pill should be PARTIAL.
    await expect(page.getByText(/^PARTIAL$/i).first()).toBeVisible();
  });

  test("payment links tab shows the seeded created link", async ({ page }) => {
    await page.goto("/dashboard/billing");
    await page.getByRole("button", { name: /Payment links/i }).click();
    // Token gets truncated in the UI to 12 chars + ellipsis.
    await expect(
      page.getByText("E2ETESTTOKEN", { exact: false }),
      SEED_NOT_FOUND_HINT,
    ).toBeVisible();
  });
});

test.describe("sprint data — lab", () => {
  test("pathologist worklist shows pending Random Glucose", async ({ page }) => {
    await page.goto("/dashboard/lab");
    // Worklist tab is the default.
    await expect(
      page.getByText("Random Glucose").first(),
      SEED_NOT_FOUND_HINT,
    ).toBeVisible();
  });

  test("critical alerts tab shows the open Serum Potassium alert", async ({
    page,
  }) => {
    await page.goto("/dashboard/lab");
    await page.getByRole("button", { name: /Critical alerts/i }).click();
    await expect(
      page.getByText("Serum Potassium").first(),
      SEED_NOT_FOUND_HINT,
    ).toBeVisible();
  });
});

test.describe("sprint data — insurance", () => {
  test("preauth tab shows the seeded PA-E2E-0001 row", async ({ page }) => {
    await page.goto("/dashboard/insurance");
    // Pre-auth is the default tab.
    await expect(
      page.getByText("PA-E2E-0001"),
      SEED_NOT_FOUND_HINT,
    ).toBeVisible();
  });

  test("claims tab shows the seeded CL-E2E-0001 row", async ({ page }) => {
    await page.goto("/dashboard/insurance");
    await page.getByRole("button", { name: /^Claims$/i }).click();
    await expect(
      page.getByText("CL-E2E-0001"),
      SEED_NOT_FOUND_HINT,
    ).toBeVisible();
  });

  test("policies tab loads policies for the seeded patient UID", async ({
    page,
  }) => {
    await page.goto("/dashboard/insurance");
    await page.getByRole("button", { name: /Policies/i }).click();
    await page
      .getByPlaceholder("UUID")
      .fill("11111111-1111-4111-8111-111111111111");
    await page.getByRole("button", { name: /Fetch/i }).click();
    await expect(
      page.getByText("E2E-POL-001"),
      SEED_NOT_FOUND_HINT,
    ).toBeVisible();
  });
});

test.describe("sprint data — OR board + maternity", () => {
  test("OR board shows the seeded case scheduled today", async ({ page }) => {
    await page.goto("/dashboard/or-board");
    await expect(
      page.getByText("E2E Lap Appendectomy"),
      SEED_NOT_FOUND_HINT,
    ).toBeVisible();
  });

  test("maternity board shows the seeded active labour admission", async ({
    page,
  }) => {
    await page.goto("/dashboard/maternity");
    // Expect at least one Partograph button (i.e. at least one row).
    await expect(
      page.getByRole("button", { name: /Partograph/i }).first(),
      SEED_NOT_FOUND_HINT,
    ).toBeVisible();
  });
});

test.describe("sprint data — messaging", () => {
  test("staff inbox shows the seeded thread on the awaiting_staff filter", async ({
    page,
  }) => {
    await page.goto("/dashboard/messaging");
    // Default filter is awaiting_staff.
    await expect(
      page.getByText("E2E test thread"),
      SEED_NOT_FOUND_HINT,
    ).toBeVisible();
  });
});
