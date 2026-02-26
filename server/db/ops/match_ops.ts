import { ulid } from "@std/ulid";
import {
  logServer,
  serializeLogValue,
  type ServerLogLevel,
} from "@/server/logging.ts";
import type {
  ActiveMatch,
  CompletedMatchSnapshot,
  GameTypes,
} from "@/types/mod.ts";
import type { DbContext } from "../context.ts";
import type { CreateMatchOnOperationOptions, MatchOps } from "../contracts.ts";
import {
  getActivePublicMatchesKey,
  getActivePublicMatchKey,
  getMatchKey,
  getUserCompletedMatchesKey,
  getUserCompletedMatchKey,
  getUserMatchmakingKey,
} from "../keys.ts";
import type {
  MatchStorageData,
  UserMatchmakingStorageData,
} from "../models.ts";

const MATCH_OPS_LOG_MODULE = "server.db.match";

/**
 * Deno KV implementation of match storage operations.
 */
export class KvMatchOps<T extends GameTypes> implements MatchOps<T> {
  constructor(
    private readonly context: DbContext<T>,
  ) {}

  /**
   * Emits one log entry for match DB operations.
   */
  private log(level: ServerLogLevel, message: string): void {
    logServer(MATCH_OPS_LOG_MODULE, level, message);
  }

  /**
   * Creates one new match record and updates global/user active indexes.
   */
  async createNewMatchOnOperation(
    transaction: Deno.AtomicOperation,
    options: CreateMatchOnOperationOptions<T>,
  ): Promise<void> {
    const activePublicMatchKey = getActivePublicMatchKey(options.matchId);
    const gameKey = getMatchKey(options.matchId);
    const timestamp = new Date();
    const userMatchmakingKeys = options.userIds.map((userId) =>
      getUserMatchmakingKey(userId)
    );
    const userMatchmakingEntries = await this.context.kv.getMany<
      UserMatchmakingStorageData<T>[]
    >(
      userMatchmakingKeys,
    );
    for (
      const [index, userMatchmakingEntry] of userMatchmakingEntries.entries()
    ) {
      if (userMatchmakingEntry.value == null) {
        throw new Error(`User ${options.userIds[index]} not found`);
      }
    }

    const setupObject = {
      timestamp,
      numPlayers: options.userIds.length,
      config: options.config,
      loadouts: options.loadouts,
    };
    const chatThreadId = ulid();
    const gameState = this.context.game.setup(setupObject);
    const gameStorageData: MatchStorageData<T> = {
      chatThreadId,
      config: options.config,
      queueId: options.queueId,
      gameState,
      userIds: options.userIds,
      players: options.playerSnapshots,
      outcome: undefined,
    };

    const activePublicMatch: ActiveMatch<T> = {
      matchId: options.matchId,
      chatThreadId,
      players: options.playerSnapshots,
      config: options.config,
      created: timestamp,
    };

    transaction
      .check({ key: activePublicMatchKey, versionstamp: null })
      .set(activePublicMatchKey, activePublicMatch)
      .check({ key: gameKey, versionstamp: null })
      .set(gameKey, gameStorageData);
    this.context.mutateIndexedListRootCountOnOperation(
      transaction,
      getActivePublicMatchesKey(),
      1,
    );

    for (const userMatchmakingEntry of userMatchmakingEntries) {
      const userActiveMatchesNext = [
        ...userMatchmakingEntry.value!.activeMatches ?? [],
        activePublicMatch,
      ];

      const updatedUserMatchmaking: UserMatchmakingStorageData<T> = {
        ...userMatchmakingEntry.value!,
        activeMatches: userActiveMatchesNext,
      };

      transaction
        .check(userMatchmakingEntry)
        .set(userMatchmakingEntry.key, updatedUserMatchmaking);
    }
  }

  /**
   * Persists game data updates and completion snapshots.
   */
  async updateMatchStorageData(
    matchId: string,
    gameData: MatchStorageData<T>,
    userId: string,
  ): Promise<void> {
    this.log(
      "INFO",
      `updateMatchStorageData request=${
        serializeLogValue({ matchId, userId, gameData })
      }`,
    );
    const gameKey = getMatchKey(matchId);
    const activePublicMatchKey = getActivePublicMatchKey(matchId);
    const participantUserIds = [...new Set(gameData.userIds)];
    const userMatchmakingKeys = participantUserIds.map((participantUserId) =>
      getUserMatchmakingKey(participantUserId)
    );

    const entry = await this.context.kv.get<
      MatchStorageData<T>
    >(
      gameKey,
    );
    if (entry.value == null) {
      throw new Error(`Appending moves to unstored ${matchId}`);
    }

    const outcome = gameData.outcome;
    let completedMatchEntryId: string | undefined;
    const activePublicMatchEntry = await this.context.kv.get<
      ActiveMatch<T>
    >(
      activePublicMatchKey,
    );
    const userMatchmakingEntries = await this.context.kv.getMany<
      UserMatchmakingStorageData<T>[]
    >(userMatchmakingKeys);

    let transaction = this.context.kv.atomic()
      .check(entry)
      .set(gameKey, gameData);

    for (
      const [index, userMatchmakingEntry] of userMatchmakingEntries.entries()
    ) {
      if (userMatchmakingEntry.value == null) {
        throw new Error(`User ${participantUserIds[index]} not found`);
      }

      const updatedUserMatchmaking: UserMatchmakingStorageData<T> =
        outcome == null ? userMatchmakingEntry.value : {
          ...userMatchmakingEntry.value,
          activeMatches: userMatchmakingEntry.value.activeMatches.filter(
            (activeMatch) => activeMatch.matchId !== matchId,
          ),
        };

      transaction = transaction
        .check(userMatchmakingEntry)
        .set(userMatchmakingEntry.key, updatedUserMatchmaking);
    }

    if (outcome != null) {
      if (activePublicMatchEntry.value != null) {
        transaction = transaction
          .check(activePublicMatchEntry)
          .delete(activePublicMatchKey);
        this.context.mutateIndexedListRootCountOnOperation(
          transaction,
          getActivePublicMatchesKey(),
          -1,
        );
      }

      completedMatchEntryId = ulid();
      const completedMatch: CompletedMatchSnapshot<T> = {
        matchId,
        queueId: gameData.queueId,
        players: gameData.players,
        config: gameData.config,
        outcome,
        completed: new Date(),
      };

      for (const participantUserId of participantUserIds) {
        const completedMatchKey = getUserCompletedMatchKey(
          participantUserId,
          completedMatchEntryId,
        );
        transaction = transaction
          .check({ key: completedMatchKey, versionstamp: null })
          .set(completedMatchKey, completedMatch);
        this.context.mutateIndexedListRootCountOnOperation(
          transaction,
          getUserCompletedMatchesKey(participantUserId),
          1,
        );
      }
    } else if (activePublicMatchEntry.value != null) {
      this.context.mutateIndexedListRootCountOnOperation(
        transaction,
        getActivePublicMatchesKey(),
        0,
      );
    }

    this.context.setAuditLogEntryOnOperation(transaction, {
      type: "UpdateMatchStorageData",
      userId,
      matchId,
      completedMatchEntryId,
    });

    const res = await transaction.commit();

    if (!res.ok) {
      throw new Error(`Failed to update match ${matchId}`);
    }
    this.log(
      "INFO",
      `updateMatchStorageData completed=${
        serializeLogValue({
          matchId,
          userId,
          completedMatchEntryId,
          hasOutcome: gameData.outcome != null,
        })
      }`,
    );
  }

  /**
   * Fetches one match storage record.
   */
  async getMatchStorageData(
    matchId: string,
  ): Promise<MatchStorageData<T>> {
    this.log(
      "INFO",
      `getMatchStorageData request=${serializeLogValue({ matchId })}`,
    );
    const gameKey = getMatchKey(matchId);
    const entry = await this.context.kv.get<
      MatchStorageData<T>
    >(
      gameKey,
    );
    if (entry.value == null) {
      throw new Error(`Match ${matchId} not found`);
    }

    this.log(
      "INFO",
      `getMatchStorageData response=${
        serializeLogValue({ matchId, gameData: entry.value })
      }`,
    );
    return entry.value;
  }

  /**
   * Watches one match key and emits non-null values.
   */
  watchForMatchChanges(
    matchId: string,
  ): ReadableStream<MatchStorageData<T>> {
    this.log(
      "INFO",
      `watchForMatchChanges request=${serializeLogValue({ matchId })}`,
    );
    const gameKey = getMatchKey(matchId);
    const stream = this.context.kv.watch<
      MatchStorageData<T>[]
    >(
      [gameKey],
    );
    return stream.pipeThrough(
      new TransformStream({
        transform(events, controller) {
          const data = events[0].value;
          if (data != null) {
            controller.enqueue(data);
          }
        },
      }),
    );
  }
}
