import { useEffect, useRef } from "preact/hooks";
import type {
  Socket,
  SocketMessageListener,
  SocketOpenListener,
} from "@/types/mod.ts";

const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

/**
 * Opens and manages one websocket with reconnect-on-close behavior.
 */
export function useSocket(socketUrl: string): Socket {
  const ws = useRef<WebSocket | null>(null);
  const messageListeners = useRef(new Set<SocketMessageListener>());
  const openListeners = useRef(new Set<SocketOpenListener>());
  const socketApi = useRef<Socket | null>(null);

  useEffect(() => {
    let closedIntentionally = false;
    let reconnectAttempt = 0;
    let reconnectTimer: number | null = null;

    /**
     * Broadcasts websocket messages to all registered message listeners.
     */
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        return;
      }

      for (const listener of messageListeners.current) {
        listener(event.data);
      }
    };

    /**
     * Resets reconnect backoff and notifies current open listeners.
     */
    const onOpen = () => {
      reconnectAttempt = 0;
      for (const listener of openListeners.current) {
        listener();
      }
    };

    /**
     * Connects one websocket and schedules reconnects when needed.
     */
    const connectWebSocket = () => {
      if (closedIntentionally) {
        return;
      }

      const socket = new WebSocket(socketUrl);
      ws.current = socket;

      socket.addEventListener("message", onMessage);
      socket.addEventListener("open", onOpen);
      socket.addEventListener("close", () => {
        if (closedIntentionally) {
          return;
        }

        const delay = Math.min(
          MAX_RECONNECT_DELAY_MS,
          BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempt),
        );
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(connectWebSocket, delay);
      });
    };

    connectWebSocket();

    return () => {
      closedIntentionally = true;
      if (reconnectTimer != null) {
        clearTimeout(reconnectTimer);
      }
      ws.current?.close();
      ws.current = null;
    };
  }, [socketUrl]);

  /**
   * Lazily initializes one stable socket API object for the hook lifetime.
   */
  if (socketApi.current == null) {
    socketApi.current = {
      addMessageListener: (handler: SocketMessageListener) => {
        messageListeners.current.add(handler);
      },
      removeMessageListener: (handler: SocketMessageListener) => {
        messageListeners.current.delete(handler);
      },
      addOpenListener: (handler: SocketOpenListener) => {
        openListeners.current.add(handler);
      },
      removeOpenListener: (handler: SocketOpenListener) => {
        openListeners.current.delete(handler);
      },
      send: (msg: string) => {
        ws.current?.send(msg);
      },
    };
  }

  return socketApi.current;
}
