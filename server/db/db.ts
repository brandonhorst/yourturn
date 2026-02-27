import type {
  ActivePublicMatch,
  AvailableRoom,
  ChatMessage,
  GameDefinition,
  GameTypes,
  PlayerSnapshot,
  TokenData,
  UserProfileViewData,
} from "@/types/mod.ts";
import { logServer } from "../logging.ts";
import { DbContext } from "./context.ts";
import type {
  ChatOps,
  DbOperationOverrides,
  MatchOps,
  PublicIndexOps,
  QueueOps,
  RoomOps,
  TokenOps,
  UserMatchmakingOps,
  UserOps,
} from "./contracts.ts";
import type {
  MatchAssignmentNotification,
  MatchStorageData,
  RoomStorageData,
  RoomWatchEvent,
  UserMatchmakingStorageData,
  UserStorageData,
} from "./models.ts";
import { KvChatOps } from "./ops/chat_ops.ts";
import { KvMatchOps } from "./ops/match_ops.ts";
import { KvPresenceOps } from "./ops/presence_ops.ts";
import { KvQueueOps } from "./ops/queue_ops.ts";
import { KvRoomOps } from "./ops/room_ops.ts";
import { KvTokenOps } from "./ops/token_ops.ts";
import { KvUserMatchmakingOps } from "./ops/user_matchmaking_ops.ts";
import { KvUserOps } from "./ops/user_ops.ts";

const DB_LOG_MODULE = "server.db";

/**
 * Facade over domain-specific DB operation objects.
 */
export class DB<T extends GameTypes> {
  private readonly queueOps: QueueOps<T>;
  private readonly roomOps: RoomOps<T>;
  private readonly matchOps: MatchOps<T>;
  private readonly publicIndexOps: PublicIndexOps<T>;
  private readonly chatOps: ChatOps<T>;
  private readonly userOps: UserOps<T>;
  private readonly userMatchmakingOps: UserMatchmakingOps<T>;
  private readonly tokenOps: TokenOps;

  constructor(
    kv: Deno.Kv,
    game: GameDefinition<T>,
    overrides: DbOperationOverrides<T> = {},
  ) {
    const context = new DbContext<T>(kv, game);

    const matchOps = overrides.matchOps ?? new KvMatchOps<T>(context);

    this.matchOps = matchOps;
    this.queueOps = overrides.queueOps ?? new KvQueueOps<T>(context, matchOps);
    this.roomOps = overrides.roomOps ?? new KvRoomOps<T>(context, matchOps);
    this.publicIndexOps = overrides.publicIndexOps ??
      new KvPresenceOps<T>(context);
    this.chatOps = overrides.chatOps ?? new KvChatOps<T>(context);
    this.userOps = overrides.userOps ?? new KvUserOps<T>(context);
    this.userMatchmakingOps = overrides.userMatchmakingOps ??
      new KvUserMatchmakingOps<T>(context);
    this.tokenOps = overrides.tokenOps ?? new KvTokenOps<T>(context);

    logServer(DB_LOG_MODULE, "INFO", "DB initialized");
  }

  /**
   * Adds one queue entry and returns any resulting assignments.
   */
  addToQueue(
    queueId: string,
    entryId: string,
    userId: string,
    playerSnapshot: PlayerSnapshot<T>,
    loadout: T["Loadout"],
    assignmentSubscriptionId?: string,
  ): Promise<MatchAssignmentNotification[]> {
    return this.queueOps.addToQueue(
      queueId,
      entryId,
      userId,
      playerSnapshot,
      loadout,
      assignmentSubscriptionId,
    );
  }

  /**
   * Removes one queue entry.
   */
  removeFromQueue(
    queueId: string,
    entryId: string,
  ): Promise<void> {
    return this.queueOps.removeFromQueue(queueId, entryId);
  }

  /**
   * Creates one room.
   */
  createRoom(
    roomId: string,
    userId: string,
    roomConfig: {
      numPlayers: number;
      config: T["Config"];
      private: boolean;
    },
  ): Promise<void> {
    return this.roomOps.createRoom(roomId, userId, roomConfig);
  }

  /**
   * Fetches one room.
   */
  getRoom(
    roomId: string,
  ): Promise<RoomStorageData<T> | null> {
    return this.roomOps.getRoom(roomId);
  }

  /**
   * Watches one room for updates.
   */
  watchForRoomChanges(
    roomId: string,
  ): ReadableStream<RoomWatchEvent<T>> {
    return this.roomOps.watchForRoomChanges(roomId);
  }

  /**
   * Adds one member to a room.
   */
  addToRoom(
    roomId: string,
    entryId: string,
    userId: string,
    playerSnapshot: PlayerSnapshot<T>,
    loadout: T["Loadout"],
    assignmentSubscriptionId?: string,
  ): Promise<void> {
    return this.roomOps.addToRoom(
      roomId,
      entryId,
      userId,
      playerSnapshot,
      loadout,
      assignmentSubscriptionId,
    );
  }

  /**
   * Removes one room member.
   */
  removeFromRoom(
    roomId: string,
    entryId: string,
  ): Promise<void> {
    return this.roomOps.removeFromRoom(roomId, entryId);
  }

  /**
   * Commits one room into a match.
   */
  commitRoom(
    roomId: string,
    userId: string,
  ): Promise<MatchAssignmentNotification[]> {
    return this.roomOps.commitRoom(roomId, userId);
  }

  /**
   * Updates one match storage record.
   */
  updateMatchStorageData(
    matchId: string,
    gameData: MatchStorageData<T>,
    userId: string,
  ): Promise<void> {
    return this.matchOps.updateMatchStorageData(matchId, gameData, userId);
  }

  /**
   * Fetches one match storage record.
   */
  getMatchStorageData(
    matchId: string,
  ): Promise<MatchStorageData<T>> {
    return this.matchOps.getMatchStorageData(matchId);
  }

  /**
   * Increments one active public user connection count.
   */
  incrementActivePublicUserConnection(
    userId: string,
    playerSnapshot: PlayerSnapshot<T>,
  ): Promise<void> {
    return this.publicIndexOps.incrementActivePublicUserConnection(
      userId,
      playerSnapshot,
    );
  }

  /**
   * Refreshes one active public user entry.
   */
  touchActivePublicUser(userId: string): Promise<void> {
    return this.publicIndexOps.touchActivePublicUser(userId);
  }

  /**
   * Decrements one active public user connection count.
   */
  decrementActivePublicUserConnection(userId: string): Promise<void> {
    return this.publicIndexOps.decrementActivePublicUserConnection(userId);
  }

  /**
   * Returns all active public users.
   */
  getAllActivePublicUsers(): Promise<PlayerSnapshot<T>[]> {
    return this.publicIndexOps.getAllActivePublicUsers();
  }

  /**
   * Watches active public users list updates.
   */
  watchForActivePublicUsersListChanges(): ReadableStream<PlayerSnapshot<T>[]> {
    return this.publicIndexOps.watchForActivePublicUsersListChanges();
  }

  /**
   * Returns all active public matches.
   */
  getAllActivePublicMatches(): Promise<ActivePublicMatch<T>[]> {
    return this.publicIndexOps.getAllActivePublicMatches();
  }

  /**
   * Watches one match for updates.
   */
  watchForMatchChanges(
    matchId: string,
  ): ReadableStream<MatchStorageData<T>> {
    return this.matchOps.watchForMatchChanges(matchId);
  }

  /**
   * Watches active public matches list updates.
   */
  watchForActivePublicMatchesListChanges(): ReadableStream<
    ActivePublicMatch<T>[]
  > {
    return this.publicIndexOps.watchForActivePublicMatchesListChanges();
  }

  /**
   * Returns all available public rooms.
   */
  getAllAvailablePublicRooms(): Promise<AvailableRoom<T>[]> {
    return this.publicIndexOps.getAllAvailablePublicRooms();
  }

  /**
   * Watches available public rooms list updates.
   */
  watchForAvailablePublicRoomListChanges(): ReadableStream<AvailableRoom<T>[]> {
    return this.publicIndexOps.watchForAvailablePublicRoomListChanges();
  }

  /**
   * Appends one chat message.
   */
  appendChatMessage(
    chatThreadId: string,
    chatMessage: ChatMessage<T>,
  ): Promise<void> {
    return this.chatOps.appendChatMessage(chatThreadId, chatMessage);
  }

  /**
   * Fetches recent chat messages for one thread.
   */
  getMostRecentChatThreadMessages(
    chatThreadId: string,
    limit: number,
  ): Promise<ChatMessage<T>[]> {
    return this.chatOps.getMostRecentChatThreadMessages(chatThreadId, limit);
  }

  /**
   * Fetches chat messages after one message id.
   */
  getChatThreadMessagesAfter(
    chatThreadId: string,
    lastMessageId?: string,
  ): Promise<ChatMessage<T>[]> {
    return this.chatOps.getChatThreadMessagesAfter(chatThreadId, lastMessageId);
  }

  /**
   * Watches one chat thread for append notifications.
   */
  watchForChatThreadMessageChanges(
    chatThreadId: string,
  ): ReadableStream<void> {
    return this.chatOps.watchForChatThreadMessageChanges(chatThreadId);
  }

  /**
   * Creates one user storage record.
   */
  createNewUserStorageData(
    userId: string,
    data: UserStorageData<T>,
  ): Promise<void> {
    return this.userOps.createNewUserStorageData(userId, data);
  }

  /**
   * Updates one user storage record.
   */
  updateUserStorageData(
    userId: string,
    data: Partial<UserStorageData<T>>,
    options?: { actorUserId?: string },
  ): Promise<void> {
    return this.userOps.updateUserStorageData(userId, data, options);
  }

  /**
   * Updates user-editable profile fields.
   */
  updateUserProfile(
    userId: string,
    profile: {
      description?: string;
      starUserId?: string;
      unstarUserId?: string;
    },
  ): Promise<void> {
    return this.userOps.updateUserProfile(userId, profile);
  }

  /**
   * Fetches one user storage record.
   */
  getUserStorageData(
    userId: string,
  ): Promise<UserStorageData<T> | null> {
    return this.userOps.getUserStorageData(userId);
  }

  /**
   * Fetches one user profile view payload.
   */
  getUserProfileViewData(
    userId: string,
  ): Promise<UserProfileViewData<T> | null> {
    return this.userOps.getUserProfileViewData(userId);
  }

  /**
   * Watches one user profile view payload.
   */
  watchForUserProfileChanges(
    userId: string,
  ): ReadableStream<UserProfileViewData<T>> {
    return this.userOps.watchForUserProfileChanges(userId);
  }

  /**
   * Creates one user matchmaking record.
   */
  createNewUserMatchmakingStorageData(
    userId: string,
    data: UserMatchmakingStorageData<T>,
    options?: { actorUserId?: string },
  ): Promise<void> {
    return this.userMatchmakingOps.createNewUserMatchmakingStorageData(
      userId,
      data,
      options,
    );
  }

  /**
   * Updates one user matchmaking record.
   */
  updateUserMatchmakingStorageData(
    userId: string,
    data: Partial<UserMatchmakingStorageData<T>>,
    options?: { actorUserId?: string },
  ): Promise<void> {
    return this.userMatchmakingOps.updateUserMatchmakingStorageData(
      userId,
      data,
      options,
    );
  }

  /**
   * Fetches one user matchmaking record.
   */
  getUserMatchmakingStorageData(
    userId: string,
  ): Promise<UserMatchmakingStorageData<T> | null> {
    return this.userMatchmakingOps.getUserMatchmakingStorageData(userId);
  }

  /**
   * Watches one user matchmaking record.
   */
  watchForUserMatchmakingChanges(
    userId: string,
  ): ReadableStream<UserMatchmakingStorageData<T>> {
    return this.userMatchmakingOps.watchForUserMatchmakingChanges(userId);
  }

  /**
   * Checks whether one username exists.
   */
  usernameExists(username: string): Promise<boolean> {
    return this.userOps.usernameExists(username);
  }

  /**
   * Stores one auth token payload.
   */
  storeToken(token: string, tokenData: TokenData): Promise<void> {
    return this.tokenOps.storeToken(token, tokenData);
  }

  /**
   * Fetches one auth token payload.
   */
  getToken(token: string): Promise<TokenData | null> {
    return this.tokenOps.getToken(token);
  }
}
