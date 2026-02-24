import { ulid } from "@std/ulid";
import type {
  ActiveGame,
  AvailableRoom,
  PlayerSnapshot,
  QueueConfig,
} from "@/types.ts";
import type {
  GameAssignmentNotification,
  GameStorageData,
  QueueEntryValue,
  RoomStorageData,
  RoomWatchEvent,
  UserMatchmakingStorageData,
} from "@/server/db/types.ts";
import {
  getActivePublicGameKey,
  getActivePublicGamesKey,
  getAvailablePublicRoomKey,
  getAvailablePublicRoomsKey,
  getGameKey,
  getQueueEntryKey,
  getQueuePrefix,
  getRoomKey,
  getUserMatchmakingKey,
} from "@/server/db/utils.ts";
import { PresenceDB } from "@/server/db/presence.ts";

/**
 * Matchmaking, room, game, and list-index persistence methods.
 */
export class MatchmakingDB<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Rating,
  Loadout,
> extends PresenceDB<
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
   * Adds one user to a queue and attempts queue graduation if capacity is met.
   */
  public async addToQueue(
    queueId: string,
    entryId: string,
    userId: string,
    playerSnapshot: PlayerSnapshot<Rating>,
    loadout: Loadout,
    assignmentSubscriptionId?: string,
  ): Promise<GameAssignmentNotification[]> {
    const queueConfig = this.getQueueConfig(queueId);
    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const entryKey = getQueueEntryKey(queueId, entryId);
      const userMatchmakingEntry = await this.kv.get<
        UserMatchmakingStorageData<Config, Loadout, Rating>
      >(
        getUserMatchmakingKey(userId),
      );
      if (userMatchmakingEntry.value == null) {
        throw new Error(`User ${userId} not found`);
      }

      const queueEntry = {
        queueId,
        loadout,
      };
      const updatedUserMatchmaking: UserMatchmakingStorageData<
        Config,
        Loadout,
        Rating
      > = {
        ...userMatchmakingEntry.value,
        queueEntries: [...userMatchmakingEntry.value.queueEntries, queueEntry],
      };

      transaction
        .check({ key: entryKey, versionstamp: null })
        .set(entryKey, {
          timestamp: new Date(),
          userId,
          playerSnapshot,
          loadout,
          assignmentSubscriptionId,
        })
        .check(userMatchmakingEntry)
        .set(getUserMatchmakingKey(userId), updatedUserMatchmaking);
    });

    return await this.maybeGraduateFromQueue(queueId, queueConfig);
  }

  /**
   * Removes one queue entry and clears that queue from the owner's matchmaking data.
   */
  public async removeFromQueue(
    queueId: string,
    entryId: string,
  ): Promise<void> {
    const entryKey = getQueueEntryKey(queueId, entryId);

    // First get the entry to find the userId.
    const entry = await this.kv.get<QueueEntryValue<Loadout, Rating>>(entryKey);
    if (entry.value == null) {
      // Entry already removed, nothing to do.
      return;
    }

    const userId = entry.value.userId;

    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const userMatchmakingEntry = await this.kv.get<
        UserMatchmakingStorageData<Config, Loadout, Rating>
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
        Loadout,
        Rating
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

  /**
   * Creates a new room and updates the available-public-rooms index if needed.
   */
  public async createRoom(
    roomId: string,
    roomConfig: {
      numPlayers: number;
      config: Config;
      private: boolean;
    },
  ): Promise<void> {
    const roomKey = getRoomKey(roomId);
    const roomData: RoomStorageData<Config, Loadout, Rating> = {
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

  /**
   * Fetches one room record by room ID.
   */
  public async getRoom(
    roomId: string,
  ): Promise<RoomStorageData<Config, Loadout, Rating> | null> {
    const entry = await this.kv.get<RoomStorageData<Config, Loadout, Rating>>(
      getRoomKey(roomId),
    );
    return entry.value;
  }

  /**
   * Watches a room record and emits updates as well as room deletion events.
   */
  public watchForRoomChanges(
    roomId: string,
  ): ReadableStream<RoomWatchEvent<Config, Loadout, Rating>> {
    const roomKey = getRoomKey(roomId);
    const stream = this.kv.watch<RoomStorageData<Config, Loadout, Rating>[]>([
      roomKey,
    ]);
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

  /**
   * Adds one user to a room and updates related user matchmaking and room indexes.
   */
  public async addToRoom(
    roomId: string,
    entryId: string,
    userId: string,
    playerSnapshot: PlayerSnapshot<Rating>,
    loadout: Loadout,
    assignmentSubscriptionId?: string,
  ): Promise<void> {
    const roomKey = getRoomKey(roomId);

    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const roomEntry = await this.kv.get<
        RoomStorageData<Config, Loadout, Rating>
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
        UserMatchmakingStorageData<Config, Loadout, Rating>
      >(
        getUserMatchmakingKey(userId),
      );
      if (userMatchmakingEntry.value == null) {
        throw new Error(`User ${userId} not found`);
      }

      const updatedRoom: RoomStorageData<Config, Loadout, Rating> = {
        ...roomEntry.value,
        members: [
          ...currentMembers,
          {
            entryId,
            timestamp: new Date(),
            userId,
            playerSnapshot,
            loadout,
            assignmentSubscriptionId,
          },
        ],
      };

      const updatedUserMatchmaking: UserMatchmakingStorageData<
        Config,
        Loadout,
        Rating
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

  /**
   * Removes one room member and cleans up room or user state as needed.
   */
  public async removeFromRoom(
    roomId: string,
    entryId: string,
  ): Promise<void> {
    const roomKey = getRoomKey(roomId);

    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const roomEntry = await this.kv.get<
        RoomStorageData<Config, Loadout, Rating>
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
        UserMatchmakingStorageData<Config, Loadout, Rating>
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
        Loadout,
        Rating
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

  /**
   * Creates a new game record and updates global/user active-game indexes in one transaction.
   */
  private async createNewGameOnOperation(
    transaction: Deno.AtomicOperation,
    options: {
      config: Config;
      gameId: string;
      loadouts: Loadout[];
      playerSnapshots: PlayerSnapshot<Rating>[];
      queueId?: string;
      userIds: string[];
    },
  ): Promise<void> {
    const activePublicGameKey = getActivePublicGameKey(options.gameId);
    const gameKey = getGameKey(options.gameId);
    const timestamp = new Date();
    const userMatchmakingKeys = options.userIds.map((userId) =>
      getUserMatchmakingKey(userId)
    );
    const userMatchmakingEntries = await this.kv.getMany<
      UserMatchmakingStorageData<Config, Loadout, Rating>[]
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

    // Build the new game state and active public game payloads.
    const setupObject = {
      timestamp,
      numPlayers: options.userIds.length,
      config: options.config,
      loadouts: options.loadouts,
    };
    const gameState = this.game.setup(setupObject);
    const gameStorageData: GameStorageData<Config, GameState, Outcome, Rating> =
      {
        config: options.config,
        queueId: options.queueId,
        gameState,
        userIds: options.userIds,
        players: options.playerSnapshots,
        outcome: undefined,
      };

    const activePublicGame: ActiveGame<Config, Rating> = {
      gameId: options.gameId,
      players: options.playerSnapshots,
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
        Loadout,
        Rating
      > = {
        ...userMatchmakingEntry.value!,
        activeGames: userActiveGamesNext,
      };

      transaction
        .check(userMatchmakingEntry)
        .set(userMatchmakingEntry.key, updatedUserMatchmaking);
    }
  }

  /**
   * Updates the available-public-rooms index entry for one room in the provided transaction.
   */
  private async updateAvailablePublicRoomsOnOperation(
    transaction: Deno.AtomicOperation,
    options: {
      roomId: string;
      room: RoomStorageData<Config, Loadout, Rating> | null;
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
      AvailableRoom<Config, Rating>
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
      const nextRoom: AvailableRoom<Config, Rating> = {
        roomId: options.roomId,
        numPlayers: options.room.numPlayers,
        players: options.room.members.map((member) => member.playerSnapshot),
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

  /**
   * Converts a full room into a committed game and returns assignment notifications.
   */
  public async commitRoom(
    roomId: string,
  ): Promise<GameAssignmentNotification[]> {
    const roomKey = getRoomKey(roomId);
    let gameAssignments: GameAssignmentNotification[] = [];

    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const roomEntry = await this.kv.get<
        RoomStorageData<Config, Loadout, Rating>
      >(
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
      const playerSnapshots = assignedMembers.map((member) =>
        member.playerSnapshot
      );

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
          playerSnapshots,
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
        UserMatchmakingStorageData<Config, Loadout, Rating>[]
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
          Loadout,
          Rating
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

  /**
   * Starts a game when a queue reaches required players and returns assignment notifications.
   */
  private async maybeGraduateFromQueue(
    queueId: string,
    queueConfig: QueueConfig<Config>,
  ): Promise<GameAssignmentNotification[]> {
    const queuePrefix = getQueuePrefix(queueId);
    let gameAssignments: GameAssignmentNotification[] = [];

    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      // Get desired queue entries, if they exist.
      const queueEntries = await Array.fromAsync(
        this.kv.list<QueueEntryValue<Loadout, Rating>>(
          { prefix: queuePrefix },
          { limit: queueConfig.numPlayers },
        ),
      );
      // If the queue doesn't have enough entrants, stop.
      if (queueEntries.length < queueConfig.numPlayers) {
        gameAssignments = [];
        return; // Nothing to do.
      }

      // Initialize game storage data.
      const userIds: string[] = [];

      for (let i = 0; i < queueConfig.numPlayers; i++) {
        userIds[i] = queueEntries[i].value.userId;
      }
      const loadouts: Loadout[] = [];
      const playerSnapshots: PlayerSnapshot<Rating>[] = [];
      for (let i = 0; i < queueConfig.numPlayers; i++) {
        loadouts[i] = queueEntries[i].value.loadout;
        playerSnapshots[i] = queueEntries[i].value.playerSnapshot;
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
          playerSnapshots,
          queueId,
          userIds,
        },
      );

      // Fetch all user matchmaking entries to update their joinedQueues.
      const userMatchmakingKeys = userIds.map((userId) =>
        getUserMatchmakingKey(userId)
      );
      const userMatchmakingEntries = await this.kv.getMany<
        UserMatchmakingStorageData<Config, Loadout, Rating>[]
      >(userMatchmakingKeys);

      // For each player.
      for (let i = 0; i < queueEntries.length; i++) {
        const entry = queueEntries[i];

        const userMatchmakingEntry = userMatchmakingEntries[i];
        if (userMatchmakingEntry.value == null) {
          throw new Error(`User ${userIds[i]} not found`);
        }

        // Remove this queue from the user's queueEntries.
        const updatedQueues = userMatchmakingEntry.value.queueEntries.filter(
          (q) => q.queueId !== queueId,
        );
        const updatedUserMatchmaking: UserMatchmakingStorageData<
          Config,
          Loadout,
          Rating
        > = {
          ...userMatchmakingEntry.value,
          queueEntries: updatedQueues,
        };

        // Delete their queue entry, add an assignment, and update user data.
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
   * @param gameId The ID of the game to update.
   * @param gameData The updated game data.
   */
  public async updateGameStorageData(
    gameId: string,
    gameData: GameStorageData<Config, GameState, Outcome, Rating>,
  ): Promise<void> {
    const gameKey = getGameKey(gameId);
    const activePublicGameKey = getActivePublicGameKey(gameId);

    const entry = await this.kv.get<
      GameStorageData<Config, GameState, Outcome, Rating>
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
      const activePublicGameEntry = await this.kv.get<
        ActiveGame<Config, Rating>
      >(
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

  /**
   * Fetches one game storage record by game ID.
   */
  public async getGameStorageData(
    gameId: string,
  ): Promise<GameStorageData<Config, GameState, Outcome, Rating>> {
    const gameKey = getGameKey(gameId);
    const entry = await this.kv.get<
      GameStorageData<Config, GameState, Outcome, Rating>
    >(
      gameKey,
    );
    if (entry.value == null) {
      throw new Error(`Game ${gameId} not found`);
    } else {
      return entry.value;
    }
  }

  /**
   * Returns all currently active public games.
   */
  public async getAllActivePublicGames(): Promise<
    ActiveGame<Config, Rating>[]
  > {
    const activePublicGameEntries = await this.listSingleBatch<
      ActiveGame<Config, Rating>
    >(
      getActivePublicGamesKey(),
    );
    return activePublicGameEntries.map((entry) => entry.value);
  }

  /**
   * Watches one game record and emits non-null game snapshots.
   */
  public watchForGameChanges(
    gameId: string,
  ): ReadableStream<GameStorageData<Config, GameState, Outcome, Rating>> {
    const gameKey = getGameKey(gameId);
    const stream = this.kv.watch<
      GameStorageData<Config, GameState, Outcome, Rating>[]
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

  /**
   * Watches the active-public-games root key and emits full indexed snapshots.
   */
  public watchForActivePublicGamesListChanges(): ReadableStream<
    ActiveGame<Config, Rating>[]
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

  /**
   * Returns all currently available public rooms.
   */
  public async getAllAvailablePublicRooms(): Promise<
    AvailableRoom<Config, Rating>[]
  > {
    const availablePublicRoomEntries = await this.listSingleBatch<
      AvailableRoom<Config, Rating>
    >(
      getAvailablePublicRoomsKey(),
    );
    return availablePublicRoomEntries.map((entry) => entry.value);
  }

  /**
   * Watches the available-public-rooms root key and emits full indexed snapshots.
   */
  public watchForAvailablePublicRoomListChanges(): ReadableStream<
    AvailableRoom<Config, Rating>[]
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

  /**
   * Creates a new user matchmaking record if one does not already exist.
   */
  public async createNewUserMatchmakingStorageData(
    userId: string,
    data: UserMatchmakingStorageData<Config, Loadout, Rating>,
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
    data: Partial<UserMatchmakingStorageData<Config, Loadout, Rating>>,
  ): Promise<void> {
    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const entry = await this.kv.get<
        UserMatchmakingStorageData<Config, Loadout, Rating>
      >(
        getUserMatchmakingKey(userId),
      );
      if (entry.value == null) {
        throw new Error(`Updating unstored user matchmaking ${userId}`);
      }

      const updatedData: UserMatchmakingStorageData<Config, Loadout, Rating> = {
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
  ): Promise<UserMatchmakingStorageData<Config, Loadout, Rating> | null> {
    const entry = await this.kv.get<
      UserMatchmakingStorageData<Config, Loadout, Rating>
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
  ): ReadableStream<UserMatchmakingStorageData<Config, Loadout, Rating>> {
    const userMatchmakingKey = getUserMatchmakingKey(userId);
    const stream = this.kv.watch<
      [UserMatchmakingStorageData<Config, Loadout, Rating>]
    >([
      userMatchmakingKey,
    ]);
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
}
