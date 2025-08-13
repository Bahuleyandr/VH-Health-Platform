// src/hooks/useApi.ts
"use client";

import { useCallback } from "react";
import { fetchAdminAPI } from "@/lib/api";

type Json =
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null;

export function useApi() {
  const get = useCallback(
    async <T = unknown>(path: string, init?: RequestInit) =>
      fetchAdminAPI<T>(path, { method: "GET", ...(init ?? {}) }),
    [],
  );

  const post = useCallback(
    async <T = unknown>(path: string, body?: Json, init?: RequestInit) =>
      fetchAdminAPI<T>(path, {
        method: "POST",
        body: body !== undefined ? JSON.stringify(body) : undefined,
        headers: {
          "content-type": "application/json",
          ...(init?.headers ?? {}),
        },
        ...(init ?? {}),
      }),
    [],
  );

  const put = useCallback(
    async <T = unknown>(path: string, body?: Json, init?: RequestInit) =>
      fetchAdminAPI<T>(path, {
        method: "PUT",
        body: body !== undefined ? JSON.stringify(body) : undefined,
        headers: {
          "content-type": "application/json",
          ...(init?.headers ?? {}),
        },
        ...(init ?? {}),
      }),
    [],
  );

  const del = useCallback(
    async <T = unknown>(path: string, init?: RequestInit) =>
      fetchAdminAPI<T>(path, { method: "DELETE", ...(init ?? {}) }),
    [],
  );

  return { get, post, put, del };
}
