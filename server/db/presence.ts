import type { PlayerSnapshot } from "../../types.ts";
import type { ActiveUserStorageData } from "./types.ts";
import {
  ACTIVE_PUBLIC_USER_TTL_MS,
  getActivePublicUserKey,
  getActivePublicUsersKey,
} from "./utils.ts";
import { UsersDB } from "./users.ts";

/**
 * Active-public-user presence persistence and watchers.
 */
export class PresenceDB<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Rating,
  Loadout,
> extends UsersDB<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Rating,
  Loadout
> {
  /**
   * Increments one user's active-public-user connection count and refreshes TTL.
   */
  public async incrementActivePublicUserConnection(
    userId: string,
    playerSnapshot: PlayerSnapshot<Rating>,
  ): Promise<void> {
    const activePublicUserKey = getActivePublicUserKey(userId);
    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const entry = await this.kv.get<ActiveUserStorageData<Rating>>(
        activePublicUserKey,
      );
      const nextActiveUser: ActiveUserStorageData<Rating> = {
        playerSnapshot,
        connectionCount: (entry.value?.connectionCount ?? 0) + 1,
      };

      transaction
        .check(entry)
        .set(activePublicUserKey, nextActiveUser, {
          expireIn: ACTIVE_PUBLIC_USER_TTL_MS,
        });
      this.mutateActivePublicUsersRootCountOnOperation(transaction, 1);
    });
  }

  /**
   * Refreshes one active-public-user entry's TTL without changing its value.
   */
  public async touchActivePublicUser(userId: string): Promise<void> {
    const activePublicUserKey = getActivePublicUserKey(userId);
    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const entry = await this.kv.get<ActiveUserStorageData<Rating>>(
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
      this.mutateActivePublicUsersRootCountOnOperation(transaction, 1);
    });
  }

  /**
   * Decrements one user's active-public-user connection count.
   * Deletes the entry once the count reaches zero.
   */
  public async decrementActivePublicUserConnection(userId: string): Promise<
    void
  > {
    const activePublicUserKey = getActivePublicUserKey(userId);
    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const entry = await this.kv.get<ActiveUserStorageData<Rating>>(
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
        transaction.set(activePublicUserKey, {
          playerSnapshot: entry.value.playerSnapshot,
          connectionCount: nextConnectionCount,
        }, {
          expireIn: ACTIVE_PUBLIC_USER_TTL_MS,
        });
      }
      this.mutateActivePublicUsersRootCountOnOperation(transaction, 1);
    });
  }

  /**
   * Returns all currently active public users as player snapshots.
   */
  public async getAllActivePublicUsers(): Promise<PlayerSnapshot<Rating>[]> {
    const activePublicUserEntries = await this.listSingleBatch<
      ActiveUserStorageData<Rating>
    >(
      getActivePublicUsersKey(),
    );
    return activePublicUserEntries.map((entry) => entry.value.playerSnapshot);
  }

  /**
   * Watches the active public users root key and emits full indexed snapshots.
   */
  public watchForActivePublicUsersListChanges(): ReadableStream<
    PlayerSnapshot<Rating>[]
  > {
    const activePublicUsersKey = getActivePublicUsersKey();
    const stream = this.kv.watch<[Deno.KvU64]>([activePublicUsersKey]);
    return stream.pipeThrough(
      new TransformStream({
        transform: async (_events, controller) => {
          const data = await this.getAllActivePublicUsers();
          controller.enqueue(data);
        },
      }),
    );
  }
}
