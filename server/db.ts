import { ulid } from "@std/ulid";
import type {
  ActiveGame,
  AvailableRoom,
  Game,
  Player,
  QueueConfig,
  QueueEntry,
  TokenData,
} from "../types.ts";
import { assert } from "@std/assert";

type QueueEntryValue<Loadout> = {
  timestamp: Date;
  userId: string;
  user: Player;
  loadout: Loadout;
  assignmentSubscriptionId?: string;
};

export type RoomStorageData<Config, Loadout> = {
  numPlayers: number;
  config: Config;
  private: boolean;
  members: RoomMember<Loadout>[];
};

export type RoomWatchEvent<Config, Loadout> =
  | { type: "updated"; room: RoomStorageData<Config, Loadout> }
  | { type: "deleted" };

type RoomMember<Loadout> = {
  entryId: string;
  timestamp: Date;
  userId: string;
  player: Player;
  loadout: Loadout;
  assignmentSubscriptionId?: string;
};

export type GameStorageData<Config, GameState, Outcome> = {
  config: Config;
  queueId?: string;
  gameState: GameState;
  userIds: string[];
  players: Player[];
  outcome: Outcome | undefined;
};

export type GameAssignmentNotification = {
  gameId: string;
  subscriptionId?: string;
};

export type JoinedRoom<Loadout> = {
  roomId: string;
  loadout: Loadout;
};

export type UserStorageData<Rating> = {
  player: Player;
  ratings: Record<string, Rating>;
};

export type UserMatchmakingStorageData<Config, Loadout> = {
  activeGames: ActiveGame<Config>[];
  joinedRooms: JoinedRoom<Loadout>[];
  queueEntries: QueueEntry<Loadout>[];
};

function getQueuePrefix(queueId: string) {
  return ["queueentry", queueId];
}

function getQueueEntryKey(queueId: string, entryId: string) {
  return ["queueentry", queueId, entryId];
}
function getRoomKey(roomId: string) {
  return ["rooms", roomId];
}
function getAvailablePublicRoomsKey() {
  return ["availablepublicrooms"];
}
function getAvailablePublicRoomKey(roomId: string) {
  return ["availablepublicrooms", roomId];
}
function getActivePublicGamesKey() {
  return ["activepublicgames"];
}
function getActivePublicGameKey(gameId: string) {
  return ["activepublicgames", gameId];
}
function getGameKey(gameId: string) {
  return ["games", gameId];
}
function getUserKey(userId: string) {
  return ["users", userId];
}
function getUserMatchmakingKey(userId: string) {
  return ["usermatchmakings", userId];
}
function getUserByUsernameKey(username: string) {
  return ["usersByUsername", username];
}
function getTokenKey(token: string) {
  return ["tokens", token];
}

const PUBLIC_LIST_READ_LIMIT = 500;
const PUBLIC_LIST_BATCH_SIZE = 500;
const U64_MAX = (1n << 64n) - 1n;

export class DB<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Rating,
  Loadout,
> {
  private kv: Deno.Kv;
  private game: Game<
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
  private async repeatUntilTransactionSucceeds(
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
  private getQueueConfig(queueId: string): QueueConfig<Config> {
    const queueConfig = this.game.queues[queueId];
    if (queueConfig == null) {
      throw new Error(`Queue ${queueId} not found`);
    }
    return queueConfig;
  }

  /**
   * Reads one snapshot batch for a direct-child index prefix.
   */
  private async listSingleBatch<T>(
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
  private mutateIndexedListRootCountOnOperation(
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
  private mutateActivePublicGamesRootCountOnOperation(
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
   * Mutates the available public rooms root count.
   */
  private mutateAvailablePublicRoomsRootCountOnOperation(
    transaction: Deno.AtomicOperation,
    delta: -1 | 0 | 1,
  ): void {
    this.mutateIndexedListRootCountOnOperation(
      transaction,
      getAvailablePublicRoomsKey(),
      delta,
    );
  }

  public async addToQueue(
    queueId: string,
    entryId: string,
    userId: string,
    user: Player,
    loadout: Loadout,
    assignmentSubscriptionId?: string,
  ): Promise<GameAssignmentNotification[]> {
    const queueConfig = this.getQueueConfig(queueId);
    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const entryKey = getQueueEntryKey(queueId, entryId);
      const userMatchmakingEntry = await this.kv.get<
        UserMatchmakingStorageData<Config, Loadout>
      >(
        getUserMatchmakingKey(userId),
      );
      if (userMatchmakingEntry.value == null) {
        throw new Error(`User ${userId} not found`);
      }

      const queueEntry: QueueEntry<Loadout> = {
        queueId,
        loadout,
      };
      const updatedUserMatchmaking: UserMatchmakingStorageData<
        Config,
        Loadout
      > = {
        ...userMatchmakingEntry.value,
        queueEntries: [...userMatchmakingEntry.value.queueEntries, queueEntry],
      };

      transaction
        .check({ key: entryKey, versionstamp: null })
        .set(entryKey, {
          timestamp: new Date(),
          userId,
          user,
          loadout,
          assignmentSubscriptionId,
        })
        .check(userMatchmakingEntry)
        .set(getUserMatchmakingKey(userId), updatedUserMatchmaking);
    });

    return await this.maybeGraduateFromQueue(queueId, queueConfig);
  }

  public async removeFromQueue(
    queueId: string,
    entryId: string,
  ): Promise<void> {
    const entryKey = getQueueEntryKey(queueId, entryId);

    // First get the entry to find the userId
    const entry = await this.kv.get<QueueEntryValue<Loadout>>(entryKey);
    if (entry.value == null) {
      // Entry already removed, nothing to do
      return;
    }

    const userId = entry.value.userId;

    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const userMatchmakingEntry = await this.kv.get<
        UserMatchmakingStorageData<Config, Loadout>
      >(
        getUserMatchmakingKey(userId),
      );
      if (userMatchmakingEntry.value == null) {
        throw new Error(`User ${userId} not found`);
      }

      const updatedQueues = userMatchmakingEntry.value.queueEntries.filter(
        (q) => q.queueId !== queueId,
      );
      const updatedUserMatchmaking: UserMatchmakingStorageData<
        Config,
        Loadout
      > = {
        ...userMatchmakingEntry.value,
        queueEntries: updatedQueues,
      };

      transaction
        .delete(entryKey)
        .check(userMatchmakingEntry)
        .set(getUserMatchmakingKey(userId), updatedUserMatchmaking);
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
    const roomData: RoomStorageData<Config, Loadout> = {
      numPlayers: roomConfig.numPlayers,
      config: roomConfig.config,
      private: roomConfig.private,
      members: [],
    };

    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      transaction
        .check({ key: roomKey, versionstamp: null })
        .set(roomKey, roomData);
      await this.updateAvailablePublicRoomsOnOperation(
        transaction,
        { roomId, room: roomData },
      );
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

  // Watches a room record and emits updates as well as room deletion events.
  public watchForRoomChanges(
    roomId: string,
  ): ReadableStream<RoomWatchEvent<Config, Loadout>> {
    const roomKey = getRoomKey(roomId);
    const stream = this.kv.watch<RoomStorageData<Config, Loadout>[]>([roomKey]);
    return stream.pipeThrough(
      new TransformStream({
        transform: (events, controller) => {
          const room = events[0].value;
          if (room == null) {
            controller.enqueue({ type: "deleted" });
            return;
          }
          controller.enqueue({ type: "updated", room });
        },
      }),
    );
  }

  public async addToRoom(
    roomId: string,
    entryId: string,
    userId: string,
    user: Player,
    loadout: Loadout,
    assignmentSubscriptionId?: string,
  ): Promise<void> {
    const roomKey = getRoomKey(roomId);

    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const roomEntry = await this.kv.get<
        RoomStorageData<Config, Loadout>
      >(
        roomKey,
      );
      if (roomEntry.value == null) {
        throw new Error(`Room ${roomId} not found`);
      }
      const currentMembers = roomEntry.value.members;
      if (currentMembers.some((member) => member.userId === userId)) {
        throw new Error(`User ${userId} already in room ${roomId}`);
      }
      if (currentMembers.length >= roomEntry.value.numPlayers) {
        throw new Error(`Room ${roomId} is full`);
      }

      const userMatchmakingEntry = await this.kv.get<
        UserMatchmakingStorageData<Config, Loadout>
      >(
        getUserMatchmakingKey(userId),
      );
      if (userMatchmakingEntry.value == null) {
        throw new Error(`User ${userId} not found`);
      }

      const updatedRoom: RoomStorageData<Config, Loadout> = {
        ...roomEntry.value,
        members: [
          ...currentMembers,
          {
            entryId,
            timestamp: new Date(),
            userId,
            player: user,
            loadout,
            assignmentSubscriptionId,
          },
        ],
      };

      const updatedUserMatchmaking: UserMatchmakingStorageData<
        Config,
        Loadout
      > = {
        ...userMatchmakingEntry.value,
        joinedRooms: [
          ...userMatchmakingEntry.value.joinedRooms,
          { roomId, loadout },
        ],
      };

      transaction
        .check(roomEntry)
        .set(roomKey, updatedRoom)
        .check(userMatchmakingEntry)
        .set(getUserMatchmakingKey(userId), updatedUserMatchmaking);
      await this.updateAvailablePublicRoomsOnOperation(
        transaction,
        { roomId, room: updatedRoom },
      );
    });
  }

  public async removeFromRoom(
    roomId: string,
    entryId: string,
  ): Promise<void> {
    const roomKey = getRoomKey(roomId);

    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const roomEntry = await this.kv.get<
        RoomStorageData<Config, Loadout>
      >(
        roomKey,
      );
      if (roomEntry.value == null) {
        throw new Error(`Attempted to remove from non-existant room ${roomId}`);
      }
      const members = roomEntry.value.members;
      const memberIndex = members.findIndex(
        (member) => member.entryId === entryId,
      );
      if (memberIndex === -1) {
        throw new Error(
          `Attempted to remove non-existing entry ${entryId} room ${roomId}`,
        );
      }

      const userId = members[memberIndex].userId;
      const userMatchmakingEntry = await this.kv.get<
        UserMatchmakingStorageData<Config, Loadout>
      >(
        getUserMatchmakingKey(userId),
      );
      if (userMatchmakingEntry.value == null) {
        throw new Error(`User ${userId} not found`);
      }

      const nextMembers = members.toSpliced(memberIndex, 1);

      // Remove this room from the user's joinedRooms.
      const updatedRooms = userMatchmakingEntry.value.joinedRooms.filter(
        (r) => r.roomId !== roomId,
      );
      const updatedUserMatchmaking: UserMatchmakingStorageData<
        Config,
        Loadout
      > = {
        ...userMatchmakingEntry.value,
        joinedRooms: updatedRooms,
      };

      transaction
        .check(roomEntry)
        .check(userMatchmakingEntry)
        .set(getUserMatchmakingKey(userId), updatedUserMatchmaking);

      if (nextMembers.length === 0) {
        transaction.delete(roomKey);
      } else {
        transaction.set(roomKey, {
          ...roomEntry.value,
          members: nextMembers,
        });
      }
      await this.updateAvailablePublicRoomsOnOperation(
        transaction,
        {
          roomId,
          room: nextMembers.length === 0 ? null : {
            ...roomEntry.value,
            members: nextMembers,
          },
          wasPrivate: roomEntry.value.private,
        },
      );
    });
  }

  // Creates a new game record and updates global and user-specific active game lists
  // by mutating the provided transaction.
  private async createNewGameOnOperation(
    transaction: Deno.AtomicOperation,
    options: {
      config: Config;
      gameId: string;
      loadouts: Loadout[];
      queueId?: string;
      userIds: string[];
    },
  ): Promise<void> {
    const activePublicGameKey = getActivePublicGameKey(options.gameId);
    const gameKey = getGameKey(options.gameId);
    const timestamp = new Date();
    // Fetch user records needed to build the new game state.
    const userKeys = options.userIds.map((userId) => getUserKey(userId));
    const userMatchmakingKeys = options.userIds.map((userId) =>
      getUserMatchmakingKey(userId)
    );
    const [userEntries, userMatchmakingEntries] = await Promise
      .all([
        this.kv.getMany<UserStorageData<Rating>[]>(userKeys),
        this.kv.getMany<UserMatchmakingStorageData<Config, Loadout>[]>(
          userMatchmakingKeys,
        ),
      ]);

    // Validate that all users and matchmaking records exist.
    for (const userEntry of userEntries) {
      assert(userEntry.value != null);
    }
    for (const userMatchmakingEntry of userMatchmakingEntries) {
      assert(userMatchmakingEntry.value != null);
    }
    const players = userEntries.map((userEntry) => userEntry.value!.player);

    // Build the new game state and active public game payloads.
    const setupObject = {
      timestamp,
      numPlayers: options.userIds.length,
      config: options.config,
      loadouts: options.loadouts,
    };
    const gameState = this.game.setup(setupObject);
    const gameStorageData: GameStorageData<Config, GameState, Outcome> = {
      config: options.config,
      queueId: options.queueId,
      gameState,
      userIds: options.userIds,
      players,
      outcome: undefined,
    };

    const activePublicGame: ActiveGame<Config> = {
      gameId: options.gameId,
      players,
      config: options.config,
      created: timestamp,
    };

    // Mutate the provided transaction with game + active list index + user updates.
    transaction
      .check({ key: activePublicGameKey, versionstamp: null })
      .set(activePublicGameKey, activePublicGame)
      .check({ key: gameKey, versionstamp: null })
      .set(gameKey, gameStorageData);
    this.mutateActivePublicGamesRootCountOnOperation(transaction, 1);

    for (const userMatchmakingEntry of userMatchmakingEntries) {
      const userActiveGamesNext = [
        ...userMatchmakingEntry.value!.activeGames ?? [],
        activePublicGame,
      ];

      const updatedUserMatchmaking: UserMatchmakingStorageData<
        Config,
        Loadout
      > = {
        ...userMatchmakingEntry.value!,
        activeGames: userActiveGamesNext,
      };

      transaction
        .check(userMatchmakingEntry)
        .set(userMatchmakingEntry.key, updatedUserMatchmaking);
    }
  }

  // Updates the indexed available public room list by mutating the provided
  // transaction. When room is null, the room is removed from the list.
  private async updateAvailablePublicRoomsOnOperation(
    transaction: Deno.AtomicOperation,
    options: {
      roomId: string;
      room: RoomStorageData<Config, Loadout> | null;
      wasPrivate?: boolean;
    },
  ): Promise<void> {
    if (options.room == null && options.wasPrivate === true) {
      return;
    }
    if (options.room != null && options.room.private) {
      return;
    }

    const availablePublicRoomKey = getAvailablePublicRoomKey(options.roomId);
    const availablePublicRoomEntry = await this.kv.get<
      AvailableRoom<Config>
    >(
      availablePublicRoomKey,
    );

    if (options.room == null) {
      if (availablePublicRoomEntry.value == null) {
        return;
      }
      transaction
        .check(availablePublicRoomEntry)
        .delete(availablePublicRoomKey);
      this.mutateAvailablePublicRoomsRootCountOnOperation(transaction, -1);
    } else {
      const nextRoom: AvailableRoom<Config> = {
        roomId: options.roomId,
        numPlayers: options.room.numPlayers,
        players: options.room.members.map((member) => member.player),
        config: options.room.config,
      };
      if (availablePublicRoomEntry.value == null) {
        transaction
          .check({ key: availablePublicRoomKey, versionstamp: null })
          .set(availablePublicRoomKey, nextRoom);
        this.mutateAvailablePublicRoomsRootCountOnOperation(transaction, 1);
      } else {
        transaction
          .check(availablePublicRoomEntry)
          .set(availablePublicRoomKey, nextRoom);
        this.mutateAvailablePublicRoomsRootCountOnOperation(transaction, 0);
      }
    }
  }

  public async commitRoom(
    roomId: string,
  ): Promise<GameAssignmentNotification[]> {
    const roomKey = getRoomKey(roomId);
    let gameAssignments: GameAssignmentNotification[] = [];

    await this.repeatUntilTransactionSucceeds(async (transaction) => {
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

      const assignedMembers = members.slice(0, roomEntry.value.numPlayers);
      const userIds = assignedMembers.map((member) => member.userId);
      const loadouts = assignedMembers.map((member) => member.loadout);

      const config = roomEntry.value.config;
      const gameId = ulid();
      gameAssignments = assignedMembers.map((member) => ({
        gameId,
        subscriptionId: member.assignmentSubscriptionId,
      }));
      await this.createNewGameOnOperation(
        transaction,
        {
          config,
          gameId,
          loadouts,
          userIds,
        },
      );

      transaction
        .check(roomEntry)
        .delete(roomKey);
      await this.updateAvailablePublicRoomsOnOperation(
        transaction,
        { roomId, room: null, wasPrivate: roomEntry.value.private },
      );

      // Fetch all user matchmaking entries to update their joinedRooms.
      const userMatchmakingKeys = userIds.map((userId) =>
        getUserMatchmakingKey(userId)
      );
      const userMatchmakingEntries = await this.kv.getMany<
        UserMatchmakingStorageData<Config, Loadout>[]
      >(userMatchmakingKeys);

      for (let i = 0; i < assignedMembers.length; i++) {
        const userMatchmakingEntry = userMatchmakingEntries[i];
        if (userMatchmakingEntry.value == null) {
          throw new Error(`User ${userIds[i]} not found`);
        }

        // Remove this room from the user's joinedRooms.
        const updatedRooms = userMatchmakingEntry.value.joinedRooms.filter(
          (r) => r.roomId !== roomId,
        );
        const updatedUserMatchmaking: UserMatchmakingStorageData<
          Config,
          Loadout
        > = {
          ...userMatchmakingEntry.value,
          joinedRooms: updatedRooms,
        };

        transaction
          .check(userMatchmakingEntry)
          .set(userMatchmakingKeys[i], updatedUserMatchmaking);
      }
    });

    return gameAssignments;
  }

  private async maybeGraduateFromQueue(
    queueId: string,
    queueConfig: QueueConfig<Config>,
  ): Promise<GameAssignmentNotification[]> {
    const queuePrefix = getQueuePrefix(queueId);
    let gameAssignments: GameAssignmentNotification[] = [];

    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      // Get desired queue entries, if they exist
      const queueEntries = await Array.fromAsync(
        this.kv.list<QueueEntryValue<Loadout>>(
          { prefix: queuePrefix },
          { limit: queueConfig.numPlayers },
        ),
      );
      // If the queue doesn't have enough entrants, stop
      if (queueEntries.length < queueConfig.numPlayers) {
        gameAssignments = [];
        return; // Nothing to do
      }

      // Initialize Game Storage Data
      const userIds: string[] = [];

      for (let i = 0; i < queueConfig.numPlayers; i++) {
        userIds[i] = queueEntries[i].value.userId;
      }
      const loadouts: Loadout[] = [];
      for (let i = 0; i < queueConfig.numPlayers; i++) {
        loadouts[i] = queueEntries[i].value.loadout;
      }
      const gameId = ulid();
      gameAssignments = queueEntries.map((entry) => ({
        gameId,
        subscriptionId: entry.value.assignmentSubscriptionId,
      }));
      await this.createNewGameOnOperation(
        transaction,
        {
          config: queueConfig.config,
          gameId,
          loadouts,
          queueId,
          userIds,
        },
      );

      // Fetch all user matchmaking entries to update their joinedQueues.
      const userMatchmakingKeys = userIds.map((userId) =>
        getUserMatchmakingKey(userId)
      );
      const userMatchmakingEntries = await this.kv.getMany<
        UserMatchmakingStorageData<Config, Loadout>[]
      >(userMatchmakingKeys);

      // For each player
      for (let i = 0; i < queueEntries.length; i++) {
        const entry = queueEntries[i];

        const userMatchmakingEntry = userMatchmakingEntries[i];
        if (userMatchmakingEntry.value == null) {
          throw new Error(`User ${userIds[i]} not found`);
        }

        // Remove this queue from the user's queueEntries
        const updatedQueues = userMatchmakingEntry.value.queueEntries.filter(
          (q) => q.queueId !== queueId,
        );
        const updatedUserMatchmaking: UserMatchmakingStorageData<
          Config,
          Loadout
        > = {
          ...userMatchmakingEntry.value,
          queueEntries: updatedQueues,
        };

        // Delete their queue entry, add an assignment, and update user data
        transaction
          .check(entry)
          .delete(entry.key)
          .check(userMatchmakingEntry)
          .set(userMatchmakingKeys[i], updatedUserMatchmaking);
      }
    });

    return gameAssignments;
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
    const activePublicGameKey = getActivePublicGameKey(gameId);

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
      // If the game is over, remove it from the active public game index.
      const activePublicGameEntry = await this.kv.get<ActiveGame<Config>>(
        activePublicGameKey,
      );
      if (activePublicGameEntry.value != null) {
        transaction = transaction
          .check(activePublicGameEntry)
          .delete(activePublicGameKey);
        this.mutateActivePublicGamesRootCountOnOperation(transaction, -1);
      }
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

  // Returns all currently active public games.
  public async getAllActivePublicGames(): Promise<ActiveGame<Config>[]> {
    const activePublicGameEntries = await this.listSingleBatch<
      ActiveGame<Config>
    >(
      getActivePublicGamesKey(),
    );
    return activePublicGameEntries.map((entry) => entry.value);
  }

  public watchForGameChanges(
    gameId: string,
  ): ReadableStream<GameStorageData<Config, GameState, Outcome>> {
    const gameKey = getGameKey(gameId);
    const stream = this.kv.watch<GameStorageData<Config, GameState, Outcome>[]>(
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

  // Watches the active public games root key and emits full indexed snapshots.
  public watchForActivePublicGamesListChanges(): ReadableStream<
    ActiveGame<Config>[]
  > {
    const activePublicGamesKey = getActivePublicGamesKey();
    const stream = this.kv.watch<[Deno.KvU64]>([activePublicGamesKey]);
    return stream.pipeThrough(
      new TransformStream({
        transform: async (_events, controller) => {
          const data = await this.getAllActivePublicGames();
          controller.enqueue(data);
        },
      }),
    );
  }

  // Returns all currently available public rooms.
  public async getAllAvailablePublicRooms(): Promise<AvailableRoom<Config>[]> {
    const availablePublicRoomEntries = await this.listSingleBatch<
      AvailableRoom<Config>
    >(
      getAvailablePublicRoomsKey(),
    );
    return availablePublicRoomEntries.map((entry) => entry.value);
  }

  // Watches the available public rooms root key and emits full indexed snapshots.
  public watchForAvailablePublicRoomListChanges(): ReadableStream<
    AvailableRoom<Config>[]
  > {
    const availablePublicRoomsKey = getAvailablePublicRoomsKey();
    const stream = this.kv.watch<[Deno.KvU64]>([availablePublicRoomsKey]);
    return stream.pipeThrough(
      new TransformStream({
        transform: async (_events, controller) => {
          const data = await this.getAllAvailablePublicRooms();
          controller.enqueue(data);
        },
      }),
    );
  }

  // Creates a new user record and username index entry if neither already exists.
  public async createNewUserStorageData(
    userId: string,
    data: UserStorageData<Rating>,
  ): Promise<void> {
    const userKey = getUserKey(userId);
    const usernameKey = getUserByUsernameKey(data.player.username);
    const res = await this.kv.atomic()
      .check({ key: userKey, versionstamp: null })
      .check({ key: usernameKey, versionstamp: null })
      .set(userKey, data)
      .set(usernameKey, userId)
      .commit();
    if (!res.ok) {
      throw new Error(
        `User ${userId} or username ${data.player.username} already exists`,
      );
    }
  }

  // Upserts user storage data and keeps the username index in sync.
  public async updateUserStorageData(
    userId: string,
    data: Partial<UserStorageData<Rating>>,
  ): Promise<void> {
    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const entry = await this.kv.get<UserStorageData<Rating>>(
        getUserKey(userId),
      );
      if (entry.value == null) {
        throw new Error(`Updating unstored user ${userId}`);
      }
      const existingData = entry.value;

      const updatedData: UserStorageData<Rating> = {
        ...existingData,
        ...data,
      };

      const previousUsername = existingData.player.username;
      const updatedUsername = updatedData.player.username;
      transaction
        .check(entry)
        .set(getUserKey(userId), updatedData);
      if (previousUsername !== updatedUsername) {
        transaction
          .delete(getUserByUsernameKey(previousUsername))
          .set(getUserByUsernameKey(updatedUsername), userId);
      } else {
        transaction.set(getUserByUsernameKey(previousUsername), userId);
      }
    });
  }

  // Fetches the stored user data for a userId, if present.
  public async getUserStorageData(
    userId: string,
  ): Promise<UserStorageData<Rating> | null> {
    const entry = await this.kv.get<UserStorageData<Rating>>(
      getUserKey(userId),
    );
    return entry.value;
  }

  /**
   * Creates a new user matchmaking record if one does not already exist.
   */
  public async createNewUserMatchmakingStorageData(
    userId: string,
    data: UserMatchmakingStorageData<Config, Loadout>,
  ): Promise<void> {
    const userMatchmakingKey = getUserMatchmakingKey(userId);
    const res = await this.kv.atomic()
      .check({ key: userMatchmakingKey, versionstamp: null })
      .set(userMatchmakingKey, data)
      .commit();
    if (!res.ok) {
      throw new Error(`User matchmaking ${userId} already exists`);
    }
  }

  /**
   * Upserts user matchmaking storage data.
   */
  public async updateUserMatchmakingStorageData(
    userId: string,
    data: Partial<UserMatchmakingStorageData<Config, Loadout>>,
  ): Promise<void> {
    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const entry = await this.kv.get<
        UserMatchmakingStorageData<Config, Loadout>
      >(
        getUserMatchmakingKey(userId),
      );
      if (entry.value == null) {
        throw new Error(`Updating unstored user matchmaking ${userId}`);
      }

      const updatedData: UserMatchmakingStorageData<Config, Loadout> = {
        ...entry.value,
        ...data,
      };

      transaction
        .check(entry)
        .set(getUserMatchmakingKey(userId), updatedData);
    });
  }

  /**
   * Fetches the stored user matchmaking data for a userId, if present.
   */
  public async getUserMatchmakingStorageData(
    userId: string,
  ): Promise<UserMatchmakingStorageData<Config, Loadout> | null> {
    const entry = await this.kv.get<
      UserMatchmakingStorageData<Config, Loadout>
    >(
      getUserMatchmakingKey(userId),
    );
    return entry.value;
  }

  /**
   * Watches user matchmaking storage data updates for one user.
   */
  public watchForUserMatchmakingChanges(
    userId: string,
  ): ReadableStream<UserMatchmakingStorageData<Config, Loadout>> {
    const userMatchmakingKey = getUserMatchmakingKey(userId);
    const stream = this.kv.watch<[UserMatchmakingStorageData<Config, Loadout>]>(
      [
        userMatchmakingKey,
      ],
    );
    return stream.pipeThrough(
      new TransformStream({
        transform: (events, controller) => {
          const data = events[0].value;
          if (data != null) {
            controller.enqueue(data);
          }
        },
      }),
    );
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
