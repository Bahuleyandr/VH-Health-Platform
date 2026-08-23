import GeneralLedgerPage from "@/app/(with-auth)/dashboard/billing/ledger/page";
import { usePermissions } from "@/hooks/usePermissions";
import {
  getTrialBalance,
  getArAging,
  getInsurerAging,
  getCashPosition,
  getDailyCollection,
} from "@/lib/api";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/lib/api", () => ({
  getTrialBalance: jest.fn(),
  getArAging: jest.fn(),
  getInsurerAging: jest.fn(),
  getCashPosition: jest.fn(),
  getDailyCollection: jest.fn(),
}));

jest.mock("@/hooks/usePermissions", () => ({ usePermissions: jest.fn() }));

const mockedUsePermissions = usePermissions as jest.MockedFunction<
  typeof usePermissions
>;

function setPermissions(over: Record<string, unknown> = {}) {
  mockedUsePermissions.mockReturnValue({
    user: { role: "ADMIN" },
    role: "ADMIN",
    permissions: [],
    isSuperAdmin: false,
    isAdmin: true,
    isHR: false,
    isDoctor: false,
    isStaff: false,
    isHROrAbove: true,
    isStaffOrAbove: true,
    loading: false,
    hasPermission: () => true,
    hasAnyPermission: () => true,
    hasAllPermissions: () => true,
    allowed: true,
    roleAllowed: true,
    permsAllowed: true,
    ...over,
  } as unknown as ReturnType<typeof usePermissions>);
}

function seedReports() {
  (getTrialBalance as jest.Mock).mockResolvedValue({
    accounts: [
      {
        code: "PATIENT_AR",
        type: "ASSET",
        balancePaise: 750000,
        balance: "7500.00",
      },
      {
        code: "REVENUE",
        type: "REVENUE",
        balancePaise: 750000,
        balance: "7500.00",
      },
    ],
    signedTotalPaise: 0,
    balanced: true,
  });
  (getArAging as jest.Mock).mockResolvedValue({
    buckets: [
      { bucket: "0-30", invoiceCount: 1, totalPaise: 250000, total: "2500.00" },
      { bucket: "31-60", invoiceCount: 0, totalPaise: 0, total: "0.00" },
      { bucket: "61-90", invoiceCount: 0, totalPaise: 0, total: "0.00" },
      { bucket: "90+", invoiceCount: 1, totalPaise: 500000, total: "5000.00" },
    ],
    grandTotalPaise: 750000,
    grandTotal: "7500.00",
  });
  (getInsurerAging as jest.Mock).mockResolvedValue({
    buckets: [
      { bucket: "0-30", invoiceCount: 0, totalPaise: 0, total: "0.00" },
      { bucket: "31-60", invoiceCount: 0, totalPaise: 0, total: "0.00" },
      { bucket: "61-90", invoiceCount: 0, totalPaise: 0, total: "0.00" },
      { bucket: "90+", invoiceCount: 0, totalPaise: 0, total: "0.00" },
    ],
    grandTotalPaise: 0,
    grandTotal: "0.00",
  });
  (getCashPosition as jest.Mock).mockResolvedValue({
    cashTotalPaise: 100000,
    cashTotal: "1000.00",
    bankTotalPaise: 500000,
    bankTotal: "5000.00",
    byDrawer: [{ drawerSessionId: 7, netPaise: 100000, net: "1000.00" }],
  });
  (getDailyCollection as jest.Mock).mockResolvedValue({
    days: [{ day: "2026-06-20", collectedPaise: 100000, collected: "1000.00" }],
    totalPaise: 100000,
    total: "1000.00",
  });
}

describe("<GeneralLedgerPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seedReports();
    setPermissions();
  });

  it("renders all five report sections with data for a finance/admin user", async () => {
    render(<GeneralLedgerPage />);
    expect(
      screen.getByRole("heading", { name: "General Ledger" }),
    ).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByText("Balanced")).toBeInTheDocument(),
    );
    expect(screen.getByText("PATIENT_AR")).toBeInTheDocument();
    expect(screen.getAllByText("₹7,500.00").length).toBeGreaterThan(0);
    expect(
      screen.getByText("No outstanding insurer receivables."),
    ).toBeInTheDocument();
    expect(screen.getByText("Cash on hand")).toBeInTheDocument();
    expect(screen.getByText("#7")).toBeInTheDocument();
    expect(getDailyCollection).toHaveBeenCalled();
  });

  it("collapses a section when its header is clicked", async () => {
    render(<GeneralLedgerPage />);
    await waitFor(() =>
      expect(screen.getByText("Balanced")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Trial Balance/ }));
    await waitFor(() =>
      expect(screen.queryByText("Balanced")).not.toBeInTheDocument(),
    );
  });

  it("blocks non-finance users with a finance-access empty state", () => {
    setPermissions({
      isAdmin: false,
      isSuperAdmin: false,
      role: "STAFF",
      user: { role: "STAFF" },
    });
    render(<GeneralLedgerPage />);
    expect(screen.getByText("Finance access required")).toBeInTheDocument();
    expect(getTrialBalance).not.toHaveBeenCalled();
  });

  it("re-fetches daily collection with the chosen date range on Apply", async () => {
    render(<GeneralLedgerPage />);
    await waitFor(() => expect(getDailyCollection).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-06-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(getDailyCollection).toHaveBeenLastCalledWith({
        from: "2026-06-01",
        to: undefined,
      }),
    );
  });
});
