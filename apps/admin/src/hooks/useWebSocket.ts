// src/hooks/useWebSocket.ts
"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";

type UseWebSocketOptions<T = unknown> = {
  protocols?: string | string[];
  autoReconnect?: boolean;
  reconnectIntervalMs?: number;
  maxReconnectAttempts?: number;
  exponentialBackoff?: boolean;
  parseJson?: boolean;
  onMessage?: (data: T) => void;
  onOpen?: (ev: Event) => void;
  onClose?: (ev: CloseEvent) => void;
  onError?: (ev: Event) => void;
  onReconnect?: (attempt: number) => void;
  /** Optional notifier (e.g., pass `msg => toast(msg)`) */
  toast?: (msg: string) => void;
  /** Include auth token in connection */
  authenticated?: boolean;
  /** Enable message queueing when disconnected */
  enableQueue?: boolean;
  /** Max messages to queue */
  maxQueueSize?: number;
};

type ConnectionState = "connecting" | "connected" | "disconnected" | "error";
type WebSocketSendData = string | Blob | BufferSource;

function hasStringMessage(x: unknown): x is { message: string } {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as Record<string, unknown>).message === "string"
  );
}

export function useWebSocket<T = unknown>(
  url: string,
  {
    protocols,
    autoReconnect = true,
    reconnectIntervalMs = 2000,
    maxReconnectAttempts = 10,
    exponentialBackoff = true,
    parseJson = true,
    onMessage,
    onOpen,
    onClose,
    onError,
    onReconnect,
    toast,
    authenticated = false,
    enableQueue = true,
    maxQueueSize = 100,
  }: UseWebSocketOptions<T> = {},
) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const messageQueueRef = useRef<WebSocketSendData[]>([]);
  const isManualCloseRef = useRef(false);

  // Keep callback options in refs so the main effect's deps stay simple
  const onMessageRef = useRef<typeof onMessage>(onMessage);
  const onOpenRef = useRef<typeof onOpen>(onOpen);
  const onCloseRef = useRef<typeof onClose>(onClose);
  const onErrorRef = useRef<typeof onError>(onError);
  const onReconnectRef = useRef<typeof onReconnect>(onReconnect);
  const toastRef = useRef<typeof toast>(toast);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);
  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  useEffect(() => {
    onReconnectRef.current = onReconnect;
  }, [onReconnect]);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [lastMessage, setLastMessage] = useState<T | null>(null);
  const [lastError, setLastError] = useState<Event | null>(null);
  const [reconnectCount, setReconnectCount] = useState(0);

  // Track protocols value in a ref so the effect doesn't reference `protocols` directly
  const protocolsRef = useRef<string | string[] | undefined>(protocols);
  useEffect(() => {
    protocolsRef.current = protocols;
  }, [protocols]);

  // Make a simple key so the effect re-runs when protocols change
  const protocolsKey = useMemo(
    () => (Array.isArray(protocols) ? protocols.join(",") : (protocols ?? "")),
    [protocols],
  );

  // Calculate reconnect delay with exponential backoff
  const getReconnectDelay = useCallback((attempt: number) => {
    if (!exponentialBackoff) return reconnectIntervalMs;
    // Exponential backoff: 2s, 4s, 8s, 16s, 32s, then cap at 60s
    const delay = Math.min(reconnectIntervalMs * Math.pow(2, attempt), 60000);
    return delay + Math.random() * 1000; // Add jitter to prevent thundering herd
  }, [exponentialBackoff, reconnectIntervalMs]);

  // Process queued messages when connected
  const processMessageQueue = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    
    while (messageQueueRef.current.length > 0) {
      const message = messageQueueRef.current.shift();
      if (message) {
        try {
          wsRef.current.send(message);
        } catch {
          // Put it back if send fails
          messageQueueRef.current.unshift(message);
          break;
        }
      }
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const connect = () => {
      try {
        setConnectionState("connecting");
        
        // Auth tokens are in httpOnly cookies — cannot be read by JS.
        // Authentication is handled server-side via the cookie on the upgrade request.
        // If the server requires explicit auth message, send it in the onopen handler.
        const ws = new WebSocket(url, protocolsRef.current);
        wsRef.current = ws;

        // Set connection timeout
        const connectionTimeout = setTimeout(() => {
          if (ws.readyState === WebSocket.CONNECTING) {
            ws.close();
            setConnectionState("error");
            setLastError(new Event("Connection timeout"));
          }
        }, 10000); // 10 second timeout

        ws.addEventListener("open", (ev) => {
          clearTimeout(connectionTimeout);
          setConnectionState("connected");
          reconnectAttemptsRef.current = 0;
          setReconnectCount(0);
          isManualCloseRef.current = false;
          
          // Process any queued messages
          if (enableQueue) {
            processMessageQueue();
          }
          
          onOpenRef.current?.(ev);
        });

        ws.addEventListener("message", (ev) => {
          let payload: unknown = ev.data;
          if (parseJson && typeof payload === "string") {
            try {
              payload = JSON.parse(payload);
            } catch {
              /* keep raw string */
            }
          }

          setLastMessage(payload as T);
          onMessageRef.current?.(payload as T);

          if (toastRef.current && hasStringMessage(payload)) {
            toastRef.current(payload.message);
          }
        });

        ws.addEventListener("close", (ev) => {
          clearTimeout(connectionTimeout);
          setConnectionState("disconnected");
          onCloseRef.current?.(ev);
          
          // Only attempt reconnect if not manually closed and autoReconnect is enabled
          if (autoReconnect && !isManualCloseRef.current) {
            if (reconnectAttemptsRef.current < maxReconnectAttempts) {
              reconnectAttemptsRef.current++;
              setReconnectCount(reconnectAttemptsRef.current);
              
              const delay = getReconnectDelay(reconnectAttemptsRef.current - 1);
              onReconnectRef.current?.(reconnectAttemptsRef.current);
              
              reconnectRef.current = window.setTimeout(connect, delay);
            } else {
              // Max reconnection attempts reached
              setConnectionState("error");
              setLastError(new Event("Max reconnection attempts reached"));
              toastRef.current?.("Connection lost. Please refresh the page.");
            }
          }
        });

        ws.addEventListener("error", (ev) => {
          clearTimeout(connectionTimeout);
          setConnectionState("error");
          setLastError(ev);
          onErrorRef.current?.(ev);
        });
      } catch (error) {
        setConnectionState("error");
        setLastError(new Event(error instanceof Error ? error.message : "Connection failed"));
        
        // Schedule reconnection attempt
        if (autoReconnect && reconnectAttemptsRef.current < maxReconnectAttempts) {
          reconnectAttemptsRef.current++;
          setReconnectCount(reconnectAttemptsRef.current);
          const delay = getReconnectDelay(reconnectAttemptsRef.current - 1);
          reconnectRef.current = window.setTimeout(connect, delay);
        }
      }
    };

    connect();

    return () => {
      isManualCloseRef.current = true;
      if (reconnectRef.current) {
        window.clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
    // Static deps; protocols changes are captured via protocolsKey
  }, [
    url,
    protocolsKey,
    autoReconnect,
    reconnectIntervalMs,
    maxReconnectAttempts,
    parseJson,
    authenticated,
    enableQueue,
    getReconnectDelay,
    processMessageQueue,
  ]);

  const send = useCallback((data: WebSocketSendData) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(data);
        return true;
      } catch (error) {
        console.error("WebSocket send error:", error);
        
        // Queue the message if queueing is enabled
        if (enableQueue && messageQueueRef.current.length < maxQueueSize) {
          messageQueueRef.current.push(data);
          return false; // Queued, not sent
        }
        throw error;
      }
    } else if (enableQueue && messageQueueRef.current.length < maxQueueSize) {
      // Queue message if disconnected
      messageQueueRef.current.push(data);
      return false; // Queued, not sent
    }
    
    throw new Error("WebSocket is not connected");
  }, [enableQueue, maxQueueSize]);

  const sendJson = useCallback((data: unknown) => {
    return send(JSON.stringify(data));
  }, [send]);

  const close = useCallback((code?: number, reason?: string) => {
    isManualCloseRef.current = true;
    if (reconnectRef.current) {
      window.clearTimeout(reconnectRef.current);
      reconnectRef.current = null;
    }
    wsRef.current?.close(code, reason);
  }, []);

  const reconnect = useCallback(() => {
    close();
    isManualCloseRef.current = false;
    reconnectAttemptsRef.current = 0;
    setReconnectCount(0);
    // The close event handler will trigger reconnection
  }, [close]);

  const clearQueue = useCallback(() => {
    messageQueueRef.current = [];
  }, []);

  const getQueueSize = useCallback(() => {
    return messageQueueRef.current.length;
  }, []);

  // Computed states
  const isConnected = connectionState === "connected";
  const isConnecting = connectionState === "connecting";
  const isDisconnected = connectionState === "disconnected";
  const hasError = connectionState === "error";

  return {
    // Connection state
    isConnected,
    isConnecting,
    isDisconnected,
    hasError,
    connectionState,
    
    // Data
    lastMessage,
    lastError,
    
    // Reconnection info
    reconnectCount,
    isReconnecting: isDisconnected && reconnectCount > 0,
    
    // Methods
    send,
    sendJson,
    close,
    reconnect,
    
    // Queue management
    clearQueue,
    getQueueSize,
    queuedMessages: getQueueSize(),
    
    // WebSocket instance (advanced usage)
    ws: wsRef.current,
  };
}

// Re-export for backward compatibility
export type { UseWebSocketOptions, ConnectionState };
