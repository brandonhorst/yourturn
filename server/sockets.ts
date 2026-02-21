import type {
  AssignmentStorageData,
  DB,
  GameStorageData,
  LobbyUserData,
  RoomWatchEvent,
} from "./db.ts";
import type {
  ActiveGame,
  AvailableRoom,
  LobbyViewData,
  Player,
  PlayerStateObject,
  PublicStateObject,
  RoomEntry,
} from "../types.ts";
import type { ServerMessage } from "../common/sockettypes.ts";
import { getPlayerState, getPublicState } from "./gamedata.ts";
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
  socket: WebSocket;
  playerId: number | undefined;
};

/**
 * Shared stream and subscriber state for a single game.
 */
type GameConnection<Config, GameState, PlayerState, PublicState, Outcome> = {
  gameSockets: Map<WebSocket, GameSocketSubscription>;
  changesReader: ReadableStreamDefaultReader<
    GameStorageData<Config, GameState, Outcome>
  >;
  playerStateLogic: (
    state: GameState,
    options: PlayerStateObject<Config>,
  ) => PlayerState;
  publicStateLogic: (
    state: GameState,
    options: PublicStateObject<Config>,
  ) => PublicState;
};

/**
 * Combined state for a websocket across lobby and game subscriptions.
 */
type SocketConnectionState<Config, Loadout, Rating> = {
  lobby?: LobbyConnectionState<Config, Loadout, Rating>;
  gameIds: Set<string>;
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
  private lobbySockets: Set<WebSocket> = new Set();
  private gameConnections: Map<
    string,
    GameConnection<Config, GameState, PlayerState, PublicState, Outcome>
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
    this.streamActiveGamesToLobbySockets(activeGamesStream);
    this.streamAvailableRoomsToLobbySockets(availableRoomsStream);
  }

  /**
   * Subscribes a websocket to lobby state and user updates.
   */
  async subscribeLobby(
    socket: WebSocket,
    userId: string,
    userData: LobbyUserData<Config, Loadout, Rating>,
  ): Promise<void> {
    const connectionState = this.getOrCreateSocketConnection(socket);

    if (connectionState.lobby == null) {
      const userChangesReader = this.db.watchForLobbyUserChanges(userId)
        .getReader();

      connectionState.lobby = {
        userId,
        userChangesReader,
        queueSubscriptions: new Map(),
        roomSubscriptions: new Map(),
      };
      this.lobbySockets.add(socket);
      void this.streamUserChangesToSocket(socket, userChangesReader);
    } else {
      connectionState.lobby.userId = userId;
    }

    await this.sendLobbySnapshot(socket, userData);
    await this.syncRoomSubscriptions(socket, userData.roomEntries);
  }

  /**
   * Unsubscribes a websocket from all lobby channels and matchmaking entries.
   */
  async unsubscribeLobby(socket: WebSocket): Promise<void> {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null || connectionState.lobby == null) {
      return;
    }

    const lobbyState = connectionState.lobby;

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
    connectionState.lobby = undefined;
    this.lobbySockets.delete(socket);
    this.pruneIdleSocket(socket);
  }

  /**
   * Unsubscribes a websocket from all lobby and game subscriptions.
   */
  async unsubscribeSocket(socket: WebSocket): Promise<void> {
    await this.unsubscribeLobby(socket);

    const connectionState = this.sockets.get(socket);
    if (connectionState == null) {
      return;
    }

    for (const gameId of [...connectionState.gameIds]) {
      this.unsubscribeGame(socket, gameId);
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
   * Subscribes a websocket to one game's update stream.
   */
  async subscribeGame(
    socket: WebSocket,
    gameId: string,
    playerStateLogic: (
      state: GameState,
      options: PlayerStateObject<Config>,
    ) => PlayerState,
    publicStateLogic: (
      state: GameState,
      options: PublicStateObject<Config>,
    ) => PublicState,
    playerId?: number,
  ): Promise<void> {
    const connectionState = this.getOrCreateSocketConnection(socket);

    if (!this.gameConnections.has(gameId)) {
      this.createGameConnection(gameId, playerStateLogic, publicStateLogic);
    }

    const gameConnection = this.gameConnections.get(gameId);
    if (gameConnection == null) {
      throw new Error(`Game connection ${gameId} not found`);
    }

    gameConnection.gameSockets.set(socket, {
      socket,
      playerId,
    });
    connectionState.gameIds.add(gameId);

    const gameData = await this.db.getGameStorageData(gameId);
    const nextPlayerState = playerId == null
      ? undefined
      : getPlayerState(gameData, playerStateLogic, playerId);
    const nextPublicState = getPublicState(gameData, publicStateLogic);

    sendServerMessage<
      never,
      never,
      never,
      PlayerState,
      PublicState,
      Outcome
    >(socket, {
      type: "UpdateGameState",
      playerState: nextPlayerState,
      publicState: nextPublicState,
      outcome: gameData.outcome,
    });
  }

  /**
   * Unsubscribes a websocket from one game's update stream.
   */
  unsubscribeGame(socket: WebSocket, gameId: string): void {
    const gameConnection = this.gameConnections.get(gameId);
    if (gameConnection == null) {
      return;
    }

    const wasRemoved = gameConnection.gameSockets.delete(socket);
    if (!wasRemoved) {
      return;
    }

    const connectionState = this.sockets.get(socket);
    if (connectionState != null) {
      connectionState.gameIds.delete(gameId);
    }

    if (gameConnection.gameSockets.size === 0) {
      closeReader(gameConnection.changesReader);
      this.gameConnections.delete(gameId);
    }

    this.pruneIdleSocket(socket);
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
        sendServerMessage<Config, Loadout, Rating, never, never, never>(
          socket,
          {
            type: "UpdateLobbyUserProps",
            userActiveGames: userData.activeGames,
            player: userData.player,
            ratings: userData.ratings,
            roomEntries: userData.roomEntries,
            queueEntries: userData.queueEntries,
            roomInvitations: userData.roomInvitations,
          },
        );

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

        sendServerMessage<Config, Loadout, Rating, never, never, never>(
          socket,
          {
            type: "GameAssignment",
            gameId: data.value.gameId,
          },
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
          sendServerMessage<Config, Loadout, Rating, never, never, never>(
            socket,
            {
              type: "RemoveRoomEntry",
              roomId,
            },
          );
          await this.cleanupRoomSubscription(socket, roomId, {
            removeFromDb: false,
            notifyClient: false,
          });
          break;
        }

        sendServerMessage<Config, Loadout, Rating, never, never, never>(
          socket,
          {
            type: "UpdateRoomEntry",
            roomEntry: {
              roomId,
              numPlayers: data.value.room.numPlayers,
              players: data.value.room.members.map((member) => member.player),
              config: data.value.room.config,
              loadout,
            },
          },
        );
      }
    } catch {
      // Reader cancellation is expected during unsubscribe.
    }
  }

  /**
   * Sends a full lobby snapshot to one websocket.
   */
  private async sendLobbySnapshot(
    socket: WebSocket,
    userData: LobbyUserData<Config, Loadout, Rating>,
  ): Promise<void> {
    const [allActiveGames, allAvailableRooms] = await Promise.all([
      this.db.getAllActiveGames(),
      this.db.getAllAvailableRooms(),
    ]);

    const lobbyProps: LobbyViewData<Config, Loadout, Rating> = {
      allActiveGames,
      allAvailableRooms,
      userActiveGames: userData.activeGames,
      player: userData.player,
      ratings: userData.ratings,
      roomEntries: userData.roomEntries,
      queueEntries: userData.queueEntries,
      roomInvitations: userData.roomInvitations,
    };

    sendServerMessage<Config, Loadout, Rating, never, never, never>(socket, {
      type: "UpdateLobbyProps",
      lobbyProps,
    });
  }

  /**
   * Broadcasts active game list updates to all lobby subscribers.
   */
  private streamActiveGamesToLobbySockets(
    activeGamesStream: ReadableStream<ActiveGame<Config>[]>,
  ): void {
    activeGamesStream.pipeTo(
      new WritableStream({
        write: (allActiveGames: ActiveGame<Config>[]) => {
          for (const socket of this.lobbySockets.values()) {
            sendServerMessage<Config, Loadout, Rating, never, never, never>(
              socket,
              {
                type: "UpdateActiveGames",
                allActiveGames,
              },
            );
          }
        },
      }),
    ).catch((err) => {
      console.error("Failed to broadcast active game updates", err);
    });
  }

  /**
   * Broadcasts available room list updates to all lobby subscribers.
   */
  private streamAvailableRoomsToLobbySockets(
    availableRoomsStream: ReadableStream<AvailableRoom<Config>[]>,
  ): void {
    availableRoomsStream.pipeTo(
      new WritableStream({
        write: (allAvailableRooms: AvailableRoom<Config>[]) => {
          for (const socket of this.lobbySockets.values()) {
            sendServerMessage<Config, Loadout, Rating, never, never, never>(
              socket,
              {
                type: "UpdateAvailableRooms",
                allAvailableRooms,
              },
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
        sendServerMessage<Config, Loadout, Rating, never, never, never>(
          socket,
          {
            type: "RemoveRoomEntry",
            roomId: options.roomId,
          },
        );
        return;
      }

      const member = room.members.find((roomMember) =>
        roomMember.userId === lobbyState.userId
      );
      if (member == null) {
        sendServerMessage<Config, Loadout, Rating, never, never, never>(
          socket,
          {
            type: "RemoveRoomEntry",
            roomId: options.roomId,
          },
        );
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
      sendServerMessage<Config, Loadout, Rating, never, never, never>(
        socket,
        {
          type: "UpdateRoomEntry",
          roomEntry: {
            roomId: options.roomId,
            numPlayers: roomSnapshot.numPlayers,
            players: roomSnapshot.members.map((member) => member.player),
            config: roomSnapshot.config,
            loadout: options.loadout,
          },
        },
      );
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
      sendServerMessage<Config, Loadout, Rating, never, never, never>(
        socket,
        {
          type: "RemoveRoomEntry",
          roomId,
        },
      );
    }
  }

  /**
   * Creates and registers one game connection stream.
   */
  private createGameConnection(
    gameId: string,
    playerStateLogic: (
      state: GameState,
      options: PlayerStateObject<Config>,
    ) => PlayerState,
    publicStateLogic: (
      state: GameState,
      options: PublicStateObject<Config>,
    ) => PublicState,
  ): void {
    const changesReader = this.db.watchForGameChanges(gameId).getReader();

    this.gameConnections.set(gameId, {
      gameSockets: new Map(),
      changesReader,
      playerStateLogic,
      publicStateLogic,
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
        const state = gameData.gameState;
        const numPlayers = gameData.userIds.length;
        const timestamp = new Date();

        const nextPublicState = gameConnection.publicStateLogic(state, {
          config: gameData.config,
          numPlayers,
          timestamp,
        });

        for (const gameSocket of gameConnection.gameSockets.values()) {
          const nextPlayerState = gameSocket.playerId == null
            ? undefined
            : gameConnection.playerStateLogic(state, {
              playerId: gameSocket.playerId,
              config: gameData.config,
              numPlayers,
              timestamp,
            });

          sendServerMessage<
            never,
            never,
            never,
            PlayerState,
            PublicState,
            Outcome
          >(
            gameSocket.socket,
            {
              type: "UpdateGameState",
              playerState: nextPlayerState,
              publicState: nextPublicState,
              outcome: gameData.outcome,
            },
          );
        }
      }
    } catch {
      // Reader cancellation is expected during unsubscribe.
    }
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
      gameIds: new Set(),
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
    if (connectionState.lobby != null) {
      return;
    }
    if (connectionState.gameIds.size > 0) {
      return;
    }

    this.sockets.delete(socket);
  }
}
