import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { AdminsTable } from "@/app/(with-auth)/dashboard/admin-management/components/AdminsTable";
import type { AdminUser } from "@/lib/types";
import { API_ENDPOINTS } from "@/lib/api-config";
import { postJSON } from "@/lib/api";
import { usePermissions } from "@/hooks/usePermissions";

jest.mock("@/lib/api", () => ({
  postJSON: jest.fn(),
}));

jest.mock("@/hooks/usePermissions", () => ({
  usePermissions: jest.fn(),
}));

const mockedPostJSON = postJSON as jest.MockedFunction<typeof postJSON>;
const mockedUsePermissions = usePermissions as jest.MockedFunction<typeof usePermissions>;

function makeAdmin(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: 1,
    name: "Dr Meena Iyer",
    email: "meena@vhhealth.app",
    phone: "9999999999",
    is_active: true,
    created_at: "2026-01-01T00:00:00.000Z",
    uid: "admin-uid-1",
    role: "ADMIN",
    permissions: [],
    last_login: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function mockPermissions(
  overrides: Partial<ReturnType<typeof usePermissions>> = {},
): ReturnType<typeof usePermissions> {
  return {
    user: null,
    role: "SUPER_ADMIN",
    permissions: ["*"],
    isSuperAdmin: true,
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
    ...overrides,
  };
}

describe("<AdminsTable />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedPostJSON.mockResolvedValue({});
    mockedUsePermissions.mockReturnValue(mockPermissions());
  });

  it("deactivates an active admin via POST /auth/admin/deactivate", async () => {
    render(<AdminsTable admins={[makeAdmin({ is_active: true })]} />);

    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Deactivate" }));

    await waitFor(() =>
      expect(mockedPostJSON).toHaveBeenCalledWith(API_ENDPOINTS.auth.admin.deactivate, {
        adminId: "admin-uid-1",
        reason: "Deactivated via admin portal",
      }),
    );
  });

  it("reactivates an inactive admin via POST /auth/admin/reactivate", async () => {
    render(<AdminsTable admins={[makeAdmin({ is_active: false })]} />);

    fireEvent.click(screen.getByRole("button", { name: "Reactivate" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reactivate" }));

    await waitFor(() =>
      expect(mockedPostJSON).toHaveBeenCalledWith(API_ENDPOINTS.auth.admin.reactivate, {
        adminId: "admin-uid-1",
      }),
    );
  });
});
