import { useEffect, useRef } from "preact/hooks";

export interface Socket {
  addEventListener: (
    name: string,
    handler: (event: MessageEvent) => void,
  ) => void;
  removeEventListener: (
    name: string,
    handler: (event: MessageEvent) => void,
  ) => void;
  close: () => void;
  send: (data: string) => void;
}

// Hook that opens and manages a socket created by `createSocket`, then calls
// `onMessage` for each JSON message. It reconnects on close with exponential
// backoff and sends `initializeMessage` whenever a connection opens.
export function useSocket(socketUrl: string): Socket {
  const ws = useRef<Socket | null>(null);
  const closedIntentionally = useRef(false);
  const reconnectAttempt = useRef(0);
  const maxReconnectDelay = 30000; // Maximum delay in ms (30 seconds)

  const connectWebSocket = () => {
    ws.current = new WebSocket(socketUrl);

    ws.current.addEventListener("open", () => {
      console.log("WebSocket opened");
      reconnectAttempt.current = 0; // Reset attempt counter on successful connection
    });
    ws.current.addEventListener("close", () => {
      console.log("WebSocket closed");
      if (closedIntentionally.current) {
        return;
      }

      // Calculate delay with exponential backoff
      const delay = Math.min(
        maxReconnectDelay,
        Math.pow(2, reconnectAttempt.current) - 1,
      );
      reconnectAttempt.current++;

      console.log(
        `Reconnecting in ${delay}ms (attempt ${reconnectAttempt.current})`,
      );
      setTimeout(connectWebSocket, delay);
    });
  };

  useEffect(() => {
    connectWebSocket();

    return () => {
      closedIntentionally.current = true;
      ws.current?.close();
    };
  }, []);

  return {
    addEventListener: (
      name: string,
      handler: (event: MessageEvent) => void,
    ) => {
      ws.current?.addEventListener(name, handler);
    },
    removeEventListener: (
      name: string,
      handler: (event: MessageEvent) => void,
    ) => {
      ws.current?.removeEventListener(name, handler);
    },
    send: (msg: string) => {
      ws.current?.send(msg);
    },
    close: () => {
      closedIntentionally.current = true;
      ws.current?.close();
    },
  };
}
