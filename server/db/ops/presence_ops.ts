import {
  logServer,
  serializeLogValue,
  type ServerLogLevel,
} from "@/server/logging.ts";
import type {
  ActiveMatch,
  AvailableRoom,
  GameTypes,
  PlayerSnapshot,
} from "@/types/mod.ts";
import { ACTIVE_PUBLIC_USER_TTL_MS } from "../constants.ts";
import type { DbContext } from "../context.ts";
import type { PublicIndexOps } from "../contracts.ts";
import {
  getActivePublicMatchesKey,
  getActivePublicUserKey,
  getActivePublicUsersKey,
  getAvailablePublicRoomsKey,
} from "../keys.ts";
import type { ActiveUserStorageData } from "../models.ts";

const PRESENCE_OPS_LOG_MODULE = "server.db.presence";

/**
 * Deno KV implementation of presence and public-list index operations.
 */
export class KvPresenceOps<T extends GameTypes> implements PublicIndexOps<T> {
  constructor(
    private readonly context: DbContext<T>,
  ) {}

  /**
   * Emits one log entry for presence DB operations.
   */
  private log(level: ServerLogLevel, message: string): void {
    logServer(PRESENCE_OPS_LOG_MODULE, level, message);
  }

  /**
   * Increments one user's active-public connection count and refreshes TTL.
   */
  async incrementActivePublicUserConnection(
    userId: string,
    playerSnapshot: PlayerSnapshot<T>,
  ): Promise<void> {
    this.log(
      "INFO",
      `incrementActivePublicUserConnection request=${
        serializeLogValue({ userId, playerSnapshot })
      }`,
    );
    const activePublicUserKey = getActivePublicUserKey(userId);
    await this.context.repeatUntilTransactionSucceeds(async (transaction) => {
      const entry = await this.context.kv.get<ActiveUserStorageData<T>>(
        activePublicUserKey,
      );
      const nextActiveUser: ActiveUserStorageData<T> = {
        playerSnapshot,
        connectionCount: (entry.value?.connectionCount ?? 0) + 1,
      };

      transaction
        .check(entry)
        .set(activePublicUserKey, nextActiveUser, {
          expireIn: ACTIVE_PUBLIC_USER_TTL_MS,
        });
      this.context.mutateIndexedListRootCountOnOperation(
        transaction,
        getActivePublicUsersKey(),
        1,
      );
    });
    this.log(
      "INFO",
      `incrementActivePublicUserConnection completed=${
        serializeLogValue({ userId })
      }`,
    );
  }

  /**
   * Refreshes one active-public-user entry's TTL without changing value.
   */
  async touchActivePublicUser(userId: string): Promise<void> {
    this.log(
      "INFO",
      `touchActivePublicUser request=${serializeLogValue({ userId })}`,
    );
    const activePublicUserKey = getActivePublicUserKey(userId);
    await this.context.repeatUntilTransactionSucceeds(async (transaction) => {
      const entry = await this.context.kv.get<ActiveUserStorageData<T>>(
        activePublicUserKey,
      );
      if (entry.value == null) {
        return;
      }

      transaction
        .check(entry)
        .set(activePublicUserKey, entry.value, {
          expireIn: ACTIVE_PUBLIC_USER_TTL_MS,
        });
      this.context.mutateIndexedListRootCountOnOperation(
        transaction,
        getActivePublicUsersKey(),
        1,
      );
    });
    this.log(
      "INFO",
      `touchActivePublicUser completed=${serializeLogValue({ userId })}`,
    );
  }

  /**
   * Decrements one active-public-user connection count and deletes at zero.
   */
  async decrementActivePublicUserConnection(userId: string): Promise<void> {
    this.log(
      "INFO",
      `decrementActivePublicUserConnection request=${
        serializeLogValue({ userId })
      }`,
    );
    const activePublicUserKey = getActivePublicUserKey(userId);
    await this.context.repeatUntilTransactionSucceeds(async (transaction) => {
      const entry = await this.context.kv.get<ActiveUserStorageData<T>>(
        activePublicUserKey,
      );
      if (entry.value == null) {
        return;
      }

      const nextConnectionCount = entry.value.connectionCount - 1;
      transaction.check(entry);
      if (nextConnectionCount <= 0) {
        transaction.delete(activePublicUserKey);
      } else {
        transaction.set(
          activePublicUserKey,
          {
            playerSnapshot: entry.value.playerSnapshot,
            connectionCount: nextConnectionCount,
          },
          {
            expireIn: ACTIVE_PUBLIC_USER_TTL_MS,
          },
        );
      }
      this.context.mutateIndexedListRootCountOnOperation(
        transaction,
        getActivePublicUsersKey(),
        1,
      );
    });
    this.log(
      "INFO",
      `decrementActivePublicUserConnection completed=${
        serializeLogValue({ userId })
      }`,
    );
  }

  /**
   * Returns all currently active public users as player snapshots.
   */
  async getAllActivePublicUsers(): Promise<PlayerSnapshot<T>[]> {
    this.log(
      "INFO",
      "getAllActivePublicUsers request={}",
    );
    const activePublicUserEntries = await this.context.listSingleBatch<
      ActiveUserStorageData<T>
    >(
      getActivePublicUsersKey(),
    );
    const allActiveUsers = activePublicUserEntries.map((entry) =>
      entry.value.playerSnapshot
    );
    this.log(
      "INFO",
      `getAllActivePublicUsers response=${
        serializeLogValue({ count: allActiveUsers.length, allActiveUsers })
      }`,
    );
    return allActiveUsers;
  }

  /**
   * Watches the active public users root key and emits full snapshots.
   */
  watchForActivePublicUsersListChanges(): ReadableStream<PlayerSnapshot<T>[]> {
    this.log(
      "INFO",
      "watchForActivePublicUsersListChanges request={}",
    );
    const activePublicUsersKey = getActivePublicUsersKey();
    const stream = this.context.kv.watch<[Deno.KvU64]>([activePublicUsersKey]);
    return stream.pipeThrough(
      new TransformStream({
        transform: async (_events, controller) => {
          const data = await this.getAllActivePublicUsers();
          controller.enqueue(data);
        },
      }),
    );
  }

  /**
   * Returns all currently active public matches.
   */
  async getAllActivePublicMatches(): Promise<ActiveMatch<T>[]> {
    this.log(
      "INFO",
      "getAllActivePublicMatches request={}",
    );
    const activePublicMatchEntries = await this.context.listSingleBatch<
      ActiveMatch<T>
    >(
      getActivePublicMatchesKey(),
    );
    const allActiveMatches = activePublicMatchEntries.map((entry) =>
      entry.value
    );
    this.log(
      "INFO",
      `getAllActivePublicMatches response=${
        serializeLogValue({ count: allActiveMatches.length, allActiveMatches })
      }`,
    );
    return allActiveMatches;
  }

  /**
   * Watches the active public matches root key and emits full snapshots.
   */
  watchForActivePublicMatchesListChanges(): ReadableStream<ActiveMatch<T>[]> {
    this.log(
      "INFO",
      "watchForActivePublicMatchesListChanges request={}",
    );
    const activePublicMatchesKey = getActivePublicMatchesKey();
    const stream = this.context.kv.watch<[Deno.KvU64]>([
      activePublicMatchesKey,
    ]);
    return stream.pipeThrough(
      new TransformStream({
        transform: async (_events, controller) => {
          const data = await this.getAllActivePublicMatches();
          controller.enqueue(data);
        },
      }),
    );
  }

  /**
   * Returns all currently available public rooms.
   */
  async getAllAvailablePublicRooms(): Promise<AvailableRoom<T>[]> {
    this.log(
      "INFO",
      "getAllAvailablePublicRooms request={}",
    );
    const availablePublicRoomEntries = await this.context.listSingleBatch<
      AvailableRoom<T>
    >(
      getAvailablePublicRoomsKey(),
    );
    const allAvailableRooms = availablePublicRoomEntries.map((entry) =>
      entry.value
    );
    this.log(
      "INFO",
      `getAllAvailablePublicRooms response=${
        serializeLogValue({
          count: allAvailableRooms.length,
          allAvailableRooms,
        })
      }`,
    );
    return allAvailableRooms;
  }

  /**
   * Watches the available public rooms root key and emits full snapshots.
   */
  watchForAvailablePublicRoomListChanges(): ReadableStream<AvailableRoom<T>[]> {
    this.log(
      "INFO",
      "watchForAvailablePublicRoomListChanges request={}",
    );
    const availablePublicRoomsKey = getAvailablePublicRoomsKey();
    const stream = this.context.kv.watch<[Deno.KvU64]>([
      availablePublicRoomsKey,
    ]);
    return stream.pipeThrough(
      new TransformStream({
        transform: async (_events, controller) => {
          const data = await this.getAllAvailablePublicRooms();
          controller.enqueue(data);
        },
      }),
    );
  }
}
