import { ulid } from "@std/ulid";
import {
  logServer,
  serializeLogValue,
  type ServerLogLevel,
} from "@/server/logging.ts";
import type { AvailableRoom, GameTypes, PlayerSnapshot } from "@/types/mod.ts";
import type { DbContext } from "../context.ts";
import type { MatchOps, RoomOps } from "../contracts.ts";
import {
  getAvailablePublicRoomKey,
  getAvailablePublicRoomsKey,
  getRoomKey,
  getUserMatchmakingKey,
} from "../keys.ts";
import type {
  MatchAssignmentNotification,
  RoomStorageData,
  RoomWatchEvent,
  UserMatchmakingStorageData,
} from "../models.ts";

const ROOM_OPS_LOG_MODULE = "server.db.room";

/**
 * Deno KV implementation of room and room-to-match operations.
 */
export class KvRoomOps<T extends GameTypes> implements RoomOps<T> {
  constructor(
    private readonly context: DbContext<T>,
    private readonly matchOps: MatchOps<T>,
  ) {}

  /**
   * Emits one log entry for room DB operations.
   */
  private log(level: ServerLogLevel, message: string): void {
    logServer(ROOM_OPS_LOG_MODULE, level, message);
  }

  /**
   * Creates one room and updates the available-room index when public.
   */
  async createRoom(
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
    const chatThreadId = ulid();
    const roomKey = getRoomKey(roomId);
    const roomData: RoomStorageData<T> = {
      chatThreadId,
      numPlayers: roomConfig.numPlayers,
      config: roomConfig.config,
      private: roomConfig.private,
      members: [],
    };

    await this.context.repeatUntilTransactionSucceeds(async (transaction) => {
      transaction
        .check({ key: roomKey, versionstamp: null })
        .set(roomKey, roomData);
      await this.updateAvailablePublicRoomsOnOperation(
        transaction,
        { roomId, room: roomData },
      );
      this.context.setAuditLogEntryOnOperation(transaction, {
        type: "CreateRoom",
        userId,
        roomId,
        private: roomConfig.private,
      });
    });
    this.log(
      "INFO",
      `createRoom completed=${
        serializeLogValue({ roomId, userId, chatThreadId })
      }`,
    );
  }

  /**
   * Fetches one room record by id.
   */
  async getRoom(
    roomId: string,
  ): Promise<RoomStorageData<T> | null> {
    this.log(
      "INFO",
      `getRoom request=${serializeLogValue({ roomId })}`,
    );
    const entry = await this.context.kv.get<RoomStorageData<T>>(
      getRoomKey(roomId),
    );
    this.log(
      "INFO",
      `getRoom response=${serializeLogValue({ roomId, room: entry.value })}`,
    );
    return entry.value;
  }

  /**
   * Watches one room record and emits updates and deletion events.
   */
  watchForRoomChanges(
    roomId: string,
  ): ReadableStream<RoomWatchEvent<T>> {
    this.log(
      "INFO",
      `watchForRoomChanges request=${serializeLogValue({ roomId })}`,
    );
    const roomKey = getRoomKey(roomId);
    const stream = this.context.kv.watch<RoomStorageData<T>[]>(
      [roomKey],
    );
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
   * Adds one member to a room and updates that user's joined-room metadata.
   */
  async addToRoom(
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

    await this.context.repeatUntilTransactionSucceeds(async (transaction) => {
      const roomEntry = await this.context.kv.get<
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

      const userMatchmakingEntry = await this.context.kv.get<
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
      this.context.setAuditLogEntryOnOperation(transaction, {
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

  /**
   * Removes one room member and cleans up room and user metadata.
   */
  async removeFromRoom(
    roomId: string,
    entryId: string,
  ): Promise<void> {
    this.log(
      "INFO",
      `removeFromRoom request=${serializeLogValue({ roomId, entryId })}`,
    );
    const roomKey = getRoomKey(roomId);

    await this.context.repeatUntilTransactionSucceeds(async (transaction) => {
      const roomEntry = await this.context.kv.get<
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

      const removedUserId = members[memberIndex].userId;
      const userMatchmakingEntry = await this.context.kv.get<
        UserMatchmakingStorageData<T>
      >(
        getUserMatchmakingKey(removedUserId),
      );
      if (userMatchmakingEntry.value == null) {
        throw new Error(`User ${removedUserId} not found`);
      }

      const nextMembers = members.toSpliced(memberIndex, 1);

      const updatedRooms = userMatchmakingEntry.value.joinedRooms.filter(
        (room) => room.roomId !== roomId,
      );
      const updatedUserMatchmaking: UserMatchmakingStorageData<T> = {
        ...userMatchmakingEntry.value,
        joinedRooms: updatedRooms,
      };

      transaction
        .check(roomEntry)
        .check(userMatchmakingEntry)
        .set(getUserMatchmakingKey(removedUserId), updatedUserMatchmaking);

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
      this.context.setAuditLogEntryOnOperation(transaction, {
        type: "RemoveFromRoom",
        userId: removedUserId,
        roomId,
        entryId,
      });
    });
    this.log(
      "INFO",
      `removeFromRoom completed=${serializeLogValue({ roomId, entryId })}`,
    );
  }

  /**
   * Commits a full room into a newly created match and returns assignments.
   */
  async commitRoom(
    roomId: string,
    userId: string,
  ): Promise<MatchAssignmentNotification[]> {
    this.log(
      "INFO",
      `commitRoom request=${serializeLogValue({ roomId, userId })}`,
    );
    const roomKey = getRoomKey(roomId);
    let matchAssignments: MatchAssignmentNotification[] = [];

    await this.context.repeatUntilTransactionSucceeds(async (transaction) => {
      const roomEntry = await this.context.kv.get<
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
      await this.matchOps.createNewMatchOnOperation(
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

      const userMatchmakingKeys = userIds.map((assignedUserId) =>
        getUserMatchmakingKey(assignedUserId)
      );
      const userMatchmakingEntries = await this.context.kv.getMany<
        UserMatchmakingStorageData<T>[]
      >(userMatchmakingKeys);

      for (let i = 0; i < assignedMembers.length; i++) {
        const userMatchmakingEntry = userMatchmakingEntries[i];
        if (userMatchmakingEntry.value == null) {
          throw new Error(`User ${userIds[i]} not found`);
        }

        const updatedRooms = userMatchmakingEntry.value.joinedRooms.filter(
          (room) => room.roomId !== roomId,
        );
        const updatedUserMatchmaking: UserMatchmakingStorageData<T> = {
          ...userMatchmakingEntry.value,
          joinedRooms: updatedRooms,
        };

        transaction
          .check(userMatchmakingEntry)
          .set(userMatchmakingKeys[i], updatedUserMatchmaking);
      }
      this.context.setAuditLogEntryOnOperation(transaction, {
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

  /**
   * Updates one available-public-room index entry inside an open transaction.
   */
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
    const availablePublicRoomEntry = await this.context.kv.get<
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
      this.context.mutateIndexedListRootCountOnOperation(
        transaction,
        getAvailablePublicRoomsKey(),
        -1,
      );
      return;
    }

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
      this.context.mutateIndexedListRootCountOnOperation(
        transaction,
        getAvailablePublicRoomsKey(),
        1,
      );
    } else {
      transaction
        .check(availablePublicRoomEntry)
        .set(availablePublicRoomKey, nextRoom);
      this.context.mutateIndexedListRootCountOnOperation(
        transaction,
        getAvailablePublicRoomsKey(),
        0,
      );
    }
  }
}
