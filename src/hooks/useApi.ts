// src/hooks/useApi.ts
import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/auth';

interface UseApiOptions<T> {
  immediate?: boolean;
  onSuccess?: (data: T) => void;
  onError?: (error: Error) => void;
}

interface UseApiReturn<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useApi<T = unknown>(
  url: string | null,
  options: UseApiOptions<T> = { immediate: true }
): UseApiReturn<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const execute = useCallback(async () => {
    if (!url) return;
    
    try {
      setLoading(true);
      setError(null);
      const response = await api.get<T>(url);
      setData(response.data);
      options.onSuccess?.(response.data);
    } catch (err) {
      const errorObj = err instanceof Error ? err : new Error('An unknown error occurred');
      setError(errorObj);
      options.onError?.(errorObj);
    } finally {
      setLoading(false);
    }
  }, [url, options]);

  useEffect(() => {
    if (options.immediate && url) {
      execute();
    }
  }, [url, options.immediate, execute]);

  return { data, loading, error, refetch: execute };
}