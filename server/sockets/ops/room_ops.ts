import { ulid } from "@std/ulid";
import type { RoomWatchEvent } from "@/server/db/mod.ts";
import { logServer, serializeLogValue } from "@/server/logging.ts";
import type { GameTypes, PlayerSnapshot, RoomEntry } from "@/types/mod.ts";
import type { RoomSocketOps, UnsubscribeSubscription } from "../contracts.ts";
import type { SocketStoreContext } from "../context.ts";
import { closeReader, sendServerMessage } from "../wire.ts";

const SOCKET_ROOM_LOG_MODULE = "server.sockets.room";

/**
 * Room subscription and room action operations.
 */
export class SocketRoomOps<T extends GameTypes> implements RoomSocketOps<T> {
  constructor(
    private readonly context: SocketStoreContext<T>,
  ) {}

  /**
   * Subscribes one logical room channel instance on a websocket.
   */
  async subscribeRoom(
    socket: WebSocket,
    subscriptionId: string,
    roomId: string,
    userId: string,
    unsubscribeSubscription: UnsubscribeSubscription,
  ): Promise<void> {
    logServer(
      SOCKET_ROOM_LOG_MODULE,
      "INFO",
      `subscribeRoom request=${
        serializeLogValue({ subscriptionId, roomId, userId })
      }`,
    );
    await unsubscribeSubscription();

    const room = await this.context.db.getRoom(roomId);
    if (room == null) {
      throw new Error(`Room ${roomId} not found`);
    }

    const roomMember = room.members.find((member) => member.userId === userId);
    if (roomMember == null) {
      throw new Error(`User ${userId} is not in room ${roomId}`);
    }

    const connectionState = this.context.getOrCreateSocketConnection(socket);
    let roomConnection = connectionState.roomConnections.get(roomId);

    if (roomConnection == null) {
      const roomChangesReader = this.context.db.watchForRoomChanges(roomId)
        .getReader();

      roomConnection = {
        userId,
        roomId,
        subscriptionIds: new Set(),
        entryId: roomMember.entryId,
        loadout: roomMember.loadout,
        roomChangesReader,
      };
      connectionState.roomConnections.set(roomId, roomConnection);

      void this.streamRoomChangesToSocket(socket, roomId, roomChangesReader);
    } else {
      roomConnection.userId = userId;
      roomConnection.entryId = roomMember.entryId;
      roomConnection.loadout = roomMember.loadout;
    }

    roomConnection.subscriptionIds.add(subscriptionId);
    connectionState.subscriptions.set(subscriptionId, {
      type: "Room",
      roomId,
    });

    const roomEntry: RoomEntry<T> = {
      roomId,
      chatThreadId: room.chatThreadId,
      numPlayers: room.numPlayers,
      players: room.members.map((member) => member.playerSnapshot),
      config: room.config,
      loadout: roomMember.loadout,
    };
    this.sendRoomEntryUpdateToSubscription(
      socket,
      subscriptionId,
      roomEntry,
    );
  }

  /**
   * Creates a room and immediately joins it for the requesting user.
   */
  async createAndJoinRoom(
    socket: WebSocket,
    roomConfig: {
      numPlayers: number;
      config: T["Config"];
      private: boolean;
    },
    userId: string,
    playerSnapshot: PlayerSnapshot<T>,
    loadout: T["Loadout"],
    assignmentSubscriptionId?: string,
  ): Promise<void> {
    logServer(
      SOCKET_ROOM_LOG_MODULE,
      "INFO",
      `createAndJoinRoom request=${
        serializeLogValue({
          roomConfig,
          userId,
          playerSnapshot,
          loadout,
          assignmentSubscriptionId,
        })
      }`,
    );
    const roomId = ulid();
    await this.context.db.createRoom(roomId, userId, roomConfig);
    await this.joinRoom(
      socket,
      roomId,
      userId,
      playerSnapshot,
      loadout,
      assignmentSubscriptionId,
    );
    logServer(
      SOCKET_ROOM_LOG_MODULE,
      "INFO",
      `createAndJoinRoom created room=${serializeLogValue({ roomId, userId })}`,
    );
  }

  /**
   * Adds a user to a room.
   */
  async joinRoom(
    _socket: WebSocket,
    roomId: string,
    userId: string,
    playerSnapshot: PlayerSnapshot<T>,
    loadout: T["Loadout"],
    assignmentSubscriptionId?: string,
  ): Promise<boolean> {
    logServer(
      SOCKET_ROOM_LOG_MODULE,
      "INFO",
      `joinRoom request=${
        serializeLogValue({
          roomId,
          userId,
          playerSnapshot,
          loadout,
          assignmentSubscriptionId,
        })
      }`,
    );
    const entryId = ulid();

    try {
      await this.context.db.addToRoom(
        roomId,
        entryId,
        userId,
        playerSnapshot,
        loadout,
        assignmentSubscriptionId,
      );
    } catch (error) {
      logServer(
        SOCKET_ROOM_LOG_MODULE,
        "WARN",
        `joinRoom failed error=${
          serializeLogValue(error instanceof Error ? error : String(error))
        }`,
      );
      return false;
    }

    logServer(
      SOCKET_ROOM_LOG_MODULE,
      "INFO",
      `joinRoom succeeded=${serializeLogValue({ roomId, userId, entryId })}`,
    );
    return true;
  }

  /**
   * Commits one room to a match when the user is an active member.
   */
  async commitRoom(roomId: string, userId: string): Promise<void> {
    logServer(
      SOCKET_ROOM_LOG_MODULE,
      "INFO",
      `commitRoom request=${serializeLogValue({ roomId, userId })}`,
    );
    const room = await this.context.db.getRoom(roomId);
    if (room == null) {
      throw new Error(`Room ${roomId} not found`);
    }

    const member = room.members.find((roomMember) =>
      roomMember.userId === userId
    );
    if (member == null) {
      throw new Error(`User ${userId} is not in room ${roomId}`);
    }

    const matchAssignments = await this.context.db.commitRoom(roomId, userId);
    this.context.sendMatchAssignmentsToStoredSubscriptions(matchAssignments);
    logServer(
      SOCKET_ROOM_LOG_MODULE,
      "INFO",
      `commitRoom assignments=${
        serializeLogValue({ roomId, userId, matchAssignments })
      }`,
    );
  }

  /**
   * Leaves one room regardless of whether this socket is subscribed to it.
   */
  async leaveRoom(
    socket: WebSocket,
    roomId: string,
    userId: string,
  ): Promise<void> {
    logServer(
      SOCKET_ROOM_LOG_MODULE,
      "INFO",
      `leaveRoom request=${serializeLogValue({ roomId, userId })}`,
    );
    const room = await this.context.db.getRoom(roomId);
    if (room != null) {
      const member = room.members.find((roomMember) =>
        roomMember.userId === userId
      );
      if (member != null) {
        await this.context.db.removeFromRoom(roomId, member.entryId);
      }
    }

    this.cleanupRoomConnection(socket, roomId, {
      notifyClient: true,
      removeSubscriptionEntries: true,
    });
    logServer(
      SOCKET_ROOM_LOG_MODULE,
      "INFO",
      `leaveRoom completed=${serializeLogValue({ roomId, userId })}`,
    );
  }

  /**
   * Unsubscribes one room subscription and tears down room streams when last.
   */
  unsubscribeRoomSubscription(
    socket: WebSocket,
    subscriptionId: string,
    roomId: string,
  ): void {
    const roomConnection = this.context.getRoomConnection(socket, roomId);
    if (roomConnection == null) {
      return;
    }

    roomConnection.subscriptionIds.delete(subscriptionId);
    if (roomConnection.subscriptionIds.size > 0) {
      return;
    }

    this.cleanupRoomConnection(socket, roomId, {
      notifyClient: false,
      removeSubscriptionEntries: false,
    });
  }

  /**
   * Streams room updates for one room subscription.
   */
  private async streamRoomChangesToSocket(
    socket: WebSocket,
    roomId: string,
    roomChangesReader: ReadableStreamDefaultReader<
      RoomWatchEvent<T>
    >,
  ): Promise<void> {
    try {
      while (true) {
        const data = await roomChangesReader.read();
        if (data.done) {
          break;
        }

        if (data.value.type === "deleted") {
          this.sendRoomEntryRemovalToRoomSubscriptions(socket, roomId);
          this.cleanupRoomConnection(socket, roomId, {
            notifyClient: false,
            removeSubscriptionEntries: true,
          });
          break;
        }

        const roomConnection = this.context.getRoomConnection(socket, roomId);
        if (roomConnection == null) {
          break;
        }

        const roomMember = data.value.room.members.find((member) =>
          member.userId === roomConnection.userId
        );
        if (roomMember == null) {
          this.sendRoomEntryRemovalToRoomSubscriptions(socket, roomId);
          this.cleanupRoomConnection(socket, roomId, {
            notifyClient: false,
            removeSubscriptionEntries: true,
          });
          break;
        }

        roomConnection.entryId = roomMember.entryId;
        roomConnection.loadout = roomMember.loadout;

        const roomEntry: RoomEntry<T> = {
          roomId,
          chatThreadId: data.value.room.chatThreadId,
          numPlayers: data.value.room.numPlayers,
          players: data.value.room.members.map((member) =>
            member.playerSnapshot
          ),
          config: data.value.room.config,
          loadout: roomMember.loadout,
        };

        this.sendRoomEntryUpdateToRoomSubscriptions(socket, roomId, roomEntry);
      }
    } catch {
      // Reader cancellation is expected during unsubscribe.
    } finally {
      closeReader(roomChangesReader);
    }
  }

  /**
   * Sends one room entry update to one subscription ID.
   */
  private sendRoomEntryUpdateToSubscription(
    socket: WebSocket,
    subscriptionId: string,
    roomEntry: RoomEntry<T>,
  ): void {
    sendServerMessage<T>(socket, {
      type: "UpdateRoomEntry",
      subscriptionId,
      roomEntry,
    });
  }

  /**
   * Sends one room entry update to each active room subscription.
   */
  private sendRoomEntryUpdateToRoomSubscriptions(
    socket: WebSocket,
    roomId: string,
    roomEntry: RoomEntry<T>,
  ): void {
    for (const subscriptionId of this.getRoomSubscriptionIds(socket, roomId)) {
      this.sendRoomEntryUpdateToSubscription(socket, subscriptionId, roomEntry);
    }
  }

  /**
   * Sends one room entry removal to each active room subscription.
   */
  private sendRoomEntryRemovalToRoomSubscriptions(
    socket: WebSocket,
    roomId: string,
  ): void {
    for (const subscriptionId of this.getRoomSubscriptionIds(socket, roomId)) {
      sendServerMessage<T>(socket, {
        type: "RemoveRoomEntry",
        subscriptionId,
        roomId,
      });
    }
  }

  /**
   * Returns all active room subscription IDs for one socket and room.
   */
  private getRoomSubscriptionIds(
    socket: WebSocket,
    roomId: string,
  ): string[] {
    const roomConnection = this.context.getRoomConnection(socket, roomId);
    if (roomConnection == null) {
      return [];
    }

    return [...roomConnection.subscriptionIds];
  }

  /**
   * Cleans up one room connection and optionally removes channel subscriptions.
   */
  private cleanupRoomConnection(
    socket: WebSocket,
    roomId: string,
    options: { notifyClient: boolean; removeSubscriptionEntries: boolean },
  ): void {
    const connectionState = this.context.sockets.get(socket);
    if (connectionState == null) {
      return;
    }

    const roomConnection = connectionState.roomConnections.get(roomId);
    if (roomConnection == null) {
      return;
    }

    const roomSubscriptionIds = [...roomConnection.subscriptionIds];

    closeReader(roomConnection.roomChangesReader);

    connectionState.roomConnections.delete(roomId);

    if (options.removeSubscriptionEntries) {
      for (const subscriptionId of roomSubscriptionIds) {
        const subscription = connectionState.subscriptions.get(subscriptionId);
        if (subscription?.type === "Room" && subscription.roomId === roomId) {
          connectionState.subscriptions.delete(subscriptionId);
        }
      }
    }

    if (options.notifyClient) {
      for (const subscriptionId of roomSubscriptionIds) {
        sendServerMessage<T>(
          socket,
          {
            type: "RemoveRoomEntry",
            subscriptionId,
            roomId,
          },
        );
      }
    }

    this.context.pruneIdleSocket(socket);
  }
}
