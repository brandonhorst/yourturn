import { ulid } from "@std/ulid";
import {
  logServer,
  serializeLogValue,
  type ServerLogLevel,
} from "../logging.ts";
import type {
  ActiveMatch,
  AuditLogEntry,
  AuditLogEntryPayload,
  AvailableRoom,
  CompletedMatchSnapshot,
  GameDefinition,
  GameTypes,
  PlayerSnapshot,
  QueueConfig,
  QueueEntry,
  TokenData,
  UserProfileViewData,
} from "@/types/mod.ts";
import {
  ACTIVE_PUBLIC_USER_TTL_MS,
  DB_LOG_MODULE,
  PUBLIC_LIST_BATCH_SIZE,
  PUBLIC_LIST_READ_LIMIT,
  U64_MAX,
  USER_COMPLETED_MATCHES_BATCH_SIZE,
  USER_COMPLETED_MATCHES_READ_LIMIT,
} from "./constants.ts";
import {
  getActivePublicMatchesKey,
  getActivePublicMatchKey,
  getActivePublicUserKey,
  getActivePublicUsersKey,
  getAuditLogEntryKey,
  getAvailablePublicRoomKey,
  getAvailablePublicRoomsKey,
  getMatchKey,
  getQueueEntryKey,
  getQueuePrefix,
  getRoomKey,
  getTokenKey,
  getUserByUsernameKey,
  getUserCompletedMatchesKey,
  getUserCompletedMatchKey,
  getUserKey,
  getUserMatchmakingKey,
} from "./keys.ts";
import {
  type ActiveUserStorageData,
  type MatchAssignmentNotification,
  type MatchStorageData,
  type RoomStorageData,
  type RoomWatchEvent,
  type UserMatchmakingStorageData,
  type UserStorageData,
  userStorageDataToUserProfileViewData,
} from "./models.ts";

type QueueEntryValue<T extends GameTypes> = {
  timestamp: Date;
  userId: string;
  playerSnapshot: PlayerSnapshot<T>;
  loadout: T["Loadout"];
  assignmentSubscriptionId?: string;
};

export class DB<
  T extends GameTypes,
> {
  private kv: Deno.Kv;
  private game: GameDefinition<T>;

  constructor(
    kv: Deno.Kv,
    game: GameDefinition<T>,
  ) {
    this.kv = kv;
    this.game = game;
    this.log("INFO", "DB initialized");
  }

  /**
   * Emits one log entry for database operations.
   */
  private log(level: ServerLogLevel, message: string): void {
    logServer(DB_LOG_MODULE, level, message);
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
  private getQueueConfig(queueId: string): QueueConfig<T> {
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
   * Mutates the active public matches root count.
   */
  private mutateActivePublicMatchesRootCountOnOperation(
    transaction: Deno.AtomicOperation,
    delta: -1 | 0 | 1,
  ): void {
    this.mutateIndexedListRootCountOnOperation(
      transaction,
      getActivePublicMatchesKey(),
      delta,
    );
  }

  /**
   * Mutates the active public users root ticker.
   */
  private mutateActivePublicUsersRootCountOnOperation(
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

  /**
   * Mutates one user's completed-games history root ticker.
   */
  private mutateUserCompletedMatchesRootCountOnOperation(
    transaction: Deno.AtomicOperation,
    userId: string,
    delta: -1 | 0 | 1,
  ): void {
    this.mutateIndexedListRootCountOnOperation(
      transaction,
      getUserCompletedMatchesKey(userId),
      delta,
    );
  }

  /**
   * Appends one audit log entry to the provided transaction.
   */
  private setAuditLogEntryOnOperation(
    transaction: Deno.AtomicOperation,
    payload: AuditLogEntryPayload,
  ): void {
    const id = ulid();
    const logEntryKey = getAuditLogEntryKey(id);
    const logEntry: AuditLogEntry = { id, payload };
    transaction
      .check({ key: logEntryKey, versionstamp: null })
      .set(logEntryKey, logEntry);
  }

  public async addToQueue(
    queueId: string,
    entryId: string,
    userId: string,
    playerSnapshot: PlayerSnapshot<T>,
    loadout: T["Loadout"],
    assignmentSubscriptionId?: string,
  ): Promise<MatchAssignmentNotification[]> {
    this.log(
      "INFO",
      `addToQueue request=${
        serializeLogValue({
          queueId,
          entryId,
          userId,
          playerSnapshot,
          loadout,
          assignmentSubscriptionId,
        })
      }`,
    );
    const queueConfig = this.getQueueConfig(queueId);
    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const entryKey = getQueueEntryKey(queueId, entryId);
      const userMatchmakingEntry = await this.kv.get<
        UserMatchmakingStorageData<T>
      >(
        getUserMatchmakingKey(userId),
      );
      if (userMatchmakingEntry.value == null) {
        throw new Error(`User ${userId} not found`);
      }

      const queueEntry: QueueEntry<T> = {
        queueId,
        loadout,
      };
      const updatedUserMatchmaking: UserMatchmakingStorageData<T> = {
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
      this.setAuditLogEntryOnOperation(transaction, {
        type: "AddToQueue",
        userId,
        queueId,
        entryId,
      });
    });

    const assignments = await this.maybeGraduateFromQueue(
      queueId,
      queueConfig,
      userId,
    );
    this.log(
      "INFO",
      `addToQueue result=${
        serializeLogValue({ queueId, entryId, userId, assignments })
      }`,
    );
    return assignments;
  }

  public async removeFromQueue(
    queueId: string,
    entryId: string,
  ): Promise<void> {
    this.log(
      "INFO",
      `removeFromQueue request=${serializeLogValue({ queueId, entryId })}`,
    );
    const entryKey = getQueueEntryKey(queueId, entryId);

    // First get the entry to find the userId
    const entry = await this.kv.get<QueueEntryValue<T>>(entryKey);
    if (entry.value == null) {
      // Entry already removed, nothing to do
      this.log(
        "INFO",
        `removeFromQueue noop=${serializeLogValue({ queueId, entryId })}`,
      );
      return;
    }

    const userId = entry.value.userId;

    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const userMatchmakingEntry = await this.kv.get<
        UserMatchmakingStorageData<T>
      >(
        getUserMatchmakingKey(userId),
      );
      if (userMatchmakingEntry.value == null) {
        throw new Error(`User ${userId} not found`);
      }

      const updatedQueues = userMatchmakingEntry.value.queueEntries.filter(
        (q) => q.queueId !== queueId,
      );
      const updatedUserMatchmaking: UserMatchmakingStorageData<T> = {
        ...userMatchmakingEntry.value,
        queueEntries: updatedQueues,
      };

      transaction
        .delete(entryKey)
        .check(userMatchmakingEntry)
        .set(getUserMatchmakingKey(userId), updatedUserMatchmaking);
      this.setAuditLogEntryOnOperation(transaction, {
        type: "RemoveFromQueue",
        userId,
        queueId,
        entryId,
      });
    });
    this.log(
      "INFO",
      `removeFromQueue completed=${
        serializeLogValue({ queueId, entryId, userId })
      }`,
    );
  }

  public async createRoom(
    roomId: string,
    userId: string,
    roomConfig: {
      numPlayers: number;
      config: T["Config"];
      private: boolean;
    },
  ): Promise<void> {
    this.log(
      "INFO",
      `createRoom request=${serializeLogValue({ roomId, userId, roomConfig })}`,
    );
    const roomKey = getRoomKey(roomId);
    const roomData: RoomStorageData<T> = {
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
      this.setAuditLogEntryOnOperation(transaction, {
        type: "CreateRoom",
        userId,
        roomId,
        private: roomConfig.private,
      });
    });
    this.log(
      "INFO",
      `createRoom completed=${serializeLogValue({ roomId, userId })}`,
    );
  }

  public async getRoom(
    roomId: string,
  ): Promise<RoomStorageData<T> | null> {
    this.log(
      "INFO",
      `getRoom request=${serializeLogValue({ roomId })}`,
    );
    const entry = await this.kv.get<RoomStorageData<T>>(
      getRoomKey(roomId),
    );
    this.log(
      "INFO",
      `getRoom response=${serializeLogValue({ roomId, room: entry.value })}`,
    );
    return entry.value;
  }

  // Watches a room record and emits updates as well as room deletion events.
  public watchForRoomChanges(
    roomId: string,
  ): ReadableStream<RoomWatchEvent<T>> {
    this.log(
      "INFO",
      `watchForRoomChanges request=${serializeLogValue({ roomId })}`,
    );
    const roomKey = getRoomKey(roomId);
    const stream = this.kv.watch<RoomStorageData<T>[]>([
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

  public async addToRoom(
    roomId: string,
    entryId: string,
    userId: string,
    playerSnapshot: PlayerSnapshot<T>,
    loadout: T["Loadout"],
    assignmentSubscriptionId?: string,
  ): Promise<void> {
    this.log(
      "INFO",
      `addToRoom request=${
        serializeLogValue({
          roomId,
          entryId,
          userId,
          playerSnapshot,
          loadout,
          assignmentSubscriptionId,
        })
      }`,
    );
    const roomKey = getRoomKey(roomId);

    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const roomEntry = await this.kv.get<
        RoomStorageData<T>
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
        UserMatchmakingStorageData<T>
      >(
        getUserMatchmakingKey(userId),
      );
      if (userMatchmakingEntry.value == null) {
        throw new Error(`User ${userId} not found`);
      }

      const updatedRoom: RoomStorageData<T> = {
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

      const updatedUserMatchmaking: UserMatchmakingStorageData<T> = {
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
      this.setAuditLogEntryOnOperation(transaction, {
        type: "AddToRoom",
        userId,
        roomId,
        entryId,
      });
    });
    this.log(
      "INFO",
      `addToRoom completed=${serializeLogValue({ roomId, entryId, userId })}`,
    );
  }

  public async removeFromRoom(
    roomId: string,
    entryId: string,
  ): Promise<void> {
    this.log(
      "INFO",
      `removeFromRoom request=${serializeLogValue({ roomId, entryId })}`,
    );
    const roomKey = getRoomKey(roomId);

    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const roomEntry = await this.kv.get<
        RoomStorageData<T>
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
        UserMatchmakingStorageData<T>
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
      const updatedUserMatchmaking: UserMatchmakingStorageData<T> = {
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
      this.setAuditLogEntryOnOperation(transaction, {
        type: "RemoveFromRoom",
        userId,
        roomId,
        entryId,
      });
    });
    this.log(
      "INFO",
      `removeFromRoom completed=${serializeLogValue({ roomId, entryId })}`,
    );
  }

  // Creates a new game record and updates global and user-specific active game lists
  // by mutating the provided transaction.
  private async createNewMatchOnOperation(
    transaction: Deno.AtomicOperation,
    options: {
      config: T["Config"];
      matchId: string;
      loadouts: T["Loadout"][];
      playerSnapshots: PlayerSnapshot<T>[];
      queueId?: string;
      userIds: string[];
    },
  ): Promise<void> {
    const activePublicMatchKey = getActivePublicMatchKey(options.matchId);
    const gameKey = getMatchKey(options.matchId);
    const timestamp = new Date();
    const userMatchmakingKeys = options.userIds.map((userId) =>
      getUserMatchmakingKey(userId)
    );
    const userMatchmakingEntries = await this.kv.getMany<
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

    // Build the new game state and active public game payloads.
    const setupObject = {
      timestamp,
      numPlayers: options.userIds.length,
      config: options.config,
      loadouts: options.loadouts,
    };
    const gameState = this.game.setup(setupObject);
    const gameStorageData: MatchStorageData<T> = {
      config: options.config,
      queueId: options.queueId,
      gameState,
      userIds: options.userIds,
      players: options.playerSnapshots,
      outcome: undefined,
    };

    const activePublicMatch: ActiveMatch<T> = {
      matchId: options.matchId,
      players: options.playerSnapshots,
      config: options.config,
      created: timestamp,
    };

    // Mutate the provided transaction with game + active list index + user updates.
    transaction
      .check({ key: activePublicMatchKey, versionstamp: null })
      .set(activePublicMatchKey, activePublicMatch)
      .check({ key: gameKey, versionstamp: null })
      .set(gameKey, gameStorageData);
    this.mutateActivePublicMatchesRootCountOnOperation(transaction, 1);

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

  // Updates the indexed available public room list by mutating the provided
  // transaction. When room is null, the room is removed from the list.
  private async updateAvailablePublicRoomsOnOperation(
    transaction: Deno.AtomicOperation,
    options: {
      roomId: string;
      room: RoomStorageData<T> | null;
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
      AvailableRoom<T>
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
      const nextRoom: AvailableRoom<T> = {
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

  public async commitRoom(
    roomId: string,
    userId: string,
  ): Promise<MatchAssignmentNotification[]> {
    this.log(
      "INFO",
      `commitRoom request=${serializeLogValue({ roomId, userId })}`,
    );
    const roomKey = getRoomKey(roomId);
    let matchAssignments: MatchAssignmentNotification[] = [];

    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const roomEntry = await this.kv.get<
        RoomStorageData<T>
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
      const matchId = ulid();
      matchAssignments = assignedMembers.map((member) => ({
        matchId,
        subscriptionId: member.assignmentSubscriptionId,
      }));
      await this.createNewMatchOnOperation(
        transaction,
        {
          config,
          matchId,
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
        UserMatchmakingStorageData<T>[]
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
        const updatedUserMatchmaking: UserMatchmakingStorageData<T> = {
          ...userMatchmakingEntry.value,
          joinedRooms: updatedRooms,
        };

        transaction
          .check(userMatchmakingEntry)
          .set(userMatchmakingKeys[i], updatedUserMatchmaking);
      }
      this.setAuditLogEntryOnOperation(transaction, {
        type: "CommitRoom",
        userId,
        roomId,
        matchId,
      });
    });

    this.log(
      "INFO",
      `commitRoom result=${
        serializeLogValue({ roomId, userId, matchAssignments })
      }`,
    );
    return matchAssignments;
  }

  private async maybeGraduateFromQueue(
    queueId: string,
    queueConfig: QueueConfig<T>,
    userId: string,
  ): Promise<MatchAssignmentNotification[]> {
    this.log(
      "INFO",
      `maybeGraduateFromQueue request=${
        serializeLogValue({
          queueId,
          userId,
          numPlayers: queueConfig.numPlayers,
        })
      }`,
    );
    const queuePrefix = getQueuePrefix(queueId);
    let matchAssignments: MatchAssignmentNotification[] = [];

    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      // Get desired queue entries, if they exist
      const queueEntries = await Array.fromAsync(
        this.kv.list<QueueEntryValue<T>>(
          { prefix: queuePrefix },
          { limit: queueConfig.numPlayers },
        ),
      );
      // If the queue doesn't have enough entrants, stop
      if (queueEntries.length < queueConfig.numPlayers) {
        matchAssignments = [];
        return; // Nothing to do
      }

      // Initialize Match Storage Data
      const userIds: string[] = [];

      for (let i = 0; i < queueConfig.numPlayers; i++) {
        userIds[i] = queueEntries[i].value.userId;
      }
      const loadouts: T["Loadout"][] = [];
      const playerSnapshots: PlayerSnapshot<T>[] = [];
      for (let i = 0; i < queueConfig.numPlayers; i++) {
        loadouts[i] = queueEntries[i].value.loadout;
        playerSnapshots[i] = queueEntries[i].value.playerSnapshot;
      }
      const matchId = ulid();
      matchAssignments = queueEntries.map((entry) => ({
        matchId,
        subscriptionId: entry.value.assignmentSubscriptionId,
      }));
      await this.createNewMatchOnOperation(
        transaction,
        {
          config: queueConfig.config,
          matchId,
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
        UserMatchmakingStorageData<T>[]
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
        const updatedUserMatchmaking: UserMatchmakingStorageData<T> = {
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
      this.setAuditLogEntryOnOperation(transaction, {
        type: "GraduateQueue",
        userId,
        queueId,
        matchId,
      });
    });

    this.log(
      "INFO",
      `maybeGraduateFromQueue result=${
        serializeLogValue({ queueId, userId, matchAssignments })
      }`,
    );
    return matchAssignments;
  }

  /**
   * Updates match storage data and persists per-user completion history
   * snapshots when a match first reaches an outcome.
   * Also refreshes per-user matchmaking records so state-derived payloads can
   * be re-projected by channel subscribers.
   * @param matchId The ID of the match to update
   * @param gameData The updated match data
   * @param userId The actor performing the match mutation
   */
  public async updateMatchStorageData(
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

    const entry = await this.kv.get<
      MatchStorageData<T>
    >(
      gameKey,
    );
    if (entry.value == null) {
      throw new Error(`Appending moves to unstored ${matchId}`);
    }

    const outcome = gameData.outcome;
    let completedMatchEntryId: string | undefined;
    const activePublicMatchEntry = await this.kv.get<
      ActiveMatch<T>
    >(
      activePublicMatchKey,
    );
    const userMatchmakingEntries = await this.kv.getMany<
      UserMatchmakingStorageData<T>[]
    >(userMatchmakingKeys);

    let transaction = this.kv.atomic()
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
      // If the match is over, remove it from the active public match index.
      if (activePublicMatchEntry.value != null) {
        transaction = transaction
          .check(activePublicMatchEntry)
          .delete(activePublicMatchKey);
        this.mutateActivePublicMatchesRootCountOnOperation(transaction, -1);
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

      // Persist one denormalized completion snapshot per player profile feed.
      for (const participantUserId of participantUserIds) {
        const completedMatchKey = getUserCompletedMatchKey(
          participantUserId,
          completedMatchEntryId,
        );
        transaction = transaction
          .check({ key: completedMatchKey, versionstamp: null })
          .set(completedMatchKey, completedMatch);
        this.mutateUserCompletedMatchesRootCountOnOperation(
          transaction,
          participantUserId,
          1,
        );
      }
    } else if (activePublicMatchEntry.value != null) {
      // Trigger active public match list subscribers to re-project public state.
      this.mutateActivePublicMatchesRootCountOnOperation(transaction, 0);
    }

    this.setAuditLogEntryOnOperation(transaction, {
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

  public async getMatchStorageData(
    matchId: string,
  ): Promise<MatchStorageData<T>> {
    this.log(
      "INFO",
      `getMatchStorageData request=${serializeLogValue({ matchId })}`,
    );
    const gameKey = getMatchKey(matchId);
    const entry = await this.kv.get<
      MatchStorageData<T>
    >(
      gameKey,
    );
    if (entry.value == null) {
      throw new Error(`Match ${matchId} not found`);
    } else {
      this.log(
        "INFO",
        `getMatchStorageData response=${
          serializeLogValue({ matchId, gameData: entry.value })
        }`,
      );
      return entry.value;
    }
  }

  /**
   * Increments one user's active-public-user connection count and refreshes TTL.
   */
  public async incrementActivePublicUserConnection(
    userId: string,
    playerSnapshot: PlayerSnapshot<T>,
  ): Promise<void> {
    this.log(
      "INFO",
      `incrementActivePublicUserConnection request=${
        serializeLogValue({ userId, playerSnapshot })
      }`,
    );
    const activePublicUserKey = getActivePublicUserKey(userId);
    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const entry = await this.kv.get<ActiveUserStorageData<T>>(
        activePublicUserKey,
      );
      const nextActiveUser: ActiveUserStorageData<T> = {
        playerSnapshot,
        connectionCount: (entry.value?.connectionCount ?? 0) + 1,
      };

      transaction
        .check(entry)
        .set(activePublicUserKey, nextActiveUser, {
          expireIn: ACTIVE_PUBLIC_USER_TTL_MS,
        });
      this.mutateActivePublicUsersRootCountOnOperation(transaction, 1);
    });
    this.log(
      "INFO",
      `incrementActivePublicUserConnection completed=${
        serializeLogValue({ userId })
      }`,
    );
  }

  /**
   * Refreshes one active-public-user entry's TTL without changing its value.
   */
  public async touchActivePublicUser(userId: string): Promise<void> {
    this.log(
      "INFO",
      `touchActivePublicUser request=${serializeLogValue({ userId })}`,
    );
    const activePublicUserKey = getActivePublicUserKey(userId);
    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const entry = await this.kv.get<ActiveUserStorageData<T>>(
        activePublicUserKey,
      );
      if (entry.value == null) {
        return;
      }

      transaction
        .check(entry)
        .set(activePublicUserKey, entry.value, {
          expireIn: ACTIVE_PUBLIC_USER_TTL_MS,
        });
      this.mutateActivePublicUsersRootCountOnOperation(transaction, 1);
    });
    this.log(
      "INFO",
      `touchActivePublicUser completed=${serializeLogValue({ userId })}`,
    );
  }

  /**
   * Decrements one user's active-public-user connection count.
   * Deletes the entry once the count reaches zero.
   */
  public async decrementActivePublicUserConnection(userId: string): Promise<
    void
  > {
    this.log(
      "INFO",
      `decrementActivePublicUserConnection request=${
        serializeLogValue({ userId })
      }`,
    );
    const activePublicUserKey = getActivePublicUserKey(userId);
    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const entry = await this.kv.get<ActiveUserStorageData<T>>(
        activePublicUserKey,
      );
      if (entry.value == null) {
        return;
      }

      const nextConnectionCount = entry.value.connectionCount - 1;
      transaction.check(entry);
      if (nextConnectionCount <= 0) {
        transaction.delete(activePublicUserKey);
      } else {
        transaction.set(activePublicUserKey, {
          playerSnapshot: entry.value.playerSnapshot,
          connectionCount: nextConnectionCount,
        }, {
          expireIn: ACTIVE_PUBLIC_USER_TTL_MS,
        });
      }
      this.mutateActivePublicUsersRootCountOnOperation(transaction, 1);
    });
    this.log(
      "INFO",
      `decrementActivePublicUserConnection completed=${
        serializeLogValue({ userId })
      }`,
    );
  }

  /**
   * Returns all currently active public users as player snapshots.
   */
  public async getAllActivePublicUsers(): Promise<
    PlayerSnapshot<T>[]
  > {
    this.log(
      "INFO",
      "getAllActivePublicUsers request={}",
    );
    const activePublicUserEntries = await this.listSingleBatch<
      ActiveUserStorageData<T>
    >(
      getActivePublicUsersKey(),
    );
    const allActiveUsers = activePublicUserEntries.map((entry) =>
      entry.value.playerSnapshot
    );
    this.log(
      "INFO",
      `getAllActivePublicUsers response=${
        serializeLogValue({ count: allActiveUsers.length, allActiveUsers })
      }`,
    );
    return allActiveUsers;
  }

  /**
   * Watches the active public users root key and emits full indexed snapshots.
   */
  public watchForActivePublicUsersListChanges(): ReadableStream<
    PlayerSnapshot<T>[]
  > {
    this.log(
      "INFO",
      "watchForActivePublicUsersListChanges request={}",
    );
    const activePublicUsersKey = getActivePublicUsersKey();
    const stream = this.kv.watch<[Deno.KvU64]>([activePublicUsersKey]);
    return stream.pipeThrough(
      new TransformStream({
        transform: async (_events, controller) => {
          const data = await this.getAllActivePublicUsers();
          controller.enqueue(data);
        },
      }),
    );
  }

  // Returns all currently active public matches.
  public async getAllActivePublicMatches(): Promise<
    ActiveMatch<T>[]
  > {
    this.log(
      "INFO",
      "getAllActivePublicMatches request={}",
    );
    const activePublicMatchEntries = await this.listSingleBatch<
      ActiveMatch<T>
    >(
      getActivePublicMatchesKey(),
    );
    const allActiveMatches = activePublicMatchEntries.map((entry) =>
      entry.value
    );
    this.log(
      "INFO",
      `getAllActivePublicMatches response=${
        serializeLogValue({ count: allActiveMatches.length, allActiveMatches })
      }`,
    );
    return allActiveMatches;
  }

  public watchForMatchChanges(
    matchId: string,
  ): ReadableStream<MatchStorageData<T>> {
    this.log(
      "INFO",
      `watchForMatchChanges request=${serializeLogValue({ matchId })}`,
    );
    const gameKey = getMatchKey(matchId);
    const stream = this.kv.watch<
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

  // Watches the active public matches root key and emits full indexed snapshots.
  public watchForActivePublicMatchesListChanges(): ReadableStream<
    ActiveMatch<T>[]
  > {
    this.log(
      "INFO",
      "watchForActivePublicMatchesListChanges request={}",
    );
    const activePublicMatchesKey = getActivePublicMatchesKey();
    const stream = this.kv.watch<[Deno.KvU64]>([activePublicMatchesKey]);
    return stream.pipeThrough(
      new TransformStream({
        transform: async (_events, controller) => {
          const data = await this.getAllActivePublicMatches();
          controller.enqueue(data);
        },
      }),
    );
  }

  // Returns all currently available public rooms.
  public async getAllAvailablePublicRooms(): Promise<
    AvailableRoom<T>[]
  > {
    this.log(
      "INFO",
      "getAllAvailablePublicRooms request={}",
    );
    const availablePublicRoomEntries = await this.listSingleBatch<
      AvailableRoom<T>
    >(
      getAvailablePublicRoomsKey(),
    );
    const allAvailableRooms = availablePublicRoomEntries.map((entry) =>
      entry.value
    );
    this.log(
      "INFO",
      `getAllAvailablePublicRooms response=${
        serializeLogValue({
          count: allAvailableRooms.length,
          allAvailableRooms,
        })
      }`,
    );
    return allAvailableRooms;
  }

  // Watches the available public rooms root key and emits full indexed snapshots.
  public watchForAvailablePublicRoomListChanges(): ReadableStream<
    AvailableRoom<T>[]
  > {
    this.log(
      "INFO",
      "watchForAvailablePublicRoomListChanges request={}",
    );
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
    data: UserStorageData<T>,
  ): Promise<void> {
    this.log(
      "INFO",
      `createNewUserStorageData request=${serializeLogValue({ userId, data })}`,
    );
    const userKey = getUserKey(userId);
    const usernameKey = getUserByUsernameKey(data.username);
    const transaction = this.kv.atomic()
      .check({ key: userKey, versionstamp: null })
      .check({ key: usernameKey, versionstamp: null })
      .set(userKey, data)
      .set(usernameKey, userId);
    this.setAuditLogEntryOnOperation(transaction, {
      type: "CreateNewUserStorageData",
      userId,
      username: data.username,
      isGuest: data.isGuest,
    });
    const res = await transaction.commit();
    if (!res.ok) {
      throw new Error(
        `User ${userId} or username ${data.username} already exists`,
      );
    }
    this.log(
      "INFO",
      `createNewUserStorageData completed=${
        serializeLogValue({ userId, username: data.username })
      }`,
    );
  }

  /**
   * Upserts user storage data and keeps the username index in sync.
   */
  public async updateUserStorageData(
    userId: string,
    data: Partial<UserStorageData<T>>,
    options?: { actorUserId?: string },
  ): Promise<void> {
    this.log(
      "INFO",
      `updateUserStorageData request=${
        serializeLogValue({ userId, data, options })
      }`,
    );
    const actorUserId = options?.actorUserId ?? userId;
    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const entry = await this.kv.get<UserStorageData<T>>(
        getUserKey(userId),
      );
      if (entry.value == null) {
        throw new Error(`Updating unstored user ${userId}`);
      }
      const existingData = entry.value;

      const updatedData: UserStorageData<T> = {
        ...existingData,
        ...data,
      };

      const previousUsername = existingData.username;
      const updatedUsername = updatedData.username;
      const previousUsernameEntry = await this.kv.get<string>(
        getUserByUsernameKey(previousUsername),
      );
      if (previousUsernameEntry.value !== userId) {
        throw new Error(
          `Username index for ${previousUsername} is not owned by ${userId}`,
        );
      }

      transaction
        .check(entry)
        .set(getUserKey(userId), updatedData);

      if (previousUsername !== updatedUsername) {
        const updatedUsernameEntry = await this.kv.get<string>(
          getUserByUsernameKey(updatedUsername),
        );
        if (
          updatedUsernameEntry.value != null &&
          updatedUsernameEntry.value !== userId
        ) {
          throw new Error(`Username ${updatedUsername} already exists`);
        }

        transaction
          .check(previousUsernameEntry)
          .check(updatedUsernameEntry)
          .delete(getUserByUsernameKey(previousUsername))
          .set(getUserByUsernameKey(updatedUsername), userId);
      } else {
        transaction
          .check(previousUsernameEntry)
          .set(getUserByUsernameKey(previousUsername), userId);
      }
      this.setAuditLogEntryOnOperation(transaction, {
        type: "UpdateUserStorageData",
        userId: actorUserId,
      });
    });
    this.log(
      "INFO",
      `updateUserStorageData completed=${
        serializeLogValue({ userId, actorUserId })
      }`,
    );
  }

  /**
   * Updates canonical user profile fields that are user-editable at runtime.
   */
  public async updateUserProfile(
    userId: string,
    profile: { description?: string },
  ): Promise<void> {
    this.log(
      "INFO",
      `updateUserProfile request=${serializeLogValue({ userId, profile })}`,
    );
    const profileUpdate: Partial<UserStorageData<T>> = {};
    if (profile.description !== undefined) {
      profileUpdate.description = profile.description;
    }
    if (Object.keys(profileUpdate).length === 0) {
      this.log(
        "INFO",
        `updateUserProfile noop=${serializeLogValue({ userId })}`,
      );
      return;
    }

    await this.updateUserStorageData(userId, profileUpdate);
    this.log(
      "INFO",
      `updateUserProfile completed=${serializeLogValue({ userId })}`,
    );
  }

  // Fetches the stored user data for a userId, if present.
  public async getUserStorageData(
    userId: string,
  ): Promise<UserStorageData<T> | null> {
    this.log(
      "INFO",
      `getUserStorageData request=${serializeLogValue({ userId })}`,
    );
    const entry = await this.kv.get<UserStorageData<T>>(
      getUserKey(userId),
    );
    this.log(
      "INFO",
      `getUserStorageData response=${
        serializeLogValue({ userId, user: entry.value })
      }`,
    );
    return entry.value;
  }

  /**
   * Fetches one user's completed games in reverse chronological order.
   */
  private async getUserCompletedMatches(
    userId: string,
  ): Promise<CompletedMatchSnapshot<T>[]> {
    const completedMatchesKey = getUserCompletedMatchesKey(userId);
    const completedMatchEntries = await Array.fromAsync(
      this.kv.list<CompletedMatchSnapshot<T>>(
        { prefix: completedMatchesKey },
        {
          limit: USER_COMPLETED_MATCHES_READ_LIMIT,
          batchSize: USER_COMPLETED_MATCHES_BATCH_SIZE,
          reverse: true,
        },
      ),
    );

    return completedMatchEntries
      .filter((entry) => entry.key.length === completedMatchesKey.length + 1)
      .map((entry) => entry.value);
  }

  /**
   * Fetches the canonical user profile view data for a userId, if present.
   */
  public async getUserProfileViewData(
    userId: string,
  ): Promise<UserProfileViewData<T> | null> {
    this.log(
      "INFO",
      `getUserProfileViewData request=${serializeLogValue({ userId })}`,
    );
    const userStorageData = await this.getUserStorageData(userId);
    if (userStorageData == null) {
      this.log(
        "INFO",
        `getUserProfileViewData response=${
          serializeLogValue({ userId, userProfile: null })
        }`,
      );
      return null;
    }
    const completedMatches = await this.getUserCompletedMatches(userId);
    const userProfile = userStorageDataToUserProfileViewData(
      userId,
      userStorageData,
      completedMatches,
    );
    this.log(
      "INFO",
      `getUserProfileViewData response=${
        serializeLogValue({ userId, userProfile })
      }`,
    );
    return userProfile;
  }

  /**
   * Watches canonical user profile and completed-game history updates for one
   * user.
   */
  public watchForUserProfileChanges(
    userId: string,
  ): ReadableStream<UserProfileViewData<T>> {
    this.log(
      "INFO",
      `watchForUserProfileChanges request=${serializeLogValue({ userId })}`,
    );
    const userKey = getUserKey(userId);
    const completedMatchesKey = getUserCompletedMatchesKey(userId);
    const stream = this.kv.watch<[UserStorageData<T>, Deno.KvU64]>([
      userKey,
      completedMatchesKey,
    ]);
    return stream.pipeThrough(
      new TransformStream({
        transform: async (_events, controller) => {
          const userProfile = await this.getUserProfileViewData(userId);
          if (userProfile == null) {
            return;
          }
          controller.enqueue(userProfile);
        },
      }),
    );
  }

  /**
   * Creates a new user matchmaking record if one does not already exist.
   */
  public async createNewUserMatchmakingStorageData(
    userId: string,
    data: UserMatchmakingStorageData<T>,
    options?: { actorUserId?: string },
  ): Promise<void> {
    this.log(
      "INFO",
      `createNewUserMatchmakingStorageData request=${
        serializeLogValue({ userId, data, options })
      }`,
    );
    const actorUserId = options?.actorUserId ?? userId;
    const userMatchmakingKey = getUserMatchmakingKey(userId);
    const transaction = this.kv.atomic()
      .check({ key: userMatchmakingKey, versionstamp: null })
      .set(userMatchmakingKey, data);
    this.setAuditLogEntryOnOperation(transaction, {
      type: "UpdateUserMatchmakingStorageData",
      userId: actorUserId,
    });
    const res = await transaction.commit();
    if (!res.ok) {
      throw new Error(`User matchmaking ${userId} already exists`);
    }
    this.log(
      "INFO",
      `createNewUserMatchmakingStorageData completed=${
        serializeLogValue({ userId, actorUserId })
      }`,
    );
  }

  /**
   * Upserts user matchmaking storage data.
   */
  public async updateUserMatchmakingStorageData(
    userId: string,
    data: Partial<UserMatchmakingStorageData<T>>,
    options?: { actorUserId?: string },
  ): Promise<void> {
    this.log(
      "INFO",
      `updateUserMatchmakingStorageData request=${
        serializeLogValue({ userId, data, options })
      }`,
    );
    const actorUserId = options?.actorUserId ?? userId;
    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const entry = await this.kv.get<
        UserMatchmakingStorageData<T>
      >(
        getUserMatchmakingKey(userId),
      );
      if (entry.value == null) {
        throw new Error(`Updating unstored user matchmaking ${userId}`);
      }

      const updatedData: UserMatchmakingStorageData<T> = {
        ...entry.value,
        ...data,
      };

      transaction
        .check(entry)
        .set(getUserMatchmakingKey(userId), updatedData);
      this.setAuditLogEntryOnOperation(transaction, {
        type: "UpdateUserMatchmakingStorageData",
        userId: actorUserId,
      });
    });
    this.log(
      "INFO",
      `updateUserMatchmakingStorageData completed=${
        serializeLogValue({ userId, actorUserId })
      }`,
    );
  }

  /**
   * Fetches the stored user matchmaking data for a userId, if present.
   */
  public async getUserMatchmakingStorageData(
    userId: string,
  ): Promise<UserMatchmakingStorageData<T> | null> {
    this.log(
      "INFO",
      `getUserMatchmakingStorageData request=${serializeLogValue({ userId })}`,
    );
    const entry = await this.kv.get<
      UserMatchmakingStorageData<T>
    >(
      getUserMatchmakingKey(userId),
    );
    this.log(
      "INFO",
      `getUserMatchmakingStorageData response=${
        serializeLogValue({ userId, userMatchmaking: entry.value })
      }`,
    );
    return entry.value;
  }

  /**
   * Watches user matchmaking storage data updates for one user.
   */
  public watchForUserMatchmakingChanges(
    userId: string,
  ): ReadableStream<UserMatchmakingStorageData<T>> {
    this.log(
      "INFO",
      `watchForUserMatchmakingChanges request=${serializeLogValue({ userId })}`,
    );
    const userMatchmakingKey = getUserMatchmakingKey(userId);
    const stream = this.kv.watch<
      [UserMatchmakingStorageData<T>]
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

  public async usernameExists(username: string): Promise<boolean> {
    this.log(
      "INFO",
      `usernameExists request=${serializeLogValue({ username })}`,
    );
    const entry = await this.kv.get<string>(getUserByUsernameKey(username));
    const exists = entry.value != null;
    this.log(
      "INFO",
      `usernameExists response=${serializeLogValue({ username, exists })}`,
    );
    return exists;
  }

  public async storeToken(token: string, tokenData: TokenData): Promise<void> {
    this.log(
      "INFO",
      `storeToken request=${serializeLogValue({ token, tokenData })}`,
    );
    const res = await this.kv.atomic()
      .set(getTokenKey(token), tokenData)
      .commit();
    if (!res.ok) {
      throw new Error(`Failed to store token`);
    }
    this.log(
      "INFO",
      `storeToken completed=${serializeLogValue({ token, tokenData })}`,
    );
  }

  public async getToken(token: string): Promise<TokenData | null> {
    this.log(
      "INFO",
      `getToken request=${serializeLogValue({ token })}`,
    );
    const entry = await this.kv.get<TokenData>(getTokenKey(token));
    const tokenData = entry.value ?? null;
    this.log(
      "INFO",
      `getToken response=${serializeLogValue({ token, tokenData })}`,
    );
    return tokenData;
  }
}
