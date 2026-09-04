// Pharmacy overview facility-authority gate — OPEN-25.
//
// The overview tab fired GET /pharmacy-orders/orders/sla unconditionally on
// mount. That read is facility-scoped: pharmacyFacilityAuthorityService resolves
// the actor's pharmacy custody and answers 403 PHARMACY_FACILITY_GRANT_REQUIRED
// when they hold none, so an administrator who has simply not been assigned a
// facility was greeted with a red failure box, and the authenticated route crawl
// took a 403 on /dashboard/pharmacy.
//
// This is NOT a role gate, which is why it cannot be decided client-side the way
// MAR's was. FACILITY_OPERATION_ROLES admits ADMIN and SUPER_ADMIN
// (pharmacyFacilityAuthorityService.js:53-61); authority additionally requires a
// staff row and an active pharmacy_staff_facility_grants row. So the page asks
// an always-200 sibling endpoint first and only requests the scoped data when
// the answer says it can succeed.
//
// Why asking matters rather than just handling the error: the route crawl flags
// any >=400 on /api/proxy/* at the NETWORK layer, so catching the 403 and
// rendering something friendly would not have made the tier honest. The page has
// to not make the call.

import { render, screen, waitFor } from "@testing-library/react";
import { OverviewTab } from "@/app/(with-auth)/dashboard/pharmacy/components/OverviewTab";

const fetchAdminAPI = jest.fn();
jest.mock("@/lib/api", () => ({
  fetchAdminAPI: (...args: unknown[]) => fetchAdminAPI(...args),
}));

const AUTHORITY = "/pharmacy-orders/orders/facility-authority";
const SLA = "/pharmacy-orders/orders/sla";

function calls() {
  return fetchAdminAPI.mock.calls.map((c) => String(c[0]));
}

function respond({ hasAuthority }: { hasAuthority: boolean }) {
  fetchAdminAPI.mockImplementation((url: string) => {
    if (url === AUTHORITY) {
      return Promise.resolve({
        data: {
          has_authority: hasAuthority,
          facility_id: hasAuthority ? 2 : null,
          code: hasAuthority ? null : "PHARMACY_FACILITY_GRANT_REQUIRED",
        },
      });
    }
    if (url === SLA) {
      return Promise.resolve({
        data: {
          summary: {
            total: "0",
            placed: "0",
            confirmed: "0",
            preparing: "0",
            dispatched: "0",
            delivered: "0",
            cancelled: "0",
            total_revenue: "0",
          },
          avg_times: {
            avg_confirm_mins: null,
            avg_dispatch_mins: null,
            avg_delivery_mins: null,
          },
          sla_breaches: 0,
          date_range: { from: "2026-09-01", to: "2026-09-04" },
        },
      });
    }
    return Promise.reject(new Error(`unexpected call: ${url}`));
  });
}

beforeEach(() => {
  fetchAdminAPI.mockReset();
});

describe("pharmacy overview facility-authority gate", () => {
  it("does not request the facility-scoped SLA read without authority", async () => {
    respond({ hasAuthority: false });
    render(<OverviewTab />);

    await screen.findByText(/not currently assigned to one/i);
    expect(calls()).toContain(AUTHORITY);
    // The regression this test exists for.
    expect(calls()).not.toContain(SLA);
  });

  it("explains the scope rather than rendering a failure", async () => {
    respond({ hasAuthority: false });
    render(<OverviewTab />);

    const notice = await screen.findByText(/not currently assigned to one/i);
    // Must not read as an error: the route crawl fails a page rendering any of
    // this vocabulary (route-crawl.spec.ts), and "Failed to load" — the previous
    // copy — matched it.
    expect(notice.textContent ?? "").not.toMatch(
      /page not found|cannot get|request failed|failed to load|something went wrong|http 404|http 500/i,
    );
  });

  it("requests the SLA read when authority is held", async () => {
    respond({ hasAuthority: true });
    render(<OverviewTab />);

    await waitFor(() => expect(calls()).toContain(SLA));
    expect(calls()).toContain(AUTHORITY);
    expect(screen.queryByText(/not currently assigned to one/i)).toBeNull();
  });

  it("asks for authority before the scoped read, never after", async () => {
    respond({ hasAuthority: true });
    render(<OverviewTab />);

    await waitFor(() => expect(calls()).toContain(SLA));
    // Ordering is the whole mechanism: asking afterwards would still have fired
    // the call the gate exists to avoid.
    expect(calls().indexOf(AUTHORITY)).toBeLessThan(calls().indexOf(SLA));
  });

  it("still surfaces a real fault rather than showing the scope notice", async () => {
    fetchAdminAPI.mockImplementation((url: string) =>
      url === AUTHORITY
        ? Promise.reject(new Error("Gateway timeout"))
        : Promise.reject(new Error(`unexpected call: ${url}`)),
    );
    render(<OverviewTab />);

    // An outage must not be flattened into "you have no authority" — that would
    // hide a real failure behind a calm empty state.
    expect(await screen.findByText(/Gateway timeout/i)).toBeInTheDocument();
    expect(screen.queryByText(/not currently assigned to one/i)).toBeNull();
    expect(calls()).not.toContain(SLA);
  });
});
