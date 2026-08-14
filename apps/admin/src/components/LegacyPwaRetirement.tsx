"use client";

import { useEffect } from "react";

export const LEGACY_PWA_RETIREMENT_KEY = "vhhealth-admin:pwa-retirement:v1";

const LEGACY_WORKBOX_CACHE_NAMES = new Set([
  "apis",
  "cross-origin",
  "google-fonts-stylesheets",
  "google-fonts-webfonts",
  "next-data",
  "next-image",
  "next-static-js-assets",
  "pages",
  "pages-rsc",
  "pages-rsc-prefetch",
  "start-url",
  "static-audio-assets",
  "static-data-assets",
  "static-font-assets",
  "static-image-assets",
  "static-js-assets",
  "static-style-assets",
  "static-video-assets",
]);

type LegacyRegistration = Pick<ServiceWorkerRegistration, "unregister"> & {
  active?: Pick<ServiceWorker, "scriptURL"> | null;
  installing?: Pick<ServiceWorker, "scriptURL"> | null;
  waiting?: Pick<ServiceWorker, "scriptURL"> | null;
};

export interface LegacyPwaRetirementEnvironment {
  origin: string;
  storage: Pick<Storage, "getItem" | "setItem">;
  registrations: () => Promise<readonly LegacyRegistration[]>;
  cacheNames: () => Promise<readonly string[]>;
  deleteCache: (cacheName: string) => Promise<boolean>;
}

export function isLegacyAdminServiceWorker(
  registration: LegacyRegistration,
  origin: string,
): boolean {
  return [
    registration.active?.scriptURL,
    registration.waiting?.scriptURL,
    registration.installing?.scriptURL,
  ].some((scriptUrl) => {
    if (!scriptUrl) return false;
    try {
      const url = new URL(scriptUrl);
      return url.origin === origin && url.pathname === "/sw.js";
    } catch {
      return false;
    }
  });
}

export function isLegacyAdminCache(cacheName: string, origin: string): boolean {
  const legacyPrecacheName = `workbox-precache-v2-${new URL("/", origin).href}`;
  return (
    LEGACY_WORKBOX_CACHE_NAMES.has(cacheName) ||
    cacheName === legacyPrecacheName
  );
}

export async function retireLegacyPwa(
  environment: LegacyPwaRetirementEnvironment,
): Promise<void> {
  try {
    if (environment.storage.getItem(LEGACY_PWA_RETIREMENT_KEY) === "complete") {
      return;
    }
  } catch {
    // Storage can be unavailable in privacy modes. Retirement must still run.
  }

  const [registrations, cacheNames] = await Promise.all([
    environment.registrations(),
    environment.cacheNames(),
  ]);
  const legacyRegistrations = registrations.filter((registration) =>
    isLegacyAdminServiceWorker(registration, environment.origin),
  );
  const legacyCacheNames = cacheNames.filter((cacheName) =>
    isLegacyAdminCache(cacheName, environment.origin),
  );

  const cleanupOperations = [
    ...legacyRegistrations.map((registration, index) => ({
      label: `legacy Admin service worker ${index + 1}`,
      run: () => registration.unregister(),
    })),
    ...legacyCacheNames.map((cacheName) => ({
      label: `legacy Admin cache ${cacheName}`,
      run: () => environment.deleteCache(cacheName),
    })),
  ];
  const cleanupResults = await Promise.all(
    cleanupOperations.map(({ run }) => run()),
  );
  const failedOperations = cleanupOperations
    .filter((_, index) => cleanupResults[index] !== true)
    .map(({ label }) => label);
  if (failedOperations.length > 0) {
    throw new Error(
      `Legacy Admin PWA cleanup returned false for: ${failedOperations.join(", ")}`,
    );
  }

  try {
    environment.storage.setItem(LEGACY_PWA_RETIREMENT_KEY, "complete");
  } catch {
    // A missing marker only means the narrowly-scoped retirement may retry.
  }
}

export function LegacyPwaRetirement() {
  useEffect(() => {
    const serviceWorker = navigator.serviceWorker;
    const cacheStorage = window.caches;
    let storage: Pick<Storage, "getItem" | "setItem">;
    try {
      storage = window.localStorage;
    } catch {
      storage = {
        getItem: () => null,
        setItem: () => undefined,
      };
    }

    void retireLegacyPwa({
      origin: window.location.origin,
      storage,
      registrations: () =>
        serviceWorker ? serviceWorker.getRegistrations() : Promise.resolve([]),
      cacheNames: () =>
        cacheStorage ? cacheStorage.keys() : Promise.resolve([]),
      deleteCache: (cacheName) =>
        cacheStorage ? cacheStorage.delete(cacheName) : Promise.resolve(false),
    }).catch((error: unknown) => {
      console.warn("Legacy Admin PWA retirement failed", error);
    });
  }, []);

  return null;
}
