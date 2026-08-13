import { render, screen } from "@testing-library/react";
import DashboardRouter from "@/app/(with-auth)/dashboard/DashboardRouter";
import { usePermissions } from "@/hooks/usePermissions";

jest.mock("next/dynamic", () => () => function DynamicAdminDashboard() {
  return "Admin command center";
});

jest.mock("@/hooks/usePermissions", () => ({
  usePermissions: jest.fn(),
}));

jest.mock("@/lib/api/staff", () => ({
  getHRDashboard: jest.fn().mockResolvedValue({
    overview: { active_staff: 2, currently_checked_in: 1 },
    departmentBreakdown: [],
    leaves: { pending: 0 },
  }),
  getStaffList: jest.fn().mockResolvedValue({ staff: [] }),
}));

const mockedUsePermissions = usePermissions as jest.MockedFunction<typeof usePermissions>;

function mockPermissions(overrides: Partial<ReturnType<typeof usePermissions>>) {
  mockedUsePermissions.mockReturnValue({
    user: null,
    rawRole: null,
    role: null,
    permissions: [],
    isSuperAdmin: false,
    isAdmin: false,
    isHR: false,
    isDoctor: false,
    isStaff: false,
    isHROrAbove: false,
    isStaffOrAbove: false,
    loading: false,
    hasPermission: jest.fn(),
    hasAnyPermission: jest.fn(),
    hasAllPermissions: jest.fn(),
    allowed: false,
    roleAllowed: false,
    permsAllowed: false,
    ...overrides,
  });
}

describe("DashboardRouter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows a neutral loading state while permissions resolve", () => {
    mockPermissions({ loading: true });

    render(<DashboardRouter />);

    expect(screen.getByText("Loading dashboard...")).toBeInTheDocument();
  });

  it("renders the admin command center only for admin users", () => {
    mockPermissions({ role: "ADMIN", isAdmin: true, isHROrAbove: true, isStaffOrAbove: true });

    render(<DashboardRouter />);

    expect(screen.getByText("Admin command center")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Doctor Dashboard" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "HR Dashboard" })).not.toBeInTheDocument();
  });

  it("renders the doctor work queue instead of admin controls", () => {
    mockPermissions({ role: "DOCTOR", isDoctor: true, isStaffOrAbove: true });

    render(<DashboardRouter />);

    expect(screen.getByRole("heading", { name: "Doctor Dashboard" })).toBeInTheDocument();
    expect(screen.getByText("Today's Patient Queue")).toBeInTheDocument();
    expect(screen.queryByText("Admin command center")).not.toBeInTheDocument();
  });

  it("renders HR-sensitive links for HR users", () => {
    mockPermissions({ role: "HR", isHR: true, isHROrAbove: true, isStaffOrAbove: true });

    render(<DashboardRouter />);

    expect(screen.getByRole("heading", { name: "HR Dashboard" })).toBeInTheDocument();
    expect(screen.getByText("Leave Approvals")).toBeInTheDocument();
    expect(screen.getByText("Attendance Audit")).toBeInTheDocument();
    expect(screen.getAllByText("Staff Roster").length).toBeGreaterThan(0);
    expect(screen.queryByText("Admin command center")).not.toBeInTheDocument();
  });

  it("renders the least-privileged staff home for staff users", () => {
    mockPermissions({ role: "STAFF", isStaff: true, isStaffOrAbove: true });

    render(<DashboardRouter />);

    expect(screen.getByRole("heading", { name: "My Dashboard" })).toBeInTheDocument();
    expect(screen.getByText("Upload Documents")).toBeInTheDocument();
    expect(screen.queryByText("Leave Approvals")).not.toBeInTheDocument();
  });

  it("does not grant an admin dashboard when the role is unknown", () => {
    mockPermissions({ rawRole: null, role: null });

    render(<DashboardRouter />);

    expect(screen.getByRole("heading", { name: "Dashboard access unavailable" })).toBeInTheDocument();
    expect(screen.queryByText("Admin command center")).not.toBeInTheDocument();
  });
});
