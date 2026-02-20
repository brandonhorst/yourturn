import { useEffect, useRef } from "preact/hooks";

type MessageListener = (message: string) => void;
type OpenListener = () => void;

export interface Socket {
  // Registers a handler for incoming WebSocket message events.
  addMessageListener: (handler: MessageListener) => void;
  // Removes a previously registered message handler.
  removeMessageListener: (handler: MessageListener) => void;
  // Registers a handler for the WebSocket open event.
  addOpenListener: (handler: OpenListener) => void;
  // Removes a previously registered open handler.
  removeOpenListener: (handler: OpenListener) => void;
  close: () => void;
  send: (data: string) => void;
}

// Hook that opens and manages a socket created by `createSocket`, then calls
// `onMessage` for each JSON message. It reconnects on close with exponential
// backoff and sends `initializeMessage` whenever a connection opens.
export function useSocket(socketUrl: string): Socket {
  const ws = useRef<WebSocket | null>(null);
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
    addMessageListener: (handler: MessageListener) => {
      ws.current?.addEventListener(
        "message",
        (event) => handler(event.data),
      );
    },
    removeMessageListener: (handler: MessageListener) => {
      ws.current?.removeEventListener(
        "message",
        (event) => handler(event.data),
      );
    },
    addOpenListener: (handler: OpenListener) => {
      ws.current?.addEventListener("open", handler);
    },
    removeOpenListener: (handler: OpenListener) => {
      ws.current?.removeEventListener("open", handler);
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
