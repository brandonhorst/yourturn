import type {
  AssignmentStorageData,
  DB,
  GameStorageData,
  LobbyUserData,
  RoomWatchEvent,
} from "./db.ts";
import type {
  ActiveGame,
  ActivePublicGamesViewData,
  AvailablePublicRoomsViewData,
  AvailableRoom,
  GameViewData,
  LobbyViewData,
  Player,
  RoomEntry,
} from "../types.ts";
import type { ServerMessage } from "../common/sockettypes.ts";
import type { GameStateService } from "./gamestateservice.ts";
import { ulid } from "@std/ulid";

type QueueSubscription = {
  queueId: string;
  entryId: string;
  assignmentsReader: ReadableStreamDefaultReader<AssignmentStorageData>;
};

type RoomConnectionState<Config, Loadout> = {
  userId: string;
  roomId: string;
  subscriptionIds: Set<string>;
  entryId: string;
  loadout: Loadout;
  assignmentsReader: ReadableStreamDefaultReader<AssignmentStorageData>;
  roomChangesReader: ReadableStreamDefaultReader<
    RoomWatchEvent<Config, Loadout>
  >;
};

/**
 * Lobby-specific state tracked for one websocket.
 */
type LobbyConnectionState<Config, Loadout> = {
  subscriptionIds: Set<string>;
  userChangesReader: ReadableStreamDefaultReader<
    LobbyUserData<Config, Loadout>
  >;
  queueSubscriptions: Map<string, QueueSubscription>;
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
type GameConnection<Config, GameState, Outcome> = {
  gameSubscriptions: Map<string, GameSocketSubscription>;
  changesReader: ReadableStreamDefaultReader<
    GameStorageData<Config, GameState, Outcome>
  >;
};

type SocketSubscription =
  | { type: "Lobby" }
  | { type: "Room"; roomId: string }
  | { type: "ActivePublicGames" }
  | { type: "AvailablePublicRooms" }
  | { type: "Game"; gameId: string };

/**
 * Combined state for a websocket across lobby, room, and game subscriptions.
 */
type SocketConnectionState<Config, Loadout> = {
  subscriptions: Map<string, SocketSubscription>;
  roomConnections: Map<string, RoomConnectionState<Config, Loadout>>;
  lobby?: LobbyConnectionState<Config, Loadout>;
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
function buildGameViewData<PlayerState, PublicState, Outcome>(
  players: Player[],
  playerId: number | undefined,
  gameStateUpdate: {
    playerState: PlayerState | undefined;
    publicState: PublicState;
    outcome: Outcome | undefined;
  },
): GameViewData<PlayerState, PublicState, Outcome> {
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
    SocketConnectionState<Config, Loadout>
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
  private availablePublicRoomsSubscriptions: Map<string, WebSocket> = new Map();
  private gameConnections: Map<
    string,
    GameConnection<Config, GameState, Outcome>
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
    activeGamesStream: ReadableStream<ActiveGame<Config>[]>,
    availableRoomsStream: ReadableStream<AvailableRoom<Config>[]>,
  ) {
    this.streamActivePublicGamesToSockets(activeGamesStream);
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
   * Subscribes one logical lobby channel instance on a websocket.
   */
  async subscribeLobby(
    socket: WebSocket,
    subscriptionId: string,
    userId: string,
    userData: LobbyUserData<Config, Loadout>,
  ): Promise<void> {
    const existingConnection = this.sockets.get(socket);
    const existingSubscription = existingConnection?.subscriptions.get(
      subscriptionId,
    );

    if (
      existingSubscription?.type === "Lobby" &&
      existingConnection != null &&
      existingConnection.lobby != null
    ) {
      existingConnection.lobby.subscriptionIds.add(subscriptionId);
      this.sendLobbySnapshot(socket, subscriptionId, userData);
      return;
    }

    await this.unsubscribe(socket, subscriptionId);

    const connectionState = this.getOrCreateSocketConnection(socket);

    if (connectionState.lobby == null) {
      const userChangesReader = this.db.watchForLobbyUserChanges(userId)
        .getReader();

      connectionState.lobby = {
        subscriptionIds: new Set(),
        userChangesReader,
        queueSubscriptions: new Map(),
      };
      void this.streamUserChangesToSocket(socket, userChangesReader);
    }

    const lobbyState = connectionState.lobby;
    if (lobbyState == null) {
      throw new Error("Lobby connection state was not initialized");
    }

    lobbyState.subscriptionIds.add(subscriptionId);
    connectionState.subscriptions.set(subscriptionId, { type: "Lobby" });

    this.sendLobbySnapshot(socket, subscriptionId, userData);
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
      const assignmentsReader = this.db.watchForAssignments(roomMember.entryId)
        .getReader();
      const roomChangesReader = this.db.watchForRoomChanges(roomId)
        .getReader();

      roomConnection = {
        userId,
        roomId,
        subscriptionIds: new Set(),
        entryId: roomMember.entryId,
        loadout: roomMember.loadout,
        assignmentsReader,
        roomChangesReader,
      };
      connectionState.roomConnections.set(roomId, roomConnection);

      void this.streamRoomAssignmentsToSocket(
        socket,
        roomId,
        assignmentsReader,
      );
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

    const roomEntry: RoomEntry<Config, Loadout> = {
      roomId,
      numPlayers: room.numPlayers,
      players: room.members.map((member) => member.player),
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
      case "Lobby":
        await this.unsubscribeLobbySubscription(socket, subscriptionId);
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
   * Adds a user to a queue and watches for assignment updates.
   */
  async joinQueue(
    socket: WebSocket,
    queueId: string,
    userId: string,
    user: Player,
    loadout: Loadout,
  ): Promise<void> {
    const lobbyState = this.getLobbyConnectionState(socket);

    if (lobbyState.queueSubscriptions.has(queueId)) {
      await this.cleanupQueueSubscription(socket, queueId, {
        removeFromDb: true,
      });
    }

    const entryId = ulid();
    const assignmentsReader = this.db.watchForAssignments(entryId).getReader();

    try {
      await this.db.addToQueue(queueId, entryId, userId, user, loadout);
    } catch (err) {
      closeReader(assignmentsReader);
      throw err;
    }

    lobbyState.queueSubscriptions.set(queueId, {
      queueId,
      entryId,
      assignmentsReader,
    });

    void this.streamQueueAssignmentsToSocket(socket, assignmentsReader);
  }

  /**
   * Creates a room and immediately joins it for the requesting user.
   */
  async createAndJoinRoom(
    socket: WebSocket,
    roomConfig: { numPlayers: number; config: Config; private: boolean },
    userId: string,
    user: Player,
    loadout: Loadout,
  ): Promise<void> {
    const roomId = ulid();
    await this.db.createRoom(roomId, roomConfig);
    await this.joinRoom(socket, roomId, userId, user, loadout);
  }

  /**
   * Adds a user to a room.
   */
  async joinRoom(
    _socket: WebSocket,
    roomId: string,
    userId: string,
    user: Player,
    loadout: Loadout,
  ): Promise<boolean> {
    const entryId = ulid();

    try {
      await this.db.addToRoom(
        roomId,
        entryId,
        userId,
        user,
        loadout,
      );
    } catch {
      return false;
    }

    return true;
  }

  /**
   * Leaves one queue and stops that queue's assignment stream.
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

    await this.db.commitRoom(roomId);
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
      never,
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
   * Unsubscribes one lobby subscription and tears down lobby streams when last.
   */
  private async unsubscribeLobbySubscription(
    socket: WebSocket,
    subscriptionId: string,
  ): Promise<void> {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null || connectionState.lobby == null) {
      return;
    }

    const lobbyState = connectionState.lobby;
    lobbyState.subscriptionIds.delete(subscriptionId);

    if (lobbyState.subscriptionIds.size > 0) {
      return;
    }

    await this.cleanupLobbyConnection(socket, lobbyState);
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
   * Cleans up shared lobby resources after the last lobby subscription is gone.
   */
  private async cleanupLobbyConnection(
    socket: WebSocket,
    lobbyState: LobbyConnectionState<Config, Loadout>,
  ): Promise<void> {
    for (const queueId of [...lobbyState.queueSubscriptions.keys()]) {
      await this.cleanupQueueSubscription(socket, queueId, {
        removeFromDb: true,
      });
    }

    closeReader(lobbyState.userChangesReader);

    const connectionState = this.sockets.get(socket);
    if (connectionState != null) {
      connectionState.lobby = undefined;
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
   * Streams lobby user updates for one websocket.
   */
  private async streamUserChangesToSocket(
    socket: WebSocket,
    userChangesReader: ReadableStreamDefaultReader<
      LobbyUserData<Config, Loadout>
    >,
  ): Promise<void> {
    try {
      while (true) {
        const data = await userChangesReader.read();
        if (data.done) {
          break;
        }

        const userData = data.value;
        this.sendLobbySnapshotToSubscriptions(socket, userData);
      }
    } catch {
      // Reader cancellation is expected during unsubscribe.
    }
  }

  /**
   * Streams assignment updates for one queue entry.
   */
  private async streamQueueAssignmentsToSocket(
    socket: WebSocket,
    assignmentsReader: ReadableStreamDefaultReader<AssignmentStorageData>,
  ): Promise<void> {
    try {
      while (true) {
        const data = await assignmentsReader.read();
        if (data.done) {
          break;
        }

        this.sendGameAssignmentToLobbySubscriptions(socket, data.value.gameId);
        break;
      }
    } catch {
      // Reader cancellation is expected during unsubscribe.
    } finally {
      closeReader(assignmentsReader);
    }
  }

  /**
   * Streams assignment updates for one room entry.
   */
  private async streamRoomAssignmentsToSocket(
    socket: WebSocket,
    roomId: string,
    assignmentsReader: ReadableStreamDefaultReader<AssignmentStorageData>,
  ): Promise<void> {
    try {
      while (true) {
        const data = await assignmentsReader.read();
        if (data.done) {
          break;
        }

        this.sendGameAssignmentToRoomSubscriptions(
          socket,
          roomId,
          data.value.gameId,
        );
        break;
      }
    } catch {
      // Reader cancellation is expected during unsubscribe.
    } finally {
      closeReader(assignmentsReader);
    }
  }

  /**
   * Streams room updates for one room subscription.
   */
  private async streamRoomChangesToSocket(
    socket: WebSocket,
    roomId: string,
    roomChangesReader: ReadableStreamDefaultReader<
      RoomWatchEvent<Config, Loadout>
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

        const roomEntry: RoomEntry<Config, Loadout> = {
          roomId,
          numPlayers: data.value.room.numPlayers,
          players: data.value.room.members.map((member) => member.player),
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
   * Sends one full lobby snapshot to one subscription ID.
   */
  private sendLobbySnapshot(
    socket: WebSocket,
    subscriptionId: string,
    userData: LobbyUserData<Config, Loadout>,
  ): void {
    const lobbyProps: LobbyViewData<Config, Loadout> = {
      userActiveGames: userData.activeGames,
      roomEntries: userData.roomEntries,
      queueEntries: userData.queueEntries,
    };

    sendServerMessage<Config, Loadout, Rating, never, never, never>(socket, {
      type: "UpdateLobbyProps",
      subscriptionId,
      lobbyProps,
    });
  }

  /**
   * Sends the latest lobby snapshot to each active lobby subscription.
   */
  private sendLobbySnapshotToSubscriptions(
    socket: WebSocket,
    userData: LobbyUserData<Config, Loadout>,
  ): void {
    for (const subscriptionId of this.getLobbySubscriptionIds(socket)) {
      this.sendLobbySnapshot(socket, subscriptionId, userData);
    }
  }

  /**
   * Sends one room entry update to one subscription ID.
   */
  private sendRoomEntryUpdateToSubscription(
    socket: WebSocket,
    subscriptionId: string,
    roomEntry: RoomEntry<Config, Loadout>,
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
    roomEntry: RoomEntry<Config, Loadout>,
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
   * Sends one game assignment message to each active lobby subscription.
   */
  private sendGameAssignmentToLobbySubscriptions(
    socket: WebSocket,
    gameId: string,
  ): void {
    for (const subscriptionId of this.getLobbySubscriptionIds(socket)) {
      sendServerMessage<Config, Loadout, Rating, never, never, never>(socket, {
        type: "GameAssignment",
        subscriptionId,
        gameId,
      });
    }
  }

  /**
   * Sends one game assignment message to each active room subscription.
   */
  private sendGameAssignmentToRoomSubscriptions(
    socket: WebSocket,
    roomId: string,
    gameId: string,
  ): void {
    for (const subscriptionId of this.getRoomSubscriptionIds(socket, roomId)) {
      sendServerMessage<Config, Loadout, Rating, never, never, never>(socket, {
        type: "GameAssignment",
        subscriptionId,
        gameId,
      });
    }
  }

  /**
   * Returns all active lobby subscription IDs for a socket.
   */
  private getLobbySubscriptionIds(socket: WebSocket): string[] {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null || connectionState.lobby == null) {
      return [];
    }

    return [...connectionState.lobby.subscriptionIds];
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
    const allActiveGames = await this.db.getAllActiveGames();
    this.sendActivePublicGamesUpdate(socket, subscriptionId, allActiveGames);
  }

  /**
   * Sends one active public games update payload to one subscription.
   */
  private sendActivePublicGamesUpdate(
    socket: WebSocket,
    subscriptionId: string,
    allActiveGames: ActiveGame<Config>[],
  ): void {
    const activePublicGamesProps: ActivePublicGamesViewData<Config> = {
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
    activeGamesStream: ReadableStream<ActiveGame<Config>[]>,
  ): void {
    activeGamesStream.pipeTo(
      new WritableStream({
        write: (allActiveGames: ActiveGame<Config>[]) => {
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
   * Sends the latest available public rooms snapshot to one subscription.
   */
  private async sendAvailablePublicRoomsSnapshot(
    socket: WebSocket,
    subscriptionId: string,
  ): Promise<void> {
    const allAvailableRooms = await this.db.getAllAvailableRooms();
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
    allAvailableRooms: AvailableRoom<Config>[],
  ): void {
    const availablePublicRoomsProps: AvailablePublicRoomsViewData<Config> = {
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
    availableRoomsStream: ReadableStream<AvailableRoom<Config>[]>,
  ): void {
    availableRoomsStream.pipeTo(
      new WritableStream({
        write: (allAvailableRooms: AvailableRoom<Config>[]) => {
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
  ): RoomConnectionState<Config, Loadout> | undefined {
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
    if (connectionState == null || connectionState.lobby == null) {
      return;
    }

    const lobbyState = connectionState.lobby;
    const queueSubscription = lobbyState.queueSubscriptions.get(queueId);
    if (queueSubscription == null) {
      return;
    }

    closeReader(queueSubscription.assignmentsReader);

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

    lobbyState.queueSubscriptions.delete(queueId);
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

    closeReader(roomConnection.assignmentsReader);
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
      GameStorageData<Config, GameState, Outcome>
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
            never,
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
   * Returns the lobby connection state for a socket or throws when absent.
   */
  private getLobbyConnectionState(
    socket: WebSocket,
  ): LobbyConnectionState<Config, Loadout> {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null || connectionState.lobby == null) {
      throw new Error("Socket is not subscribed to lobby");
    }

    return connectionState.lobby;
  }

  /**
   * Returns a socket connection state, creating one when missing.
   */
  private getOrCreateSocketConnection(
    socket: WebSocket,
  ): SocketConnectionState<Config, Loadout> {
    const existing = this.sockets.get(socket);
    if (existing != null) {
      return existing;
    }

    const connectionState: SocketConnectionState<Config, Loadout> = {
      subscriptions: new Map(),
      roomConnections: new Map(),
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
    if (connectionState.lobby != null) {
      return;
    }

    this.sockets.delete(socket);
  }
}
