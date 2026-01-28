import type {
  AssignmentStorageData,
  DB,
  QueueConfig,
  RoomStorageData,
  UserStorageData,
} from "./db.ts";
import type { LobbyServerMessage } from "../common/sockettypes.ts";
import type {
  ActiveGame,
  AvailableRoom,
  LobbyProps,
  Player,
  QueueEntry,
  RoomEntry,
  SetupObject,
} from "../types.ts";
import { ulid } from "@std/ulid";
import { jsonEquals, type Socket } from "./socketutils.ts";

type MatchmakingEntry =
  | {
    type: "queue";
    queueId: string;
    entryId: string;
    assignmentsReader: ReadableStreamDefaultReader;
  }
  | {
    type: "room";
    roomId: string;
    entryId: string;
    assignmentsReader: ReadableStreamDefaultReader;
  };

/**
 * Represents a connected lobby socket with cached state for change detection.
 * Owns the underlying WebSocket and contains the "last" values used to detect
 * changes and avoid sending unnecessary updates.
 */
class LobbySocket<Config, Loadout> {
  private lastActiveGames: ActiveGame<Config>[] = [];
  private lastAvailableRooms: AvailableRoom<Config>[] = [];
  private lastUserActiveGames: ActiveGame<Config>[] = [];
  private lastPlayer: Player;
  private lastRoomEntries: RoomEntry<Config, Loadout>[] = [];
  private lastQueueEntries: QueueEntry<Loadout>[] = [];

  constructor(
    private socket: Socket,
    public readonly userId: string,
    initialPlayer: Player,
    initialActiveGames: ActiveGame<Config>[],
    initialRoomEntries: RoomEntry<Config, Loadout>[],
    initialQueueEntries: QueueEntry<Loadout>[],
  ) {
    this.lastPlayer = initialPlayer;
    this.lastUserActiveGames = initialActiveGames;
    this.lastRoomEntries = initialRoomEntries;
    this.lastQueueEntries = initialQueueEntries;
  }

  /**
   * Sends a message through the underlying socket.
   */
  private send(message: string): void {
    this.socket.send(message);
  }

  /**
   * Initializes the cached values without sending updates.
   * Used when a socket first connects to establish the baseline state.
   */
  initialize(
    allActiveGames: ActiveGame<Config>[],
    allAvailableRooms: AvailableRoom<Config>[],
  ): void {
    this.lastActiveGames = allActiveGames;
    this.lastAvailableRooms = allAvailableRooms;
  }

  /**
   * Sends a game assignment notification to the client.
   */
  sendGameAssignment(gameId: string): void {
    const message: LobbyServerMessage<Config, Loadout> = {
      type: "GameAssignment",
      gameId,
    };
    this.send(JSON.stringify(message));
  }

  /**
   * Sends a display error message to the client.
   */
  sendDisplayError(errorMessage: string): void {
    const message: LobbyServerMessage<Config, Loadout> = {
      type: "DisplayError",
      message: errorMessage,
    };
    this.send(JSON.stringify(message));
  }

  /**
   * Updates all active games if they have changed since the last update.
   */
  updateActiveGamesIfNecessary(allActiveGames: ActiveGame<Config>[]): void {
    if (jsonEquals(this.lastActiveGames, allActiveGames)) {
      return;
    }

    const response: LobbyServerMessage<Config, Loadout> = {
      type: "UpdateLobbyProps",
      lobbyProps: { allActiveGames },
    };
    this.lastActiveGames = allActiveGames;
    this.send(JSON.stringify(response));
  }

  /**
   * Updates available rooms if they have changed since the last update.
   */
  updateAvailableRoomsIfNecessary(
    allAvailableRooms: AvailableRoom<Config>[],
  ): void {
    if (jsonEquals(this.lastAvailableRooms, allAvailableRooms)) {
      return;
    }

    const response: LobbyServerMessage<Config, Loadout> = {
      type: "UpdateLobbyProps",
      lobbyProps: { allAvailableRooms },
    };
    this.lastAvailableRooms = allAvailableRooms;
    this.send(JSON.stringify(response));
  }

  /**
   * Updates user-specific lobby props when the stored user data changes.
   */
  updateUserPropsIfNecessary(userData: UserStorageData<Config, Loadout>): void {
    const lobbyProps: Partial<LobbyProps<Config, Loadout>> = {};
    let didUpdate = false;

    if (!jsonEquals(this.lastUserActiveGames, userData.activeGames)) {
      lobbyProps.userActiveGames = userData.activeGames;
      this.lastUserActiveGames = userData.activeGames;
      didUpdate = true;
    }

    if (!jsonEquals(this.lastPlayer, userData.player)) {
      lobbyProps.player = userData.player;
      this.lastPlayer = userData.player;
      didUpdate = true;
    }

    if (!jsonEquals(this.lastRoomEntries, userData.roomEntries)) {
      lobbyProps.roomEntries = userData.roomEntries;
      this.lastRoomEntries = userData.roomEntries;
      didUpdate = true;
    }

    if (!jsonEquals(this.lastQueueEntries, userData.queueEntries)) {
      lobbyProps.queueEntries = userData.queueEntries;
      this.lastQueueEntries = userData.queueEntries;
      didUpdate = true;
    }

    if (!didUpdate) {
      return;
    }

    const response: LobbyServerMessage<Config, Loadout> = {
      type: "UpdateLobbyProps",
      lobbyProps,
    };
    this.send(JSON.stringify(response));
  }
}

/**
 * Connection state for a lobby socket.
 * Contains the LobbySocket instance and the readers managed by the store.
 */
type ConnectionState<Config, Loadout> = {
  lobbySocket: LobbySocket<Config, Loadout>;
  matchmakingEntries?: Readonly<MatchmakingEntry>[];
  userChangesReader?: ReadableStreamDefaultReader;
};

/**
 * Streams assignment updates to the lobby socket until the stream ends.
 */
async function streamAssignmentsToSocket<Config, Loadout>(
  stream: ReadableStreamDefaultReader<AssignmentStorageData>,
  lobbySocket: LobbySocket<Config, Loadout>,
) {
  while (true) {
    const data = await stream.read();
    if (data.done) {
      break;
    }

    lobbySocket.sendGameAssignment(data.value.gameId);
  }
}

/**
 * Streams user changes to the lobby socket and updates lobby props when needed.
 */
async function streamUserChangesToSocket<Config, Loadout>(
  stream: ReadableStreamDefaultReader<UserStorageData<Config, Loadout>>,
  lobbySocket: LobbySocket<Config, Loadout>,
) {
  while (true) {
    const data = await stream.read();
    if (data.done) {
      break;
    }

    lobbySocket.updateUserPropsIfNecessary(data.value);
  }
}

export class LobbySocketStore<Config, GameState, Loadout, Outcome> {
  private sockets: Map<Socket, ConnectionState<Config, Loadout>> = new Map();

  constructor(
    private db: DB<Config, GameState, Loadout, Outcome>,
    activeGamesStream: ReadableStream<ActiveGame<Config>[]>,
    availableRoomsStream: ReadableStream<AvailableRoom<Config>[]>,
  ) {
    this.streamToAllSockets(activeGamesStream);
    this.streamRoomsToAllSockets(availableRoomsStream);
  }

  /**
   * Registers a socket and starts watching for user changes.
   */
  register(
    socket: Socket,
    userId: string,
    user: UserStorageData<Config, Loadout>,
  ) {
    const userChangesReader = this.db.watchForUserChanges(userId).getReader();
    const lobbySocket = new LobbySocket(
      socket,
      userId,
      user.player,
      user.activeGames,
      user.roomEntries,
      user.queueEntries,
    );
    const connectionState: ConnectionState<Config, Loadout> = {
      lobbySocket,
      userChangesReader,
    };
    this.sockets.set(socket, connectionState);
    streamUserChangesToSocket(userChangesReader, lobbySocket);
  }

  initialize(
    socket: Socket,
    allActiveGames: ActiveGame<Config>[],
    allAvailableRooms: AvailableRoom<Config>[],
  ) {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null) {
      return;
    }

    connectionState.lobbySocket.initialize(allActiveGames, allAvailableRooms);
  }

  async unregister(socket: Socket) {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null) {
      return;
    }

    // Clean up all matchmaking entries
    const entries = connectionState.matchmakingEntries ?? [];
    for (const entry of entries) {
      entry.assignmentsReader.cancel();
      entry.assignmentsReader.releaseLock();

      if (entry.type === "queue") {
        await this.db.removeFromQueue(entry.queueId, entry.entryId);
      } else {
        await this.db.removeFromRoom(entry.roomId, entry.entryId);
      }
    }

    if (connectionState.userChangesReader != null) {
      connectionState.userChangesReader.cancel();
      connectionState.userChangesReader.releaseLock();
    }
    this.sockets.delete(socket);
  }

  /**
   * Subscribe to the activeGamesStream and send to all registered sockets.
   */
  private streamToAllSockets(
    activeGamesStream: ReadableStream<ActiveGame<Config>[]>,
  ) {
    activeGamesStream.pipeTo(
      new WritableStream({
        write: (allActiveGames: ActiveGame<Config>[]) => {
          for (const connectionState of this.sockets.values()) {
            connectionState.lobbySocket.updateActiveGamesIfNecessary(
              allActiveGames,
            );
          }
        },
      }),
    );
  }

  private streamRoomsToAllSockets(
    availableRoomsStream: ReadableStream<AvailableRoom<Config>[]>,
  ) {
    availableRoomsStream.pipeTo(
      new WritableStream({
        write: (allAvailableRooms: AvailableRoom<Config>[]) => {
          for (const connectionState of this.sockets.values()) {
            connectionState.lobbySocket.updateAvailableRoomsIfNecessary(
              allAvailableRooms,
            );
          }
        },
      }),
    );
  }

  /**
   * Creates a new queue entry, assigns it to the given queue in the database,
   * and stores the socket. Watches for assignments, and when an assignment is
   * made, sends it to the socket.
   */
  public async joinQueue(
    socket: Socket,
    queueConfig: QueueConfig<Config>,
    userId: string,
    user: Player,
    loadout: Loadout,
    setupGame: (o: SetupObject<Config, Loadout>) => GameState,
  ) {
    const connectionState = this.sockets.get(socket);
    if (!connectionState) {
      return;
    }

    const entryId = ulid();

    const assignmentsReader = this.db.watchForAssignments(entryId).getReader();
    streamAssignmentsToSocket(assignmentsReader, connectionState.lobbySocket);

    await this.db.addToQueue(
      queueConfig,
      entryId,
      userId,
      user,
      loadout,
      setupGame,
    );

    // Track this entry so we can clean it up if needed
    const existingEntries = connectionState.matchmakingEntries ?? [];
    connectionState.matchmakingEntries = [
      ...existingEntries,
      {
        type: "queue",
        queueId: queueConfig.queueId,
        entryId,
        assignmentsReader,
      },
    ];
  }

  public async createAndJoinRoom(
    socket: Socket,
    roomConfig: { numPlayers: number; config: Config; private: boolean },
    userId: string,
    user: Player,
    loadout: Loadout,
  ) {
    const roomId = ulid();
    try {
      await this.db.createRoom(roomId, roomConfig);
      await this.joinRoom(
        socket,
        roomId,
        { config: roomConfig.config },
        userId,
        user,
        loadout,
      );
    } catch (err) {
      const connectionState = this.sockets.get(socket);
      if (connectionState) {
        console.error("Failed to create and join room", err);
        connectionState.lobbySocket.sendDisplayError("Unable to create room.");
      }
    }
  }

  public async joinRoom(
    socket: Socket,
    roomId: string,
    _roomConfig: Pick<RoomStorageData<Config, Loadout>, "config">,
    userId: string,
    user: Player,
    loadout: Loadout,
  ): Promise<boolean> {
    const connectionState = this.sockets.get(socket);
    if (!connectionState) {
      return false;
    }

    const entryId = ulid();

    const assignmentsReader = this.db.watchForAssignments(entryId).getReader();
    streamAssignmentsToSocket(assignmentsReader, connectionState.lobbySocket);

    try {
      await this.db.addToRoom(
        roomId,
        entryId,
        userId,
        user,
        loadout,
      );
    } catch (err) {
      console.error("Failed to join room", err);
      assignmentsReader.cancel();
      assignmentsReader.releaseLock();
      return false;
    }

    // Track this entry so we can clean it up if needed
    const existingEntries = connectionState.matchmakingEntries ?? [];
    connectionState.matchmakingEntries = [
      ...existingEntries,
      {
        type: "room",
        roomId,
        entryId,
        assignmentsReader,
      },
    ];

    return true;
  }

  /**
   * Leaves a specific queue.
   */
  async leaveQueue(socket: Socket, queueId: string) {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null) {
      return;
    }

    const entries = connectionState.matchmakingEntries ?? [];
    const queueEntry = entries.find(
      (e) => e.type === "queue" && e.queueId === queueId,
    );

    if (queueEntry == null || queueEntry.type !== "queue") {
      return;
    }

    queueEntry.assignmentsReader.cancel();
    queueEntry.assignmentsReader.releaseLock();

    await this.db.removeFromQueue(
      queueEntry.queueId,
      queueEntry.entryId,
    );

    // Remove this entry from the list
    connectionState.matchmakingEntries = entries.filter((e) =>
      e !== queueEntry
    );
  }

  /**
   * Leaves a specific room.
   */
  async leaveRoom(socket: Socket, roomId: string) {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null) {
      return;
    }

    const entries = connectionState.matchmakingEntries ?? [];
    const roomEntry = entries.find(
      (e) => e.type === "room" && e.roomId === roomId,
    );

    if (roomEntry == null || roomEntry.type !== "room") {
      return;
    }

    roomEntry.assignmentsReader.cancel();
    roomEntry.assignmentsReader.releaseLock();

    await this.db.removeFromRoom(
      roomEntry.roomId,
      roomEntry.entryId,
    );

    // Remove this entry from the list
    connectionState.matchmakingEntries = entries.filter((e) => e !== roomEntry);
  }
}
