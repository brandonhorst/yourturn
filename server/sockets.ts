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
import { assert } from "@std/assert";

type MatchmakingEntry<Config, Loadout> =
  | {
    type: "queue";
    queueId: string;
    entryId: string;
    assignmentsReader: ReadableStreamDefaultReader<AssignmentStorageData>;
  }
  | {
    type: "room";
    roomId: string;
    entryId: string;
    loadout: Loadout;
    assignmentsReader: ReadableStreamDefaultReader<AssignmentStorageData>;
    roomChangesReader: ReadableStreamDefaultReader<
      RoomWatchEvent<Config, Loadout>
    >;
  };

/**
 * Socket wrapper used by the store to send both lobby and game messages.
 */
class Socket<Config, Loadout, Rating, PlayerState, PublicState, Outcome> {
  private lobbyProps?: LobbyViewData<Config, Loadout, Rating>;

  constructor(private socket: WebSocket) {}

  /**
   * Initializes lobby state for this socket.
   */
  setLobbyContext(initialLobbyProps: LobbyViewData<Config, Loadout, Rating>) {
    this.lobbyProps = initialLobbyProps;
  }

  /**
   * Clears all cached lobby state for this socket.
   */
  clearLobbyContext() {
    this.lobbyProps = undefined;
  }

  /**
   * Sends a raw string message over the underlying WebSocket.
   */
  private send(message: string): void {
    this.socket.send(message);
  }

  /**
   * Returns cached lobby props and asserts that lobby context exists.
   */
  private getLobbyProps(): LobbyViewData<Config, Loadout, Rating> {
    assert(this.lobbyProps != null);
    return this.lobbyProps;
  }

  /**
   * Sends a game assignment notification to the client.
   */
  sendGameAssignment(gameId: string): void {
    const message: ServerMessage<
      Config,
      Loadout,
      Rating,
      never,
      never,
      never
    > = {
      type: "GameAssignment",
      gameId,
    };
    this.send(JSON.stringify(message));
  }

  /**
   * Sends a display error message to the client.
   */
  sendDisplayError(errorMessage: string): void {
    const message: ServerMessage<
      Config,
      Loadout,
      Rating,
      never,
      never,
      never
    > = {
      type: "DisplayError",
      message: errorMessage,
    };
    this.send(JSON.stringify(message));
  }

  /**
   * Sends the current lobby props snapshot to the client.
   */
  sendLobbyProps(): void {
    const response: ServerMessage<
      Config,
      Loadout,
      Rating,
      never,
      never,
      never
    > = {
      type: "UpdateLobbyProps",
      lobbyProps: this.getLobbyProps(),
    };
    this.send(JSON.stringify(response));
  }

  /**
   * Updates one room entry in cached lobby props and notifies the client.
   */
  sendRoomEntryUpdate(roomEntry: RoomEntry<Config, Loadout>): void {
    const lobbyProps = this.getLobbyProps();
    const existingIndex = lobbyProps.roomEntries.findIndex((entry) =>
      entry.roomId === roomEntry.roomId
    );
    if (existingIndex === -1) {
      this.lobbyProps = {
        ...lobbyProps,
        roomEntries: [...lobbyProps.roomEntries, roomEntry],
      };
    } else {
      const roomEntries = [...lobbyProps.roomEntries];
      roomEntries[existingIndex] = roomEntry;
      this.lobbyProps = {
        ...lobbyProps,
        roomEntries,
      };
    }

    const message: ServerMessage<
      Config,
      Loadout,
      Rating,
      never,
      never,
      never
    > = {
      type: "UpdateRoomEntry",
      roomEntry,
    };
    this.send(JSON.stringify(message));
  }

  /**
   * Removes one room entry from cached lobby props and notifies the client.
   */
  sendRoomEntryRemoved(roomId: string): void {
    const lobbyProps = this.getLobbyProps();
    this.lobbyProps = {
      ...lobbyProps,
      roomEntries: lobbyProps.roomEntries.filter((entry) =>
        entry.roomId !== roomId
      ),
    };

    const message: ServerMessage<
      Config,
      Loadout,
      Rating,
      never,
      never,
      never
    > = {
      type: "RemoveRoomEntry",
      roomId,
    };
    this.send(JSON.stringify(message));
  }

  /**
   * Sends active game updates to the client.
   */
  sendActiveGames(allActiveGames: ActiveGame<Config>[]): void {
    const lobbyProps = this.getLobbyProps();
    this.lobbyProps = {
      ...lobbyProps,
      allActiveGames,
    };
    this.sendLobbyProps();
  }

  /**
   * Sends available room updates to the client.
   */
  sendAvailableRooms(allAvailableRooms: AvailableRoom<Config>[]): void {
    const lobbyProps = this.getLobbyProps();
    this.lobbyProps = {
      ...lobbyProps,
      allAvailableRooms,
    };
    this.sendLobbyProps();
  }

  /**
   * Sends user-specific lobby props.
   */
  sendUserProps(userData: LobbyUserData<Config, Loadout, Rating>): void {
    const lobbyProps = this.getLobbyProps();
    this.lobbyProps = {
      ...lobbyProps,
      userActiveGames: userData.activeGames,
      player: userData.player,
      ratings: userData.ratings,
      roomEntries: userData.roomEntries,
      queueEntries: userData.queueEntries,
      roomInvitations: userData.roomInvitations,
    };
    this.sendLobbyProps();
  }

  /**
   * Sends the current game state to the client.
   */
  sendGameState(
    playerState: PlayerState | undefined,
    publicState: PublicState,
    outcome: Outcome | undefined,
  ): void {
    const response: ServerMessage<
      never,
      never,
      never,
      PlayerState,
      PublicState,
      Outcome
    > = {
      type: "UpdateGameState",
      playerState,
      publicState,
      outcome,
    };
    this.send(JSON.stringify(response));
  }
}

/**
 * Lobby-specific connection state for one websocket.
 */
type LobbyConnectionState<Config, Loadout, Rating> = {
  userId: string;
  matchmakingEntries?: Readonly<MatchmakingEntry<Config, Loadout>>[];
  userChangesReader?: ReadableStreamDefaultReader<
    LobbyUserData<Config, Loadout, Rating>
  >;
};

/**
 * Game subscriber metadata for one websocket within a game channel.
 */
type GameSocketSubscription<
  Config,
  Loadout,
  Rating,
  PlayerState,
  PublicState,
  Outcome,
> = {
  socket: Socket<Config, Loadout, Rating, PlayerState, PublicState, Outcome>;
  playerId: number | undefined;
};

/**
 * Connection state for one game channel.
 */
type GameConnection<
  Config,
  GameState,
  Loadout,
  Rating,
  PlayerState,
  PublicState,
  Outcome,
> = {
  gameSockets: Map<
    WebSocket,
    GameSocketSubscription<
      Config,
      Loadout,
      Rating,
      PlayerState,
      PublicState,
      Outcome
    >
  >;
  changesReader: ReadableStreamDefaultReader<
    GameStorageData<Config, GameState, Outcome>
  >;
};

/**
 * Combined socket state for a websocket across lobby and game subscriptions.
 */
type SocketConnectionState<
  Config,
  GameState,
  Loadout,
  Rating,
  PlayerState,
  PublicState,
  Outcome,
> = {
  socket: Socket<Config, Loadout, Rating, PlayerState, PublicState, Outcome>;
  lobby?: LobbyConnectionState<Config, Loadout, Rating>;
  gameIds: Set<string>;
};

/**
 * Streams assignment updates to the lobby socket until the stream ends.
 */
async function streamAssignmentsToSocket<
  Config,
  Loadout,
  Rating,
  PlayerState,
  PublicState,
  Outcome,
>(
  stream: ReadableStreamDefaultReader<AssignmentStorageData>,
  socket: Socket<Config, Loadout, Rating, PlayerState, PublicState, Outcome>,
) {
  while (true) {
    const data = await stream.read();
    if (data.done) {
      break;
    }

    socket.sendGameAssignment(data.value.gameId);
  }
}

/**
 * Streams user changes to the lobby socket and sends user lobby props.
 */
async function streamUserChangesToSocket<
  Config,
  Loadout,
  Rating,
  PlayerState,
  PublicState,
  Outcome,
>(
  stream: ReadableStreamDefaultReader<
    LobbyUserData<Config, Loadout, Rating>
  >,
  socket: Socket<Config, Loadout, Rating, PlayerState, PublicState, Outcome>,
  onUserData: (
    userData: LobbyUserData<Config, Loadout, Rating>,
  ) => Promise<void>,
) {
  while (true) {
    const data = await stream.read();
    if (data.done) {
      break;
    }

    socket.sendUserProps(data.value);
    await onUserData(data.value);
  }
}

/**
 * Streams room changes to a lobby socket for one room subscription.
 */
async function streamRoomChangesToSocket<
  Config,
  Loadout,
  Rating,
  PlayerState,
  PublicState,
  Outcome,
>(
  roomId: string,
  loadout: Loadout,
  stream: ReadableStreamDefaultReader<RoomWatchEvent<Config, Loadout>>,
  socket: Socket<Config, Loadout, Rating, PlayerState, PublicState, Outcome>,
  onRoomClosed: () => Promise<void>,
) {
  while (true) {
    const data = await stream.read();
    if (data.done) {
      break;
    }

    if (data.value.type === "deleted") {
      socket.sendRoomEntryRemoved(roomId);
      await onRoomClosed();
      break;
    }

    socket.sendRoomEntryUpdate({
      roomId,
      numPlayers: data.value.room.numPlayers,
      players: data.value.room.members.map((member) => member.player),
      config: data.value.room.config,
      loadout,
    });
  }
}

/**
 * Streams game changes to all subscribed sockets for a game.
 */
async function streamGameChangesToSockets<
  Config,
  GameState,
  Loadout,
  Rating,
  PlayerState,
  PublicState,
  Outcome,
>(
  gameId: string,
  playerStateLogic: (
    state: GameState,
    options: PlayerStateObject<Config>,
  ) => PlayerState,
  publicStateLogic: (
    state: GameState,
    options: PublicStateObject<Config>,
  ) => PublicState,
  stream: ReadableStreamDefaultReader<
    GameStorageData<Config, GameState, Outcome>
  >,
  getConnection: (
    gameId: string,
  ) => GameConnection<
    Config,
    GameState,
    Loadout,
    Rating,
    PlayerState,
    PublicState,
    Outcome
  >,
) {
  while (true) {
    const data = await stream.read();
    if (data.done) {
      break;
    }

    const connection = getConnection(gameId);
    const state = data.value.gameState;
    const outcome = data.value.outcome;
    const timestamp = new Date();

    const publicState = publicStateLogic(state, {
      config: data.value.config,
      numPlayers: data.value.userIds.length,
      timestamp,
    });

    for (const gameSocket of connection.gameSockets.values()) {
      let playerState: PlayerState | undefined;

      if (gameSocket.playerId != null) {
        playerState = playerStateLogic(state, {
          playerId: gameSocket.playerId,
          config: data.value.config,
          numPlayers: data.value.userIds.length,
          timestamp,
        });
      }

      gameSocket.socket.sendGameState(playerState, publicState, outcome);
    }
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
    SocketConnectionState<
      Config,
      GameState,
      Loadout,
      Rating,
      PlayerState,
      PublicState,
      Outcome
    >
  > = new Map();
  private gameConnections: Map<
    string,
    GameConnection<
      Config,
      GameState,
      Loadout,
      Rating,
      PlayerState,
      PublicState,
      Outcome
    >
  > = new Map();
  private latestAllActiveGames?: ActiveGame<Config>[];
  private latestAllAvailableRooms?: AvailableRoom<Config>[];

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
    this.streamToAllSockets(activeGamesStream);
    this.streamRoomsToAllSockets(availableRoomsStream);
  }

  /**
   * Subscribes a websocket to lobby channels and user updates.
   */
  async subscribeLobby(
    socket: WebSocket,
    userId: string,
    user: LobbyUserData<Config, Loadout, Rating>,
  ): Promise<void> {
    const connectionState = this.getOrCreateSocketConnection(socket);

    if (connectionState.lobby == null) {
      const [allActiveGames, allAvailableRooms] = await Promise.all([
        this.getLatestAllActiveGames(),
        this.getLatestAllAvailableRooms(),
      ]);
      const userChangesReader = this.db.watchForLobbyUserChanges(userId)
        .getReader();
      connectionState.socket.setLobbyContext({
        allActiveGames,
        allAvailableRooms,
        userActiveGames: user.activeGames,
        player: user.player,
        ratings: user.ratings,
        roomEntries: user.roomEntries,
        queueEntries: user.queueEntries,
        roomInvitations: user.roomInvitations,
      });
      connectionState.lobby = {
        userId,
        userChangesReader,
      };
      connectionState.socket.sendLobbyProps();
      streamUserChangesToSocket(
        userChangesReader,
        connectionState.socket,
        async (userData) => {
          await this.syncRoomSubscriptions(socket, userData.roomEntries);
        },
      );
    } else {
      connectionState.lobby.userId = userId;
      connectionState.socket.sendUserProps(user);
    }

    await this.syncRoomSubscriptions(socket, user.roomEntries);
  }

  /**
   * Unsubscribes a websocket from lobby channels and cleans up lobby resources.
   */
  async unsubscribeLobby(socket: WebSocket): Promise<void> {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null || connectionState.lobby == null) {
      return;
    }

    const lobbyState = connectionState.lobby;
    const entries = [...(lobbyState.matchmakingEntries ?? [])];
    for (const entry of entries) {
      if (entry.type === "queue") {
        await this.cleanupQueueEntry(socket, entry, { removeFromDb: true });
      } else {
        await this.cleanupRoomEntry(socket, entry.roomId, {
          removeFromDb: true,
        });
      }
    }

    if (lobbyState.userChangesReader != null) {
      lobbyState.userChangesReader.cancel();
      lobbyState.userChangesReader.releaseLock();
    }

    connectionState.socket.clearLobbyContext();
    connectionState.lobby = undefined;
    this.pruneIdleSocket(socket);
  }

  /**
   * Adds a user to a queue and starts watching assignment updates.
   */
  async joinQueue(
    socket: WebSocket,
    queueId: string,
    userId: string,
    user: Player,
    loadout: Loadout,
  ): Promise<void> {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null || connectionState.lobby == null) {
      return;
    }

    const entryId = ulid();

    const assignmentsReader = this.db.watchForAssignments(entryId).getReader();
    streamAssignmentsToSocket(assignmentsReader, connectionState.socket);

    await this.db.addToQueue(queueId, entryId, userId, user, loadout);

    const existingEntries = connectionState.lobby.matchmakingEntries ?? [];
    connectionState.lobby.matchmakingEntries = [
      ...existingEntries,
      {
        type: "queue",
        queueId,
        entryId,
        assignmentsReader,
      },
    ];
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
    try {
      await this.db.createRoom(roomId, roomConfig);
      await this.joinRoom(
        socket,
        roomId,
        userId,
        user,
        loadout,
      );
    } catch (err) {
      const connectionState = this.sockets.get(socket);
      if (connectionState != null) {
        console.error("Failed to create and join room", err);
        connectionState.socket.sendDisplayError("Unable to create room.");
      }
    }
  }

  /**
   * Adds a user to a room and subscribes the websocket to room updates.
   */
  async joinRoom(
    socket: WebSocket,
    roomId: string,
    userId: string,
    user: Player,
    loadout: Loadout,
    options?: { consumeInvitation?: boolean },
  ): Promise<boolean> {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null || connectionState.lobby == null) {
      return false;
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
    } catch (err) {
      console.error("Failed to join room", err);
      return false;
    }

    await this.ensureRoomSubscription(socket, roomId, loadout, entryId);
    return true;
  }

  /**
   * Leaves one queue subscription for a websocket.
   */
  async leaveQueue(socket: WebSocket, queueId: string): Promise<void> {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null || connectionState.lobby == null) {
      return;
    }

    const entries = connectionState.lobby.matchmakingEntries ?? [];
    const queueEntry = entries.find((entry) =>
      entry.type === "queue" && entry.queueId === queueId
    );

    if (queueEntry == null || queueEntry.type !== "queue") {
      return;
    }

    await this.cleanupQueueEntry(socket, queueEntry, { removeFromDb: true });
  }

  /**
   * Leaves one room subscription for a websocket.
   */
  async leaveRoom(socket: WebSocket, roomId: string): Promise<void> {
    await this.cleanupRoomEntry(socket, roomId, { removeFromDb: true });
  }

  /**
   * Subscribes a websocket to a game's update channel.
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

    const gameConnection = this.getGameConnection(gameId);
    if (!gameConnection.gameSockets.has(socket)) {
      gameConnection.gameSockets.set(socket, {
        socket: connectionState.socket,
        playerId,
      });
      connectionState.gameIds.add(gameId);
    }

    const gameSocket = gameConnection.gameSockets.get(socket);
    assert(gameSocket != null);

    const gameData = await this.db.getGameStorageData(gameId);
    const newPlayerState = gameSocket.playerId == null
      ? undefined
      : getPlayerState(
        gameData,
        playerStateLogic,
        gameSocket.playerId,
      );
    const newPublicState = getPublicState(
      gameData,
      publicStateLogic,
    );

    gameSocket.socket.sendGameState(
      newPlayerState,
      newPublicState,
      gameData.outcome,
    );
  }

  /**
   * Unsubscribes a websocket from one game update channel.
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
      gameConnection.changesReader.cancel();
      gameConnection.changesReader.releaseLock();
      this.gameConnections.delete(gameId);
    }

    this.pruneIdleSocket(socket);
  }

  /**
   * Returns the latest active game list, falling back to a DB snapshot.
   */
  private async getLatestAllActiveGames(): Promise<ActiveGame<Config>[]> {
    if (this.latestAllActiveGames == null) {
      this.latestAllActiveGames = await this.db.getAllActiveGames();
    }
    return this.latestAllActiveGames;
  }

  /**
   * Returns the latest available room list, falling back to a DB snapshot.
   */
  private async getLatestAllAvailableRooms(): Promise<AvailableRoom<Config>[]> {
    if (this.latestAllAvailableRooms == null) {
      this.latestAllAvailableRooms = await this.db.getAllAvailableRooms();
    }
    return this.latestAllAvailableRooms;
  }

  /**
   * Broadcasts active game list updates to all sockets subscribed to lobby data.
   */
  private streamToAllSockets(
    activeGamesStream: ReadableStream<ActiveGame<Config>[]>,
  ): void {
    activeGamesStream.pipeTo(
      new WritableStream({
        write: (allActiveGames: ActiveGame<Config>[]) => {
          this.latestAllActiveGames = allActiveGames;
          for (const connectionState of this.sockets.values()) {
            if (connectionState.lobby == null) {
              continue;
            }
            connectionState.socket.sendActiveGames(allActiveGames);
          }
        },
      }),
    );
  }

  /**
   * Broadcasts available room list updates to all sockets subscribed to lobby data.
   */
  private streamRoomsToAllSockets(
    availableRoomsStream: ReadableStream<AvailableRoom<Config>[]>,
  ): void {
    availableRoomsStream.pipeTo(
      new WritableStream({
        write: (allAvailableRooms: AvailableRoom<Config>[]) => {
          this.latestAllAvailableRooms = allAvailableRooms;
          for (const connectionState of this.sockets.values()) {
            if (connectionState.lobby == null) {
              continue;
            }
            connectionState.socket.sendAvailableRooms(allAvailableRooms);
          }
        },
      }),
    );
  }

  /**
   * Reconciles room watchers with the latest room entries for this user.
   */
  private async syncRoomSubscriptions(
    socket: WebSocket,
    roomEntries: RoomEntry<Config, Loadout>[],
  ): Promise<void> {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null || connectionState.lobby == null) {
      return;
    }

    const activeRoomIds = new Set(roomEntries.map((entry) => entry.roomId));
    for (const roomEntry of roomEntries) {
      await this.ensureRoomSubscription(
        socket,
        roomEntry.roomId,
        roomEntry.loadout,
      );
    }

    const currentEntries = [
      ...(connectionState.lobby.matchmakingEntries ?? []),
    ];
    for (const entry of currentEntries) {
      if (entry.type !== "room") {
        continue;
      }
      if (activeRoomIds.has(entry.roomId)) {
        continue;
      }

      await this.cleanupRoomEntry(
        socket,
        entry.roomId,
        { removeFromDb: false },
      );
    }
  }

  /**
   * Ensures one room-specific subscription exists for the given websocket.
   */
  private async ensureRoomSubscription(
    socket: WebSocket,
    roomId: string,
    loadout: Loadout,
    knownEntryId?: string,
  ): Promise<void> {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null || connectionState.lobby == null) {
      return;
    }

    const entries = connectionState.lobby.matchmakingEntries ?? [];
    const existing = entries.find((entry) =>
      entry.type === "room" && entry.roomId === roomId
    );
    if (existing != null && existing.type === "room") {
      return;
    }

    let entryId = knownEntryId;
    let roomSnapshot = await this.db.getRoom(roomId);
    if (roomSnapshot == null) {
      connectionState.socket.sendRoomEntryRemoved(roomId);
      return;
    }

    if (entryId == null) {
      const member = roomSnapshot.members.find((member) =>
        member.userId === connectionState.lobby?.userId
      );
      if (member == null) {
        connectionState.socket.sendRoomEntryRemoved(roomId);
        return;
      }
      entryId = member.entryId;
    }

    const assignmentsReader = this.db.watchForAssignments(entryId).getReader();
    streamAssignmentsToSocket(assignmentsReader, connectionState.socket);

    const roomChangesReader = this.db.watchForRoomChanges(roomId).getReader();
    streamRoomChangesToSocket(
      roomId,
      loadout,
      roomChangesReader,
      connectionState.socket,
      async () => {
        await this.cleanupRoomEntry(
          socket,
          roomId,
          {
            removeFromDb: false,
            notifyClient: false,
          },
        );
      },
    );

    roomSnapshot = await this.db.getRoom(roomId);
    if (roomSnapshot != null) {
      connectionState.socket.sendRoomEntryUpdate({
        roomId,
        numPlayers: roomSnapshot.numPlayers,
        players: roomSnapshot.members.map((member) => member.player),
        config: roomSnapshot.config,
        loadout,
      });
    }

    connectionState.lobby.matchmakingEntries = [
      ...entries,
      {
        type: "room",
        roomId,
        entryId,
        loadout,
        assignmentsReader,
        roomChangesReader,
      },
    ];
  }

  /**
   * Cleans up one queue entry and optionally removes it from the database.
   */
  private async cleanupQueueEntry(
    socket: WebSocket,
    queueEntry: Extract<MatchmakingEntry<Config, Loadout>, { type: "queue" }>,
    options: { removeFromDb: boolean },
  ): Promise<void> {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null || connectionState.lobby == null) {
      return;
    }

    queueEntry.assignmentsReader.cancel();
    queueEntry.assignmentsReader.releaseLock();

    if (options.removeFromDb) {
      await this.db.removeFromQueue(queueEntry.queueId, queueEntry.entryId);
    }

    connectionState.lobby.matchmakingEntries = (connectionState.lobby
      .matchmakingEntries ?? []).filter((entry) => entry !== queueEntry);
  }

  /**
   * Cleans up one room entry and optionally removes room membership in the DB.
   */
  private async cleanupRoomEntry(
    socket: WebSocket,
    roomId: string,
    options: { removeFromDb: boolean; notifyClient?: boolean },
  ): Promise<void> {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null || connectionState.lobby == null) {
      return;
    }

    const entries = connectionState.lobby.matchmakingEntries ?? [];
    const roomEntry = entries.find((entry) =>
      entry.type === "room" && entry.roomId === roomId
    );
    if (roomEntry == null || roomEntry.type !== "room") {
      return;
    }

    roomEntry.assignmentsReader.cancel();
    roomEntry.assignmentsReader.releaseLock();
    roomEntry.roomChangesReader.cancel();
    roomEntry.roomChangesReader.releaseLock();

    if (options.removeFromDb) {
      await this.db.removeFromRoom(roomEntry.roomId, roomEntry.entryId);
    }

    connectionState.lobby.matchmakingEntries = entries.filter((entry) =>
      entry !== roomEntry
    );

    if (options.notifyClient ?? true) {
      connectionState.socket.sendRoomEntryRemoved(roomId);
    }
  }

  /**
   * Creates and registers a game connection stream for one game ID.
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
    streamGameChangesToSockets(
      gameId,
      playerStateLogic,
      publicStateLogic,
      changesReader,
      this.getGameConnection.bind(this),
    );

    const connection: GameConnection<
      Config,
      GameState,
      Loadout,
      Rating,
      PlayerState,
      PublicState,
      Outcome
    > = {
      gameSockets: new Map(),
      changesReader,
    };
    this.gameConnections.set(gameId, connection);
  }

  /**
   * Returns one game connection and asserts that it exists.
   */
  private getGameConnection(
    gameId: string,
  ): GameConnection<
    Config,
    GameState,
    Loadout,
    Rating,
    PlayerState,
    PublicState,
    Outcome
  > {
    const connection = this.gameConnections.get(gameId);
    assert(connection != null);
    return connection;
  }

  /**
   * Returns a socket connection state, creating one if needed.
   */
  private getOrCreateSocketConnection(
    socket: WebSocket,
  ): SocketConnectionState<
    Config,
    GameState,
    Loadout,
    Rating,
    PlayerState,
    PublicState,
    Outcome
  > {
    let connection = this.sockets.get(socket);
    if (connection != null) {
      return connection;
    }

    connection = {
      socket: new Socket<
        Config,
        Loadout,
        Rating,
        PlayerState,
        PublicState,
        Outcome
      >(socket),
      gameIds: new Set(),
    };
    this.sockets.set(socket, connection);
    return connection;
  }

  /**
   * Removes idle socket state when no lobby or game subscriptions remain.
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
