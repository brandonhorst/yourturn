import type {
  ActivePublicMatch,
  AvailableRoom,
  ChatMessage,
  GameTypes,
  PlayerSnapshot,
  TokenData,
  UserProfileViewData,
} from "@/types/mod.ts";
import type {
  MatchAssignmentNotification,
  MatchStorageData,
  RoomStorageData,
  RoomWatchEvent,
  UserMatchmakingStorageData,
  UserStorageData,
} from "./models.ts";

/**
 * Parameters used when creating a new match record inside a transaction.
 */
export type CreateMatchOnOperationOptions<T extends GameTypes> = {
  config: T["Config"];
  matchId: string;
  loadouts: T["Loadout"][];
  playerSnapshots: PlayerSnapshot<T>[];
  queueId?: string;
  userIds: string[];
};

/**
 * Queue matchmaking database operations.
 */
export interface QueueOps<T extends GameTypes> {
  addToQueue(
    queueId: string,
    entryId: string,
    userId: string,
    playerSnapshot: PlayerSnapshot<T>,
    loadout: T["Loadout"],
    assignmentSubscriptionId?: string,
  ): Promise<MatchAssignmentNotification[]>;

  removeFromQueue(
    queueId: string,
    entryId: string,
  ): Promise<void>;
}

/**
 * Room lifecycle database operations.
 */
export interface RoomOps<T extends GameTypes> {
  createRoom(
    roomId: string,
    userId: string,
    roomConfig: {
      numPlayers: number;
      config: T["Config"];
      private: boolean;
    },
  ): Promise<void>;

  getRoom(roomId: string): Promise<RoomStorageData<T> | null>;

  watchForRoomChanges(roomId: string): ReadableStream<RoomWatchEvent<T>>;

  addToRoom(
    roomId: string,
    entryId: string,
    userId: string,
    playerSnapshot: PlayerSnapshot<T>,
    loadout: T["Loadout"],
    assignmentSubscriptionId?: string,
  ): Promise<void>;

  removeFromRoom(
    roomId: string,
    entryId: string,
  ): Promise<void>;

  commitRoom(
    roomId: string,
    userId: string,
  ): Promise<MatchAssignmentNotification[]>;
}

/**
 * Match storage and watch database operations.
 */
export interface MatchOps<T extends GameTypes> {
  createNewMatchOnOperation(
    transaction: Deno.AtomicOperation,
    options: CreateMatchOnOperationOptions<T>,
  ): Promise<void>;

  updateMatchStorageData(
    matchId: string,
    gameData: MatchStorageData<T>,
    userId: string,
  ): Promise<void>;

  getMatchStorageData(matchId: string): Promise<MatchStorageData<T>>;

  watchForMatchChanges(matchId: string): ReadableStream<MatchStorageData<T>>;
}

/**
 * Public list and active-user index operations.
 */
export interface PublicIndexOps<T extends GameTypes> {
  incrementActivePublicUserConnection(
    userId: string,
    playerSnapshot: PlayerSnapshot<T>,
  ): Promise<void>;

  touchActivePublicUser(userId: string): Promise<void>;

  decrementActivePublicUserConnection(userId: string): Promise<void>;

  getAllActivePublicUsers(): Promise<PlayerSnapshot<T>[]>;

  watchForActivePublicUsersListChanges(): ReadableStream<PlayerSnapshot<T>[]>;

  getAllActivePublicMatches(): Promise<ActivePublicMatch<T>[]>;

  watchForActivePublicMatchesListChanges(): ReadableStream<
    ActivePublicMatch<T>[]
  >;

  getAllAvailablePublicRooms(): Promise<AvailableRoom<T>[]>;

  watchForAvailablePublicRoomListChanges(): ReadableStream<AvailableRoom<T>[]>;
}

/**
 * Chat-thread database operations.
 */
export interface ChatOps<T extends GameTypes> {
  appendChatMessage(
    chatThreadId: string,
    chatMessage: ChatMessage<T>,
  ): Promise<void>;

  getMostRecentChatThreadMessages(
    chatThreadId: string,
    limit: number,
  ): Promise<ChatMessage<T>[]>;

  getChatThreadMessagesAfter(
    chatThreadId: string,
    lastMessageId?: string,
  ): Promise<ChatMessage<T>[]>;

  watchForChatThreadMessageChanges(chatThreadId: string): ReadableStream<void>;
}

/**
 * User profile and identity database operations.
 */
export interface UserOps<T extends GameTypes> {
  createNewUserStorageData(
    userId: string,
    data: UserStorageData<T>,
  ): Promise<void>;

  updateUserStorageData(
    userId: string,
    data: Partial<UserStorageData<T>>,
    options?: { actorUserId?: string },
  ): Promise<void>;

  updateUserProfile(
    userId: string,
    profile: {
      description?: string;
      starUserId?: string;
      unstarUserId?: string;
    },
  ): Promise<void>;

  getUserStorageData(userId: string): Promise<UserStorageData<T> | null>;

  getUserProfileViewData(
    userId: string,
  ): Promise<UserProfileViewData<T> | null>;

  watchForUserProfileChanges(
    userId: string,
  ): ReadableStream<UserProfileViewData<T>>;

  usernameExists(username: string): Promise<boolean>;
}

/**
 * Per-user matchmaking record database operations.
 */
export interface UserMatchmakingOps<T extends GameTypes> {
  createNewUserMatchmakingStorageData(
    userId: string,
    data: UserMatchmakingStorageData<T>,
    options?: { actorUserId?: string },
  ): Promise<void>;

  updateUserMatchmakingStorageData(
    userId: string,
    data: Partial<UserMatchmakingStorageData<T>>,
    options?: { actorUserId?: string },
  ): Promise<void>;

  getUserMatchmakingStorageData(
    userId: string,
  ): Promise<UserMatchmakingStorageData<T> | null>;

  watchForUserMatchmakingChanges(
    userId: string,
  ): ReadableStream<UserMatchmakingStorageData<T>>;
}

/**
 * Token storage database operations.
 */
export interface TokenOps {
  storeToken(token: string, tokenData: TokenData): Promise<void>;

  getToken(token: string): Promise<TokenData | null>;
}

/**
 * Optional operation overrides used to customize DB behavior.
 */
export type DbOperationOverrides<T extends GameTypes> = {
  queueOps?: QueueOps<T>;
  roomOps?: RoomOps<T>;
  matchOps?: MatchOps<T>;
  publicIndexOps?: PublicIndexOps<T>;
  chatOps?: ChatOps<T>;
  userOps?: UserOps<T>;
  userMatchmakingOps?: UserMatchmakingOps<T>;
  tokenOps?: TokenOps;
};
