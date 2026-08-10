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
});
