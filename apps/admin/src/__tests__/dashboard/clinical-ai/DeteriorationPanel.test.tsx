import { DeteriorationPanel } from "@/app/(with-auth)/dashboard/clinical-ai/components/coreModulePanels/DeteriorationPanel";
import { fireEvent, render, screen } from "@testing-library/react";

const mockUseQuery = jest.fn();

jest.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

jest.mock("@/lib/api/clinicalAiAdmin", () => ({
  listDeteriorationSnapshots: jest.fn(),
}));

describe("DeteriorationPanel load states", () => {
  beforeEach(() => {
    mockUseQuery.mockReset();
  });

  it("shows a failed load explicitly and never labels it as no snapshots", () => {
    const refetch = jest.fn();
    mockUseQuery.mockReturnValue({
      data: undefined,
      error: new Error("readiness endpoint unavailable"),
      isError: true,
      isLoading: false,
      refetch,
    });

    render(<DeteriorationPanel />);

    expect(
      screen.getByText(/failed to load deterioration snapshots: readiness endpoint unavailable/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/no snapshots in this band/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("distinguishes loading from a successful empty result", () => {
    mockUseQuery.mockReturnValue({
      data: undefined,
      error: null,
      isError: false,
      isLoading: true,
      refetch: jest.fn(),
    });
    const { rerender } = render(<DeteriorationPanel />);
    expect(screen.getByText(/loading deterioration snapshots/i)).toBeInTheDocument();
    expect(screen.queryByText(/no snapshots in this band/i)).not.toBeInTheDocument();

    mockUseQuery.mockReturnValue({
      data: { snapshots: [] },
      error: null,
      isError: false,
      isLoading: false,
      refetch: jest.fn(),
    });
    rerender(<DeteriorationPanel />);
    expect(screen.getByText(/no snapshots in this band/i)).toBeInTheDocument();
  });
});
