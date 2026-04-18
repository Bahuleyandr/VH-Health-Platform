// src/hooks/usePerformanceMonitor.ts
"use client";

import { useEffect } from "react";

type OnEntry = (entry: PerformanceEntry) => void;

export function usePerformanceMonitor(
  onEntry?: OnEntry,
  options: PerformanceObserverInit = {
    entryTypes: ["navigation", "resource", "paint"],
  },
) {
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof PerformanceObserver === "undefined"
    )
      return;

    const handleEntries: PerformanceObserverCallback = (
      list /*: PerformanceObserverEntryList*/,
    ) => {
      const entries = list.getEntries(); // correct API on PerformanceObserverEntryList
      for (const entry of entries) {
        onEntry?.(entry);
        // You can branch on entry.entryType if you want:
        // if (entry.entryType === 'navigation') { ... }
      }
    };

    const po = new PerformanceObserver(handleEntries);
    try {
      // Prefer specific types if your TS lib supports them:
      // po.observe({ type: 'largest-contentful-paint', buffered: true });
      // Fallback to provided options:
      po.observe(options);
    } catch {
      // Some browsers throw if unsupported; ignore.
    }

    return () => po.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onEntry, JSON.stringify(options)]);
}
