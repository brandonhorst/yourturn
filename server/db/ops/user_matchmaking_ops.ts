import {
  logServer,
  serializeLogValue,
  type ServerLogLevel,
} from "@/server/logging.ts";
import type { GameTypes } from "@/types/mod.ts";
import type { DbContext } from "../context.ts";
import type { UserMatchmakingOps } from "../contracts.ts";
import { getUserMatchmakingKey } from "../keys.ts";
import type { UserMatchmakingStorageData } from "../models.ts";

const USER_MATCHMAKING_OPS_LOG_MODULE = "server.db.user_matchmaking";

/**
 * Deno KV implementation of per-user matchmaking storage operations.
 */
export class KvUserMatchmakingOps<T extends GameTypes>
  implements UserMatchmakingOps<T> {
  constructor(
    private readonly context: DbContext<T>,
  ) {}

  /**
   * Emits one log entry for user-matchmaking DB operations.
   */
  private log(level: ServerLogLevel, message: string): void {
    logServer(USER_MATCHMAKING_OPS_LOG_MODULE, level, message);
  }

  /**
   * Creates one user matchmaking record if absent.
   */
  async createNewUserMatchmakingStorageData(
    userId: string,
    data: UserMatchmakingStorageData<T>,
    options?: { actorUserId?: string },
  ): Promise<void> {
    this.log(
      "INFO",
      `createNewUserMatchmakingStorageData request=${
        serializeLogValue({ userId, data, options })
      }`,
    );
    const actorUserId = options?.actorUserId ?? userId;
    const userMatchmakingKey = getUserMatchmakingKey(userId);
    const transaction = this.context.kv.atomic()
      .check({ key: userMatchmakingKey, versionstamp: null })
      .set(userMatchmakingKey, data);
    this.context.setAuditLogEntryOnOperation(transaction, {
      type: "UpdateUserMatchmakingStorageData",
      userId: actorUserId,
    });
    const res = await transaction.commit();
    if (!res.ok) {
      throw new Error(`User matchmaking ${userId} already exists`);
    }
    this.log(
      "INFO",
      `createNewUserMatchmakingStorageData completed=${
        serializeLogValue({ userId, actorUserId })
      }`,
    );
  }

  /**
   * Updates one user matchmaking record.
   */
  async updateUserMatchmakingStorageData(
    userId: string,
    data: Partial<UserMatchmakingStorageData<T>>,
    options?: { actorUserId?: string },
  ): Promise<void> {
    this.log(
      "INFO",
      `updateUserMatchmakingStorageData request=${
        serializeLogValue({ userId, data, options })
      }`,
    );
    const actorUserId = options?.actorUserId ?? userId;
    await this.context.repeatUntilTransactionSucceeds(async (transaction) => {
      const entry = await this.context.kv.get<
        UserMatchmakingStorageData<T>
      >(
        getUserMatchmakingKey(userId),
      );
      if (entry.value == null) {
        throw new Error(`Updating unstored user matchmaking ${userId}`);
      }

      const updatedData: UserMatchmakingStorageData<T> = {
        ...entry.value,
        ...data,
      };

      transaction
        .check(entry)
        .set(getUserMatchmakingKey(userId), updatedData);
      this.context.setAuditLogEntryOnOperation(transaction, {
        type: "UpdateUserMatchmakingStorageData",
        userId: actorUserId,
      });
    });
    this.log(
      "INFO",
      `updateUserMatchmakingStorageData completed=${
        serializeLogValue({ userId, actorUserId })
      }`,
    );
  }

  /**
   * Fetches one user matchmaking record.
   */
  async getUserMatchmakingStorageData(
    userId: string,
  ): Promise<UserMatchmakingStorageData<T> | null> {
    this.log(
      "INFO",
      `getUserMatchmakingStorageData request=${serializeLogValue({ userId })}`,
    );
    const entry = await this.context.kv.get<
      UserMatchmakingStorageData<T>
    >(
      getUserMatchmakingKey(userId),
    );
    this.log(
      "INFO",
      `getUserMatchmakingStorageData response=${
        serializeLogValue({ userId, userMatchmaking: entry.value })
      }`,
    );
    return entry.value;
  }

  /**
   * Watches one user matchmaking record for updates.
   */
  watchForUserMatchmakingChanges(
    userId: string,
  ): ReadableStream<UserMatchmakingStorageData<T>> {
    this.log(
      "INFO",
      `watchForUserMatchmakingChanges request=${serializeLogValue({ userId })}`,
    );
    const userMatchmakingKey = getUserMatchmakingKey(userId);
    const stream = this.context.kv.watch<
      [UserMatchmakingStorageData<T>]
    >([
      userMatchmakingKey,
    ]);
    return stream.pipeThrough(
      new TransformStream({
        transform: (events, controller) => {
          const data = events[0].value;
          if (data != null) {
            controller.enqueue(data);
          }
        },
      }),
    );
  }
}
