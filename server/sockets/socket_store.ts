import { logServer } from "@/server/logging.ts";
import type { GameStateService } from "@/server/services/game_state_service.ts";
import type {
  ActiveMatch,
  AvailableRoom,
  GameTypes,
  PlayerSnapshot,
  UserProfileViewData,
} from "@/types/mod.ts";
import type { DB, UserMatchmakingStorageData } from "@/server/db/mod.ts";
import type {
  ChatSocketOps,
  LifecycleSocketOps,
  MatchSocketOps,
  PresenceSocketOps,
  QueueSocketOps,
  RoomSocketOps,
  SocketOperationOverrides,
  UserMatchmakingSocketOps,
  UserSocketOps,
} from "./contracts.ts";
import { SocketStoreContext } from "./context.ts";
import { SocketChatOps } from "./ops/chat_ops.ts";
import { SocketLifecycleOps } from "./ops/lifecycle_ops.ts";
import { SocketMatchOps } from "./ops/match_ops.ts";
import { SocketPresenceOps } from "./ops/presence_ops.ts";
import { SocketQueueOps } from "./ops/queue_ops.ts";
import { SocketRoomOps } from "./ops/room_ops.ts";
import { SocketUserMatchmakingOps } from "./ops/user_matchmaking_ops.ts";
import { SocketUserOps } from "./ops/user_ops.ts";

const SOCKET_STORE_FACADE_LOG_MODULE = "server.sockets.store";

/**
 * Facade over domain-specific socket operation objects.
 */
export class SocketStore<T extends GameTypes> {
  private readonly context: SocketStoreContext<T>;
  private readonly presenceOps: PresenceSocketOps<T>;
  private readonly userOps: UserSocketOps<T>;
  private readonly queueOps: QueueSocketOps<T>;
  private readonly userMatchmakingOps: UserMatchmakingSocketOps<T>;
  private readonly roomOps: RoomSocketOps<T>;
  private readonly chatOps: ChatSocketOps<T>;
  private readonly matchOps: MatchSocketOps<T>;
  private readonly lifecycleOps: LifecycleSocketOps<T>;

  constructor(
    db: DB<T>,
    activeMatchesStream: ReadableStream<ActiveMatch<T>[]>,
    activeUsersStream: ReadableStream<PlayerSnapshot<T>[]>,
    availableRoomsStream: ReadableStream<AvailableRoom<T>[]>,
    overrides: SocketOperationOverrides<T> = {},
  ) {
    this.context = new SocketStoreContext<T>(db);

    this.presenceOps = overrides.presenceOps ??
      new SocketPresenceOps<T>(this.context);
    this.userOps = overrides.userOps ?? new SocketUserOps<T>(this.context);
    this.queueOps = overrides.queueOps ?? new SocketQueueOps<T>(this.context);
    this.userMatchmakingOps = overrides.userMatchmakingOps ??
      new SocketUserMatchmakingOps<T>(
        this.context,
        this.queueOps,
        this.presenceOps,
      );
    this.roomOps = overrides.roomOps ?? new SocketRoomOps<T>(this.context);
    this.chatOps = overrides.chatOps ?? new SocketChatOps<T>(this.context);
    this.matchOps = overrides.matchOps ?? new SocketMatchOps<T>(this.context);
    this.lifecycleOps = overrides.lifecycleOps ??
      new SocketLifecycleOps<T>(this.context, {
        userOps: this.userOps,
        userMatchmakingOps: this.userMatchmakingOps,
        roomOps: this.roomOps,
        chatOps: this.chatOps,
        matchOps: this.matchOps,
      });

    logServer(
      SOCKET_STORE_FACADE_LOG_MODULE,
      "INFO",
      "SocketStore initialized",
    );

    this.presenceOps.streamActivePublicMatchesToSockets(activeMatchesStream);
    this.presenceOps.streamActivePublicUsersToSockets(activeUsersStream);
    this.presenceOps.streamAvailablePublicRoomsToSockets(availableRoomsStream);
  }

  /**
   * Registers game-derived state helpers shared by match subscriptions.
   */
  setGameStateService(
    gameStateService: GameStateService<T>,
  ): void {
    this.context.setGameStateService(gameStateService);
  }

  /**
   * Subscribes one logical AccountUserProfile channel instance on a websocket.
   */
  subscribeAccountUserProfile(
    socket: WebSocket,
    subscriptionId: string,
    userId: string,
    userProfile: UserProfileViewData<T>,
  ): Promise<void> {
    return this.userOps.subscribeAccountUserProfile(
      socket,
      subscriptionId,
      userId,
      userProfile,
      () => this.lifecycleOps.unsubscribe(socket, subscriptionId),
    );
  }

  /**
   * Subscribes one logical UserMatchmaking channel instance on a websocket.
   */
  subscribeUserMatchmaking(
    socket: WebSocket,
    subscriptionId: string,
    userId: string,
    userData: UserMatchmakingStorageData<T>,
  ): Promise<void> {
    return this.userMatchmakingOps.subscribeUserMatchmaking(
      socket,
      subscriptionId,
      userId,
      userData,
      () => this.lifecycleOps.unsubscribe(socket, subscriptionId),
    );
  }

  /**
   * Subscribes one logical active public matches channel instance.
   */
  subscribeActivePublicMatches(
    socket: WebSocket,
    subscriptionId: string,
  ): Promise<void> {
    return this.presenceOps.subscribeActivePublicMatches(
      socket,
      subscriptionId,
      () => this.lifecycleOps.unsubscribe(socket, subscriptionId),
    );
  }

  /**
   * Subscribes one logical active public users channel instance.
   */
  subscribeActivePublicUsers(
    socket: WebSocket,
    subscriptionId: string,
  ): Promise<void> {
    return this.presenceOps.subscribeActivePublicUsers(
      socket,
      subscriptionId,
      () => this.lifecycleOps.unsubscribe(socket, subscriptionId),
    );
  }

  /**
   * Subscribes one logical available public rooms channel instance.
   */
  subscribeAvailablePublicRooms(
    socket: WebSocket,
    subscriptionId: string,
  ): Promise<void> {
    return this.presenceOps.subscribeAvailablePublicRooms(
      socket,
      subscriptionId,
      () => this.lifecycleOps.unsubscribe(socket, subscriptionId),
    );
  }

  /**
   * Subscribes one logical room channel instance on a websocket.
   */
  subscribeRoom(
    socket: WebSocket,
    subscriptionId: string,
    roomId: string,
    userId: string,
  ): Promise<void> {
    return this.roomOps.subscribeRoom(
      socket,
      subscriptionId,
      roomId,
      userId,
      () => this.lifecycleOps.unsubscribe(socket, subscriptionId),
    );
  }

  /**
   * Subscribes one logical chat thread channel instance on a websocket.
   */
  subscribeChatThread(
    socket: WebSocket,
    subscriptionId: string,
    chatThreadId: string,
    lastMessageId?: string,
  ): Promise<void> {
    return this.chatOps.subscribeChatThread(
      socket,
      subscriptionId,
      chatThreadId,
      () => this.lifecycleOps.unsubscribe(socket, subscriptionId),
      lastMessageId,
    );
  }

  /**
   * Creates and stores one chat message in a chat thread.
   */
  sendChatMessage(
    chatThreadId: string,
    playerSnapshot: PlayerSnapshot<T>,
    message: string,
  ): Promise<void> {
    return this.chatOps.sendChatMessage(chatThreadId, playerSnapshot, message);
  }

  /**
   * Unsubscribes one logical channel instance identified by subscription ID.
   */
  unsubscribe(
    socket: WebSocket,
    subscriptionId: string,
  ): Promise<void> {
    return this.lifecycleOps.unsubscribe(socket, subscriptionId);
  }

  /**
   * Unsubscribes a websocket from all channel subscriptions.
   */
  unsubscribeSocket(socket: WebSocket): Promise<void> {
    return this.lifecycleOps.unsubscribeSocket(socket);
  }

  /**
   * Adds a user to a queue and dispatches any immediate match assignments.
   */
  joinQueue(
    socket: WebSocket,
    queueId: string,
    userId: string,
    playerSnapshot: PlayerSnapshot<T>,
    loadout: T["Loadout"],
    assignmentSubscriptionId?: string,
  ): Promise<void> {
    return this.queueOps.joinQueue(
      socket,
      queueId,
      userId,
      playerSnapshot,
      loadout,
      assignmentSubscriptionId,
    );
  }

  /**
   * Creates a room and immediately joins it for the requesting user.
   */
  createAndJoinRoom(
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
    return this.roomOps.createAndJoinRoom(
      socket,
      roomConfig,
      userId,
      playerSnapshot,
      loadout,
      assignmentSubscriptionId,
    );
  }

  /**
   * Adds a user to a room.
   */
  joinRoom(
    socket: WebSocket,
    roomId: string,
    userId: string,
    playerSnapshot: PlayerSnapshot<T>,
    loadout: T["Loadout"],
    assignmentSubscriptionId?: string,
  ): Promise<boolean> {
    return this.roomOps.joinRoom(
      socket,
      roomId,
      userId,
      playerSnapshot,
      loadout,
      assignmentSubscriptionId,
    );
  }

  /**
   * Leaves one queue and removes its stored queue entry state.
   */
  leaveQueue(socket: WebSocket, queueId: string): Promise<void> {
    return this.queueOps.leaveQueue(socket, queueId);
  }

  /**
   * Commits one room to a match when the user is an active member.
   */
  commitRoom(roomId: string, userId: string): Promise<void> {
    return this.roomOps.commitRoom(roomId, userId);
  }

  /**
   * Leaves one room regardless of whether this socket is subscribed to it.
   */
  leaveRoom(
    socket: WebSocket,
    roomId: string,
    userId: string,
  ): Promise<void> {
    return this.roomOps.leaveRoom(socket, roomId, userId);
  }

  /**
   * Subscribes one logical match channel instance on a websocket.
   */
  subscribeMatch(
    socket: WebSocket,
    subscriptionId: string,
    matchId: string,
    playerId?: number,
  ): Promise<void> {
    return this.matchOps.subscribeMatch(
      socket,
      subscriptionId,
      matchId,
      () => this.lifecycleOps.unsubscribe(socket, subscriptionId),
      playerId,
    );
  }
}
