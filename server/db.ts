import { ulid } from "@std/ulid";
import type { ActiveGame, SetupObject, TokenData, User } from "../types.ts";

export type QueueConfig<Config> = {
  queueId: string;
  numPlayers: number;
  config: Config;
};

type QueueEntryValue = {
  timestamp: Date;
  userId: string;
  user: User;
};

export type GameStorageData<Config, GameState, Outcome> = {
  config: Config;
  gameState: GameState;
  playerUserIds: string[];
  players: User[];
  outcome: Outcome | undefined;
  version: number;
};

export type AssignmentStorageData = {
  gameId: string;
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
function getUserKey(userId: string) {
  return ["users", userId];
}
function getUserByUsernameKey(username: string) {
  return ["usersByUsername", username];
}
function getTokenKey(token: string) {
  return ["tokens", token];
}

export class DB {
  private kv: Deno.Kv;

  constructor(kv: Deno.Kv) {
    this.kv = kv;
  }

  public async addToQueue<Config, GameState>(
    queueConfig: QueueConfig<Config>,
    entryId: string,
    userId: string,
    user: User,
    setupGame: (setupObject: SetupObject<Config>) => GameState,
  ): Promise<void> {
    await repeatUntilSuccess(async () => {
      const entryKey = getQueueEntryKey(queueConfig.queueId, entryId);
      return await this.kv
        .atomic()
        .check({ key: entryKey, versionstamp: null })
        .set(entryKey, { timestamp: new Date(), userId, user })
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

  private async maybeGraduateFromQueue<Config, GameState>(
    queueConfig: QueueConfig<Config>,
    setupGame: (o: SetupObject<Config>) => GameState,
  ): Promise<void> {
    const gameId = ulid();
    const queuePrefix = getQueuePrefix(queueConfig.queueId);
    const gameKey = getGameKey(gameId);
    const activeGameKey = getActiveGameKey(gameId);
    const activeGameTriggerKey = getActiveGameTriggerKey();

    await repeatUntilSuccess(async () => {
      // Get desired queue entries, if they exist
      const queueEntries = await Array.fromAsync(this.kv.list<QueueEntryValue>(
        { prefix: queuePrefix },
        { limit: queueConfig.numPlayers },
      ));

      // If the queue doesn't have enough entrants, stop
      if (queueEntries.length < queueConfig.numPlayers) {
        return { ok: true };
      }

      // Initialize Game Storage Data
      const playerUserIds: string[] = [];
      const players: User[] = [];

      for (let i = 0; i < queueConfig.numPlayers; i++) {
        playerUserIds[i] = queueEntries[i].value.userId;
        players[i] = queueEntries[i].value.user;
      }
      const timestamp = new Date();
      const setupObject = { timestamp, players, config: queueConfig.config };
      const gameState = setupGame(setupObject);
      const gameStorageData: GameStorageData<Config, GameState, undefined> = {
        config: queueConfig.config,
        gameState,
        playerUserIds,
        players,
        outcome: undefined,
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
  public async updateGameStorageData<Config, GameState, Outcome>(
    gameId: string,
    gameData: GameStorageData<Config, GameState, Outcome>,
    refreshDelay?: number,
  ): Promise<void> {
    const gameKey = getGameKey(gameId);
    const activeGameTriggerKey = getActiveGameTriggerKey();

    const entry = await this.kv.get<
      GameStorageData<Config, GameState, Outcome>
    >(
      gameKey,
    );
    if (entry.value == null) {
      throw new Error(`Appending moves to unknown unstored ${gameId}`);
    }

    let transaction = this.kv.atomic()
      .check(entry)
      .set(gameKey, gameData);

    if (gameData.outcome !== undefined) {
      const activeGameKey = getActiveGameKey(gameId);
      transaction = transaction
        .delete(activeGameKey)
        .set(activeGameTriggerKey, {});
    }

    // If refreshDelay is provided, enqueue a refresh as part of the same transaction
    if (refreshDelay !== undefined && gameData.outcome === undefined) {
      transaction = transaction.enqueue(gameId, { delay: refreshDelay });
    }

    const res = await transaction.commit();

    if (!res.ok) {
      throw new Error(`Failed to update game ${gameId}`);
    }
  }

  public async getGameStorageData<Config, GameState, Outcome>(
    gameId: string,
  ): Promise<GameStorageData<Config, GameState, Outcome>> {
    const key = getGameKey(gameId);
    const entry = await this.kv.get<
      GameStorageData<Config, GameState, Outcome>
    >(
      key,
    );
    if (entry.value == null) {
      throw new Error(`Game ${gameId} not found`);
    } else {
      return entry.value;
    }
  }

  public watchForGameChanges<Config, GameState, Outcome>(
    gameId: string,
  ): ReadableStream<GameStorageData<Config, GameState, Outcome>> {
    const key = getGameKey(gameId);
    const stream = this.kv.watch([key]);
    return stream.pipeThrough(
      new TransformStream({
        transform(events, controller) {
          const data = events[0].value as
            | GameStorageData<Config, GameState, Outcome>
            | null;
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

  public async storeUser(
    userId: string,
    user: User,
    previousUsername?: string,
  ): Promise<void> {
    let transaction = this.kv.atomic()
      .set(getUserKey(userId), user)
      .set(getUserByUsernameKey(user.username), user);

    if (previousUsername != null && previousUsername !== user.username) {
      transaction = transaction.delete(getUserByUsernameKey(previousUsername));
    }

    const res = await transaction.commit();
    if (!res.ok) {
      throw new Error(`Failed to store user ${userId}`);
    }
  }

  public async getUser(userId: string): Promise<User | null> {
    const entry = await this.kv.get<User>(getUserKey(userId));
    return entry.value ?? null;
  }

  public async getUserByUsername(username: string): Promise<User | null> {
    const entry = await this.kv.get<User>(getUserByUsernameKey(username));
    return entry.value ?? null;
  }

  public async storeToken(token: string, tokenData: TokenData): Promise<void> {
    const res = await this.kv.atomic()
      .set(getTokenKey(token), tokenData)
      .commit();
    if (!res.ok) {
      throw new Error(`Failed to store token`);
    }
  }

  public async getToken(token: string): Promise<TokenData | null> {
    const entry = await this.kv.get<TokenData>(getTokenKey(token));
    return entry.value ?? null;
  }
}
