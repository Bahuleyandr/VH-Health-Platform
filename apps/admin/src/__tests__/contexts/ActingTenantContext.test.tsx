import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { ActingTenantProvider } from "@/contexts/ActingTenantContext";
import { ActingTenantBanner } from "@/components/ActingTenantBanner";

const TENANT = "a5a5a5a5-c5c5-4a5a-8a5a-a5a5c5c5aa01";

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ActingTenantProvider>{ui}</ActingTenantProvider>
    </QueryClientProvider>,
  );
}

describe("ActingTenant banner + context (W5 S3)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("shows the banner when acting as a tenant", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ actingTenant: { id: TENANT, slug: "hosp-a", reason: "support" } }),
    } as Response);
    renderWithQuery(<ActingTenantBanner />);
    await waitFor(() => expect(screen.getByText(/Acting as tenant/i)).toBeInTheDocument());
    expect(screen.getByText("hosp-a")).toBeInTheDocument();
  });

  it("renders nothing when not acting (NO-OP for normal use)", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ actingTenant: null }),
    } as Response);
    const { container } = renderWithQuery(<ActingTenantBanner />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("Exit calls DELETE /api/act-as", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (_url, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "DELETE") {
        return { ok: true, json: async () => ({ actingTenant: null }) } as Response;
      }
      return {
        ok: true,
        json: async () => ({ actingTenant: { id: TENANT, slug: "hosp-a", reason: "support" } }),
      } as Response;
    });
    renderWithQuery(<ActingTenantBanner />);
    await waitFor(() => expect(screen.getByText("hosp-a")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /exit tenant/i }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/act-as", expect.objectContaining({ method: "DELETE" })),
    );
  });
});
