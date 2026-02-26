import {
  logServer,
  serializeLogValue,
  type ServerLogLevel,
} from "@/server/logging.ts";
import type { ChatMessage, GameTypes } from "@/types/mod.ts";
import {
  CHAT_THREAD_MESSAGES_BATCH_SIZE,
  CHAT_THREAD_MESSAGES_READ_LIMIT,
} from "../constants.ts";
import type { DbContext } from "../context.ts";
import type { ChatOps } from "../contracts.ts";
import {
  getChatThreadMessageKey,
  getChatThreadMessagesKey,
  getChatThreadMessagesRangeEndKey,
  getChatThreadMessagesRangeStartKey,
} from "../keys.ts";
import type { ChatMessageStorageData } from "../models.ts";

const CHAT_OPS_LOG_MODULE = "server.db.chat";

/**
 * Deno KV implementation of chat-thread operations.
 */
export class KvChatOps<T extends GameTypes> implements ChatOps<T> {
  constructor(
    private readonly context: DbContext<T>,
  ) {}

  /**
   * Emits one log entry for chat DB operations.
   */
  private log(level: ServerLogLevel, message: string): void {
    logServer(CHAT_OPS_LOG_MODULE, level, message);
  }

  /**
   * Appends one chat message and increments thread ticker atomically.
   */
  async appendChatMessage(
    chatThreadId: string,
    chatMessage: ChatMessage<T>,
  ): Promise<void> {
    this.log(
      "INFO",
      `appendChatMessage request=${
        serializeLogValue({ chatThreadId, chatMessage })
      }`,
    );
    const chatThreadMessagesKey = getChatThreadMessagesKey(chatThreadId);
    const chatMessageKey = getChatThreadMessageKey(
      chatThreadId,
      chatMessage.id,
    );
    const transaction = this.context.kv.atomic()
      .check({ key: chatMessageKey, versionstamp: null })
      .set(chatMessageKey, chatMessage as ChatMessageStorageData<T>);
    this.context.mutateIndexedListRootCountOnOperation(
      transaction,
      chatThreadMessagesKey,
      1,
    );
    const result = await transaction.commit();
    if (!result.ok) {
      throw new Error(
        `Chat message ${chatMessage.id} already exists in ${chatThreadId}`,
      );
    }
    this.log(
      "INFO",
      `appendChatMessage completed=${
        serializeLogValue({ chatThreadId, chatMessageId: chatMessage.id })
      }`,
    );
  }

  /**
   * Fetches most recent messages in oldest-to-newest order.
   */
  async getMostRecentChatThreadMessages(
    chatThreadId: string,
    limit: number,
  ): Promise<ChatMessage<T>[]> {
    const normalizedLimit = this.normalizeChatMessageLimit(limit);
    this.log(
      "INFO",
      `getMostRecentChatThreadMessages request=${
        serializeLogValue({ chatThreadId, limit, normalizedLimit })
      }`,
    );
    if (normalizedLimit === 0) {
      return [];
    }
    const chatThreadMessagesKey = getChatThreadMessagesKey(chatThreadId);
    const chatMessageEntries = await Array.fromAsync(
      this.context.kv.list<ChatMessageStorageData<T>>(
        { prefix: chatThreadMessagesKey },
        {
          limit: normalizedLimit,
          batchSize: CHAT_THREAD_MESSAGES_BATCH_SIZE,
          reverse: true,
        },
      ),
    );
    const chatMessages = chatMessageEntries
      .filter((entry) => entry.key.length === chatThreadMessagesKey.length + 1)
      .map((entry) => entry.value)
      .reverse();
    this.log(
      "INFO",
      `getMostRecentChatThreadMessages response=${
        serializeLogValue({ chatThreadId, count: chatMessages.length })
      }`,
    );
    return chatMessages;
  }

  /**
   * Fetches messages appended after a specific message id.
   */
  async getChatThreadMessagesAfter(
    chatThreadId: string,
    lastMessageId?: string,
  ): Promise<ChatMessage<T>[]> {
    this.log(
      "INFO",
      `getChatThreadMessagesAfter request=${
        serializeLogValue({ chatThreadId, lastMessageId })
      }`,
    );
    const chatThreadMessagesKey = getChatThreadMessagesKey(chatThreadId);
    const chatMessageListSelector: Deno.KvListSelector = {
      start: getChatThreadMessagesRangeStartKey(chatThreadId, lastMessageId),
      end: getChatThreadMessagesRangeEndKey(chatThreadId),
    };
    const chatMessageEntries = await Array.fromAsync(
      this.context.kv.list<ChatMessageStorageData<T>>(
        chatMessageListSelector,
        {
          batchSize: CHAT_THREAD_MESSAGES_BATCH_SIZE,
        },
      ),
    );
    const chatMessages = chatMessageEntries
      .filter((entry) => entry.key.length === chatThreadMessagesKey.length + 1)
      .map((entry) => entry.value);
    this.log(
      "INFO",
      `getChatThreadMessagesAfter response=${
        serializeLogValue({ chatThreadId, count: chatMessages.length })
      }`,
    );
    return chatMessages;
  }

  /**
   * Watches one chat thread ticker key for append notifications.
   */
  watchForChatThreadMessageChanges(
    chatThreadId: string,
  ): ReadableStream<void> {
    this.log(
      "INFO",
      `watchForChatThreadMessageChanges request=${
        serializeLogValue({ chatThreadId })
      }`,
    );
    const chatThreadMessagesKey = getChatThreadMessagesKey(chatThreadId);
    const stream = this.context.kv.watch<[Deno.KvU64]>([chatThreadMessagesKey]);
    return stream.pipeThrough(
      new TransformStream({
        transform: (_events, controller) => {
          controller.enqueue(undefined);
        },
      }),
    );
  }

  /**
   * Normalizes one chat message limit into supported bounds.
   */
  private normalizeChatMessageLimit(limit: number): number {
    if (!Number.isFinite(limit)) {
      return CHAT_THREAD_MESSAGES_READ_LIMIT;
    }
    const normalizedLimit = Math.floor(limit);
    if (normalizedLimit <= 0) {
      return 0;
    }
    return Math.min(CHAT_THREAD_MESSAGES_READ_LIMIT, normalizedLimit);
  }
}
