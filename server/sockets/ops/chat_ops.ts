import { ulid } from "@std/ulid";
import { logServer, serializeLogValue } from "@/server/logging.ts";
import type { ChatMessage, GameTypes, PlayerSnapshot } from "@/types/mod.ts";
import type { ChatSocketOps, UnsubscribeSubscription } from "../contracts.ts";
import type { SocketStoreContext } from "../context.ts";
import type { ChatThreadSubscriptionState } from "../state.ts";
import { closeReader, sendServerMessage } from "../wire.ts";

const SOCKET_CHAT_LOG_MODULE = "server.sockets.chat";

/**
 * Chat thread subscription and message operations.
 */
export class SocketChatOps<T extends GameTypes> implements ChatSocketOps<T> {
  constructor(
    private readonly context: SocketStoreContext<T>,
  ) {}

  /**
   * Subscribes one logical chat thread channel instance on a websocket.
   */
  async subscribeChatThread(
    socket: WebSocket,
    subscriptionId: string,
    chatThreadId: string,
    unsubscribeSubscription: UnsubscribeSubscription,
    lastMessageId?: string,
  ): Promise<void> {
    logServer(
      SOCKET_CHAT_LOG_MODULE,
      "INFO",
      `subscribeChatThread request=${
        serializeLogValue({ subscriptionId, chatThreadId, lastMessageId })
      }`,
    );
    await unsubscribeSubscription();

    const connectionState = this.context.getOrCreateSocketConnection(socket);
    const messageChangesReader = this.context.db
      .watchForChatThreadMessageChanges(
        chatThreadId,
      ).getReader();
    const chatThreadSubscription: ChatThreadSubscriptionState = {
      chatThreadId,
      lastMessageId,
      messageChangesReader,
    };
    connectionState.chatThreadSubscriptions.set(
      subscriptionId,
      chatThreadSubscription,
    );
    connectionState.subscriptions.set(subscriptionId, {
      type: "ChatThread",
      chatThreadId,
    });

    await this.sendChatMessagesAfterCursor(
      socket,
      subscriptionId,
      chatThreadSubscription,
    );
    void this.streamChatThreadChangesToSocket(
      socket,
      subscriptionId,
      messageChangesReader,
    );
  }

  /**
   * Creates and stores one chat message in a chat thread.
   */
  async sendChatMessage(
    chatThreadId: string,
    playerSnapshot: PlayerSnapshot<T>,
    message: string,
  ): Promise<void> {
    logServer(
      SOCKET_CHAT_LOG_MODULE,
      "INFO",
      `sendChatMessage request=${
        serializeLogValue({ chatThreadId, playerSnapshot, message })
      }`,
    );
    const chatMessage: ChatMessage<T> = {
      id: ulid(),
      playerSnapshot,
      message,
      date: new Date(),
    };
    await this.context.db.appendChatMessage(chatThreadId, chatMessage);
    logServer(
      SOCKET_CHAT_LOG_MODULE,
      "INFO",
      `sendChatMessage completed=${
        serializeLogValue({ chatThreadId, chatMessageId: chatMessage.id })
      }`,
    );
  }

  /**
   * Unsubscribes one chat thread subscription and tears down its stream reader.
   */
  unsubscribeChatThreadSubscription(
    socket: WebSocket,
    subscriptionId: string,
  ): void {
    const connectionState = this.context.sockets.get(socket);
    if (connectionState == null) {
      return;
    }
    const chatThreadSubscription = connectionState.chatThreadSubscriptions.get(
      subscriptionId,
    );
    if (chatThreadSubscription == null) {
      return;
    }
    closeReader(chatThreadSubscription.messageChangesReader);
    connectionState.chatThreadSubscriptions.delete(subscriptionId);
  }

  /**
   * Streams chat thread updates for one logical chat subscription.
   */
  private async streamChatThreadChangesToSocket(
    socket: WebSocket,
    subscriptionId: string,
    messageChangesReader: ReadableStreamDefaultReader<void>,
  ): Promise<void> {
    try {
      while (true) {
        const data = await messageChangesReader.read();
        if (data.done) {
          break;
        }

        const connectionState = this.context.sockets.get(socket);
        if (connectionState == null) {
          break;
        }
        const chatThreadSubscription = connectionState.chatThreadSubscriptions
          .get(subscriptionId);
        if (chatThreadSubscription == null) {
          break;
        }

        await this.sendChatMessagesAfterCursor(
          socket,
          subscriptionId,
          chatThreadSubscription,
        );
      }
    } catch {
      // Reader cancellation is expected during unsubscribe.
    } finally {
      closeReader(messageChangesReader);
    }
  }

  /**
   * Sends all currently available chat messages after one subscription cursor.
   */
  private async sendChatMessagesAfterCursor(
    socket: WebSocket,
    subscriptionId: string,
    chatThreadSubscription: ChatThreadSubscriptionState,
  ): Promise<void> {
    const chatMessages = await this.context.db.getChatThreadMessagesAfter(
      chatThreadSubscription.chatThreadId,
      chatThreadSubscription.lastMessageId,
    );
    if (chatMessages.length === 0) {
      return;
    }

    const connectionState = this.context.sockets.get(socket);
    const activeSubscription = connectionState?.subscriptions.get(
      subscriptionId,
    );
    if (
      activeSubscription?.type !== "ChatThread" ||
      activeSubscription.chatThreadId !== chatThreadSubscription.chatThreadId
    ) {
      return;
    }

    chatThreadSubscription.lastMessageId = chatMessages[chatMessages.length - 1]
      .id;
    sendServerMessage<T>(socket, {
      type: "AppendChatMessages",
      subscriptionId,
      chatThreadId: chatThreadSubscription.chatThreadId,
      chatMessages,
    });
  }
}
