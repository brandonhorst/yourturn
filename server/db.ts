import { ulid } from "@std/ulid";
import type { ActiveGame, SetupObject } from "../types.ts";

export type QueueConfig<Config> = {
  queueId: string;
  numPlayers: number;
  config: Config;
};

type SessionTokens = {
  [x: string]: number;
};

export type GameStorageData<Config, GameState, Player> = {
  config: Config;
  gameState: GameState;
  sessionTokens: SessionTokens;
  players: Player[];
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

  public async addToQueue<Config, GameState, Player>(
    queueConfig: QueueConfig<Config>,
    entryId: string,
    setupGame: (setupObject: SetupObject<Config, Player>) => GameState,
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

  private async maybeGraduateFromQueue<Config, GameState, Player>(
    queueConfig: QueueConfig<Config>,
    setupGame: (o: SetupObject<Config, Player>) => GameState,
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
        { limit: queueConfig.numPlayers },
      ));

      // If the queue doesn't have enough entrants, stop
      if (queueEntries.length < queueConfig.numPlayers) {
        return { ok: true };
      }

      // Initialize Game Storage Data
      const sessionTokens: { [sessionId: string]: number } = {};
      const players: Player[] = [];

      for (let i = 0; i < queueConfig.numPlayers; i++) {
        sessionTokens[ulid()] = i;
        players[i] = { playerId: i, name: `Player ${i + 1}` } as Player;
      }
      const timestamp = new Date();
      const setupObject = { timestamp, players, config: queueConfig.config };
      const gameState = setupGame(setupObject);
      const gameStorageData: GameStorageData<Config, GameState, Player> = {
        config: queueConfig.config,
        gameState,
        sessionTokens,
        players,
        isComplete: false,
        version: 0,
      };
      const activeGameEntry: ActiveGame<Config, Player> = {
        gameId,
        config: queueConfig.config,
        players,
      };

      // Create a transaction that will update the ActiveGameCount, add an activeGameKey, and write the Storage Data
      const transaction = this.kv.atomic()
        .set(activeGameTriggerKey, {})
        .check({ key: activeGameKey, versionstamp: null })
        .set(activeGameKey, activeGameEntry)
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
  public async updateGameStorageData<Config, GameState, Player>(
    gameId: string,
    gameData: GameStorageData<Config, GameState, Player>,
    refreshDelay?: number,
  ): Promise<void> {
    const gameKey = getGameKey(gameId);
    const activeGameTriggerKey = getActiveGameTriggerKey();

    const entry = await this.kv.get<
      GameStorageData<Config, GameState, Player>
    >(gameKey);
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

  public async getGameStorageData<Config, GameState, Player>(
    gameId: string,
  ): Promise<GameStorageData<Config, GameState, Player>> {
    const key = getGameKey(gameId);
    const entry = await this.kv.get<
      GameStorageData<Config, GameState, Player>
    >(key);
    if (entry.value == null) {
      throw new Error(`Game ${gameId} not found`);
    } else {
      return entry.value;
    }
  }

  public watchForGameChanges<Config, GameState, Player>(
    gameId: string,
  ): ReadableStream<GameStorageData<Config, GameState, Player>> {
    const key = getGameKey(gameId);
    const stream = this.kv.watch([key]);
    return stream.pipeThrough(
      new TransformStream({
        transform(events, controller) {
          const data = events[0].value as
            | GameStorageData<Config, GameState, Player>
            | null;
          if (data != null) {
            controller.enqueue(data);
          }
        },
      }),
    );
  }

  public async getAllActiveGames<Config, Player>(): Promise<
    ActiveGame<Config, Player>[]
  > {
    const key = getActiveGamePrefix();
    const iter = this.kv.list<ActiveGame<Config, Player>>({ prefix: key });
    const response: ActiveGame<Config, Player>[] = [];

    for await (const res of iter) {
      const gameId = res.key[res.key.length - 1] as string;
      const activeGame = res.value as ActiveGame<Config, Player> | null;
      if (activeGame && Array.isArray(activeGame.players)) {
        response.push(activeGame);
        continue;
      }
      const gameData = await this.getGameStorageData<Config, unknown, Player>(
        gameId,
      );
      response.push({
        gameId,
        config: gameData.config,
        players: gameData.players,
      });
    }

    return response;
  }

  // Watches for changes to the activeGameTriggerKey, which is an empty key only used
  // to trigger this method.
  public watchForActiveGameListChanges<Config, Player>(): ReadableStream<
    ActiveGame<Config, Player>[]
  > {
    const activeGameTriggerKey = getActiveGameTriggerKey();
    const stream = this.kv.watch([activeGameTriggerKey]);
    return stream.pipeThrough(
      new TransformStream({
        transform: async (_events, controller) => {
          const allGames = await this.getAllActiveGames<Config, Player>();
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
