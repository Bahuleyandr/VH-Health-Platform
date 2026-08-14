import { expect, test, type Page, type Response } from "@playwright/test";

const PAGE_PATH = "/dashboard/continuity-facility-context";
const CONTRACT_PATH =
  "/api/v1/admin/devices/continuity-facility-context/grants";
const UNAVAILABLE_CODE = "CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE";

async function openAsSuperAdminOrSkip(page: Page): Promise<Response> {
  const observedResponse: { value?: Response } = {};
  const mutationRequests: string[] = [];

  page.on("response", (response) => {
    if (response.url().includes(CONTRACT_PATH))
      observedResponse.value = response;
  });
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().includes("/continuity-facility-context/")
    ) {
      mutationRequests.push(request.url());
    }
  });

  await page.goto(PAGE_PATH, { waitUntil: "domcontentloaded" });
  if (!page.url().includes(PAGE_PATH)) {
    test.skip(true, "Authenticated Playwright fixture is not SUPER_ADMIN");
  }

  await expect(
    page.getByRole("heading", { name: "Facility context" }),
  ).toBeVisible();
  const accessRequired = page.getByRole("heading", {
    name: "SUPER_ADMIN access required",
  });
  const notActivated = page.getByText("Not yet activated", { exact: true });
  await expect(accessRequired.or(notActivated)).toBeVisible();
  if (await accessRequired.isVisible()) {
    test.skip(true, "Authenticated Playwright fixture is not SUPER_ADMIN");
  }

  await expect(notActivated).toBeVisible();
  await expect(page.getByText(UNAVAILABLE_CODE, { exact: true })).toBeVisible();
  expect(mutationRequests).toEqual([]);
  const contractResponse = observedResponse.value;
  expect(
    contractResponse,
    "real facility-context GET response was not observed",
  ).toBeDefined();
  if (!contractResponse) {
    throw new Error("real facility-context GET response was not observed");
  }
  return contractResponse;
}

test("SUPER_ADMIN sees the real typed-absence response and no action controls", async ({
  page,
}) => {
  const response = await openAsSuperAdminOrSkip(page);
  expect(response.status()).toBe(503);
  const body = await response.json();
  expect(body).toMatchObject({
    success: false,
    code: UNAVAILABLE_CODE,
  });
  expect(body.requestId).toEqual(expect.any(String));

  await expect(
    page.getByRole("button", { name: "Enroll fixed device" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Issue exact staff\/device grant/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Revoke/ })).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Open device-loss operator runbook" }),
  ).toBeVisible();
});

test("typed absence remains readable at a mobile viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAsSuperAdminOrSkip(page);

  const hasHorizontalOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);
});
