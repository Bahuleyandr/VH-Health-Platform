// src/hooks/usePerformanceMonitor.ts
import { useEffect } from 'react';

declare global {
  interface Window {
    gtag?: (
      command: string,
      action: string,
      parameters: Record<string, any>
    ) => void;
  }
}

export function usePerformanceMonitor(componentName: string) {
  useEffect(() => {
    const startTime = performance.now();
    
    return () => {
      const endTime = performance.now();
      const loadTime = endTime - startTime;
      
      // Send to analytics
      if (window.gtag) {
        window.gtag('event', 'timing_complete', {
          name: componentName,
          value: Math.round(loadTime),
        });
      }
    };
  }, [componentName]);
}