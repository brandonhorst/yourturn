import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ClientMessage, ServerMessage } from "@/protocol/mod.ts";
import type {
  ChatThreadProps,
  ChatThreadViewData,
  GameTypes,
  Socket,
} from "@/types/mod.ts";

/**
 * Subscribes to one chat thread and streams appended messages to local state.
 */
export function useChatThreadChannel<T extends GameTypes>(
  socket: Socket,
  chatThreadId: string,
  initialChatThreadViewData: ChatThreadViewData<T>,
): ChatThreadProps<T> {
  const [chatMessages, setChatMessages] = useState(
    initialChatThreadViewData.chatMessages,
  );
  const lastMessageIdRef = useRef<string | undefined>(
    initialChatThreadViewData.chatMessages[
      initialChatThreadViewData.chatMessages.length - 1
    ]?.id,
  );

  useEffect(() => {
    setChatMessages(initialChatThreadViewData.chatMessages);
    lastMessageIdRef.current = initialChatThreadViewData.chatMessages[
      initialChatThreadViewData.chatMessages.length - 1
    ]?.id;
  }, [chatThreadId, initialChatThreadViewData]);

  useEffect(() => {
    /**
     * Sends one chat thread subscription with the latest cursor.
     */
    const subscriptionId = crypto.randomUUID();
    function sendSubscribe() {
      const request: ClientMessage<T> = {
        type: "SubscribeChatThread",
        subscriptionId,
        chatThreadId,
        lastMessageId: lastMessageIdRef.current,
      };
      socket.send(JSON.stringify(request));
    }

    function onOpen() {
      sendSubscribe();
    }

    function onMessage(message: string) {
      const response = JSON.parse(message) as ServerMessage<T>;

      switch (response.type) {
        case "AppendChatMessages":
          if (
            response.subscriptionId !== subscriptionId ||
            response.chatThreadId !== chatThreadId
          ) {
            break;
          }

          setChatMessages((previousMessages) => {
            if (response.chatMessages.length === 0) {
              return previousMessages;
            }
            const existingIds = new Set(
              previousMessages.map((chatMessage) => chatMessage.id),
            );
            const nextMessages = response.chatMessages.filter((chatMessage) =>
              !existingIds.has(chatMessage.id)
            );
            if (nextMessages.length === 0) {
              return previousMessages;
            }
            const updatedMessages = [...previousMessages, ...nextMessages];
            lastMessageIdRef.current =
              updatedMessages[updatedMessages.length - 1]?.id;
            return updatedMessages;
          });
          break;
      }
    }

    socket.addMessageListener(onMessage);
    socket.addOpenListener(onOpen);
    try {
      sendSubscribe();
    } catch {
      // The socket may still be connecting; subscription will be sent on open.
    }

    return () => {
      const request: ClientMessage<T> = {
        type: "Unsubscribe",
        subscriptionId,
      };
      try {
        socket.send(JSON.stringify(request));
      } catch {
        // Ignore socket state errors during teardown.
      }
      socket.removeMessageListener(onMessage);
      socket.removeOpenListener(onOpen);
    };
  }, [chatThreadId, socket]);

  const sendChatMessage = useCallback((message: string) => {
    const request: ClientMessage<T> = {
      type: "SendChatMessage",
      chatThreadId,
      message,
    };
    socket.send(JSON.stringify(request));
  }, [chatThreadId, socket]);

  return {
    chatMessages,
    sendChatMessage,
  };
}
