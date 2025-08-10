// src/hooks/useWebSocket.ts
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

type UseWebSocketOptions<T = unknown> = {
  protocols?: string | string[];
  autoReconnect?: boolean;
  reconnectIntervalMs?: number;
  parseJson?: boolean;
  onMessage?: (data: T) => void;
  onOpen?: (ev: Event) => void;
  onClose?: (ev: CloseEvent) => void;
  onError?: (ev: Event) => void;
  /** Optional notifier (e.g., pass `msg => toast(msg)`) */
  toast?: (msg: string) => void;
};

function hasStringMessage(x: unknown): x is { message: string } {
  return typeof x === 'object' && x !== null && typeof (x as Record<string, unknown>).message === 'string';
}

export function useWebSocket<T = unknown>(
  url: string,
  {
    protocols,
    autoReconnect = true,
    reconnectIntervalMs = 2000,
    parseJson = true,
    onMessage,
    onOpen,
    onClose,
    onError,
    toast,
  }: UseWebSocketOptions<T> = {}
) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);

  // Keep callback options in refs so the main effect's deps stay simple
  const onMessageRef = useRef<typeof onMessage>(onMessage);
  const onOpenRef = useRef<typeof onOpen>(onOpen);
  const onCloseRef = useRef<typeof onClose>(onClose);
  const onErrorRef = useRef<typeof onError>(onError);
  const toastRef = useRef<typeof toast>(toast);

  useEffect(() => { onMessageRef.current = onMessage; }, [onMessage]);
  useEffect(() => { onOpenRef.current = onOpen; }, [onOpen]);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => { toastRef.current = toast; }, [toast]);

  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<T | null>(null);

  // Track protocols value in a ref so the effect doesn't reference `protocols` directly
  const protocolsRef = useRef<string | string[] | undefined>(protocols);
  useEffect(() => { protocolsRef.current = protocols; }, [protocols]);

  // Make a simple key so the effect re-runs when protocols change
  const protocolsKey = useMemo(
    () => (Array.isArray(protocols) ? protocols.join(',') : protocols ?? ''),
    [protocols]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const connect = () => {
      const ws = new WebSocket(url, protocolsRef.current);
      wsRef.current = ws;

      ws.addEventListener('open', (ev) => {
        setIsConnected(true);
        onOpenRef.current?.(ev);
      });

      ws.addEventListener('message', (ev) => {
        let payload: unknown = ev.data;
        if (parseJson && typeof payload === 'string') {
          try { payload = JSON.parse(payload); } catch { /* keep raw string */ }
        }

        setLastMessage(payload as T);
        onMessageRef.current?.(payload as T);

        if (toastRef.current && hasStringMessage(payload)) {
          toastRef.current(payload.message);
        }
      });

      ws.addEventListener('close', (ev) => {
        setIsConnected(false);
        onCloseRef.current?.(ev);
        if (autoReconnect) {
          reconnectRef.current = window.setTimeout(connect, reconnectIntervalMs);
        }
      });

      ws.addEventListener('error', (ev) => {
        onErrorRef.current?.(ev);
      });
    };

    connect();

    return () => {
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
    // Static deps; protocols changes are captured via protocolsKey
  }, [url, protocolsKey, autoReconnect, reconnectIntervalMs, parseJson]);

  const send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
    wsRef.current?.send(data);
  };

  const close = () => wsRef.current?.close();

  return { isConnected, lastMessage, send, close };
}
