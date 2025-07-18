// src/hooks/use-dashboard.ts
import { useQuery } from '@tanstack/react-query';
import { API_ENDPOINTS } from '@/lib/api-config';

export function useDashboardData() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: async () => {
      // Use the correct endpoint
      const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.users.dashboard}`, {
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
        }
      });
      
      if (!response.ok) {
        throw new Error(`Dashboard fetch failed: ${response.status}`);
      }
      
      return response.json();
    },
  });
}