// Pharmacy ORDERS tab facility-authority gate — OPEN-25, second surface.
//
// The Orders tab fired GET /pharmacy-orders/orders/queue on mount. That read is
// facility-scoped exactly as the Overview tab's SLA read was: getOrderQueue
// makes the IDENTICAL resolvePharmacyFacility call, so an administrator holding
// no facility grant got a red failure box here too.
//
// It was invisible for a different reason than the Overview tab's. The route
// crawl only ever loads the DEFAULT tab, so it never clicked through to Orders;
// `table-controls.spec.ts` does click through, and it had been SKIPPED for at
// least six consecutive runs behind an earlier failing smoke step. The defect
// was not absent, it was unobserved — twice over.
//
// Both tabs now share one probe (useFacilityAuthority). Two copies of this
// predicate is how they would drift, and a tab gating on a subtly different
// question is worse than a tab that does not gate at all.

import { render, screen, waitFor } from "@testing-library/react";
import { OrdersTab } from "@/app/(with-auth)/dashboard/pharmacy/components/OrdersTab";

const fetchAdminAPI = jest.fn();
jest.mock("@/lib/api", () => ({
  fetchAdminAPI: (...args: unknown[]) => fetchAdminAPI(...args),
  postJSON: jest.fn(),
}));

const AUTHORITY = "/pharmacy-orders/orders/facility-authority";
const QUEUE = "/pharmacy-orders/orders/queue";

function calls() {
  return fetchAdminAPI.mock.calls.map((c) => String(c[0]));
}
function queueCalls() {
  return calls().filter((u) => u.startsWith(QUEUE));
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
    if (url.startsWith(QUEUE)) return Promise.resolve({ data: [] });
    return Promise.reject(new Error(`unexpected call: ${url}`));
  });
}

beforeEach(() => {
  fetchAdminAPI.mockReset();
});

describe("pharmacy orders tab facility-authority gate", () => {
  it("does not request the order queue without authority", async () => {
    respond({ hasAuthority: false });
    render(<OrdersTab />);

    await screen.findByText(/not currently assigned to one/i);
    expect(calls()).toContain(AUTHORITY);
    // The regression this test exists for.
    expect(queueCalls()).toEqual([]);
  });

  it("shows a scope notice rather than a failure", async () => {
    respond({ hasAuthority: false });
    render(<OrdersTab />);

    const notice = await screen.findByText(/not currently assigned to one/i);
    // The route crawl fails a page rendering this vocabulary, and the previous
    // copy here ("Failed to load pharmacy orders") matched it.
    expect(notice.textContent ?? "").not.toMatch(
      /page not found|cannot get|request failed|failed to load|something went wrong|http 404|http 500/i,
    );
  });

  it("requests the queue when authority is held", async () => {
    respond({ hasAuthority: true });
    render(<OrdersTab />);

    await waitFor(() => expect(queueCalls().length).toBeGreaterThan(0));
    expect(calls().indexOf(AUTHORITY)).toBeLessThan(
      calls().findIndex((u) => u.startsWith(QUEUE)),
    );
    expect(screen.queryByText(/not currently assigned to one/i)).toBeNull();
  });

  it("surfaces a probe fault instead of the scope notice", async () => {
    fetchAdminAPI.mockImplementation((url: string) =>
      url === AUTHORITY
        ? Promise.reject(new Error("Gateway timeout"))
        : Promise.reject(new Error(`unexpected call: ${url}`)),
    );
    render(<OrdersTab />);

    // An outage must not be flattened into "you have no authority".
    expect(await screen.findByText(/Gateway timeout/i)).toBeInTheDocument();
    expect(screen.queryByText(/not currently assigned to one/i)).toBeNull();
    expect(queueCalls()).toEqual([]);
  });

  it("treats an unresolved probe as unresolved, never as authority", async () => {
    // Never settles: the gate must not fire the scoped read while waiting, and
    // must not show the scope notice either — `authority === null` means we do
    // not know yet, which is a different state from "no".
    fetchAdminAPI.mockImplementation(() => new Promise(() => {}));
    render(<OrdersTab />);

    await screen.findByText(/loading orders/i);
    expect(queueCalls()).toEqual([]);
    expect(screen.queryByText(/not currently assigned to one/i)).toBeNull();
  });
});
