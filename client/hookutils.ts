import { useEffect, useRef } from "preact/hooks";

export interface Socket {
  addEventListener: (
    name: string,
    handler: (event: MessageEvent) => void,
  ) => void;
  close: () => void;
  send: (data: string) => void;
}

// Hook that opens and manages a WebSocket connection to `socketUrl`, and calls `onUpdate` for JSON messages
// Automatically reconnects on close with exponential backoff. Whenever a socket opens
// it will send `initializeMessage,` if provided.
export function useSocket<Req, Res>(
  shouldOpen: boolean,
  createSocket: () => Socket,
  initializeMessage: Req,
  onMessage: (res: Res, close: () => void) => void,
  onClose?: () => void,
): (request: Req) => void {
  const ws = useRef<Socket | null>(null);
  const closedIntentionally = useRef(false);
  const reconnectAttempt = useRef(0);
  const maxReconnectDelay = 30000; // Maximum delay in ms (30 seconds)

  const close = () => {
    closedIntentionally.current = true;
    ws.current?.close();
  };

  const connectWebSocket = () => {
    ws.current = createSocket();

    ws.current.addEventListener("open", () => {
      console.log("WebSocket opened");
      reconnectAttempt.current = 0; // Reset attempt counter on successful connection
      if (initializeMessage != null) {
        ws.current?.send(JSON.stringify(initializeMessage));
      }
    });
    ws.current.addEventListener("message", (event) => {
      const newValue = JSON.parse(event.data);
      onMessage(newValue, close);
    });
    ws.current.addEventListener("close", () => {
      onClose?.();
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
    if (shouldOpen) {
      connectWebSocket();

      return () => {
        closedIntentionally.current = true;
        ws.current?.close();
      };
    } else {
      return () => {};
    }
  }, []);

  return (request: Req) => {
    ws.current?.send(JSON.stringify(request));
  };
}
