import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RevenueCycleTab } from "@/app/(with-auth)/dashboard/billing/components/RevenueCycleTab";
import { getARAging, getClaimQueue } from "@/lib/api";

jest.mock("@/lib/api", () => ({
  getARAging: jest.fn(),
  getClaimQueue: jest.fn(),
}));

const mockedGetARAging = getARAging as jest.MockedFunction<typeof getARAging>;
const mockedGetClaimQueue = getClaimQueue as jest.MockedFunction<typeof getClaimQueue>;

function mockRevenueCycleData() {
  mockedGetARAging.mockResolvedValue({
    as_of: "2026-04-21T00:00:00.000Z",
    overall: {
      total_outstanding: 12500,
      invoice_count: 2,
      oldest_age_days: 94,
    },
    buckets: [
      { bucket: "31-60", invoice_count: 1, outstanding_amount: 5000 },
      { bucket: "90+", invoice_count: 1, outstanding_amount: 7500 },
    ],
    invoices: [
      {
        id: 1,
        invoice_number: "INV-1001",
        patient_uid: "patient-123456",
        patient_name: "Asha Rao",
        type: "insurance_claim",
        payment_status: "pending",
        due_date: "2026-01-15T00:00:00.000Z",
        issued_at: "2026-01-01T00:00:00.000Z",
        age_days: 94,
        total_amount: 10000,
        paid_amount: 2500,
        outstanding_amount: 7500,
      },
    ],
  });

  mockedGetClaimQueue.mockResolvedValue({
    statuses: ["under_review"],
    summary: [
      {
        status: "under_review",
        count: 1,
        claim_amount: 10000,
        payer_balance: 7500,
      },
    ],
    claims: [
      {
        id: 1,
        claim_number: "CLM-1001",
        status: "under_review",
        insurance_provider: "Care Shield",
        policy_number: "POL-1001",
        claim_amount: 10000,
        approved_amount: 2500,
        payer_balance: 7500,
        submitted_at: "2026-03-01T00:00:00.000Z",
        reviewed_at: null,
        rejection_reason: null,
        days_in_queue: 50,
        invoice_id: 1,
        invoice_number: "INV-1001",
        patient_uid: "patient-123456",
        patient_name: "Asha Rao",
      },
    ],
  });
}

describe("RevenueCycleTab", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRevenueCycleData();
  });

  it("renders A/R aging and claim follow-up data from revenue-cycle APIs", async () => {
    render(<RevenueCycleTab />);

    await waitFor(() => expect(screen.getByText("Total A/R")).toBeInTheDocument());

    expect(mockedGetARAging).toHaveBeenCalledWith({ limit: 8 });
    expect(mockedGetClaimQueue).toHaveBeenCalledWith({ status: undefined, limit: 10 });
    expect(screen.getByText("Total A/R")).toBeInTheDocument();
    expect(screen.getByText("₹12,500.00")).toBeInTheDocument();
    expect(screen.getByText("90+ days")).toBeInTheDocument();
    expect(screen.getAllByText("Asha Rao")).toHaveLength(2);
    expect(screen.getAllByText("Care Shield")).toHaveLength(1);
    expect(screen.getAllByText("INV-1001")).toHaveLength(2);
  });

  it("reloads claim queue with selected status filter", async () => {
    render(<RevenueCycleTab />);

    await waitFor(() => expect(mockedGetClaimQueue).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "under review" }));

    await waitFor(() => {
      expect(mockedGetClaimQueue).toHaveBeenLastCalledWith({ status: "under_review", limit: 10 });
    });
  });
});
