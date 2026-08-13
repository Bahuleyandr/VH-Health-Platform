import { act, renderHook } from "@testing-library/react";
import * as Sentry from "@sentry/nextjs";
import { toast } from "react-hot-toast";
import { useIdleTimeout } from "@/hooks/useIdleTimeout";
import {
  adminLogout,
  clearAuthData,
  IDLE_SIGN_OUT_WARNING_KEY,
} from "@/lib/api-client";

const push = jest.fn();

jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
jest.mock("@/lib/api-client", () => ({
  adminLogout: jest.fn(),
  clearAuthData: jest.fn(),
  IDLE_SIGN_OUT_WARNING_KEY: "vh:idle-sign-out-warning",
}));
jest.mock("@sentry/nextjs", () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

const mockedAdminLogout = adminLogout as jest.MockedFunction<
  typeof adminLogout
>;
const mockedClearAuthData = clearAuthData as jest.MockedFunction<
  typeof clearAuthData
>;

describe("useIdleTimeout", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    sessionStorage.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("revokes the backend session before local cleanup and redirect", async () => {
    mockedAdminLogout.mockResolvedValue({ serverSignOutOk: true });
    renderHook(() => useIdleTimeout(100));

    await act(async () => {
      jest.advanceTimersByTime(100);
      await Promise.resolve();
    });

    expect(mockedAdminLogout).toHaveBeenCalledTimes(1);
    expect(mockedClearAuthData).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/login?reason=idle");
  });

  it("surfaces and records a backend revocation failure while clearing locally", async () => {
    mockedAdminLogout.mockResolvedValue({
      serverSignOutOk: false,
      serverSignOutError: "revocation store unavailable",
    });
    renderHook(() => useIdleTimeout(100));

    await act(async () => {
      jest.advanceTimersByTime(100);
      await Promise.resolve();
    });

    expect(sessionStorage.getItem(IDLE_SIGN_OUT_WARNING_KEY)).toMatch(
      /revocation failed/i,
    );
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      "Idle sign-out backend revocation failed",
      expect.objectContaining({ level: "error" }),
    );
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/revocation failed/i),
      { duration: 10000 },
    );
    expect(mockedClearAuthData).toHaveBeenCalledTimes(1);
  });
});
