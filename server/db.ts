import { ulid } from "@std/ulid";
import type {
  ActiveGame,
  Room,
  SetupObject,
  TokenData,
  User,
} from "../types.ts";

export type QueueConfig<Config> = {
  queueId: string;
  numPlayers: number;
  config: Config;
};

type QueueEntryValue<Loadout> = {
  timestamp: Date;
  userId: string;
  user: User;
  loadout: Loadout;
};

export type RoomStorageData<Config, Loadout> = {
  numPlayers: number;
  config: Config;
  private: boolean;
  members: RoomMember<Loadout>[];
};

type RoomMember<Loadout> = {
  entryId: string;
  timestamp: Date;
  userId: string;
  user: User;
  loadout: Loadout;
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

async function repeatUntilSuccess(
  fn: () => Promise<boolean>,
): Promise<void> {
  let ok = false;
  while (!ok) {
    ok = await fn();
  }
}

function getQueuePrefix(queueId: string) {
  return ["queueentry", queueId];
}

function getQueueEntryKey(queueId: string, entryId: string) {
  return ["queueentry", queueId, entryId];
}
function getRoomPrefix() {
  return ["rooms"];
}
function getRoomKey(roomId: string) {
  return ["rooms", roomId];
}
function getAssignmentKey(entryId: string) {
  return ["assignments", entryId];
}
function getActiveGameTriggerKey() {
  return ["activegametrigger"];
}
function getRoomListTriggerKey() {
  return ["roomlisttrigger"];
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

export class DB<
  ConfigType = unknown,
  GameStateType = unknown,
  LoadoutType = unknown,
  OutcomeType = unknown,
> {
  private kv: Deno.Kv;

  constructor(kv: Deno.Kv) {
    this.kv = kv;
  }

  public async addToQueue<
    Config = ConfigType,
    GameState = GameStateType,
    Loadout = LoadoutType,
  >(
    queueConfig: QueueConfig<Config>,
    entryId: string,
    userId: string,
    user: User,
    loadout: Loadout,
    setupGame: (setupObject: SetupObject<Config, Loadout>) => GameState,
  ): Promise<void> {
    await repeatUntilSuccess(async () => {
      const entryKey = getQueueEntryKey(queueConfig.queueId, entryId);
      const res = await this.kv
        .atomic()
        .check({ key: entryKey, versionstamp: null })
        .set(entryKey, { timestamp: new Date(), userId, user, loadout })
        .commit();
      return res.ok;
    });

    await this.maybeGraduateFromQueue(queueConfig, setupGame);
  }

  public async removeFromQueue(
    queueId: string,
    entryId: string,
  ): Promise<void> {
    await repeatUntilSuccess(async () => {
      const entryKey = getQueueEntryKey(queueId, entryId);

      const res = await this.kv.atomic()
        .delete(entryKey)
        .commit();
      return res.ok;
    });
  }

  public async createRoom<Config = ConfigType, Loadout = LoadoutType>(
    roomId: string,
    roomConfig: { numPlayers: number; config: Config; private: boolean },
  ): Promise<void> {
    const roomKey = getRoomKey(roomId);
    const roomListTriggerKey = getRoomListTriggerKey();
    const roomData: RoomStorageData<Config, Loadout> = {
      numPlayers: roomConfig.numPlayers,
      config: roomConfig.config,
      private: roomConfig.private,
      members: [],
    };

    await repeatUntilSuccess(async () => {
      const res = await this.kv.atomic()
        .check({ key: roomKey, versionstamp: null })
        .set(roomKey, roomData)
        .set(roomListTriggerKey, {})
        .commit();
      return res.ok;
    });
  }

  public async getRoom<Config = ConfigType, Loadout = LoadoutType>(
    roomId: string,
  ): Promise<RoomStorageData<Config, Loadout> | null> {
    const entry = await this.kv.get<RoomStorageData<Config, Loadout>>(
      getRoomKey(roomId),
    );
    return entry.value;
  }

  public async addToRoom<Config = ConfigType, Loadout = LoadoutType>(
    roomId: string,
    entryId: string,
    userId: string,
    user: User,
    loadout: Loadout,
  ): Promise<void> {
    const roomKey = getRoomKey(roomId);
    const roomListTriggerKey = getRoomListTriggerKey();

    await repeatUntilSuccess(async () => {
      const roomEntry = await this.kv.get<RoomStorageData<Config, Loadout>>(
        roomKey,
      );
      if (roomEntry.value == null) {
        throw new Error(`Room ${roomId} not found`);
      }
      const currentMembers = roomEntry.value.members;
      if (currentMembers.length >= roomEntry.value.numPlayers) {
        throw new Error(`Room ${roomId} is full`);
      }

      const updatedRoom: RoomStorageData<Config, Loadout> = {
        ...roomEntry.value,
        members: [
          ...currentMembers,
          { entryId, timestamp: new Date(), userId, user, loadout },
        ],
      };

      const res = await this.kv.atomic()
        .check(roomEntry)
        .set(roomKey, updatedRoom)
        .set(roomListTriggerKey, {})
        .commit();

      return res.ok;
    });
  }

  public async removeFromRoom<Config = ConfigType, Loadout = LoadoutType>(
    roomId: string,
    entryId: string,
  ): Promise<void> {
    const roomKey = getRoomKey(roomId);
    const roomListTriggerKey = getRoomListTriggerKey();

    await repeatUntilSuccess(async () => {
      const roomEntry = await this.kv.get<RoomStorageData<Config, Loadout>>(
        roomKey,
      );
      if (roomEntry.value == null) {
        return true;
      }
      const members = roomEntry.value.members;
      const memberIndex = members.findIndex(
        (member) => member.entryId === entryId,
      );
      if (memberIndex === -1) {
        return true;
      }

      const nextMembers = members.toSpliced(memberIndex, 1);
      let transaction = this.kv.atomic()
        .check(roomEntry)
        .set(roomListTriggerKey, {});

      if (nextMembers.length === 0) {
        transaction = transaction.delete(roomKey);
      } else {
        transaction = transaction.set(roomKey, {
          ...roomEntry.value,
          members: nextMembers,
        });
      }

      const res = await transaction.commit();
      return res.ok;
    });
  }

  public async commitRoom<
    Config = ConfigType,
    GameState = GameStateType,
    Loadout = LoadoutType,
  >(
    roomId: string,
    setupGame: (setupObject: SetupObject<Config, Loadout>) => GameState,
  ): Promise<void> {
    const roomKey = getRoomKey(roomId);
    const activeGameTriggerKey = getActiveGameTriggerKey();
    const roomListTriggerKey = getRoomListTriggerKey();

    await repeatUntilSuccess(async () => {
      const roomEntry = await this.kv.get<RoomStorageData<Config, Loadout>>(
        roomKey,
      );
      if (roomEntry.value == null) {
        throw new Error(`Room ${roomId} not found`);
      }
      const members = roomEntry.value.members;
      if (members.length < roomEntry.value.numPlayers) {
        throw new Error(`Room ${roomId} does not have enough players`);
      }

      const gameId = ulid();
      const gameKey = getGameKey(gameId);
      const activeGameKey = getActiveGameKey(gameId);

      const playerUserIds: string[] = [];
      const players: User[] = [];
      const loadouts: Loadout[] = [];
      for (let i = 0; i < roomEntry.value.numPlayers; i++) {
        playerUserIds[i] = members[i].userId;
        players[i] = members[i].user;
        loadouts[i] = members[i].loadout;
      }

      const timestamp = new Date();
      const setupObject = {
        timestamp,
        numPlayers: roomEntry.value.numPlayers,
        config: roomEntry.value.config,
        loadouts,
      };
      const gameState = setupGame(setupObject);
      const gameStorageData: GameStorageData<Config, GameState, undefined> = {
        config: roomEntry.value.config,
        gameState,
        playerUserIds,
        players,
        outcome: undefined,
        version: 0,
      };

      let transaction = this.kv.atomic()
        .check(roomEntry)
        .set(activeGameTriggerKey, {})
        .check({ key: activeGameKey, versionstamp: null })
        .set(activeGameKey, {})
        .check({ key: gameKey, versionstamp: null })
        .set(gameKey, gameStorageData)
        .set(roomListTriggerKey, {})
        .delete(roomKey);

      for (let i = 0; i < roomEntry.value.numPlayers; i++) {
        const member = members[i];
        const entryId = member.entryId;
        const assignmentKey = getAssignmentKey(entryId);
        const assignmentValue: AssignmentStorageData = { gameId };

        transaction = transaction
          .check({ key: assignmentKey, versionstamp: null })
          .set(assignmentKey, assignmentValue);
      }

      const res = await transaction.commit();
      return res.ok;
    });
  }

  private async maybeGraduateFromQueue<
    Config = ConfigType,
    GameState = GameStateType,
    Loadout = LoadoutType,
  >(
    queueConfig: QueueConfig<Config>,
    setupGame: (o: SetupObject<Config, Loadout>) => GameState,
  ): Promise<void> {
    const gameId = ulid();
    const queuePrefix = getQueuePrefix(queueConfig.queueId);
    const gameKey = getGameKey(gameId);
    const activeGameKey = getActiveGameKey(gameId);
    const activeGameTriggerKey = getActiveGameTriggerKey();

    await repeatUntilSuccess(async () => {
      // Get desired queue entries, if they exist
      const queueEntries = await Array.fromAsync(
        this.kv.list<QueueEntryValue<Loadout>>(
          { prefix: queuePrefix },
          { limit: queueConfig.numPlayers },
        ),
      );

      // If the queue doesn't have enough entrants, stop
      if (queueEntries.length < queueConfig.numPlayers) {
        return true;
      }

      // Initialize Game Storage Data
      const playerUserIds: string[] = [];
      const players: User[] = [];

      for (let i = 0; i < queueConfig.numPlayers; i++) {
        playerUserIds[i] = queueEntries[i].value.userId;
        players[i] = queueEntries[i].value.user;
      }
      const timestamp = new Date();
      const loadouts: Loadout[] = [];
      const setupObject = {
        timestamp,
        numPlayers: queueConfig.numPlayers,
        config: queueConfig.config,
        loadouts,
      };
      for (let i = 0; i < queueConfig.numPlayers; i++) {
        loadouts[i] = queueEntries[i].value.loadout;
      }
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
      const res = await transaction.commit();
      return res.ok;
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
   * Updates game storage data.
   * @param gameId The ID of the game to update
   * @param gameData The updated game data
   */
  public async updateGameStorageData<
    Config = ConfigType,
    GameState = GameStateType,
    Outcome = OutcomeType,
  >(
    gameId: string,
    gameData: GameStorageData<Config, GameState, Outcome>,
  ): Promise<void> {
    const gameKey = getGameKey(gameId);
    const activeGameTriggerKey = getActiveGameTriggerKey();

    const entry = await this.kv.get<
      GameStorageData<Config, GameState, Outcome>
    >(
      gameKey,
    );
    if (entry.value == null) {
      throw new Error(`Appending moves to unstored ${gameId}`);
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

    const res = await transaction.commit();

    if (!res.ok) {
      throw new Error(`Failed to update game ${gameId}`);
    }
  }

  public async getGameStorageData<
    Config = ConfigType,
    GameState = GameStateType,
    Outcome = OutcomeType,
  >(
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

  public watchForGameChanges<
    Config = ConfigType,
    GameState = GameStateType,
    Outcome = OutcomeType,
  >(
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

  public async getAllAvailableRooms<
    Config = ConfigType,
    Loadout = LoadoutType,
  >(): Promise<Room<Config>[]> {
    const roomPrefix = getRoomPrefix();
    const iter = this.kv.list<RoomStorageData<Config, Loadout>>(
      { prefix: roomPrefix },
    );
    const rooms: Room<Config>[] = [];

    for await (const res of iter) {
      const roomId = res.key[res.key.length - 1] as string;
      const room = res.value;
      if (room.private) {
        continue;
      }
      const players = (room.members ?? []).map((member) => member.user);
      rooms.push({
        roomId,
        numPlayers: room.numPlayers,
        players,
        config: room.config,
      });
    }

    return rooms;
  }

  public watchForAvailableRoomListChanges<
    Config = ConfigType,
    Loadout = LoadoutType,
  >(): ReadableStream<Room<Config>[]> {
    const roomListTriggerKey = getRoomListTriggerKey();
    const stream = this.kv.watch([roomListTriggerKey]);
    return stream.pipeThrough(
      new TransformStream({
        transform: async (_events, controller) => {
          const rooms = await this.getAllAvailableRooms<Config, Loadout>();
          controller.enqueue(rooms);
        },
      }),
    );
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
