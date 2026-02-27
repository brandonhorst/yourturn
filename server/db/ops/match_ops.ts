import { ulid } from "@std/ulid";
import {
  logServer,
  serializeLogValue,
  type ServerLogLevel,
} from "@/server/logging.ts";
import type {
  ActivePublicMatch,
  CompletedMatchSnapshot,
  GameTypes,
  UserActiveMatch,
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

    const derivedStates = this.buildDerivedStateSnapshots(
      gameStorageData,
      timestamp,
    );
    const activePublicMatch = this.buildActivePublicMatchSnapshot(
      options.matchId,
      gameStorageData,
      timestamp,
      derivedStates.publicState,
    );

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

    for (
      const [index, userMatchmakingEntry] of userMatchmakingEntries.entries()
    ) {
      const participantUserId = options.userIds[index];
      if (participantUserId == null) {
        throw new Error(
          `User index ${index} missing for match ${options.matchId}`,
        );
      }

      const privateState = derivedStates.privateStateByUserId.get(
        participantUserId,
      );
      if (privateState == null) {
        throw new Error(
          `Missing private state for user ${participantUserId} in match ${options.matchId}`,
        );
      }

      const userActiveMatch = this.buildUserActiveMatchSnapshot(
        activePublicMatch,
        privateState,
      );
      const userActiveMatchesNext = [
        ...(userMatchmakingEntry.value!.activeMatches ?? []),
        userActiveMatch,
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
      ActivePublicMatch<T>
    >(
      activePublicMatchKey,
    );
    const userMatchmakingEntries = await this.context.kv.getMany<
      UserMatchmakingStorageData<T>[]
    >(userMatchmakingKeys);

    const timestamp = new Date();
    const derivedStates = outcome == null
      ? this.buildDerivedStateSnapshots(gameData, timestamp)
      : undefined;
    const activeMatchCreated = outcome == null
      ? this.resolveActiveMatchCreatedAt(
        matchId,
        activePublicMatchEntry.value,
        userMatchmakingEntries,
      )
      : undefined;
    const nextActivePublicMatch =
      derivedStates != null && activeMatchCreated != null
        ? this.buildActivePublicMatchSnapshot(
          matchId,
          gameData,
          activeMatchCreated,
          derivedStates.publicState,
        )
        : undefined;

    let transaction = this.context.kv.atomic()
      .check(entry)
      .set(gameKey, gameData);

    for (
      const [index, userMatchmakingEntry] of userMatchmakingEntries.entries()
    ) {
      const participantUserId = participantUserIds[index];
      if (participantUserId == null || userMatchmakingEntry.value == null) {
        throw new Error(`User ${participantUserId} not found`);
      }

      let updatedUserMatchmaking: UserMatchmakingStorageData<T>;
      if (outcome != null) {
        updatedUserMatchmaking = {
          ...userMatchmakingEntry.value,
          activeMatches: userMatchmakingEntry.value.activeMatches.filter(
            (activeMatch) => activeMatch.matchId !== matchId,
          ),
        };
      } else {
        if (derivedStates == null || nextActivePublicMatch == null) {
          throw new Error(
            `Missing active state snapshots for match ${matchId}`,
          );
        }

        const privateState = derivedStates.privateStateByUserId.get(
          participantUserId,
        );
        if (privateState == null) {
          throw new Error(
            `Missing private state for user ${participantUserId} in match ${matchId}`,
          );
        }

        const userActiveMatch = this.buildUserActiveMatchSnapshot(
          nextActivePublicMatch,
          privateState,
        );
        updatedUserMatchmaking = {
          ...userMatchmakingEntry.value,
          activeMatches: this.upsertUserActiveMatch(
            userMatchmakingEntry.value.activeMatches,
            userActiveMatch,
          ),
        };
      }

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
    } else {
      if (nextActivePublicMatch == null) {
        throw new Error(`Missing active public snapshot for match ${matchId}`);
      }

      if (activePublicMatchEntry.value == null) {
        transaction = transaction
          .check({ key: activePublicMatchKey, versionstamp: null })
          .set(activePublicMatchKey, nextActivePublicMatch);
        this.context.mutateIndexedListRootCountOnOperation(
          transaction,
          getActivePublicMatchesKey(),
          1,
        );
      } else {
        transaction = transaction
          .check(activePublicMatchEntry)
          .set(activePublicMatchKey, nextActivePublicMatch);
        this.context.mutateIndexedListRootCountOnOperation(
          transaction,
          getActivePublicMatchesKey(),
          0,
        );
      }
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
   * Derives public and player-scoped state snapshots for one stored match.
   */
  private buildDerivedStateSnapshots(
    gameData: MatchStorageData<T>,
    timestamp: Date,
  ): {
    publicState: T["PublicState"];
    privateStateByUserId: Map<string, T["PlayerState"]>;
  } {
    const numPlayers = gameData.userIds.length;
    const publicState = this.context.game.publicState(gameData.gameState, {
      config: gameData.config,
      numPlayers,
      timestamp,
    });
    const privateStateByUserId = new Map<string, T["PlayerState"]>();

    for (const [playerId, participantUserId] of gameData.userIds.entries()) {
      if (privateStateByUserId.has(participantUserId)) {
        continue;
      }

      const privateState = this.context.game.playerState(gameData.gameState, {
        config: gameData.config,
        playerId,
        numPlayers,
        timestamp,
      });
      privateStateByUserId.set(participantUserId, privateState);
    }

    return {
      publicState,
      privateStateByUserId,
    };
  }

  /**
   * Builds one active-public match snapshot with precomputed public state.
   */
  private buildActivePublicMatchSnapshot(
    matchId: string,
    gameData: MatchStorageData<T>,
    created: Date,
    publicState: T["PublicState"],
  ): ActivePublicMatch<T> {
    return {
      matchId,
      players: gameData.players,
      config: gameData.config,
      created,
      publicState,
    };
  }

  /**
   * Builds one user-scoped active-match snapshot with private state included.
   */
  private buildUserActiveMatchSnapshot(
    activePublicMatch: ActivePublicMatch<T>,
    privateState: T["PlayerState"],
  ): UserActiveMatch<T> {
    return {
      matchId: activePublicMatch.matchId,
      players: activePublicMatch.players,
      config: activePublicMatch.config,
      created: activePublicMatch.created,
      publicState: activePublicMatch.publicState,
      privateState,
    };
  }

  /**
   * Replaces or appends one user-active match snapshot by match id.
   */
  private upsertUserActiveMatch(
    activeMatches: UserActiveMatch<T>[],
    nextActiveMatch: UserActiveMatch<T>,
  ): UserActiveMatch<T>[] {
    const existingIndex = activeMatches.findIndex((activeMatch) =>
      activeMatch.matchId === nextActiveMatch.matchId
    );
    if (existingIndex === -1) {
      return [...activeMatches, nextActiveMatch];
    }

    const nextActiveMatches = [...activeMatches];
    nextActiveMatches[existingIndex] = nextActiveMatch;
    return nextActiveMatches;
  }

  /**
   * Resolves the canonical created timestamp for one active match snapshot.
   */
  private resolveActiveMatchCreatedAt(
    matchId: string,
    activePublicMatch: ActivePublicMatch<T> | null,
    userMatchmakingEntries: ReadonlyArray<
      { value: UserMatchmakingStorageData<T> | null }
    >,
  ): Date {
    if (activePublicMatch != null) {
      return activePublicMatch.created;
    }

    for (const userMatchmakingEntry of userMatchmakingEntries) {
      const userActiveMatch = userMatchmakingEntry.value?.activeMatches.find(
        (activeMatch) => activeMatch.matchId === matchId,
      );
      if (userActiveMatch != null) {
        return userActiveMatch.created;
      }
    }

    return new Date();
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
