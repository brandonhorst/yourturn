import { ulid } from "@std/ulid";
import type {
  ActiveGame,
  Room,
  SetupObject,
  TokenData,
  User as Player,
} from "../types.ts";

export type QueueConfig<Config> = {
  queueId: string;
  numPlayers: number;
  config: Config;
};

type QueueEntryValue<Loadout> = {
  timestamp: Date;
  userId: string;
  user: Player;
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
  player: Player;
  loadout: Loadout;
};

export type GameStorageData<Config, GameState, Outcome> = {
  config: Config;
  gameState: GameState;
  playerUserIds: string[];
  players: Player[];
  outcome: Outcome | undefined;
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
function getRoomListTriggerKey() {
  return ["roomlisttrigger"];
}
function getActiveGamesKey() {
  return ["activegames"];
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

export class DB<Config, GameState, Loadout, Outcome> {
  private kv: Deno.Kv;

  constructor(kv: Deno.Kv) {
    this.kv = kv;
  }

  public async addToQueue(
    queueConfig: QueueConfig<Config>,
    entryId: string,
    userId: string,
    user: Player,
    loadout: Loadout,
    setupGame: (
      setupObject: SetupObject<Config, Loadout>,
    ) => GameState,
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

  public async createRoom(
    roomId: string,
    roomConfig: {
      numPlayers: number;
      config: Config;
      private: boolean;
    },
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

  public async getRoom(
    roomId: string,
  ): Promise<RoomStorageData<Config, Loadout> | null> {
    const entry = await this.kv.get<RoomStorageData<Config, Loadout>>(
      getRoomKey(roomId),
    );
    return entry.value;
  }

  public async addToRoom(
    roomId: string,
    entryId: string,
    userId: string,
    user: Player,
    loadout: Loadout,
  ): Promise<void> {
    const roomKey = getRoomKey(roomId);
    const roomListTriggerKey = getRoomListTriggerKey();

    await repeatUntilSuccess(async () => {
      const roomEntry = await this.kv.get<
        RoomStorageData<Config, Loadout>
      >(
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
          { entryId, timestamp: new Date(), userId, player: user, loadout },
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

  public async removeFromRoom(
    roomId: string,
    entryId: string,
  ): Promise<void> {
    const roomKey = getRoomKey(roomId);
    const roomListTriggerKey = getRoomListTriggerKey();

    await repeatUntilSuccess(async () => {
      const roomEntry = await this.kv.get<
        RoomStorageData<Config, Loadout>
      >(
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

  // Creates a new game record and returns the base transaction plus game id.
  private createNewGameTransaction(
    setupGame: (setupObject: SetupObject<Config, Loadout>) => GameState,
    options: {
      activeGamesKey: Deno.KvKey;
      activeGamesEntry: Deno.KvEntryMaybe<ActiveGame<Config>[]>;
      config: Config;
      loadouts: Loadout[];
      numPlayers: number;
      playerUserIds: string[];
      players: Player[];
    },
  ): { transaction: Deno.AtomicOperation; gameId: string } {
    const gameId = ulid();
    const gameKey = getGameKey(gameId);
    const timestamp = new Date();
    const setupObject = {
      timestamp,
      numPlayers: options.numPlayers,
      config: options.config,
      loadouts: options.loadouts,
    };
    const gameState = setupGame(setupObject);
    const gameStorageData: GameStorageData<Config, GameState, Outcome> = {
      config: options.config,
      gameState,
      playerUserIds: options.playerUserIds,
      players: options.players,
      outcome: undefined,
    };
    const allActiveGames = options.activeGamesEntry.value ?? [];
    const activeGamesNext =
      allActiveGames.some((game) => game.gameId === gameId) ? allActiveGames : [
        ...allActiveGames,
        {
          gameId,
          players: options.players,
          config: options.config,
          created: timestamp,
        },
      ];

    const transaction = this.kv.atomic()
      .check(options.activeGamesEntry)
      .set(options.activeGamesKey, activeGamesNext)
      .check({ key: gameKey, versionstamp: null })
      .set(gameKey, gameStorageData);

    return { transaction, gameId };
  }

  public async commitRoom(
    roomId: string,
    setupGame: (
      setupObject: SetupObject<Config, Loadout>,
    ) => GameState,
  ): Promise<void> {
    const roomKey = getRoomKey(roomId);
    const roomListTriggerKey = getRoomListTriggerKey();
    const activeGamesKey = getActiveGamesKey();

    await repeatUntilSuccess(async () => {
      const roomEntry = await this.kv.get<
        RoomStorageData<Config, Loadout>
      >(
        roomKey,
      );
      if (roomEntry.value == null) {
        throw new Error(`Room ${roomId} not found`);
      }
      const activeGamesEntry = await this.kv.get<ActiveGame<Config>[]>(
        activeGamesKey,
      );
      const members = roomEntry.value.members;
      if (members.length < roomEntry.value.numPlayers) {
        throw new Error(`Room ${roomId} does not have enough players`);
      }

      const playerUserIds: string[] = [];
      const players: Player[] = [];
      const loadouts: Loadout[] = [];
      for (let i = 0; i < roomEntry.value.numPlayers; i++) {
        playerUserIds[i] = members[i].userId;
        players[i] = members[i].player;
        loadouts[i] = members[i].loadout;
      }

      const config = roomEntry.value.config;
      const { transaction, gameId } = this.createNewGameTransaction(
        setupGame,
        {
          activeGamesEntry,
          activeGamesKey,
          config,
          loadouts,
          numPlayers: roomEntry.value.numPlayers,
          playerUserIds,
          players,
        },
      );

      let transactionWithRoom = transaction
        .check(roomEntry)
        .set(roomListTriggerKey, {})
        .delete(roomKey);

      for (let i = 0; i < roomEntry.value.numPlayers; i++) {
        const member = members[i];
        const entryId = member.entryId;
        const assignmentKey = getAssignmentKey(entryId);
        const assignmentValue: AssignmentStorageData = { gameId };

        transactionWithRoom = transactionWithRoom
          .check({ key: assignmentKey, versionstamp: null })
          .set(assignmentKey, assignmentValue);
      }

      const res = await transactionWithRoom.commit();
      return res.ok;
    });
  }

  private async maybeGraduateFromQueue(
    queueConfig: QueueConfig<Config>,
    setupGame: (o: SetupObject<Config, Loadout>) => GameState,
  ): Promise<void> {
    const queuePrefix = getQueuePrefix(queueConfig.queueId);
    const activeGamesKey = getActiveGamesKey();

    await repeatUntilSuccess(async () => {
      // Get desired queue entries, if they exist
      const queueEntries = await Array.fromAsync(
        this.kv.list<QueueEntryValue<Loadout>>(
          { prefix: queuePrefix },
          { limit: queueConfig.numPlayers },
        ),
      );
      const activeGamesEntry = await this.kv.get<ActiveGame<Config>[]>(
        activeGamesKey,
      );

      // If the queue doesn't have enough entrants, stop
      if (queueEntries.length < queueConfig.numPlayers) {
        return true;
      }

      // Initialize Game Storage Data
      const playerUserIds: string[] = [];
      const players: Player[] = [];

      for (let i = 0; i < queueConfig.numPlayers; i++) {
        playerUserIds[i] = queueEntries[i].value.userId;
        players[i] = queueEntries[i].value.user;
      }
      const loadouts: Loadout[] = [];
      for (let i = 0; i < queueConfig.numPlayers; i++) {
        loadouts[i] = queueEntries[i].value.loadout;
      }
      const { transaction, gameId } = this.createNewGameTransaction(
        setupGame,
        {
          activeGamesEntry,
          activeGamesKey,
          config: queueConfig.config,
          loadouts,
          numPlayers: queueConfig.numPlayers,
          playerUserIds,
          players,
        },
      );

      // For each player
      let transactionWithAssignments = transaction;
      for (const entry of queueEntries) {
        const entryId = entry.key[2] as string;
        const assignmentKey = getAssignmentKey(entryId);
        const assignmentValue: AssignmentStorageData = {
          gameId,
        };

        // Delete their queue entry, and add an assignment
        transactionWithAssignments = transactionWithAssignments
          .check(entry)
          .delete(entry.key)
          .check({ key: assignmentKey, versionstamp: null })
          .set(assignmentKey, assignmentValue);
      }
      const res = await transactionWithAssignments.commit();
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
  public async updateGameStorageData(
    gameId: string,
    gameData: GameStorageData<Config, GameState, Outcome>,
  ): Promise<void> {
    const gameKey = getGameKey(gameId);
    const activeGamesKey = getActiveGamesKey();

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
      const activeGamesEntry = await this.kv.get<ActiveGame<Config>[]>(
        activeGamesKey,
      );
      const allActiveGames = activeGamesEntry.value ?? [];
      const activeGamesNext = allActiveGames.filter((game) =>
        game.gameId !== gameId
      );
      transaction = transaction
        .check(activeGamesEntry)
        .set(activeGamesKey, activeGamesNext);
    }

    const res = await transaction.commit();

    if (!res.ok) {
      throw new Error(`Failed to update game ${gameId}`);
    }
  }

  public async getGameStorageData(
    gameId: string,
  ): Promise<GameStorageData<Config, GameState, Outcome>> {
    const gameKey = getGameKey(gameId);
    const entry = await this.kv.get<
      GameStorageData<Config, GameState, Outcome>
    >(
      gameKey,
    );
    if (entry.value == null) {
      throw new Error(`Game ${gameId} not found`);
    } else {
      return entry.value;
    }
  }

  public watchForGameChanges(
    gameId: string,
  ): ReadableStream<GameStorageData<Config, GameState, Outcome>> {
    const gameKey = getGameKey(gameId);
    const stream = this.kv.watch([gameKey]);
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

  public async getAllActiveGames(): Promise<ActiveGame<Config>[]> {
    const entry = await this.kv.get<ActiveGame<Config>[]>(
      getActiveGamesKey(),
    );
    return entry.value ?? [];
  }

  // Watches for changes to the active game list key.
  public watchForActiveGameListChanges(): ReadableStream<ActiveGame<Config>[]> {
    const activeGamesKey = getActiveGamesKey();
    const stream = this.kv.watch([activeGamesKey]);
    return stream.pipeThrough(
      new TransformStream({
        transform: (events, controller) => {
          const data = events[0].value as ActiveGame<Config>[] | null;
          controller.enqueue(data ?? []);
        },
      }),
    );
  }

  public async getAllAvailableRooms(): Promise<Room<Config>[]> {
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
      const players = (room.members ?? []).map((member) => member.player);
      rooms.push({
        roomId,
        numPlayers: room.numPlayers,
        players,
        config: room.config,
      });
    }

    return rooms;
  }

  public watchForAvailableRoomListChanges(): ReadableStream<
    Room<Config>[]
  > {
    const roomListTriggerKey = getRoomListTriggerKey();
    const stream = this.kv.watch([roomListTriggerKey]);
    return stream.pipeThrough(
      new TransformStream({
        transform: async (_events, controller) => {
          const rooms = await this.getAllAvailableRooms();
          controller.enqueue(rooms);
        },
      }),
    );
  }

  public async storeUser(
    userId: string,
    user: Player,
    previousUsername?: string,
  ): Promise<void> {
    let transaction = this.kv.atomic()
      .set(getUserKey(userId), user)
      .set(getUserByUsernameKey(user.username), userId);

    if (previousUsername != null && previousUsername !== user.username) {
      transaction = transaction.delete(getUserByUsernameKey(previousUsername));
    }

    const res = await transaction.commit();
    if (!res.ok) {
      throw new Error(`Failed to store user ${userId}`);
    }
  }

  public async getUser(userId: string): Promise<Player | null> {
    const entry = await this.kv.get<Player>(getUserKey(userId));
    return entry.value;
  }

  public async usernameExists(username: string): Promise<boolean> {
    const entry = await this.kv.get<string>(getUserByUsernameKey(username));
    return entry.value != null;
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
