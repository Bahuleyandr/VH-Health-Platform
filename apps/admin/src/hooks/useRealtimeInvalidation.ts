"use client";

// Turns a polled react-query dashboard into a real-time-first one: subscribe to
// a VHHealth real-time channel and invalidate the given query keys on every
// event (react-query then refetches through the existing query functions).
// Pairs with a dynamic poll fallback in the consumer (real-time when WS is up;
// the consumer keeps a slow safety poll for the at-most-once bus). Generic — no
// per-dashboard logic. The reusable unit for the real-time-dashboards epic.
import { useCallback, useRef } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useRealtimeChannel, type RealtimeMessage } from "./useRealtimeChannel";

export function useRealtimeInvalidation(
  channel: string,
  queryKeys: QueryKey[],
  { enabled = true }: { enabled?: boolean } = {},
) {
  const queryClient = useQueryClient();
  const lastEventAtRef = useRef<number | null>(null);

  // Stable onEvent — invalidate every passed key. queryKeys may be a new array
  // each render; read it from a ref so the callback identity stays stable and
  // we don't churn the WS effect (which keys on `channel`/`enabled` only).
  const keysRef = useRef(queryKeys);
  keysRef.current = queryKeys;

  const onEvent = useCallback(
    (_msg: RealtimeMessage) => {
      lastEventAtRef.current = Date.now();
      for (const key of keysRef.current) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
    [queryClient],
  );

  const { connected, subscribed, denied } = useRealtimeChannel(channel, { enabled, onEvent });

  return { connected, subscribed, denied, lastEventAt: lastEventAtRef.current };
}
