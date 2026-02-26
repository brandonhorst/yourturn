import type {
  MatchStorageData,
  RoomWatchEvent,
  UserMatchmakingStorageData,
} from "../db/mod.ts";
import type { GameTypes, UserProfileViewData } from "@/types/mod.ts";

export type QueueSubscription = {
  queueId: string;
  entryId: string;
};

export type RoomConnectionState<T extends GameTypes> = {
  userId: string;
  roomId: string;
  subscriptionIds: Set<string>;
  entryId: string;
  loadout: T["Loadout"];
  roomChangesReader: ReadableStreamDefaultReader<
    RoomWatchEvent<T>
  >;
};

/**
 * UserMatchmaking-specific state tracked for one websocket.
 */
export type UserMatchmakingConnectionState<T extends GameTypes> = {
  userId: string;
  subscriptionIds: Set<string>;
  userChangesReader: ReadableStreamDefaultReader<
    UserMatchmakingStorageData<T>
  >;
  queueSubscriptions: Map<string, QueueSubscription>;
};

/**
 * AccountUserProfile-specific state tracked for one websocket and user ID.
 */
export type AccountUserProfileConnectionState<T extends GameTypes> = {
  userId: string;
  subscriptionIds: Set<string>;
  userChangesReader: ReadableStreamDefaultReader<
    UserProfileViewData<T>
  >;
};

/**
 * One websocket subscriber within a match channel.
 */
export type MatchSocketSubscription = {
  subscriptionId: string;
  socket: WebSocket;
  playerId: number | undefined;
};

/**
 * Shared stream and subscriber state for a single game.
 */
export type MatchConnection<T extends GameTypes> = {
  matchSubscriptions: Map<string, MatchSocketSubscription>;
  changesReader: ReadableStreamDefaultReader<
    MatchStorageData<T>
  >;
};

/**
 * One websocket subscriber state for a chat thread channel.
 */
export type ChatThreadSubscriptionState = {
  chatThreadId: string;
  lastMessageId: string | undefined;
  messageChangesReader: ReadableStreamDefaultReader<void>;
};

export type SocketSubscription =
  | { type: "AccountUserProfile"; userId: string }
  | { type: "UserMatchmaking" }
  | { type: "Room"; roomId: string }
  | { type: "ActivePublicMatches" }
  | { type: "ActivePublicUsers" }
  | { type: "AvailablePublicRooms" }
  | { type: "ChatThread"; chatThreadId: string }
  | { type: "Match"; matchId: string };

/**
 * Combined state for a websocket across account profile, UserMatchmaking,
 * room, chat thread, and match subscriptions.
 */
export type SocketConnectionState<T extends GameTypes> = {
  subscriptions: Map<string, SocketSubscription>;
  roomConnections: Map<string, RoomConnectionState<T>>;
  chatThreadSubscriptions: Map<string, ChatThreadSubscriptionState>;
  accountUserProfileConnections: Map<
    string,
    AccountUserProfileConnectionState<T>
  >;
  userMatchmaking?: UserMatchmakingConnectionState<T>;
};
