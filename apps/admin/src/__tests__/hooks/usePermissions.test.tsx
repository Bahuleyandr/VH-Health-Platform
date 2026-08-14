import { renderHook } from "@testing-library/react";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/hooks/usePermissions";

jest.mock("@/contexts/AuthContext", () => ({ useAuth: jest.fn() }));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;

describe("usePermissions role identity", () => {
  it("preserves the canonical role while retaining the normalized portal tier", () => {
    mockedUseAuth.mockReturnValue({
      user: {
        role: "PHARMACY_INCHARGE",
        permissions: [],
      },
      loading: false,
    } as unknown as ReturnType<typeof useAuth>);

    const { result } = renderHook(() => usePermissions());

    expect(result.current.rawRole).toBe("PHARMACY_INCHARGE");
    expect(result.current.role).toBe("STAFF");
  });

  it("fails least-privileged for unknown and null roles", () => {
    mockedUseAuth.mockReturnValue({
      user: { role: "UNRECOGNIZED_ROLE", permissions: ["*"] },
      loading: false,
    } as unknown as ReturnType<typeof useAuth>);

    const { result } = renderHook(() => usePermissions());

    expect(result.current.rawRole).toBeNull();
    expect(result.current.role).toBeNull();
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.isStaff).toBe(false);
    expect(result.current.isStaffOrAbove).toBe(false);
    expect(result.current.allowed).toBe(false);
  });

  it("does not turn a wildcard permission into SUPER_ADMIN identity", () => {
    mockedUseAuth.mockReturnValue({
      user: { role: "RECEPTIONIST", permissions: ["*"] },
      loading: false,
    } as unknown as ReturnType<typeof useAuth>);

    const { result } = renderHook(() => usePermissions());

    expect(result.current.isSuperAdmin).toBe(false);
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.hasPermission("anything")).toBe(true);
  });
});
