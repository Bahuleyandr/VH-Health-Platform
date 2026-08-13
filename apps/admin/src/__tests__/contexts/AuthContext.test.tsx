import { render, screen, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { getAdminProfile, getAdminUser } from "@/lib/api-client";

const push = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

jest.mock("@/lib/api-client", () => ({
  adminLogin: jest.fn(),
  staffLogin: jest.fn(),
  adminLogout: jest.fn(),
  getAdminProfile: jest.fn(),
  getAdminUser: jest.fn(),
  clearAuthData: jest.fn(),
  verifyAdminMfa: jest.fn(),
  adminMfaSetupEnroll: jest.fn(),
  adminMfaSetupConfirm: jest.fn(),
}));

const mockedGetAdminProfile = getAdminProfile as jest.MockedFunction<typeof getAdminProfile>;
const mockedGetAdminUser = getAdminUser as jest.MockedFunction<typeof getAdminUser>;

function Probe() {
  const { user, loading } = useAuth();
  return <div>{loading ? "loading" : user?.name ?? "signed out"}</div>;
}

describe("AuthProvider profile probing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("probes the cookie-backed profile when no cache exists", async () => {
    mockedGetAdminUser.mockReturnValue(null);
    mockedGetAdminProfile.mockResolvedValue({
      uid: "admin-1",
      id: 1,
      name: "Cookie Admin",
      email: "admin@example.com",
      phone: "0000000000",
      is_active: true,
      created_at: "2026-01-01",
      role: "ADMIN",
      permissions: [],
    });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText("Cookie Admin")).toBeInTheDocument());
    expect(mockedGetAdminProfile).toHaveBeenCalledTimes(1);
  });

  it("fails signed-out when neither cache nor profile is valid", async () => {
    mockedGetAdminUser.mockReturnValue(null);
    mockedGetAdminProfile.mockRejectedValue(new Error("Unauthorized"));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText("signed out")).toBeInTheDocument());
  });
});
