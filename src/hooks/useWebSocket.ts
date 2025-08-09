'use client';

import { useEffect, useRef, useState } from 'react';

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

  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<T | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const connect = () => {
      const ws = new WebSocket(url, protocols);
      wsRef.current = ws;

      ws.addEventListener('open', ev => {
        setIsConnected(true);
        onOpen?.(ev);
      });

      ws.addEventListener('message', ev => {
        let payload: unknown = ev.data;
        if (parseJson && typeof payload === 'string') {
          try { payload = JSON.parse(payload); } catch { /* ignore */ }
        }
        setLastMessage(payload as T);
        onMessage?.(payload as T);

        // if payload has a "message" field, notify (optional)
        if (toast && payload && typeof payload === 'object' && 'message' in (payload as any)) {
          const m = (payload as any).message;
          if (typeof m === 'string') toast(m);
        }
      });

      ws.addEventListener('close', ev => {
        setIsConnected(false);
        onClose?.(ev);
        if (autoReconnect) {
          reconnectRef.current = window.setTimeout(connect, reconnectIntervalMs);
        }
      });

      ws.addEventListener('error', ev => {
        onError?.(ev);
      });
    };

    connect();

    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    url,
    Array.isArray(protocols) ? protocols.join(',') : protocols,
    autoReconnect,
    reconnectIntervalMs,
    parseJson,
  ]);

  const send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
    wsRef.current?.send(data);
  };

  const close = () => wsRef.current?.close();

  return { isConnected, lastMessage, send, close };
}
