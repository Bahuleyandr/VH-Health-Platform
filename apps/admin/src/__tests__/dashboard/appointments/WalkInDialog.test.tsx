/**
 * Tests for src/app/(with-auth)/dashboard/appointments/components/WalkInDialog.tsx
 *
 * Walk-in registration UI assertions:
 *  - The form renders the expected fields + CTAs.
 *  - Phone is required (or unidentified-ER toggle, but EMERGENCY dept
 *    needs to be selected for that — covered by ER-specific tests).
 *  - Cancel closes without submitting.
 *  - Filled phone + name submits and surfaces the new token.
 *
 * Conditional sections (ANC fieldset on OBGYN, guardian fieldset on minor
 * DOB, unidentified toggle on EMERGENCY) are not exercised here; they're
 * covered by the Playwright authenticated journey suite (the dropdowns
 * need real backend lists to render).
 */

import { WalkInDialog } from "@/app/(with-auth)/dashboard/appointments/components/WalkInDialog";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "react-hot-toast";

// Mock the API at the module level so submit doesn't fire real fetch.
jest.mock("@/lib/api/appointments", () => ({
  registerWalkInAdmin: jest.fn(),
}));

// The component now also fetches the doctor + department lists via
// useQuery. Stub the admin fetcher so the dropdowns render empty instead
// of hitting the network in tests.
jest.mock("@/lib/api", () => ({
  fetchAdminAPI: jest.fn().mockResolvedValue({ doctors: [], departments: [] }),
}));

import { registerWalkInAdmin } from "@/lib/api/appointments";

function withQueryClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

describe("<WalkInDialog />", () => {
  beforeEach(() => {
    (toast.error as jest.Mock).mockClear();
    (toast.success as jest.Mock).mockClear();
    (registerWalkInAdmin as jest.Mock).mockClear();
  });

  it("renders the expected form fields + CTAs", () => {
    render(withQueryClient(<WalkInDialog onClose={() => {}} onSuccess={() => {}} />));

    expect(screen.getByText(/Register Walk-in Patient/)).toBeInTheDocument();
    // Fields
    expect(screen.getByPlaceholderText(/10-digit mobile number/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Full name/i)).toBeInTheDocument();
    // Doctor + Department + Gender are <select> dropdowns sourced from
    // the backend. Use getAllByRole since there are multiple comboboxes.
    expect(screen.getByText(/Doctor \(optional\)/i)).toBeInTheDocument();
    expect(screen.getByText(/^Department$/i)).toBeInTheDocument();
    expect(screen.getAllByRole("combobox").length).toBeGreaterThanOrEqual(2);
    // CTAs
    expect(screen.getByRole("button", { name: /Cancel/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Register Walk-in/ })).toBeInTheDocument();
  });

  it("submitting with empty phone fires a toast + blocks the API call", async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    const onSuccess = jest.fn();
    render(withQueryClient(<WalkInDialog onClose={onClose} onSuccess={onSuccess} />));

    await user.click(screen.getByRole("button", { name: /Register Walk-in/ }));

    expect(toast.error).toHaveBeenCalledWith("Mobile number is required");
    expect(registerWalkInAdmin).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("Cancel button calls onClose and does NOT submit", async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    render(withQueryClient(<WalkInDialog onClose={onClose} onSuccess={() => {}} />));
    await user.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(registerWalkInAdmin).not.toHaveBeenCalled();
  });

  it("submitting with phone filled calls registerWalkInAdmin", async () => {
    const user = userEvent.setup();
    (registerWalkInAdmin as jest.Mock).mockResolvedValueOnce({ data: { token_number: 7 } });
    const onClose = jest.fn();
    const onSuccess = jest.fn();
    render(withQueryClient(<WalkInDialog onClose={onClose} onSuccess={onSuccess} />));

    await user.type(screen.getByPlaceholderText(/10-digit mobile number/i), "9999988888");
    await user.click(screen.getByRole("button", { name: /Register Walk-in/ }));

    await screen.findByRole("button", { name: /Register Walk-in/ });

    expect(registerWalkInAdmin).toHaveBeenCalledTimes(1);
    const payload = (registerWalkInAdmin as jest.Mock).mock.calls[0][0];
    expect(payload.patient_phone).toBe("9999988888");
    expect(onSuccess).toHaveBeenCalledWith(7);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("phone + name passes through to the backend payload", async () => {
    const user = userEvent.setup();
    (registerWalkInAdmin as jest.Mock).mockResolvedValueOnce({ data: { token_number: 12 } });
    render(withQueryClient(<WalkInDialog onClose={() => {}} onSuccess={() => {}} />));

    await user.type(screen.getByPlaceholderText(/10-digit mobile number/i), "9999988888");
    await user.type(screen.getByPlaceholderText(/Full name/i), "Jane Doe");
    await user.click(screen.getByRole("button", { name: /Register Walk-in/ }));

    expect(registerWalkInAdmin).toHaveBeenCalledTimes(1);
    const payload = (registerWalkInAdmin as jest.Mock).mock.calls[0][0];
    expect(payload.patient_name).toBe("Jane Doe");
    expect(payload.patient_phone).toBe("9999988888");
  });
});
