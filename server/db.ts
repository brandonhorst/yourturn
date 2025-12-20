import { ulid } from "@std/ulid";
import type { ActiveGame, Player, SetupObject } from "../types.ts";

export type QueueConfig<C, I> = {
  queueId: string;
  playerIds: I[];
  config: C;
};

type SessionTokens<I> = {
  [x: string]: I;
};

export type GameStorageData<C, S, I> = {
  config: C;
  gameState: S;
  sessionTokens: SessionTokens<I>;
  players: Player<I>[];
  isComplete: boolean;
  version: number;
};

export type AssignmentStorageData = {
  gameId: string;
  sessionId: string;
};

async function repeatUntilSuccess(fn: () => Promise<{ ok: boolean }>) {
  let res = { ok: false };
  while (!res.ok) {
    res = await fn();
  }
}

function getQueuePrefix(queueId: string) {
  return ["queueentry", queueId];
}

function getQueueEntryKey(queueId: string, entryId: string) {
  return ["queueentry", queueId, entryId];
}
function getAssignmentKey(entryId: string) {
  return ["assignments", entryId];
}
function getActiveGameTriggerKey() {
  return ["activegametrigger"];
}
function getActiveGamePrefix() {
  return ["activegames"];
}
function getActiveGameKey(gameId: string) {
  return ["activegames", gameId];
}
function getGameKey(gameId: string) {
  return ["games", gameId];
}

export class DB {
  private kv: Deno.Kv;

  constructor(kv: Deno.Kv) {
    this.kv = kv;
  }

  public async addToQueue<C, S, I>(
    queueConfig: QueueConfig<C, I>,
    entryId: string,
    setupGame: (setupObject: SetupObject<C, I>) => S,
  ): Promise<void> {
    await repeatUntilSuccess(async () => {
      const entryKey = getQueueEntryKey(queueConfig.queueId, entryId);
      return await this.kv
        .atomic()
        .check({ key: entryKey, versionstamp: null })
        .set(entryKey, { timestamp: new Date() })
        .commit();
    });

    await this.maybeGraduateFromQueue(queueConfig, setupGame);
  }

  public async removeFromQueue(
    queueId: string,
    entryId: string,
  ): Promise<void> {
    await repeatUntilSuccess(async () => {
      const entryKey = getQueueEntryKey(queueId, entryId);

      return await this.kv.atomic()
        .delete(entryKey)
        .commit();
    });
  }

  private async maybeGraduateFromQueue<C, S, I>(
    queueConfig: QueueConfig<C, I>,
    setupGame: (o: SetupObject<C, I>) => S,
  ): Promise<void> {
    const gameId = ulid();
    const queuePrefix = getQueuePrefix(queueConfig.queueId);
    const gameKey = getGameKey(gameId);
    const activeGameKey = getActiveGameKey(gameId);
    const activeGameTriggerKey = getActiveGameTriggerKey();

    await repeatUntilSuccess(async () => {
      // Get desired queue entries, if they exist
      const queueEntries = await Array.fromAsync(this.kv.list<string>(
        { prefix: queuePrefix },
        { limit: queueConfig.playerIds.length },
      ));

      // If the queue doesn't have enough entrants, stop
      if (queueEntries.length < queueConfig.playerIds.length) {
        return { ok: true };
      }

      // Initialize Game Storage Data
      const sessionTokens: { [sessionId: string]: I } = {};
      const players: Player<I>[] = [];

      for (const playerId of queueConfig.playerIds) {
        sessionTokens[ulid()] = playerId;
        players.push({ playerId, name: `Player ${playerId}` });
      }
      const timestamp = new Date();
      const setupObject = { timestamp, players, config: queueConfig.config };
      const gameState = setupGame(setupObject);
      const gameStorageData: GameStorageData<C, S, I> = {
        config: queueConfig.config,
        gameState,
        sessionTokens,
        players,
        isComplete: false,
        version: 0,
      };

      // Create a transaction that will update the ActiveGameCount, add an activeGameKey, and write the Storage Data
      const transaction = this.kv.atomic()
        .set(activeGameTriggerKey, {})
        .check({ key: activeGameKey, versionstamp: null })
        .set(activeGameKey, {})
        .check({ key: gameKey, versionstamp: null })
        .set(gameKey, gameStorageData);

      let playerId = 0;
      // For each player
      for (const entry of queueEntries) {
        const entryId = entry.key[2] as string;
        const assignmentKey = getAssignmentKey(entryId);
        const assignmentValue: AssignmentStorageData = {
          gameId,
          sessionId: Object.keys(sessionTokens)[playerId],
        };

        // Delete their queue entry, and add an assignment
        transaction
          .check(entry)
          .delete(entry.key)
          .check({ key: assignmentKey, versionstamp: null })
          .set(assignmentKey, assignmentValue);

        playerId++;
      }
      return await transaction.commit();
    });
  }

  public watchForAssignments(
    entryId: string,
  ): ReadableStream<AssignmentStorageData> {
    const key = getAssignmentKey(entryId);
    const stream = this.kv.watch([key]);
    return stream.pipeThrough(
      new TransformStream({
        transform(events, controller) {
          const data = events[0].value as AssignmentStorageData;
          if (data != null) {
            controller.enqueue(data);
          }
        },
      }),
    );
  }

  /**
   * Updates game storage data and optionally enqueues a refresh with the specified delay
   * @param gameId The ID of the game to update
   * @param gameData The updated game data
   * @param refreshDelay Optional delay in milliseconds for scheduling a refresh
   */
  public async updateGameStorageData<C, S, I>(
    gameId: string,
    gameData: GameStorageData<C, S, I>,
    refreshDelay?: number,
  ): Promise<void> {
    const gameKey = getGameKey(gameId);
    const activeGameTriggerKey = getActiveGameTriggerKey();

    const entry = await this.kv.get<GameStorageData<C, S, I>>(gameKey);
    if (entry.value == null) {
      throw new Error(`Appending moves to unknown unstored ${gameId}`);
    }

    let transaction = this.kv.atomic()
      .check(entry)
      .set(gameKey, gameData);

    if (gameData.isComplete) {
      const activeGameKey = getActiveGameKey(gameId);
      transaction = transaction
        .delete(activeGameKey)
        .set(activeGameTriggerKey, {});
    }

    // If refreshDelay is provided, enqueue a refresh as part of the same transaction
    if (refreshDelay !== undefined && !gameData.isComplete) {
      transaction = transaction.enqueue(gameId, { delay: refreshDelay });
    }

    const res = await transaction.commit();

    if (!res.ok) {
      throw new Error(`Failed to update game ${gameId}`);
    }
  }

  public async getGameStorageData<C, S, I>(
    gameId: string,
  ): Promise<GameStorageData<C, S, I>> {
    const key = getGameKey(gameId);
    const entry = await this.kv.get<GameStorageData<C, S, I>>(key);
    if (entry.value == null) {
      throw new Error(`Game ${gameId} not found`);
    } else {
      return entry.value;
    }
  }

  public watchForGameChanges<C, S, I>(
    gameId: string,
  ): ReadableStream<GameStorageData<C, S, I>> {
    const key = getGameKey(gameId);
    const stream = this.kv.watch([key]);
    return stream.pipeThrough(
      new TransformStream({
        transform(events, controller) {
          const data = events[0].value as GameStorageData<C, S, I> | null;
          if (data != null) {
            controller.enqueue(data);
          }
        },
      }),
    );
  }

  public async getAllActiveGames(): Promise<ActiveGame[]> {
    const key = getActiveGamePrefix();
    const iter = this.kv.list<string>({ prefix: key });
    const response: ActiveGame[] = [];

    for await (const res of iter) {
      const gameId = res.key[res.key.length - 1] as string;
      response.push({ gameId });
    }

    return response;
  }

  // Watches for changes to the activeGameTriggerKey, which is an empty key only used
  // to trigger this method.
  public watchForActiveGameListChanges(): ReadableStream<ActiveGame[]> {
    const activeGameTriggerKey = getActiveGameTriggerKey();
    const stream = this.kv.watch([activeGameTriggerKey]);
    return stream.pipeThrough(
      new TransformStream({
        transform: async (_events, controller) => {
          const allGames = await this.getAllActiveGames();
          controller.enqueue(allGames);
        },
      }),
    );
  }

  public listenForRefreshes(): ReadableStream<string> {
    let controller: ReadableStreamDefaultController<string>;

    const stream = new ReadableStream<string>({
      start(c) {
        controller = c;
      },
    });

    this.kv.listenQueue((message: string) => {
      if (typeof message === "string") {
        controller.enqueue(message);
      }
    });

    return stream;
  }
}
