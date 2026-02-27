import type { UserMatchmakingStorageData } from "@/server/db/mod.ts";
import type {
  ActivePublicMatch,
  AvailableRoom,
  GameTypes,
  PlayerSnapshot,
  UserProfileViewData,
} from "@/types/mod.ts";

/**
 * Callback used to clear one existing subscription ID before replacing it.
 */
export type UnsubscribeSubscription = () => Promise<void>;

/**
 * Presence/public-list socket operations.
 */
export interface PresenceSocketOps<T extends GameTypes> {
  subscribeActivePublicMatches(
    socket: WebSocket,
    subscriptionId: string,
    unsubscribeSubscription: UnsubscribeSubscription,
  ): Promise<void>;

  subscribeActivePublicUsers(
    socket: WebSocket,
    subscriptionId: string,
    unsubscribeSubscription: UnsubscribeSubscription,
  ): Promise<void>;

  subscribeAvailablePublicRooms(
    socket: WebSocket,
    subscriptionId: string,
    unsubscribeSubscription: UnsubscribeSubscription,
  ): Promise<void>;

  streamActivePublicMatchesToSockets(
    activeMatchesStream: ReadableStream<ActivePublicMatch<T>[]>,
  ): void;

  streamActivePublicUsersToSockets(
    activeUsersStream: ReadableStream<PlayerSnapshot<T>[]>,
  ): void;

  streamAvailablePublicRoomsToSockets(
    availableRoomsStream: ReadableStream<AvailableRoom<T>[]>,
  ): void;
}

/**
 * Account user profile socket operations.
 */
export interface UserSocketOps<T extends GameTypes> {
  subscribeAccountUserProfile(
    socket: WebSocket,
    subscriptionId: string,
    userId: string,
    userProfile: UserProfileViewData<T>,
    unsubscribeSubscription: UnsubscribeSubscription,
  ): Promise<void>;

  unsubscribeAccountUserProfileSubscription(
    socket: WebSocket,
    subscriptionId: string,
    userId: string,
  ): void;
}

/**
 * Queue socket operations.
 */
export interface QueueSocketOps<T extends GameTypes> {
  joinQueue(
    socket: WebSocket,
    queueId: string,
    userId: string,
    playerSnapshot: PlayerSnapshot<T>,
    loadout: T["Loadout"],
    assignmentSubscriptionId?: string,
  ): Promise<void>;

  leaveQueue(socket: WebSocket, queueId: string): Promise<void>;

  cleanupQueueSubscription(
    socket: WebSocket,
    queueId: string,
    options: { removeFromDb: boolean },
  ): Promise<void>;
}

/**
 * UserMatchmaking socket operations.
 */
export interface UserMatchmakingSocketOps<T extends GameTypes> {
  subscribeUserMatchmaking(
    socket: WebSocket,
    subscriptionId: string,
    userId: string,
    userData: UserMatchmakingStorageData<T>,
    unsubscribeSubscription: UnsubscribeSubscription,
  ): Promise<void>;

  unsubscribeUserMatchmakingSubscription(
    socket: WebSocket,
    subscriptionId: string,
  ): Promise<void>;
}

/**
 * Room socket operations.
 */
export interface RoomSocketOps<T extends GameTypes> {
  subscribeRoom(
    socket: WebSocket,
    subscriptionId: string,
    roomId: string,
    userId: string,
    unsubscribeSubscription: UnsubscribeSubscription,
  ): Promise<void>;

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
  ): Promise<void>;

  joinRoom(
    socket: WebSocket,
    roomId: string,
    userId: string,
    playerSnapshot: PlayerSnapshot<T>,
    loadout: T["Loadout"],
    assignmentSubscriptionId?: string,
  ): Promise<boolean>;

  commitRoom(roomId: string, userId: string): Promise<void>;

  leaveRoom(
    socket: WebSocket,
    roomId: string,
    userId: string,
  ): Promise<void>;

  unsubscribeRoomSubscription(
    socket: WebSocket,
    subscriptionId: string,
    roomId: string,
  ): void;
}

/**
 * Chat socket operations.
 */
export interface ChatSocketOps<T extends GameTypes> {
  subscribeChatThread(
    socket: WebSocket,
    subscriptionId: string,
    chatThreadId: string,
    unsubscribeSubscription: UnsubscribeSubscription,
    lastMessageId?: string,
  ): Promise<void>;

  sendChatMessage(
    chatThreadId: string,
    playerSnapshot: PlayerSnapshot<T>,
    message: string,
  ): Promise<void>;

  unsubscribeChatThreadSubscription(
    socket: WebSocket,
    subscriptionId: string,
  ): void;
}

/**
 * Match socket operations.
 */
export interface MatchSocketOps<T extends GameTypes> {
  subscribeMatch(
    socket: WebSocket,
    subscriptionId: string,
    matchId: string,
    unsubscribeSubscription: UnsubscribeSubscription,
    playerId?: number,
  ): Promise<void>;

  unsubscribeMatchSubscription(
    subscriptionId: string,
    matchId: string,
  ): void;
}

/**
 * Lifecycle and unsubscribe dispatch socket operations.
 */
export interface LifecycleSocketOps<T extends GameTypes> {
  unsubscribe(
    socket: WebSocket,
    subscriptionId: string,
  ): Promise<void>;

  unsubscribeSocket(socket: WebSocket): Promise<void>;
}

/**
 * Grouped socket operation object dependencies.
 */
export type SocketOperationDependencies<T extends GameTypes> = {
  userOps: UserSocketOps<T>;
  userMatchmakingOps: UserMatchmakingSocketOps<T>;
  roomOps: RoomSocketOps<T>;
  chatOps: ChatSocketOps<T>;
  matchOps: MatchSocketOps<T>;
};

/**
 * Optional operation overrides used to customize SocketStore behavior.
 */
export type SocketOperationOverrides<T extends GameTypes> = {
  presenceOps?: PresenceSocketOps<T>;
  userOps?: UserSocketOps<T>;
  queueOps?: QueueSocketOps<T>;
  userMatchmakingOps?: UserMatchmakingSocketOps<T>;
  roomOps?: RoomSocketOps<T>;
  chatOps?: ChatSocketOps<T>;
  matchOps?: MatchSocketOps<T>;
  lifecycleOps?: LifecycleSocketOps<T>;
};
