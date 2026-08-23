import TierDEmergencyPanel, {
  TIER_D_EMERGENCY_MODULES,
} from "@/app/(with-auth)/dashboard/clinical-ai/components/coreModulePanels/TierDEmergencyPanel";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

function renderWithQuery() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TierDEmergencyPanel />
    </QueryClientProvider>,
  );
}

describe("<TierDEmergencyPanel />", () => {
  it("advertises the stroke FAST assistant module by stable key", async () => {
    expect(
      TIER_D_EMERGENCY_MODULES.some(
        (m) => m.key === "stroke_fast_check_assistant",
      ),
    ).toBe(true);

    const user = userEvent.setup();
    renderWithQuery();

    await user.click(screen.getByRole("button", { name: /Stroke FAST/i }));
    expect(screen.getByText(/thrombolysis-window check/i)).toBeInTheDocument();
  });
});
