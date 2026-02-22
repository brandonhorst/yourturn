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

type RoomSubscription<Config, Loadout> = {
  roomId: string;
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
type LobbyConnectionState<Config, Loadout, Rating> = {
  userId: string;
  subscriptionIds: Set<string>;
  userChangesReader: ReadableStreamDefaultReader<
    LobbyUserData<Config, Loadout, Rating>
  >;
  queueSubscriptions: Map<string, QueueSubscription>;
  roomSubscriptions: Map<string, RoomSubscription<Config, Loadout>>;
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
  | { type: "ActivePublicGames" }
  | { type: "AvailablePublicRooms" }
  | { type: "Game"; gameId: string };

/**
 * Combined state for a websocket across lobby and game subscriptions.
 */
type SocketConnectionState<Config, Loadout, Rating> = {
  subscriptions: Map<string, SocketSubscription>;
  lobby?: LobbyConnectionState<Config, Loadout, Rating>;
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
    userData: LobbyUserData<Config, Loadout, Rating>,
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
      await this.syncRoomSubscriptions(socket, userData.roomEntries);
      return;
    }

    await this.unsubscribe(socket, subscriptionId);

    const connectionState = this.getOrCreateSocketConnection(socket);

    if (connectionState.lobby == null) {
      const userChangesReader = this.db.watchForLobbyUserChanges(userId)
        .getReader();

      connectionState.lobby = {
        userId,
        subscriptionIds: new Set(),
        userChangesReader,
        queueSubscriptions: new Map(),
        roomSubscriptions: new Map(),
      };
      void this.streamUserChangesToSocket(socket, userChangesReader);
    } else {
      connectionState.lobby.userId = userId;
    }

    const lobbyState = connectionState.lobby;
    if (lobbyState == null) {
      throw new Error("Lobby connection state was not initialized");
    }

    lobbyState.subscriptionIds.add(subscriptionId);
    connectionState.subscriptions.set(subscriptionId, { type: "Lobby" });

    this.sendLobbySnapshot(socket, subscriptionId, userData);
    await this.syncRoomSubscriptions(socket, userData.roomEntries);
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

    void this.streamAssignmentsToSocket(socket, assignmentsReader);
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
   * Adds a user to a room and starts assignment and room-change streams.
   */
  async joinRoom(
    socket: WebSocket,
    roomId: string,
    userId: string,
    user: Player,
    loadout: Loadout,
    options?: { consumeInvitation?: boolean },
  ): Promise<boolean> {
    const lobbyState = this.getLobbyConnectionState(socket);

    if (lobbyState.roomSubscriptions.has(roomId)) {
      return true;
    }

    const entryId = ulid();

    try {
      await this.db.addToRoom(
        roomId,
        entryId,
        userId,
        user,
        loadout,
        options,
      );
    } catch {
      return false;
    }

    await this.startRoomSubscription(socket, {
      roomId,
      loadout,
      entryId,
    });

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
   * Leaves one room and stops its assignment and room-change streams.
   */
  async leaveRoom(socket: WebSocket, roomId: string): Promise<void> {
    await this.cleanupRoomSubscription(socket, roomId, {
      removeFromDb: true,
      notifyClient: true,
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
   * Cleans up shared lobby resources after the last lobby subscription is gone.
   */
  private async cleanupLobbyConnection(
    socket: WebSocket,
    lobbyState: LobbyConnectionState<Config, Loadout, Rating>,
  ): Promise<void> {
    for (const queueId of [...lobbyState.queueSubscriptions.keys()]) {
      await this.cleanupQueueSubscription(socket, queueId, {
        removeFromDb: true,
      });
    }

    for (const roomId of [...lobbyState.roomSubscriptions.keys()]) {
      await this.cleanupRoomSubscription(socket, roomId, {
        removeFromDb: true,
        notifyClient: false,
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
      LobbyUserData<Config, Loadout, Rating>
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

        await this.syncRoomSubscriptions(socket, userData.roomEntries);
      }
    } catch {
      // Reader cancellation is expected during unsubscribe.
    }
  }

  /**
   * Streams assignment updates for one queue or room entry.
   */
  private async streamAssignmentsToSocket(
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
   * Streams room updates for one room subscription.
   */
  private async streamRoomChangesToSocket(
    socket: WebSocket,
    roomId: string,
    loadout: Loadout,
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
          this.sendRoomEntryRemovalToLobbySubscriptions(socket, roomId);
          await this.cleanupRoomSubscription(socket, roomId, {
            removeFromDb: false,
            notifyClient: false,
          });
          break;
        }

        const roomEntry: RoomEntry<Config, Loadout> = {
          roomId,
          numPlayers: data.value.room.numPlayers,
          players: data.value.room.members.map((member) => member.player),
          config: data.value.room.config,
          loadout,
        };

        this.sendRoomEntryUpdateToLobbySubscriptions(socket, roomEntry);
      }
    } catch {
      // Reader cancellation is expected during unsubscribe.
    }
  }

  /**
   * Sends one full lobby snapshot to one subscription ID.
   */
  private sendLobbySnapshot(
    socket: WebSocket,
    subscriptionId: string,
    userData: LobbyUserData<Config, Loadout, Rating>,
  ): void {
    const lobbyProps: LobbyViewData<Config, Loadout, Rating> = {
      userActiveGames: userData.activeGames,
      player: userData.player,
      ratings: userData.ratings,
      roomEntries: userData.roomEntries,
      queueEntries: userData.queueEntries,
      roomInvitations: userData.roomInvitations,
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
    userData: LobbyUserData<Config, Loadout, Rating>,
  ): void {
    for (const subscriptionId of this.getLobbySubscriptionIds(socket)) {
      this.sendLobbySnapshot(socket, subscriptionId, userData);
    }
  }

  /**
   * Sends one room entry update to each active lobby subscription.
   */
  private sendRoomEntryUpdateToLobbySubscriptions(
    socket: WebSocket,
    roomEntry: RoomEntry<Config, Loadout>,
  ): void {
    for (const subscriptionId of this.getLobbySubscriptionIds(socket)) {
      sendServerMessage<Config, Loadout, Rating, never, never, never>(socket, {
        type: "UpdateRoomEntry",
        subscriptionId,
        roomEntry,
      });
    }
  }

  /**
   * Sends one room entry removal to each active lobby subscription.
   */
  private sendRoomEntryRemovalToLobbySubscriptions(
    socket: WebSocket,
    roomId: string,
  ): void {
    for (const subscriptionId of this.getLobbySubscriptionIds(socket)) {
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
   * Reconciles room streams against the latest joined rooms for a websocket.
   */
  private async syncRoomSubscriptions(
    socket: WebSocket,
    roomEntries: RoomEntry<Config, Loadout>[],
  ): Promise<void> {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null || connectionState.lobby == null) {
      return;
    }

    const lobbyState = connectionState.lobby;
    const roomEntryById = new Map(
      roomEntries.map((roomEntry) => [roomEntry.roomId, roomEntry]),
    );

    for (const [roomId, roomEntry] of roomEntryById.entries()) {
      if (lobbyState.roomSubscriptions.has(roomId)) {
        continue;
      }

      await this.startRoomSubscription(socket, {
        roomId,
        loadout: roomEntry.loadout,
      });
    }

    for (const roomId of [...lobbyState.roomSubscriptions.keys()]) {
      if (roomEntryById.has(roomId)) {
        continue;
      }

      await this.cleanupRoomSubscription(socket, roomId, {
        removeFromDb: false,
        notifyClient: true,
      });
    }
  }

  /**
   * Starts assignment and room-change streams for a single room.
   */
  private async startRoomSubscription(
    socket: WebSocket,
    options: { roomId: string; loadout: Loadout; entryId?: string },
  ): Promise<void> {
    const lobbyState = this.getLobbyConnectionState(socket);

    if (lobbyState.roomSubscriptions.has(options.roomId)) {
      return;
    }

    let entryId = options.entryId;

    if (entryId == null) {
      const room = await this.db.getRoom(options.roomId);
      if (room == null) {
        this.sendRoomEntryRemovalToLobbySubscriptions(socket, options.roomId);
        return;
      }

      const member = room.members.find((roomMember) =>
        roomMember.userId === lobbyState.userId
      );
      if (member == null) {
        this.sendRoomEntryRemovalToLobbySubscriptions(socket, options.roomId);
        return;
      }

      entryId = member.entryId;
    }

    const assignmentsReader = this.db.watchForAssignments(entryId).getReader();
    const roomChangesReader = this.db.watchForRoomChanges(options.roomId)
      .getReader();

    lobbyState.roomSubscriptions.set(options.roomId, {
      roomId: options.roomId,
      entryId,
      loadout: options.loadout,
      assignmentsReader,
      roomChangesReader,
    });

    void this.streamAssignmentsToSocket(socket, assignmentsReader);
    void this.streamRoomChangesToSocket(
      socket,
      options.roomId,
      options.loadout,
      roomChangesReader,
    );

    const roomSnapshot = await this.db.getRoom(options.roomId);
    if (roomSnapshot != null) {
      const roomEntry: RoomEntry<Config, Loadout> = {
        roomId: options.roomId,
        numPlayers: roomSnapshot.numPlayers,
        players: roomSnapshot.members.map((member) => member.player),
        config: roomSnapshot.config,
        loadout: options.loadout,
      };
      this.sendRoomEntryUpdateToLobbySubscriptions(socket, roomEntry);
    }
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
   * Cleans up one room subscription and optionally removes room membership.
   */
  private async cleanupRoomSubscription(
    socket: WebSocket,
    roomId: string,
    options: { removeFromDb: boolean; notifyClient: boolean },
  ): Promise<void> {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null || connectionState.lobby == null) {
      return;
    }

    const lobbyState = connectionState.lobby;
    const roomSubscription = lobbyState.roomSubscriptions.get(roomId);
    if (roomSubscription == null) {
      return;
    }

    closeReader(roomSubscription.assignmentsReader);
    closeReader(roomSubscription.roomChangesReader);

    if (options.removeFromDb) {
      try {
        await this.db.removeFromRoom(
          roomSubscription.roomId,
          roomSubscription.entryId,
        );
      } catch (err) {
        console.error("Failed to remove room subscription", err);
      }
    }

    lobbyState.roomSubscriptions.delete(roomId);

    if (options.notifyClient) {
      this.sendRoomEntryRemovalToLobbySubscriptions(socket, roomId);
    }
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
  ): LobbyConnectionState<Config, Loadout, Rating> {
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
  ): SocketConnectionState<Config, Loadout, Rating> {
    const existing = this.sockets.get(socket);
    if (existing != null) {
      return existing;
    }

    const connectionState: SocketConnectionState<Config, Loadout, Rating> = {
      subscriptions: new Map(),
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
    if (connectionState.lobby != null) {
      return;
    }

    this.sockets.delete(socket);
  }
}
