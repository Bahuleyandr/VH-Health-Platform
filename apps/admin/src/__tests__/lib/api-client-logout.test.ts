/**
 * Tests for adminLogout in src/lib/api-client.ts (audit R12, admin half).
 *
 * The old implementation swallowed a genuine backend logout failure (e.g. a
 * 500 when the durable revocation store is down) and reported nothing — the
 * admin was told they were signed out while the server-side session token
 * could still be alive. adminLogout now:
 *   - still clears local state (cookie route + profile cache) in EVERY case,
 *   - but reports { serverSignOutOk: false, serverSignOutError } when the
 *     backend call failed, so the UI can surface the failure honestly.
 */

const postJSONMock = jest.fn();

jest.mock("@/lib/api", () => {
  const actual = jest.requireActual("@/lib/api");
  return {
    ...actual,
    postJSON: (...args: unknown[]) => postJSONMock(...args),
  };
});

import { adminLogout } from "@/lib/api-client";

describe("adminLogout server-side sign-out honesty", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    postJSONMock.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;
    localStorage.setItem(
      "adminUser",
      JSON.stringify({ id: 1, name: "Admin", role: "ADMIN", permissions: [] }),
    );
  });

  it("reports serverSignOutOk=true and clears local state on backend success", async () => {
    postJSONMock.mockResolvedValueOnce({});

    const result = await adminLogout();

    expect(result.serverSignOutOk).toBe(true);
    expect(result.serverSignOutError).toBeUndefined();
    // Local cookie route was still invoked and the profile cache cleared.
    expect(fetchMock).toHaveBeenCalledWith("/api/logout", { method: "POST" });
    expect(localStorage.getItem("adminUser")).toBeNull();
  });

  it("reports serverSignOutOk=false (not a silent success) when the backend logout 500s", async () => {
    postJSONMock.mockRejectedValueOnce(new Error("Failed to logout"));

    const result = await adminLogout();

    expect(result.serverSignOutOk).toBe(false);
    expect(result.serverSignOutError).toContain("Failed to logout");
    // Local state is STILL cleared — this browser forgets the session either way.
    expect(fetchMock).toHaveBeenCalledWith("/api/logout", { method: "POST" });
    expect(localStorage.getItem("adminUser")).toBeNull();
  });

  it("does not throw when both the backend and the cookie route fail, but reports the failure", async () => {
    postJSONMock.mockRejectedValueOnce(new Error("network down"));
    fetchMock.mockRejectedValueOnce(new Error("cookie route down"));

    const result = await adminLogout();

    expect(result.serverSignOutOk).toBe(false);
    expect(localStorage.getItem("adminUser")).toBeNull();
  });
});
