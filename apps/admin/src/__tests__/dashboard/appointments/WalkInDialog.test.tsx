/**
 * Tests for src/app/(with-auth)/dashboard/appointments/components/WalkInDialog.tsx
 *
 * The walk-in registration dialog is user-input-heavy and has one
 * important validation rule: at least one of `patient_phone` or
 * `patient_name` must be provided. Without that gate, the backend would
 * receive an empty payload and create a headless patient record.
 *
 * We also verify Cancel + submit labels + modal lifecycle hooks.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "react-hot-toast";
import { WalkInDialog } from "@/app/(with-auth)/dashboard/appointments/components/WalkInDialog";

// Mock the API at the module level so submit doesn't fire real fetch.
jest.mock("@/lib/api/appointments", () => ({
  registerWalkInAdmin: jest.fn(),
}));

// The component now also fetches the doctor list via useQuery. Stub the
// admin fetcher so the doctor dropdown renders empty instead of hitting the
// network in tests.
jest.mock("@/lib/api", () => ({
  fetchAdminAPI: jest.fn().mockResolvedValue({ doctors: [] }),
}));

import { registerWalkInAdmin } from "@/lib/api/appointments";

function withQueryClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

describe("<WalkInDialog />", () => {
  it("renders the expected form fields + CTAs", () => {
    render(withQueryClient(<WalkInDialog onClose={() => {}} onSuccess={() => {}} />));

    expect(screen.getByText(/Register Walk-in Patient/)).toBeInTheDocument();
    // Fields
    expect(screen.getByPlaceholderText(/10-digit mobile number/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Full name/i)).toBeInTheDocument();
    // Doctor field is now a <select> dropdown sourced from /doctors, not a
    // free-form ID input — assert the label + the default option instead.
    expect(screen.getByText(/Doctor \(optional\)/i)).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    // CTAs
    expect(screen.getByRole("button", { name: /Cancel/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Register Walk-in/ })).toBeInTheDocument();
  });

  it("submitting with empty phone AND empty name fires a toast + blocks the API call", async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    const onSuccess = jest.fn();
    render(withQueryClient(<WalkInDialog onClose={onClose} onSuccess={onSuccess} />));

    await user.click(screen.getByRole("button", { name: /Register Walk-in/ }));

    expect(toast.error).toHaveBeenCalledWith("Patient phone or name required");
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

    // Wait a tick for the submit promise to settle
    await screen.findByRole("button", { name: /Register Walk-in/ });

    expect(registerWalkInAdmin).toHaveBeenCalledTimes(1);
    const payload = (registerWalkInAdmin as jest.Mock).mock.calls[0][0];
    expect(payload.patient_phone).toBe("9999988888");
    expect(onSuccess).toHaveBeenCalledWith(7);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("submitting with name-only also passes validation", async () => {
    const user = userEvent.setup();
    (registerWalkInAdmin as jest.Mock).mockResolvedValueOnce({ data: { token_number: 12 } });
    render(withQueryClient(<WalkInDialog onClose={() => {}} onSuccess={() => {}} />));

    await user.type(screen.getByPlaceholderText(/Full name/i), "Jane Doe");
    await user.click(screen.getByRole("button", { name: /Register Walk-in/ }));

    expect(registerWalkInAdmin).toHaveBeenCalledTimes(1);
    const payload = (registerWalkInAdmin as jest.Mock).mock.calls[0][0];
    expect(payload.patient_name).toBe("Jane Doe");
  });
});
