// src/hooks/useApi.ts
"use client";

import { fetchAdminAPI } from "@/lib/api";
import { useCallback } from "react";

/**
 * Valid JSON types that can be sent as request body
 */
type Json =
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null;

/**
 * Custom hook for making API calls with proper typing and error handling.
 * Wraps fetchAdminAPI with React hooks for stable references.
 * 
 * @example
 * const api = useApi();
 * const data = await api.get<UserData>('/users');
 * await api.post('/users', { name: 'John' });
 */
export function useApi() {
  /**
   * Make a GET request
   */
  const get = useCallback(
    async <T = unknown>(path: string, params?: Record<string, unknown>) => {
      // Convert params to query string if provided
      const queryString = params
        ? `?${new URLSearchParams(
            Object.entries(params).map(([k, v]) => [k, String(v)])
          ).toString()}`
        : '';
      
      return fetchAdminAPI<T>(`${path}${queryString}`, { 
        method: "GET" 
      });
    },
    [],
  );

  /**
   * Make a POST request
   */
  const post = useCallback(
    async <T = unknown>(path: string, body?: Json) =>
      fetchAdminAPI<T>(path, {
        method: "POST",
        body, // Pass body directly - fetchAdminAPI handles stringify
      }),
    [],
  );

  /**
   * Make a PUT request
   */
  const put = useCallback(
    async <T = unknown>(path: string, body?: Json) =>
      fetchAdminAPI<T>(path, {
        method: "PUT",
        body, // Pass body directly - fetchAdminAPI handles stringify
      }),
    [],
  );

  /**
   * Make a PATCH request
   */
  const patch = useCallback(
    async <T = unknown>(path: string, body?: Json) =>
      fetchAdminAPI<T>(path, {
        method: "PATCH",
        body, // Pass body directly - fetchAdminAPI handles stringify
      }),
    [],
  );

  /**
   * Make a DELETE request
   */
  const del = useCallback(
    async <T = unknown>(path: string, body?: Json) =>
      fetchAdminAPI<T>(path, {
        method: "DELETE",
        body, // Some DELETE endpoints accept body
      }),
    [],
  );

  return { 
    get, 
    post, 
    put, 
    patch,
    del,
    delete: del, // Alias for convenience
  };
}

/**
 * Type helper for extracting the data type from a Promise
 * @example
 * type UserData = ApiResponse<typeof api.get<User>>;
 */
export type ApiResponse<T> = T extends Promise<infer U> ? U : never;