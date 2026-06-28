"use client";

// Snapshot sibling of useRealtimeInvalidation: for channels that broadcast a full
// snapshot (e.g. a cron-fed dashboard payload), push each incoming message straight
// into react-query via setQueryData. Reads `lastMessage` (latest-wins, which is
// exactly the semantics a snapshot wants). The consuming useQuery still owns the
// initial load and the fallback poll.

import { useEffect, useRef } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useRealtimeChannel } from "./useRealtimeChannel";

export function useRealtimeData<T = unknown>(
  channel: string,
  queryKey: QueryKey,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const queryClient = useQueryClient();
  const keyRef = useRef(queryKey);
  keyRef.current = queryKey;
  const lastEventAtRef = useRef<number | null>(null);

  const { lastMessage, connected, subscribed, denied } = useRealtimeChannel<T>(channel, { enabled });

  useEffect(() => {
    if (!lastMessage) return;
    lastEventAtRef.current = lastMessage.receivedAt;
    queryClient.setQueryData(keyRef.current, lastMessage.data);
  }, [lastMessage, queryClient]);

  return { connected, subscribed, denied, lastEventAt: lastEventAtRef.current };
}
