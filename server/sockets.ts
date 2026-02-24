import type {
  DB,
  GameAssignmentNotification,
  GameStorageData,
  RoomWatchEvent,
  UserMatchmakingStorageData,
} from "./db.ts";
import type {
  ActiveGame,
  ActivePublicGamesViewData,
  ActiveUsersViewData,
  AvailablePublicRoomsViewData,
  AvailableRoom,
  GameViewData,
  PlayerSnapshot,
  RoomEntry,
  UserMatchmakingViewData,
  UserProfileViewData,
} from "../types.ts";
import type { ServerMessage } from "../common/sockettypes.ts";
import type { GameStateService } from "./gamestateservice.ts";
import { ulid } from "@std/ulid";

type QueueSubscription = {
  queueId: string;
  entryId: string;
};

type RoomConnectionState<Config, Loadout, Rating> = {
  userId: string;
  roomId: string;
  subscriptionIds: Set<string>;
  entryId: string;
  loadout: Loadout;
  roomChangesReader: ReadableStreamDefaultReader<
    RoomWatchEvent<Config, Loadout, Rating>
  >;
};

/**
 * UserMatchmaking-specific state tracked for one websocket.
 */
type UserMatchmakingConnectionState<Config, Loadout, Rating> = {
  subscriptionIds: Set<string>;
  userChangesReader: ReadableStreamDefaultReader<
    UserMatchmakingStorageData<Config, Loadout, Rating>
  >;
  queueSubscriptions: Map<string, QueueSubscription>;
};

/**
 * UserProfile-specific state tracked for one websocket and user ID across
 * AccountUserProfile and UserProfile channels.
 */
type UserProfileConnectionState<Rating> = {
  userId: string;
  subscriptionIds: Set<string>;
  userChangesReader: ReadableStreamDefaultReader<UserProfileViewData<Rating>>;
};

/**
 * One websocket subscriber within a game channel.
 */
type GameSocketSubscription = {
  subscriptionId: string;
  socket: WebSocket;
  playerId: number | undefined;
};

/**
 * Shared stream and subscriber state for a single game.
 */
type GameConnection<Config, GameState, Outcome, Rating> = {
  gameSubscriptions: Map<string, GameSocketSubscription>;
  changesReader: ReadableStreamDefaultReader<
    GameStorageData<Config, GameState, Outcome, Rating>
  >;
};

type SocketSubscription =
  | { type: "AccountUserProfile"; userId: string }
  | { type: "UserProfile"; userId: string }
  | { type: "UserMatchmaking" }
  | { type: "Room"; roomId: string }
  | { type: "ActivePublicGames" }
  | { type: "ActivePublicUsers" }
  | { type: "AvailablePublicRooms" }
  | { type: "Game"; gameId: string };

/**
 * Combined state for a websocket across UserMatchmaking, room, and game
 * subscriptions.
 */
type SocketConnectionState<Config, Loadout, Rating> = {
  subscriptions: Map<string, SocketSubscription>;
  roomConnections: Map<string, RoomConnectionState<Config, Loadout, Rating>>;
  userProfileConnections: Map<string, UserProfileConnectionState<Rating>>;
  userMatchmaking?: UserMatchmakingConnectionState<Config, Loadout, Rating>;
};

/**
 * Serializes and sends one server message over a websocket.
 */
function sendServerMessage<
  Config,
  Loadout,
  Rating,
  PlayerState,
  PublicState,
  Outcome,
>(
  socket: WebSocket,
  message: ServerMessage<
    Config,
    Loadout,
    Rating,
    PlayerState,
    PublicState,
    Outcome
  >,
): void {
  socket.send(JSON.stringify(message));
}

/**
 * Cancels and unlocks a stream reader.
 */
function closeReader<T>(reader: ReadableStreamDefaultReader<T>): void {
  try {
    reader.cancel();
  } catch {
    // Reader may already be closed.
  }
  try {
    reader.releaseLock();
  } catch {
    // Reader may already have released its lock.
  }
}

/**
 * Creates a strongly-typed game view payload for one subscriber update.
 */
function buildGameViewData<PlayerState, PublicState, Outcome, Rating>(
  players: PlayerSnapshot<Rating>[],
  playerId: number | undefined,
  gameStateUpdate: {
    playerState: PlayerState | undefined;
    publicState: PublicState;
    outcome: Outcome | undefined;
  },
): GameViewData<PlayerState, PublicState, Outcome, Rating> {
  if (playerId == null) {
    if (gameStateUpdate.outcome === undefined) {
      return {
        players,
        playerId: undefined,
        playerState: undefined,
        publicState: gameStateUpdate.publicState,
        outcome: undefined,
      };
    }

    return {
      players,
      playerId: undefined,
      playerState: undefined,
      publicState: gameStateUpdate.publicState,
      outcome: gameStateUpdate.outcome,
    };
  }

  if (gameStateUpdate.playerState == null) {
    throw new Error(
      `Missing player state for subscribed player ${playerId}`,
    );
  }

  if (gameStateUpdate.outcome === undefined) {
    return {
      players,
      playerId,
      playerState: gameStateUpdate.playerState,
      publicState: gameStateUpdate.publicState,
      outcome: undefined,
    };
  }

  return {
    players,
    playerId,
    playerState: gameStateUpdate.playerState,
    publicState: gameStateUpdate.publicState,
    outcome: gameStateUpdate.outcome,
  };
}

export class SocketStore<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Rating,
  Loadout,
> {
  private sockets: Map<
    WebSocket,
    SocketConnectionState<Config, Loadout, Rating>
  > = new Map();
  private gameStateService?: GameStateService<
    Config,
    GameState,
    Move,
    PlayerState,
    PublicState,
    Outcome,
    Rating,
    Loadout
  >;
  private activePublicGamesSubscriptions: Map<string, WebSocket> = new Map();
  private activePublicUsersSubscriptions: Map<string, WebSocket> = new Map();
  private availablePublicRoomsSubscriptions: Map<string, WebSocket> = new Map();
  private gameConnections: Map<
    string,
    GameConnection<Config, GameState, Outcome, Rating>
  > = new Map();

  constructor(
    private db: DB<
      Config,
      GameState,
      Move,
      PlayerState,
      PublicState,
      Outcome,
      Rating,
      Loadout
    >,
    activeGamesStream: ReadableStream<ActiveGame<Config, Rating>[]>,
    activeUsersStream: ReadableStream<PlayerSnapshot<Rating>[]>,
    availableRoomsStream: ReadableStream<AvailableRoom<Config, Rating>[]>,
  ) {
    this.streamActivePublicGamesToSockets(activeGamesStream);
    this.streamActivePublicUsersToSockets(activeUsersStream);
    this.streamAvailablePublicRoomsToSockets(availableRoomsStream);
  }

  /**
   * Registers game-derived state helpers shared by game subscriptions.
   */
  setGameStateService(
    gameStateService: GameStateService<
      Config,
      GameState,
      Move,
      PlayerState,
      PublicState,
      Outcome,
      Rating,
      Loadout
    >,
  ): void {
    this.gameStateService = gameStateService;
  }

  /**
   * Subscribes one logical AccountUserProfile channel instance on a websocket.
   */
  async subscribeAccountUserProfile(
    socket: WebSocket,
    subscriptionId: string,
    userId: string,
    userProfile: UserProfileViewData<Rating>,
  ): Promise<void> {
    await this.unsubscribe(socket, subscriptionId);

    const connectionState = this.getOrCreateSocketConnection(socket);
    let userProfileConnection = connectionState.userProfileConnections.get(
      userId,
    );

    if (userProfileConnection == null) {
      const userChangesReader = this.db.watchForUserProfileChanges(userId)
        .getReader();
      userProfileConnection = {
        userId,
        subscriptionIds: new Set(),
        userChangesReader,
      };
      connectionState.userProfileConnections.set(userId, userProfileConnection);
      void this.streamUserProfileChangesToSocket(
        socket,
        userId,
        userChangesReader,
      );
    }

    userProfileConnection.subscriptionIds.add(subscriptionId);
    connectionState.subscriptions.set(subscriptionId, {
      type: "AccountUserProfile",
      userId,
    });

    this.sendAccountUserProfileSnapshot(socket, subscriptionId, userProfile);
  }

  /**
   * Subscribes one logical UserProfile channel instance on a websocket.
   */
  async subscribeUserProfile(
    socket: WebSocket,
    subscriptionId: string,
    userId: string,
    userProfile: UserProfileViewData<Rating>,
  ): Promise<void> {
    await this.unsubscribe(socket, subscriptionId);

    const connectionState = this.getOrCreateSocketConnection(socket);
    let userProfileConnection = connectionState.userProfileConnections.get(
      userId,
    );

    if (userProfileConnection == null) {
      const userChangesReader = this.db.watchForUserProfileChanges(userId)
        .getReader();
      userProfileConnection = {
        userId,
        subscriptionIds: new Set(),
        userChangesReader,
      };
      connectionState.userProfileConnections.set(userId, userProfileConnection);
      void this.streamUserProfileChangesToSocket(
        socket,
        userId,
        userChangesReader,
      );
    }

    userProfileConnection.subscriptionIds.add(subscriptionId);
    connectionState.subscriptions.set(subscriptionId, {
      type: "UserProfile",
      userId,
    });

    this.sendUserProfileSnapshot(socket, subscriptionId, userProfile);
  }

  /**
   * Subscribes one logical UserMatchmaking channel instance on a websocket.
   */
  async subscribeUserMatchmaking(
    socket: WebSocket,
    subscriptionId: string,
    userId: string,
    userData: UserMatchmakingStorageData<Config, Loadout, Rating>,
  ): Promise<void> {
    const existingConnection = this.sockets.get(socket);
    const existingSubscription = existingConnection?.subscriptions.get(
      subscriptionId,
    );

    if (
      existingSubscription?.type === "UserMatchmaking" &&
      existingConnection != null &&
      existingConnection.userMatchmaking != null
    ) {
      existingConnection.userMatchmaking.subscriptionIds.add(subscriptionId);
      this.sendUserMatchmakingSnapshot(socket, subscriptionId, userData);
      return;
    }

    await this.unsubscribe(socket, subscriptionId);

    const connectionState = this.getOrCreateSocketConnection(socket);

    if (connectionState.userMatchmaking == null) {
      const userChangesReader = this.db.watchForUserMatchmakingChanges(userId)
        .getReader();

      connectionState.userMatchmaking = {
        subscriptionIds: new Set(),
        userChangesReader,
        queueSubscriptions: new Map(),
      };
      void this.streamUserChangesToSocket(socket, userChangesReader);
    }

    const userMatchmakingState = connectionState.userMatchmaking;
    if (userMatchmakingState == null) {
      throw new Error("UserMatchmaking connection state was not initialized");
    }

    userMatchmakingState.subscriptionIds.add(subscriptionId);
    connectionState.subscriptions.set(subscriptionId, {
      type: "UserMatchmaking",
    });

    this.sendUserMatchmakingSnapshot(socket, subscriptionId, userData);
  }

  /**
   * Subscribes one logical active public games channel instance.
   */
  async subscribeActivePublicGames(
    socket: WebSocket,
    subscriptionId: string,
  ): Promise<void> {
    await this.unsubscribe(socket, subscriptionId);

    const connectionState = this.getOrCreateSocketConnection(socket);
    connectionState.subscriptions.set(subscriptionId, {
      type: "ActivePublicGames",
    });
    this.activePublicGamesSubscriptions.set(subscriptionId, socket);
    await this.sendActivePublicGamesSnapshot(socket, subscriptionId);
  }

  /**
   * Subscribes one logical active public users channel instance.
   */
  async subscribeActivePublicUsers(
    socket: WebSocket,
    subscriptionId: string,
  ): Promise<void> {
    await this.unsubscribe(socket, subscriptionId);

    const connectionState = this.getOrCreateSocketConnection(socket);
    connectionState.subscriptions.set(subscriptionId, {
      type: "ActivePublicUsers",
    });
    this.activePublicUsersSubscriptions.set(subscriptionId, socket);
    await this.sendActivePublicUsersSnapshot(socket, subscriptionId);
  }

  /**
   * Subscribes one logical available public rooms channel instance.
   */
  async subscribeAvailablePublicRooms(
    socket: WebSocket,
    subscriptionId: string,
  ): Promise<void> {
    await this.unsubscribe(socket, subscriptionId);

    const connectionState = this.getOrCreateSocketConnection(socket);
    connectionState.subscriptions.set(subscriptionId, {
      type: "AvailablePublicRooms",
    });
    this.availablePublicRoomsSubscriptions.set(subscriptionId, socket);
    await this.sendAvailablePublicRoomsSnapshot(socket, subscriptionId);
  }

  /**
   * Subscribes one logical room channel instance on a websocket.
   */
  async subscribeRoom(
    socket: WebSocket,
    subscriptionId: string,
    roomId: string,
    userId: string,
  ): Promise<void> {
    await this.unsubscribe(socket, subscriptionId);

    const room = await this.db.getRoom(roomId);
    if (room == null) {
      throw new Error(`Room ${roomId} not found`);
    }

    const roomMember = room.members.find((member) => member.userId === userId);
    if (roomMember == null) {
      throw new Error(`User ${userId} is not in room ${roomId}`);
    }

    const connectionState = this.getOrCreateSocketConnection(socket);
    let roomConnection = connectionState.roomConnections.get(roomId);

    if (roomConnection == null) {
      const roomChangesReader = this.db.watchForRoomChanges(roomId)
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

    const roomEntry: RoomEntry<Config, Loadout, Rating> = {
      roomId,
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
   * Unsubscribes one logical channel instance identified by subscription ID.
   */
  async unsubscribe(
    socket: WebSocket,
    subscriptionId: string,
  ): Promise<void> {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null) {
      return;
    }

    const subscription = connectionState.subscriptions.get(subscriptionId);
    if (subscription == null) {
      return;
    }

    connectionState.subscriptions.delete(subscriptionId);

    switch (subscription.type) {
      case "AccountUserProfile":
        this.unsubscribeUserProfileSubscription(
          socket,
          subscriptionId,
          subscription.userId,
        );
        break;
      case "UserProfile":
        this.unsubscribeUserProfileSubscription(
          socket,
          subscriptionId,
          subscription.userId,
        );
        break;
      case "UserMatchmaking":
        await this.unsubscribeUserMatchmakingSubscription(
          socket,
          subscriptionId,
        );
        break;
      case "Room":
        await this.unsubscribeRoomSubscription(
          socket,
          subscriptionId,
          subscription.roomId,
        );
        break;
      case "ActivePublicGames":
        this.activePublicGamesSubscriptions.delete(subscriptionId);
        break;
      case "ActivePublicUsers":
        this.activePublicUsersSubscriptions.delete(subscriptionId);
        break;
      case "AvailablePublicRooms":
        this.availablePublicRoomsSubscriptions.delete(subscriptionId);
        break;
      case "Game":
        this.unsubscribeGameSubscription(subscriptionId, subscription.gameId);
        break;
    }

    this.pruneIdleSocket(socket);
  }

  /**
   * Unsubscribes a websocket from all channel subscriptions.
   */
  async unsubscribeSocket(socket: WebSocket): Promise<void> {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null) {
      return;
    }

    for (const subscriptionId of [...connectionState.subscriptions.keys()]) {
      await this.unsubscribe(socket, subscriptionId);
    }

    this.pruneIdleSocket(socket);
  }

  /**
   * Adds a user to a queue and dispatches any immediate game assignments.
   */
  async joinQueue(
    socket: WebSocket,
    queueId: string,
    userId: string,
    playerSnapshot: PlayerSnapshot<Rating>,
    loadout: Loadout,
    assignmentSubscriptionId?: string,
  ): Promise<void> {
    const userMatchmakingState = this.getUserMatchmakingConnectionState(socket);

    if (userMatchmakingState.queueSubscriptions.has(queueId)) {
      await this.cleanupQueueSubscription(socket, queueId, {
        removeFromDb: true,
      });
    }

    const entryId = ulid();
    const gameAssignments = await this.db.addToQueue(
      queueId,
      entryId,
      userId,
      playerSnapshot,
      loadout,
      assignmentSubscriptionId,
    );

    if (gameAssignments.length === 0) {
      userMatchmakingState.queueSubscriptions.set(queueId, {
        queueId,
        entryId,
      });
    } else {
      userMatchmakingState.queueSubscriptions.delete(queueId);
    }

    this.sendGameAssignmentsToStoredSubscriptions(gameAssignments);
  }

  /**
   * Creates a room and immediately joins it for the requesting user.
   */
  async createAndJoinRoom(
    socket: WebSocket,
    roomConfig: { numPlayers: number; config: Config; private: boolean },
    userId: string,
    playerSnapshot: PlayerSnapshot<Rating>,
    loadout: Loadout,
    assignmentSubscriptionId?: string,
  ): Promise<void> {
    const roomId = ulid();
    await this.db.createRoom(roomId, roomConfig);
    await this.joinRoom(
      socket,
      roomId,
      userId,
      playerSnapshot,
      loadout,
      assignmentSubscriptionId,
    );
  }

  /**
   * Adds a user to a room.
   */
  async joinRoom(
    _socket: WebSocket,
    roomId: string,
    userId: string,
    playerSnapshot: PlayerSnapshot<Rating>,
    loadout: Loadout,
    assignmentSubscriptionId?: string,
  ): Promise<boolean> {
    const entryId = ulid();

    try {
      await this.db.addToRoom(
        roomId,
        entryId,
        userId,
        playerSnapshot,
        loadout,
        assignmentSubscriptionId,
      );
    } catch {
      return false;
    }

    return true;
  }

  /**
   * Leaves one queue and removes its stored queue entry state.
   */
  async leaveQueue(socket: WebSocket, queueId: string): Promise<void> {
    await this.cleanupQueueSubscription(socket, queueId, {
      removeFromDb: true,
    });
  }

  /**
   * Commits one room to a game when the user is an active member.
   */
  async commitRoom(roomId: string, userId: string): Promise<void> {
    const room = await this.db.getRoom(roomId);
    if (room == null) {
      throw new Error(`Room ${roomId} not found`);
    }

    const member = room.members.find((roomMember) =>
      roomMember.userId === userId
    );
    if (member == null) {
      throw new Error(`User ${userId} is not in room ${roomId}`);
    }

    const gameAssignments = await this.db.commitRoom(roomId);
    this.sendGameAssignmentsToStoredSubscriptions(gameAssignments);
  }

  /**
   * Leaves one room regardless of whether this socket is subscribed to it.
   */
  async leaveRoom(
    socket: WebSocket,
    roomId: string,
    userId: string,
  ): Promise<void> {
    const room = await this.db.getRoom(roomId);
    if (room != null) {
      const member = room.members.find((roomMember) =>
        roomMember.userId === userId
      );
      if (member != null) {
        await this.db.removeFromRoom(roomId, member.entryId);
      }
    }

    await this.cleanupRoomConnection(socket, roomId, {
      notifyClient: true,
      removeSubscriptionEntries: true,
    });
  }

  /**
   * Subscribes one logical game channel instance on a websocket.
   */
  async subscribeGame(
    socket: WebSocket,
    subscriptionId: string,
    gameId: string,
    playerId?: number,
  ): Promise<void> {
    await this.unsubscribe(socket, subscriptionId);

    const gameStateService = this.requireGameStateService();
    const connectionState = this.getOrCreateSocketConnection(socket);

    if (!this.gameConnections.has(gameId)) {
      this.createGameConnection(gameId);
    }

    const gameConnection = this.gameConnections.get(gameId);
    if (gameConnection == null) {
      throw new Error(`Game connection ${gameId} not found`);
    }

    gameConnection.gameSubscriptions.set(subscriptionId, {
      subscriptionId,
      socket,
      playerId,
    });
    connectionState.subscriptions.set(subscriptionId, {
      type: "Game",
      gameId,
    });

    const gameData = await this.db.getGameStorageData(gameId);
    const gameStateUpdate = gameStateService.buildGameStateUpdate(
      gameData,
      playerId,
    );

    sendServerMessage<
      never,
      never,
      Rating,
      PlayerState,
      PublicState,
      Outcome
    >(socket, {
      type: "UpdateGameState",
      subscriptionId,
      gameViewData: buildGameViewData(
        gameData.players,
        playerId,
        gameStateUpdate,
      ),
    });
  }

  /**
   * Unsubscribes one UserProfile subscription and tears down user-profile
   * streams when last.
   */
  private unsubscribeUserProfileSubscription(
    socket: WebSocket,
    subscriptionId: string,
    userId: string,
  ): void {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null) {
      return;
    }
    const userProfileConnection = connectionState.userProfileConnections.get(
      userId,
    );
    if (userProfileConnection == null) {
      return;
    }

    userProfileConnection.subscriptionIds.delete(subscriptionId);
    if (userProfileConnection.subscriptionIds.size > 0) {
      return;
    }

    closeReader(userProfileConnection.userChangesReader);
    connectionState.userProfileConnections.delete(userId);
  }

  /**
   * Unsubscribes one UserMatchmaking subscription and tears down
   * UserMatchmaking streams when last.
   */
  private async unsubscribeUserMatchmakingSubscription(
    socket: WebSocket,
    subscriptionId: string,
  ): Promise<void> {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null || connectionState.userMatchmaking == null) {
      return;
    }

    const userMatchmakingState = connectionState.userMatchmaking;
    userMatchmakingState.subscriptionIds.delete(subscriptionId);

    if (userMatchmakingState.subscriptionIds.size > 0) {
      return;
    }

    await this.cleanupUserMatchmakingConnection(socket, userMatchmakingState);
  }

  /**
   * Unsubscribes one room subscription and tears down room streams when last.
   */
  private async unsubscribeRoomSubscription(
    socket: WebSocket,
    subscriptionId: string,
    roomId: string,
  ): Promise<void> {
    const roomConnection = this.getRoomConnection(socket, roomId);
    if (roomConnection == null) {
      return;
    }

    roomConnection.subscriptionIds.delete(subscriptionId);
    if (roomConnection.subscriptionIds.size > 0) {
      return;
    }

    await this.cleanupRoomConnection(socket, roomId, {
      notifyClient: false,
      removeSubscriptionEntries: false,
    });
  }

  /**
   * Cleans up shared UserMatchmaking resources after the last
   * UserMatchmaking subscription is gone.
   */
  private async cleanupUserMatchmakingConnection(
    socket: WebSocket,
    userMatchmakingState: UserMatchmakingConnectionState<
      Config,
      Loadout,
      Rating
    >,
  ): Promise<void> {
    for (const queueId of [...userMatchmakingState.queueSubscriptions.keys()]) {
      await this.cleanupQueueSubscription(socket, queueId, {
        removeFromDb: true,
      });
    }

    closeReader(userMatchmakingState.userChangesReader);

    const connectionState = this.sockets.get(socket);
    if (connectionState != null) {
      connectionState.userMatchmaking = undefined;
    }
  }

  /**
   * Removes one game subscription from its game stream.
   */
  private unsubscribeGameSubscription(
    subscriptionId: string,
    gameId: string,
  ): void {
    const gameConnection = this.gameConnections.get(gameId);
    if (gameConnection == null) {
      return;
    }

    const wasRemoved = gameConnection.gameSubscriptions.delete(subscriptionId);
    if (!wasRemoved) {
      return;
    }

    if (gameConnection.gameSubscriptions.size === 0) {
      closeReader(gameConnection.changesReader);
      this.gameConnections.delete(gameId);
    }
  }

  /**
   * Streams UserMatchmaking updates for one websocket.
   */
  private async streamUserChangesToSocket(
    socket: WebSocket,
    userChangesReader: ReadableStreamDefaultReader<
      UserMatchmakingStorageData<Config, Loadout, Rating>
    >,
  ): Promise<void> {
    try {
      while (true) {
        const data = await userChangesReader.read();
        if (data.done) {
          break;
        }

        const userData = data.value;
        this.sendUserMatchmakingSnapshotToSubscriptions(socket, userData);
      }
    } catch {
      // Reader cancellation is expected during unsubscribe.
    }
  }

  /**
   * Streams UserProfile updates for one websocket and target user.
   */
  private async streamUserProfileChangesToSocket(
    socket: WebSocket,
    userId: string,
    userChangesReader: ReadableStreamDefaultReader<UserProfileViewData<Rating>>,
  ): Promise<void> {
    try {
      while (true) {
        const data = await userChangesReader.read();
        if (data.done) {
          break;
        }

        this.sendUserProfileSnapshotToSubscriptions(socket, userId, data.value);
      }
    } catch {
      // Reader cancellation is expected during unsubscribe.
    } finally {
      closeReader(userChangesReader);
    }
  }

  /**
   * Streams room updates for one room subscription.
   */
  private async streamRoomChangesToSocket(
    socket: WebSocket,
    roomId: string,
    roomChangesReader: ReadableStreamDefaultReader<
      RoomWatchEvent<Config, Loadout, Rating>
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
          await this.cleanupRoomConnection(socket, roomId, {
            notifyClient: false,
            removeSubscriptionEntries: true,
          });
          break;
        }

        const roomConnection = this.getRoomConnection(socket, roomId);
        if (roomConnection == null) {
          break;
        }

        const roomMember = data.value.room.members.find((member) =>
          member.userId === roomConnection.userId
        );
        if (roomMember == null) {
          this.sendRoomEntryRemovalToRoomSubscriptions(socket, roomId);
          await this.cleanupRoomConnection(socket, roomId, {
            notifyClient: false,
            removeSubscriptionEntries: true,
          });
          break;
        }

        roomConnection.entryId = roomMember.entryId;
        roomConnection.loadout = roomMember.loadout;

        const roomEntry: RoomEntry<Config, Loadout, Rating> = {
          roomId,
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
   * Sends one full UserMatchmaking snapshot to one subscription ID.
   */
  private sendUserMatchmakingSnapshot(
    socket: WebSocket,
    subscriptionId: string,
    userData: UserMatchmakingStorageData<Config, Loadout, Rating>,
  ): void {
    const userMatchmakingProps: UserMatchmakingViewData<
      Config,
      Loadout,
      Rating
    > = {
      userActiveGames: userData.activeGames,
      roomIds: userData.joinedRooms.map((joinedRoom) => joinedRoom.roomId),
      queueEntries: userData.queueEntries,
    };

    sendServerMessage<Config, Loadout, Rating, never, never, never>(socket, {
      type: "UpdateUserMatchmakingProps",
      subscriptionId,
      userMatchmakingProps,
    });
  }

  /**
   * Sends the latest UserMatchmaking snapshot to each active UserMatchmaking
   * subscription.
   */
  private sendUserMatchmakingSnapshotToSubscriptions(
    socket: WebSocket,
    userData: UserMatchmakingStorageData<Config, Loadout, Rating>,
  ): void {
    for (
      const subscriptionId of this.getUserMatchmakingSubscriptionIds(socket)
    ) {
      this.sendUserMatchmakingSnapshot(socket, subscriptionId, userData);
    }
  }

  /**
   * Sends one full AccountUserProfile snapshot to one subscription ID.
   */
  private sendAccountUserProfileSnapshot(
    socket: WebSocket,
    subscriptionId: string,
    userProfile: UserProfileViewData<Rating>,
  ): void {
    sendServerMessage<never, never, Rating, never, never, never>(socket, {
      type: "UpdateAccountUserProfileProps",
      subscriptionId,
      accountUserProfileProps: userProfile,
    });
  }

  /**
   * Sends one full UserProfile snapshot to one subscription ID.
   */
  private sendUserProfileSnapshot(
    socket: WebSocket,
    subscriptionId: string,
    userProfile: UserProfileViewData<Rating>,
  ): void {
    sendServerMessage<never, never, Rating, never, never, never>(socket, {
      type: "UpdateUserProfileProps",
      subscriptionId,
      userProfileProps: userProfile,
    });
  }

  /**
   * Sends the latest profile snapshot to each active AccountUserProfile and
   * UserProfile subscription for a user.
   */
  private sendUserProfileSnapshotToSubscriptions(
    socket: WebSocket,
    userId: string,
    userProfile: UserProfileViewData<Rating>,
  ): void {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null) {
      return;
    }

    for (
      const subscriptionId of this.getUserProfileSubscriptionIds(socket, userId)
    ) {
      const subscription = connectionState.subscriptions.get(subscriptionId);
      if (subscription == null) {
        continue;
      }

      if (subscription.type === "AccountUserProfile") {
        this.sendAccountUserProfileSnapshot(
          socket,
          subscriptionId,
          userProfile,
        );
        continue;
      }
      if (subscription.type === "UserProfile") {
        this.sendUserProfileSnapshot(socket, subscriptionId, userProfile);
      }
    }
  }

  /**
   * Sends one room entry update to one subscription ID.
   */
  private sendRoomEntryUpdateToSubscription(
    socket: WebSocket,
    subscriptionId: string,
    roomEntry: RoomEntry<Config, Loadout, Rating>,
  ): void {
    sendServerMessage<Config, Loadout, Rating, never, never, never>(socket, {
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
    roomEntry: RoomEntry<Config, Loadout, Rating>,
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
      sendServerMessage<Config, Loadout, Rating, never, never, never>(socket, {
        type: "RemoveRoomEntry",
        subscriptionId,
        roomId,
      });
    }
  }

  /**
   * Sends game assignment messages for each stored assignment target.
   */
  private sendGameAssignmentsToStoredSubscriptions(
    assignments: GameAssignmentNotification[],
  ): void {
    for (const assignment of assignments) {
      if (assignment.subscriptionId == null) {
        continue;
      }

      this.sendGameAssignmentToMatchingSubscriptions(
        assignment.subscriptionId,
        assignment.gameId,
      );
    }
  }

  /**
   * Sends one game assignment message to sockets currently holding the
   * referenced subscription ID.
   */
  private sendGameAssignmentToMatchingSubscriptions(
    subscriptionId: string,
    gameId: string,
  ): void {
    for (const [socket, connectionState] of this.sockets.entries()) {
      if (!connectionState.subscriptions.has(subscriptionId)) {
        continue;
      }

      sendServerMessage<Config, Loadout, Rating, never, never, never>(socket, {
        type: "GameAssignment",
        subscriptionId,
        gameId,
      });
    }
  }

  /**
   * Returns all active UserMatchmaking subscription IDs for a socket.
   */
  private getUserMatchmakingSubscriptionIds(socket: WebSocket): string[] {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null || connectionState.userMatchmaking == null) {
      return [];
    }

    return [...connectionState.userMatchmaking.subscriptionIds];
  }

  /**
   * Returns all active UserProfile subscription IDs for one socket and user.
   */
  private getUserProfileSubscriptionIds(
    socket: WebSocket,
    userId: string,
  ): string[] {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null) {
      return [];
    }
    const userProfileConnection = connectionState.userProfileConnections.get(
      userId,
    );
    if (userProfileConnection == null) {
      return [];
    }
    return [...userProfileConnection.subscriptionIds];
  }

  /**
   * Returns all active room subscription IDs for one socket and room.
   */
  private getRoomSubscriptionIds(
    socket: WebSocket,
    roomId: string,
  ): string[] {
    const roomConnection = this.getRoomConnection(socket, roomId);
    if (roomConnection == null) {
      return [];
    }

    return [...roomConnection.subscriptionIds];
  }

  /**
   * Sends the latest active public games snapshot to one subscription.
   */
  private async sendActivePublicGamesSnapshot(
    socket: WebSocket,
    subscriptionId: string,
  ): Promise<void> {
    const allActiveGames = await this.db.getAllActivePublicGames();
    this.sendActivePublicGamesUpdate(socket, subscriptionId, allActiveGames);
  }

  /**
   * Sends one active public games update payload to one subscription.
   */
  private sendActivePublicGamesUpdate(
    socket: WebSocket,
    subscriptionId: string,
    allActiveGames: ActiveGame<Config, Rating>[],
  ): void {
    const activePublicGamesProps: ActivePublicGamesViewData<Config, Rating> = {
      allActiveGames,
    };
    sendServerMessage<Config, Loadout, Rating, never, never, never>(socket, {
      type: "UpdateActivePublicGames",
      subscriptionId,
      activePublicGamesProps,
    });
  }

  /**
   * Broadcasts active game list updates to all active public game subscriptions.
   */
  private streamActivePublicGamesToSockets(
    activeGamesStream: ReadableStream<ActiveGame<Config, Rating>[]>,
  ): void {
    activeGamesStream.pipeTo(
      new WritableStream({
        write: (allActiveGames: ActiveGame<Config, Rating>[]) => {
          for (
            const [subscriptionId, socket] of this
              .activePublicGamesSubscriptions.entries()
          ) {
            this.sendActivePublicGamesUpdate(
              socket,
              subscriptionId,
              allActiveGames,
            );
          }
        },
      }),
    ).catch((err) => {
      console.error("Failed to broadcast active game updates", err);
    });
  }

  /**
   * Sends the latest active public users snapshot to one subscription.
   */
  private async sendActivePublicUsersSnapshot(
    socket: WebSocket,
    subscriptionId: string,
  ): Promise<void> {
    const allActiveUsers = await this.db.getAllActivePublicUsers();
    this.sendActivePublicUsersUpdate(socket, subscriptionId, allActiveUsers);
  }

  /**
   * Sends one active public users update payload to one subscription.
   */
  private sendActivePublicUsersUpdate(
    socket: WebSocket,
    subscriptionId: string,
    allActiveUsers: PlayerSnapshot<Rating>[],
  ): void {
    const activePublicUsersProps: ActiveUsersViewData<Rating> = {
      allActiveUsers,
    };
    sendServerMessage<never, Loadout, Rating, never, never, never>(socket, {
      type: "UpdateActivePublicUsers",
      subscriptionId,
      activePublicUsersProps,
    });
  }

  /**
   * Broadcasts active user list updates to all active public user subscriptions.
   */
  private streamActivePublicUsersToSockets(
    activeUsersStream: ReadableStream<PlayerSnapshot<Rating>[]>,
  ): void {
    activeUsersStream.pipeTo(
      new WritableStream({
        write: (allActiveUsers: PlayerSnapshot<Rating>[]) => {
          for (
            const [subscriptionId, socket] of this
              .activePublicUsersSubscriptions.entries()
          ) {
            this.sendActivePublicUsersUpdate(
              socket,
              subscriptionId,
              allActiveUsers,
            );
          }
        },
      }),
    ).catch((err) => {
      console.error("Failed to broadcast active user updates", err);
    });
  }

  /**
   * Sends the latest available public rooms snapshot to one subscription.
   */
  private async sendAvailablePublicRoomsSnapshot(
    socket: WebSocket,
    subscriptionId: string,
  ): Promise<void> {
    const allAvailableRooms = await this.db.getAllAvailablePublicRooms();
    this.sendAvailablePublicRoomsUpdate(
      socket,
      subscriptionId,
      allAvailableRooms,
    );
  }

  /**
   * Sends one available public rooms update payload to one subscription.
   */
  private sendAvailablePublicRoomsUpdate(
    socket: WebSocket,
    subscriptionId: string,
    allAvailableRooms: AvailableRoom<Config, Rating>[],
  ): void {
    const availablePublicRoomsProps: AvailablePublicRoomsViewData<
      Config,
      Rating
    > = {
      allAvailableRooms,
    };
    sendServerMessage<Config, Loadout, Rating, never, never, never>(socket, {
      type: "UpdateAvailablePublicRooms",
      subscriptionId,
      availablePublicRoomsProps,
    });
  }

  /**
   * Broadcasts available room list updates to all public room subscriptions.
   */
  private streamAvailablePublicRoomsToSockets(
    availableRoomsStream: ReadableStream<AvailableRoom<Config, Rating>[]>,
  ): void {
    availableRoomsStream.pipeTo(
      new WritableStream({
        write: (allAvailableRooms: AvailableRoom<Config, Rating>[]) => {
          for (
            const [subscriptionId, socket] of this
              .availablePublicRoomsSubscriptions.entries()
          ) {
            this.sendAvailablePublicRoomsUpdate(
              socket,
              subscriptionId,
              allAvailableRooms,
            );
          }
        },
      }),
    ).catch((err) => {
      console.error("Failed to broadcast available room updates", err);
    });
  }

  /**
   * Returns one room connection tracked for a socket.
   */
  private getRoomConnection(
    socket: WebSocket,
    roomId: string,
  ): RoomConnectionState<Config, Loadout, Rating> | undefined {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null) {
      return undefined;
    }

    return connectionState.roomConnections.get(roomId);
  }

  /**
   * Cleans up one queue subscription and optionally removes it from storage.
   */
  private async cleanupQueueSubscription(
    socket: WebSocket,
    queueId: string,
    options: { removeFromDb: boolean },
  ): Promise<void> {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null || connectionState.userMatchmaking == null) {
      return;
    }

    const userMatchmakingState = connectionState.userMatchmaking;
    const queueSubscription = userMatchmakingState.queueSubscriptions.get(
      queueId,
    );
    if (queueSubscription == null) {
      return;
    }

    if (options.removeFromDb) {
      try {
        await this.db.removeFromQueue(
          queueSubscription.queueId,
          queueSubscription.entryId,
        );
      } catch (err) {
        console.error("Failed to remove queue subscription", err);
      }
    }

    userMatchmakingState.queueSubscriptions.delete(queueId);
  }

  /**
   * Cleans up one room connection and optionally removes channel subscriptions.
   */
  private cleanupRoomConnection(
    socket: WebSocket,
    roomId: string,
    options: { notifyClient: boolean; removeSubscriptionEntries: boolean },
  ): void {
    const connectionState = this.sockets.get(socket);
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
        sendServerMessage<Config, Loadout, Rating, never, never, never>(
          socket,
          {
            type: "RemoveRoomEntry",
            subscriptionId,
            roomId,
          },
        );
      }
    }

    this.pruneIdleSocket(socket);
  }

  /**
   * Creates and registers one game connection stream.
   */
  private createGameConnection(
    gameId: string,
  ): void {
    const changesReader = this.db.watchForGameChanges(gameId).getReader();

    this.gameConnections.set(gameId, {
      gameSubscriptions: new Map(),
      changesReader,
    });

    void this.streamGameChangesToSockets(gameId, changesReader);
  }

  /**
   * Streams one game channel's updates to all subscribed sockets.
   */
  private async streamGameChangesToSockets(
    gameId: string,
    changesReader: ReadableStreamDefaultReader<
      GameStorageData<Config, GameState, Outcome, Rating>
    >,
  ): Promise<void> {
    const gameStateService = this.requireGameStateService();
    try {
      while (true) {
        const data = await changesReader.read();
        if (data.done) {
          break;
        }

        const gameConnection = this.gameConnections.get(gameId);
        if (gameConnection == null) {
          break;
        }

        const gameData = data.value;
        const timestamp = new Date();

        const nextPublicState = gameStateService.getPublicState(
          gameData,
          timestamp,
        );

        for (
          const gameSubscription of gameConnection.gameSubscriptions.values()
        ) {
          const gameStateUpdate = gameStateService.buildGameStateUpdate(
            gameData,
            gameSubscription.playerId,
            {
              timestamp,
              publicState: nextPublicState,
            },
          );

          sendServerMessage<
            never,
            never,
            Rating,
            PlayerState,
            PublicState,
            Outcome
          >(
            gameSubscription.socket,
            {
              type: "UpdateGameState",
              subscriptionId: gameSubscription.subscriptionId,
              gameViewData: buildGameViewData(
                gameData.players,
                gameSubscription.playerId,
                gameStateUpdate,
              ),
            },
          );
        }
      }
    } catch {
      // Reader cancellation is expected during unsubscribe.
    }
  }

  /**
   * Returns the configured game helpers or throws when missing.
   */
  private requireGameStateService(): GameStateService<
    Config,
    GameState,
    Move,
    PlayerState,
    PublicState,
    Outcome,
    Rating,
    Loadout
  > {
    if (this.gameStateService == null) {
      throw new Error("SocketStore game state service is not configured");
    }
    return this.gameStateService;
  }

  /**
   * Returns the UserMatchmaking connection state for a socket or throws when
   * absent.
   */
  private getUserMatchmakingConnectionState(
    socket: WebSocket,
  ): UserMatchmakingConnectionState<Config, Loadout, Rating> {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null || connectionState.userMatchmaking == null) {
      throw new Error("Socket is not subscribed to userMatchmaking");
    }

    return connectionState.userMatchmaking;
  }

  /**
   * Returns a socket connection state, creating one when missing.
   */
  private getOrCreateSocketConnection(
    socket: WebSocket,
  ): SocketConnectionState<Config, Loadout, Rating> {
    const existing = this.sockets.get(socket);
    if (existing != null) {
      return existing;
    }

    const connectionState: SocketConnectionState<Config, Loadout, Rating> = {
      subscriptions: new Map(),
      roomConnections: new Map(),
      userProfileConnections: new Map(),
    };
    this.sockets.set(socket, connectionState);
    return connectionState;
  }

  /**
   * Removes socket bookkeeping when no subscriptions remain.
   */
  private pruneIdleSocket(socket: WebSocket): void {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null) {
      return;
    }
    if (connectionState.subscriptions.size > 0) {
      return;
    }
    if (connectionState.roomConnections.size > 0) {
      return;
    }
    if (connectionState.userProfileConnections.size > 0) {
      return;
    }
    if (connectionState.userMatchmaking != null) {
      return;
    }

    this.sockets.delete(socket);
  }
}
