// MAR due-list role gate — OPEN-11.
//
// /dashboard/mar fired GET /clinical/mar/due and GET /clinical/mar/overdue
// unconditionally on mount. Both are guarded by requireMarDueListRole over
// MAR_DUE_LIST_ROLES (clinicalRoutes.js:145-153,186-191), which omits ADMIN and
// SUPER_ADMIN, so the authenticated route crawl — which runs as SUPER_ADMIN in
// CI (.github/workflows/smoke-e2e.yml:70-71,122-129) — took two 403s and Smoke
// E2E was red from 2026-09-01.
//
// WHY THE GUARD IS ON THE QUERIES AND NOT ON THE ROUTE POLICY.
// The page carries four backend contracts and only the enumerate one excludes
// administrators:
//   * administer-with-scan  -> MEDICATION_ADMINISTRATION_ROLES admits ADMIN and
//     SUPER_ADMIN (clinicalRoutes.js:126-137)
//   * POST /mar/verify      -> no role gate at all (:437-442)
//   * wristband print       -> admits administrators by explicit owner decision
//     of 2026-08-25, audited as 'wristband-print-administrative-access'
//     (bcmaRoutes.js:50,120)
// A route-level `mar: { roles: MAR_DUE_LIST_ROLES }` would have revoked those
// three grants to silence the one 403. These tests pin that scoping so a later
// change cannot quietly widen the gate back to the whole route.

import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import MarPage from "@/app/(with-auth)/dashboard/mar/page";
import { MAR_DUE_LIST_ROLES } from "@/lib/marRoles";

const fetchAdminAPI = jest.fn();
jest.mock("@/lib/api", () => ({
  fetchAdminAPI: (...args: unknown[]) => fetchAdminAPI(...args),
}));

const mockRawRole = jest.fn<string | null, []>();
jest.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => ({ rawRole: mockRawRole() }),
}));

jest.mock("@/lib/bcmaWristband", () => ({
  printableWristbandUrl: () => "about:blank",
}));

function renderAs(role: string | null) {
  mockRawRole.mockReturnValue(role);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MarPage />
    </QueryClientProvider>,
  );
}

function enumerateCalls() {
  return fetchAdminAPI.mock.calls
    .map((c) => String(c[0]))
    .filter(
      (u) =>
        u.includes("/clinical/mar/due") || u.includes("/clinical/mar/overdue"),
    );
}

beforeEach(() => {
  fetchAdminAPI.mockReset();
  fetchAdminAPI.mockResolvedValue({ data: [] });
  mockRawRole.mockReset();
});

describe("MAR due-list gate", () => {
  it("the mirrored allowlist matches the backend's due-list set exactly", () => {
    expect([...MAR_DUE_LIST_ROLES].sort()).toEqual(
      [
        "CNO",
        "ICU_INCHARGE",
        "ICU_NURSE",
        "ICU_STAFF",
        "IP_INCHARGE",
        "IP_STAFF_NURSE",
        "NURSING_INCHARGE",
        "NURSING_STAFF",
      ].sort(),
    );
    // The whole point of the row: administrators are not on it.
    expect(MAR_DUE_LIST_ROLES).not.toContain("ADMIN");
    expect(MAR_DUE_LIST_ROLES).not.toContain("SUPER_ADMIN");
  });

  it.each(MAR_DUE_LIST_ROLES)("%s enumerates the due list", async (role) => {
    renderAs(role);
    await waitFor(() => expect(enumerateCalls().length).toBeGreaterThan(0));
    const urls = enumerateCalls().join(" ");
    expect(urls).toContain("/clinical/mar/due");
    expect(urls).toContain("/clinical/mar/overdue");
  });

  // The regression. These are the identities that produced the two 403s.
  it.each(["SUPER_ADMIN", "ADMIN", "LAB_STAFF", "HOUSEKEEPING_STAFF"])(
    "%s never fires either enumerate read",
    async (role) => {
      renderAs(role);
      await screen.findByText(/limited to bedside nursing roles/i);
      expect(enumerateCalls()).toEqual([]);
    },
  );

  it("an unrecognised or absent role fires nothing (fails closed)", async () => {
    renderAs(null);
    await screen.findByText(/limited to bedside nursing roles/i);
    expect(enumerateCalls()).toEqual([]);
  });

  it("explains why the lists are empty rather than showing a bare empty state", async () => {
    renderAs("SUPER_ADMIN");
    const notice = await screen.findByText(/limited to bedside nursing roles/i);
    expect(notice).toBeInTheDocument();
    // Must not read as a failure: the route crawl fails a page that renders any
    // of this vocabulary (route-crawl.spec.ts:167).
    expect(notice.textContent ?? "").not.toMatch(
      /page not found|cannot get|request failed|failed to load|something went wrong|http 404|http 500/i,
    );
  });

  it("still offers the capabilities administrators legitimately hold", async () => {
    // Scope guard. If someone later lifts this gate to the route policy, the
    // page stops rendering for administrators entirely and this goes red —
    // which is the point, because the backend grants them these.
    renderAs("SUPER_ADMIN");
    expect(
      await screen.findByRole("heading", {
        name: /medication administration/i,
      }),
    ).toBeInTheDocument();
  });
});
