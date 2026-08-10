import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import EditPermissionsPage from "@/app/(with-auth)/dashboard/admin-management/edit-permissions/[id]/page";
import type { AdminUser } from "@/lib/types";
import { API_ENDPOINTS } from "@/lib/api-config";
import { getJSON, putJSON } from "@/lib/api";
import { usePermissions } from "@/hooks/usePermissions";

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "admin-uid-1" }),
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("@/lib/api", () => ({
  getJSON: jest.fn(),
  putJSON: jest.fn(),
}));

jest.mock("@/hooks/usePermissions", () => ({
  usePermissions: jest.fn(),
}));

const mockedGetJSON = getJSON as jest.MockedFunction<typeof getJSON>;
const mockedPutJSON = putJSON as jest.MockedFunction<typeof putJSON>;
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
    permissions: ["userManagement"],
    last_login: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function mockPermissions(
  overrides: Partial<ReturnType<typeof usePermissions>> = {},
): ReturnType<typeof usePermissions> {
  return {
    user: null,
    rawRole: "SUPER_ADMIN",
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

describe("<EditPermissionsPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUsePermissions.mockReturnValue(mockPermissions());
    mockedGetJSON.mockResolvedValue([makeAdmin()]);
    mockedPutJSON.mockResolvedValue({});
  });

  it("saves permissions via PUT /auth/admin/update-permissions without a stray action field", async () => {
    render(<EditPermissionsPage />);

    await screen.findByText(/Edit Permissions for/);

    fireEvent.click(screen.getByLabelText("Doctor Management"));
    fireEvent.click(screen.getByRole("button", { name: "Save Permissions" }));

    await waitFor(() => expect(mockedPutJSON).toHaveBeenCalledTimes(1));

    const [calledUrl, calledBody] = mockedPutJSON.mock.calls[0];
    expect(calledUrl).toBe(API_ENDPOINTS.auth.admin.updatePermissions);
    expect(calledBody).toEqual({
      adminId: "admin-uid-1",
      permissions: expect.arrayContaining(["userManagement", "doctorManagement"]),
    });
    expect(calledBody).not.toHaveProperty("action");
  });
});
