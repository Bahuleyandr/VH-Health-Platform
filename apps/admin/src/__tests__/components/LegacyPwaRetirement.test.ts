import {
  LEGACY_PWA_RETIREMENT_KEY,
  isLegacyAdminCache,
  retireLegacyPwa,
  type LegacyPwaRetirementEnvironment,
} from "@/components/LegacyPwaRetirement";

function registration(scriptURL: string, unregister: jest.Mock) {
  return {
    active: { scriptURL },
    unregister,
  };
}

describe("legacy Admin PWA retirement", () => {
  it("removes only the legacy Admin worker and known Workbox caches", async () => {
    const unregisterLegacy = jest.fn().mockResolvedValue(true);
    const unregisterUnrelated = jest.fn().mockResolvedValue(true);
    const deleteCache = jest.fn().mockResolvedValue(true);
    const marker = new Map<string, string>();
    const environment: LegacyPwaRetirementEnvironment = {
      origin: "https://admin.vhhealth.app",
      storage: {
        getItem: (key) => marker.get(key) ?? null,
        setItem: (key, value) => void marker.set(key, value),
      },
      registrations: async () => [
        registration(
          "https://admin.vhhealth.app/sw.js?legacy=1",
          unregisterLegacy,
        ),
        registration(
          "https://admin.vhhealth.app/notifications-worker.js",
          unregisterUnrelated,
        ),
      ],
      cacheNames: async () => [
        "pages",
        "workbox-precache-v2-https://admin.vhhealth.app/",
        "hospital-offline-forms",
      ],
      deleteCache,
    };

    await retireLegacyPwa(environment);

    expect(unregisterLegacy).toHaveBeenCalledTimes(1);
    expect(unregisterUnrelated).not.toHaveBeenCalled();
    expect(deleteCache.mock.calls.map(([name]) => name)).toEqual([
      "pages",
      "workbox-precache-v2-https://admin.vhhealth.app/",
    ]);
    expect(marker.get(LEGACY_PWA_RETIREMENT_KEY)).toBe("complete");

    await retireLegacyPwa(environment);
    expect(unregisterLegacy).toHaveBeenCalledTimes(1);
    expect(deleteCache).toHaveBeenCalledTimes(2);
  });

  it("does not claim completion when a targeted cleanup fails", async () => {
    const setItem = jest.fn();
    await expect(
      retireLegacyPwa({
        origin: "https://admin.vhhealth.app",
        storage: { getItem: () => null, setItem },
        registrations: async () => [],
        cacheNames: async () => ["apis"],
        deleteCache: async () => {
          throw new Error("cache locked");
        },
      }),
    ).rejects.toThrow("cache locked");
    expect(setItem).not.toHaveBeenCalled();
  });

  it("does not treat arbitrary application caches as retired Workbox output", () => {
    expect(isLegacyAdminCache("static-image-assets")).toBe(true);
    expect(isLegacyAdminCache("hospital-offline-forms")).toBe(false);
    expect(isLegacyAdminCache("workbox-runtime-other-app")).toBe(false);
  });

  it("detects a legacy worker in any registration lifecycle slot", async () => {
    const unregister = jest.fn().mockResolvedValue(true);
    await retireLegacyPwa({
      origin: "https://admin.vhhealth.app",
      storage: { getItem: () => null, setItem: () => undefined },
      registrations: async () => [
        {
          active: {
            scriptURL: "https://admin.vhhealth.app/notifications-worker.js",
          },
          waiting: { scriptURL: "https://admin.vhhealth.app/sw.js" },
          unregister,
        },
      ],
      cacheNames: async () => [],
      deleteCache: async () => false,
    });

    expect(unregister).toHaveBeenCalledTimes(1);
  });
});
