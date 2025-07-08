import { useQuery } from '@tanstack/react-query';
import { getDashboardData } from '@/lib/api';
import * as Sentry from "@sentry/nextjs";

export function useDashboardData() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: async () => {
      try {
        const data = await getDashboardData();
        return data;
      } catch (error) {
        Sentry.captureException(error);
        throw error;
      }
    },
    refetchInterval: 30 * 1000, // Refetch every 30 seconds
    retry: 3, // Retry failed requests 3 times
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
  });
}