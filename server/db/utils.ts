import type { Game, QueueConfig } from "@/types.ts";

export const PUBLIC_LIST_READ_LIMIT = 500;
export const PUBLIC_LIST_BATCH_SIZE = 500;
export const ACTIVE_PUBLIC_USER_TTL_MS = 10 * 60 * 1000;
const U64_MAX = (1n << 64n) - 1n;

/**
 * Returns the queue-entry prefix for one queue.
 */
export function getQueuePrefix(queueId: string): Deno.KvKey {
  return ["queueentry", queueId];
}

/**
 * Returns the queue-entry key for one queue entry ID.
 */
export function getQueueEntryKey(queueId: string, entryId: string): Deno.KvKey {
  return ["queueentry", queueId, entryId];
}

/**
 * Returns the room key for one room ID.
 */
export function getRoomKey(roomId: string): Deno.KvKey {
  return ["rooms", roomId];
}

/**
 * Returns the root available-public-rooms index key.
 */
export function getAvailablePublicRoomsKey(): Deno.KvKey {
  return ["availablepublicrooms"];
}

/**
 * Returns the available-public-room index key for one room.
 */
export function getAvailablePublicRoomKey(roomId: string): Deno.KvKey {
  return ["availablepublicrooms", roomId];
}

/**
 * Returns the root active-public-games index key.
 */
export function getActivePublicGamesKey(): Deno.KvKey {
  return ["activepublicgames"];
}

/**
 * Returns the active-public-game index key for one game.
 */
export function getActivePublicGameKey(gameId: string): Deno.KvKey {
  return ["activepublicgames", gameId];
}

/**
 * Returns the root active-public-users index key.
 */
export function getActivePublicUsersKey(): Deno.KvKey {
  return ["activepublicusers"];
}

/**
 * Returns the active-public-user index key for one user.
 */
export function getActivePublicUserKey(userId: string): Deno.KvKey {
  return ["activepublicusers", userId];
}

/**
 * Returns the game key for one game ID.
 */
export function getGameKey(gameId: string): Deno.KvKey {
  return ["games", gameId];
}

/**
 * Returns the user key for one user ID.
 */
export function getUserKey(userId: string): Deno.KvKey {
  return ["users", userId];
}

/**
 * Returns the user-matchmaking key for one user ID.
 */
export function getUserMatchmakingKey(userId: string): Deno.KvKey {
  return ["usermatchmakings", userId];
}

/**
 * Returns the username-index key for one username.
 */
export function getUserByUsernameKey(username: string): Deno.KvKey {
  return ["usersByUsername", username];
}

/**
 * Returns the token key for one auth token.
 */
export function getTokenKey(token: string): Deno.KvKey {
  return ["tokens", token];
}

/**
 * Shared base class for DB modules, including common transaction and key helpers.
 */
export class DBBase<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Rating,
  Loadout,
> {
  protected readonly kv: Deno.Kv;
  protected readonly game: Game<
    Config,
    GameState,
    Move,
    PlayerState,
    PublicState,
    Outcome,
    Rating,
    Loadout
  >;

  constructor(
    kv: Deno.Kv,
    game: Game<
      Config,
      GameState,
      Move,
      PlayerState,
      PublicState,
      Outcome,
      Rating,
      Loadout
    >,
  ) {
    this.kv = kv;
    this.game = game;
  }

  /**
   * Repeats a transaction operation until it succeeds.
   * Creates a new Deno.AtomicOperation and passes it to the provided function.
   * The function should build up operations on the transaction by mutating it.
   * The function may be async to perform reads before building the transaction.
   * This will keep retrying until the transaction commits successfully.
   */
  protected async repeatUntilTransactionSucceeds(
    fn: (transaction: Deno.AtomicOperation) => void | Promise<void>,
  ): Promise<void> {
    let ok = false;
    while (!ok) {
      const transaction = this.kv.atomic();
      await fn(transaction);
      ok = (await transaction.commit()).ok;
    }
  }

  /**
   * Fetches queue configuration for a queue ID or throws if it is missing.
   */
  protected getQueueConfig(queueId: string): QueueConfig<Config> {
    const queueConfig = this.game.queues[queueId];
    if (queueConfig == null) {
      throw new Error(`Queue ${queueId} not found`);
    }
    return queueConfig;
  }

  /**
   * Reads one snapshot batch for a direct-child index prefix.
   */
  protected async listSingleBatch<T>(
    prefix: Deno.KvKey,
  ): Promise<Deno.KvEntry<T>[]> {
    const entries = await Array.fromAsync(
      this.kv.list<T>(
        { prefix },
        {
          limit: PUBLIC_LIST_READ_LIMIT,
          batchSize: PUBLIC_LIST_BATCH_SIZE,
        },
      ),
    );
    return entries.filter((entry) => entry.key.length === prefix.length + 1);
  }

  /**
   * Mutates an indexed-list root counter by +1, 0, or -1 via a u64 sum.
   * A delta of 0 keeps the count unchanged while still notifying watchers.
   */
  protected mutateIndexedListRootCountOnOperation(
    transaction: Deno.AtomicOperation,
    key: Deno.KvKey,
    delta: -1 | 0 | 1,
  ): void {
    const sumValue = delta === -1 ? U64_MAX : BigInt(delta);
    transaction.mutate({
      type: "sum",
      key,
      value: new Deno.KvU64(sumValue),
    });
  }

  /**
   * Mutates the active public games root count.
   */
  protected mutateActivePublicGamesRootCountOnOperation(
    transaction: Deno.AtomicOperation,
    delta: -1 | 0 | 1,
  ): void {
    this.mutateIndexedListRootCountOnOperation(
      transaction,
      getActivePublicGamesKey(),
      delta,
    );
  }

  /**
   * Mutates the active public users root ticker.
   */
  protected mutateActivePublicUsersRootCountOnOperation(
    transaction: Deno.AtomicOperation,
    delta: -1 | 0 | 1,
  ): void {
    this.mutateIndexedListRootCountOnOperation(
      transaction,
      getActivePublicUsersKey(),
      delta,
    );
  }

  /**
   * Mutates the available public rooms root count.
   */
  protected mutateAvailablePublicRoomsRootCountOnOperation(
    transaction: Deno.AtomicOperation,
    delta: -1 | 0 | 1,
  ): void {
    this.mutateIndexedListRootCountOnOperation(
      transaction,
      getAvailablePublicRoomsKey(),
      delta,
    );
  }
}
