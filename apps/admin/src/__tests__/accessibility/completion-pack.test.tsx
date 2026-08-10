import DashboardLayout from "@/app/(with-auth)/dashboard/layout";
import {
  AnnouncementBanner,
  AnnouncementBannerManager,
} from "@/app/(with-auth)/dashboard/notifications/components/AnnouncementBannerManager";
import { fetchAdminAPI } from "@/lib/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode, SVGProps } from "react";

const logout = jest.fn();
let pathname = "/dashboard";
let authUser = { uid: "admin-a" };
let tenantContext = { id: "tenant-a", branding: null };
let actingTenantContext: { id: string; slug: string; reason: string } | null = null;

jest.mock("@/lib/api", () => ({
  fetchAdminAPI: jest.fn().mockResolvedValue({ banner: null }),
}));

const fetchAdminAPIMock = fetchAdminAPI as jest.Mock;

jest.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

jest.mock("@/hooks/useIdleTimeout", () => ({
  useIdleTimeout: jest.fn(),
}));

jest.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => ({
    role: "SUPER_ADMIN",
    isSuperAdmin: true,
    hasAllPermissions: () => true,
  }),
}));

jest.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ logout, user: authUser }),
}));

jest.mock("@/contexts/TenantContext", () => ({
  useTenant: () => ({ tenant: tenantContext, isLoading: false }),
}));

jest.mock("@/contexts/ActingTenantContext", () => ({
  useActingTenant: () => ({ actingTenant: actingTenantContext }),
}));

jest.mock("@/components/CommandPalette", () => ({
  CommandPalette: () => (
    <button type="button" aria-label="Open command palette">
      Command
    </button>
  ),
}));

jest.mock("@/components/KeyboardShortcutsModal", () => ({
  KeyboardShortcutsModal: () => null,
}));

jest.mock("@/components/ThemeToggle", () => ({
  ThemeToggle: () => (
    <button type="button" aria-label="Toggle theme">
      Theme
    </button>
  ),
}));

jest.mock("@/components/Breadcrumbs", () => ({
  Breadcrumbs: () => <nav aria-label="Breadcrumb">Dashboard</nav>,
}));

jest.mock("@/components/auth/AuthDebugger", () => ({
  AuthDebugger: () => null,
}));

jest.mock("@/components/icons", () => ({
  MenuIcon: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
}));

function withQueryClient(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

function renderLayout(children: ReactNode = <h2>Care dashboard</h2>) {
  return render(withQueryClient(<DashboardLayout>{children}</DashboardLayout>));
}

describe("NL12-S6 admin accessibility completion pack", () => {
  beforeEach(() => {
    pathname = "/dashboard";
    authUser = { uid: "admin-a" };
    tenantContext = { id: "tenant-a", branding: null };
    actingTenantContext = null;
    logout.mockClear();
    localStorage.clear();
  });

  it("pins the dashboard chrome landmarks and skip link", () => {
    renderLayout();

    expect(
      screen.getByRole("link", { name: "Skip to content" }),
    ).toHaveAttribute("href", "#main-content");
    expect(
      screen.getByRole("navigation", { name: "Primary navigation" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(
      screen.getByRole("button", { name: "Open navigation" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("exposes the mobile navigation drawer as a modal dialog", () => {
    renderLayout();

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));

    const drawer = screen.getByRole("dialog", { name: "Mobile navigation" });
    expect(drawer).toHaveAttribute("aria-modal", "true");
    expect(
      screen.getByRole("button", { name: "Close navigation" }),
    ).toBeInTheDocument();
  });

  it("announces critical dashboard announcements as assertive live regions", async () => {
    // The banner is server-persisted (ADM-2) — the display component reads it
    // from the backend, not localStorage.
    fetchAdminAPIMock.mockResolvedValueOnce({
      banner: {
        text: "Oxygen manifold drill at 10:00",
        type: "critical",
        enabled: true,
        updated_at: "2026-07-09T08:00:00.000Z",
      },
    });

    render(withQueryClient(<AnnouncementBanner />));

    const alert = await screen.findByRole("alert", {
      name: "critical announcement",
    });
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveTextContent("Oxygen manifold drill at 10:00");
  });

  it("scopes dismissal state to the signed-in user and tenant", async () => {
    localStorage.setItem(
      "vhhealth-announcement-banner-dismissed",
      "2099-01-01T00:00:00.000Z",
    );
    fetchAdminAPIMock.mockResolvedValueOnce({
      banner: {
        text: "Emergency generator test",
        type: "warning",
        enabled: true,
        updated_at: "2026-08-10T04:00:00.000Z",
      },
    });

    render(withQueryClient(<AnnouncementBanner />));
    await screen.findByRole("status", { name: "warning announcement" });
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss announcement" }),
    );

    expect(
      localStorage.getItem(
        "vhhealth-announcement-banner-dismissed:tenant-a:admin-a",
      ),
    ).toBe("2026-08-10T04:00:00.000Z");
  });

  it("discards an unsaved banner draft when the acting tenant changes", async () => {
    fetchAdminAPIMock
      .mockResolvedValueOnce({
        banner: {
          text: "Tenant A maintenance",
          type: "warning",
          enabled: true,
          updated_at: "2026-08-10T04:00:00.000Z",
        },
      })
      .mockResolvedValueOnce({
        banner: {
          text: "Tenant B fire drill",
          type: "critical",
          enabled: true,
          updated_at: "2026-08-10T05:00:00.000Z",
        },
      });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const manager = () => (
      <QueryClientProvider client={client}>
        <AnnouncementBannerManager />
      </QueryClientProvider>
    );
    const view = render(manager());

    await screen.findByDisplayValue("Tenant A maintenance");
    fireEvent.change(screen.getByDisplayValue("Tenant A maintenance"), {
      target: { value: "Unsaved tenant A draft" },
    });

    actingTenantContext = {
      id: "tenant-b",
      slug: "tenant-b",
      reason: "support",
    };
    view.rerender(manager());

    await waitFor(() => {
      expect(screen.getByDisplayValue("Tenant B fire drill")).toBeInTheDocument();
    });
    expect(screen.queryByDisplayValue("Unsaved tenant A draft")).toBeNull();
  });
});
