import { useEffect, useRef } from "preact/hooks";
import type {
  Socket,
  SocketMessageListener,
  SocketOpenListener,
} from "../types.ts";

// Opens and manages one WebSocket connection with reconnect-on-close behavior.
// It exposes add/remove APIs for message/open listeners through the `Socket`
// interface used by the channel hooks.
export function useSocket(socketUrl: string): Socket {
  const ws = useRef<WebSocket | null>(null);
  const closedIntentionally = useRef(false);
  const reconnectAttempt = useRef(0);
  const messageEventHandlers = useRef(
    new Map<SocketMessageListener, (event: MessageEvent) => void>(),
  );
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
    addMessageListener: (handler: SocketMessageListener) => {
      const eventHandler = (event: MessageEvent) => handler(event.data);
      messageEventHandlers.current.set(handler, eventHandler);
      ws.current?.addEventListener("message", eventHandler);
    },
    removeMessageListener: (handler: SocketMessageListener) => {
      const eventHandler = messageEventHandlers.current.get(handler);
      if (eventHandler == null) {
        return;
      }
      ws.current?.removeEventListener("message", eventHandler);
      messageEventHandlers.current.delete(handler);
    },
    addOpenListener: (handler: SocketOpenListener) => {
      ws.current?.addEventListener("open", handler);
    },
    removeOpenListener: (handler: SocketOpenListener) => {
      ws.current?.removeEventListener("open", handler);
    },
    send: (msg: string) => {
      ws.current?.send(msg);
    },
  };
}
