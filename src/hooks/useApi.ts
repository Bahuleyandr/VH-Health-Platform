// src/hooks/useApi.ts
import { useState, useEffect } from 'react';
import { api } from '@/lib/auth';

interface UseApiOptions {
  immediate?: boolean;
  onSuccess?: (data: any) => void;
  onError?: (error: any) => void;
}

export function useApi<T = any>(
  url: string | null,
  options: UseApiOptions = { immediate: true }
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<any>(null);

  const execute = async () => {
    if (!url) return;

    try {
      setLoading(true);
      setError(null);
      const response = await api.get<T>(url);
      setData(response.data);
      options.onSuccess?.(response.data);
    } catch (err) {
      setError(err);
      options.onError?.(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (options.immediate && url) {
      execute();
    }
  }, [url]);

  return { data, loading, error, refetch: execute };
}