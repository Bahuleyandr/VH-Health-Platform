import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { TenantProvider, useTenant } from "@/contexts/TenantContext";
import { getTenantContext, type TenantContext } from "@/lib/api/tenantContext";

jest.mock("@/lib/api/tenantContext", () => ({
  getTenantContext: jest.fn(),
}));

const mockedGet = getTenantContext as jest.MockedFunction<typeof getTenantContext>;

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TenantProvider>{ui}</TenantProvider>
    </QueryClientProvider>,
  );
}

function Consumer() {
  const { tenant } = useTenant();
  return <div>name:{tenant?.branding?.name ?? "(none)"}</div>;
}

const TENANT_A: TenantContext = {
  id: "a5a5a5a5-c5c5-4a5a-8a5a-a5a5c5c5aa01",
  slug: "hospital-a",
  name: "Hospital A",
  region: "IN",
  branding: {
    name: "Brand A",
    logoUrl: null,
    primaryColor: "#aa0011",
    supportEmail: "support@brand-a.example",
    legalName: "Brand A Healthcare Pvt Ltd",
    legalFooter: "Brand A legal footer",
    helpCenterUrl: "https://help.brand-a.example",
    document: { legalName: "Brand A Healthcare Pvt Ltd", footerText: "Brand A legal footer", letterheadUrl: null },
    email: { fromName: "Brand A", replyTo: "support@brand-a.example" },
    assets: { logo: null, documentLetterhead: null },
    mobile: { identityMode: "stamped_build", tokenColorSource: "VH_TENANT_PRIMARY" },
    fallbacks: { name: false, logo: true, supportEmail: false, legalName: false, helpCenter: false },
  },
};

describe("TenantProvider / useTenant (W5 S2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.documentElement.style.removeProperty("--tenant-primary");
  });

  it("exposes the tenant branding name once loaded", async () => {
    mockedGet.mockResolvedValue(TENANT_A);
    renderWithQuery(<Consumer />);
    await waitFor(() => expect(screen.getByText("name:Brand A")).toBeInTheDocument());
  });

  it("sets --tenant-primary from branding.primaryColor", async () => {
    mockedGet.mockResolvedValue(TENANT_A);
    renderWithQuery(<Consumer />);
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--tenant-primary")).toBe("#aa0011"),
    );
  });

  it("degrades to no tenant (today's look) when the fetch fails — no crash, no CSS var", async () => {
    mockedGet.mockRejectedValue(new Error("401"));
    renderWithQuery(<Consumer />);
    await waitFor(() => expect(screen.getByText("name:(none)")).toBeInTheDocument());
    expect(document.documentElement.style.getPropertyValue("--tenant-primary")).toBe("");
  });
});
