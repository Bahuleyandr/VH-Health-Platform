// src/hooks/usePerformanceMonitor.ts
'use client';

import { useEffect, useRef } from 'react';

export type WebVitalsMetric = {
  name: string; // e.g., 'CLS', 'LCP', 'FID', 'FCP', 'TTFB', 'INP'
  id: string;
  value: number;
  delta?: number;
  rating?: 'good' | 'needs-improvement' | 'poor';
};

type Metric = PerformanceEntry | WebVitalsMetric;

type UsePerformanceMonitorOptions = {
  /** Called for each metric or performance entry observed */
  onReport?: (metric: Metric) => void;
  /** Whether to log to console (for quick debugging). Default: false */
  log?: boolean;
};

/**
 * Lightweight performance monitor:
 * - Observes key PerformanceEntry types (LCP, FID, CLS, navigation, resource, longtask)
 * - Allows reporting custom Web Vitals-like metrics via the returned `report` function
 * - No `any` types; safe across SSR/CSR
 */
export function usePerformanceMonitor(options: UsePerformanceMonitorOptions = {}) {
  const { onReport, log = false } = options;
  const reportRef = useRef<typeof onReport>(onReport);

  useEffect(() => {
    reportRef.current = onReport;
  }, [onReport]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return;

    const handleEntries = (entries: PerformanceEntryList) => {
      for (const entry of entries.getEntries()) {
        if (log) {
           
          console.debug('[perf]', entry.entryType, entry.name, entry.startTime, entry.duration);
        }
        reportRef.current?.(entry);
      }
    };

    const po = new PerformanceObserver(handleEntries);
    try {
      // Observe common entry types; unsupported ones will simply be ignored.
      po.observe({
        entryTypes: [
          'largest-contentful-paint',
          'first-input',
          'layout-shift',
          'navigation',
          'resource',
          'longtask',
        ],
      });
    } catch {
      // Silently ignore if the browser/runtime doesn't support one of the entryTypes
    }

    return () => {
      try {
        po.disconnect();
      } catch {
        /* noop */
      }
    };
  }, [log]);

  /**
   * Allows reporting custom Web Vitals-style metrics from elsewhere,
   * e.g., after computing INP or custom marks.
   */
  const report = (metric: WebVitalsMetric) => {
    if (log) {
       
      console.debug('[perf:custom]', metric.name, metric.value, metric);
    }
    reportRef.current?.(metric);
  };

  return { report };
}
