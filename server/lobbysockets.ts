import type {
  AssignmentStorageData,
  DB,
  LobbyUserData,
  RoomWatchEvent,
} from "./db.ts";
import type { LobbyServerMessage } from "../common/sockettypes.ts";
import type {
  ActiveGame,
  AvailableRoom,
  LobbyViewData,
  Player,
  QueueEntry,
  RoomEntry,
  RoomInvitation,
} from "../types.ts";
import { ulid } from "@std/ulid";
import { jsonEquals, type Socket } from "./socketutils.ts";

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
 * Represents a connected lobby socket with cached state for change detection.
 * Owns the underlying WebSocket and contains the "last" values used to detect
 * changes and avoid sending unnecessary updates.
 */
class LobbySocket<Config, Loadout, Rating> {
  private lastActiveGames: ActiveGame<Config>[] = [];
  private lastAvailableRooms: AvailableRoom<Config>[] = [];
  private lastUserActiveGames: ActiveGame<Config>[] = [];
  private lastPlayer: Player;
  private lastRatings: Record<string, Rating> = {};
  private lastQueueEntries: QueueEntry<Loadout>[] = [];
  private lastRoomInvitations: RoomInvitation<Config>[] = [];

  constructor(
    private socket: Socket,
    public readonly userId: string,
    initialPlayer: Player,
    initialRatings: Record<string, Rating>,
    initialActiveGames: ActiveGame<Config>[],
    initialQueueEntries: QueueEntry<Loadout>[],
    initialRoomInvitations: RoomInvitation<Config>[],
  ) {
    this.lastPlayer = initialPlayer;
    this.lastRatings = initialRatings;
    this.lastUserActiveGames = initialActiveGames;
    this.lastQueueEntries = initialQueueEntries;
    this.lastRoomInvitations = initialRoomInvitations;
  }

  /**
   * Sends a message through the underlying socket.
   */
  private send(message: string): void {
    this.socket.send(message);
  }

  /**
   * Sets the cached values from the client's current lobby snapshot.
   * This establishes a baseline before the socket subscribes to updates.
   */
  setSubscriptionBaseline(
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
    const message: LobbyServerMessage<Config, Loadout, Rating> = {
      type: "GameAssignment",
      gameId,
    };
    this.send(JSON.stringify(message));
  }

  /**
   * Sends a display error message to the client.
   */
  sendDisplayError(errorMessage: string): void {
    const message: LobbyServerMessage<Config, Loadout, Rating> = {
      type: "DisplayError",
      message: errorMessage,
    };
    this.send(JSON.stringify(message));
  }

  /**
   * Sends an upsert-style room update for a room the user is subscribed to.
   */
  sendRoomEntryUpdate(roomEntry: RoomEntry<Config, Loadout>): void {
    const message: LobbyServerMessage<Config, Loadout, Rating> = {
      type: "UpdateRoomEntry",
      roomEntry,
    };
    this.send(JSON.stringify(message));
  }

  /**
   * Sends a room removal notification for a room the user left or that closed.
   */
  sendRoomEntryRemoved(roomId: string): void {
    const message: LobbyServerMessage<Config, Loadout, Rating> = {
      type: "RemoveRoomEntry",
      roomId,
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

    const response: LobbyServerMessage<Config, Loadout, Rating> = {
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

    const response: LobbyServerMessage<Config, Loadout, Rating> = {
      type: "UpdateLobbyProps",
      lobbyProps: { allAvailableRooms },
    };
    this.lastAvailableRooms = allAvailableRooms;
    this.send(JSON.stringify(response));
  }

  /**
   * Updates user-specific lobby props when the stored user data changes.
   */
  updateUserPropsIfNecessary(
    userData: LobbyUserData<Config, Loadout, Rating>,
  ): void {
    const lobbyProps: Partial<LobbyViewData<Config, Loadout, Rating>> = {};
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

    if (!jsonEquals(this.lastRatings, userData.ratings)) {
      lobbyProps.ratings = userData.ratings;
      this.lastRatings = userData.ratings;
      didUpdate = true;
    }

    if (!jsonEquals(this.lastQueueEntries, userData.queueEntries)) {
      lobbyProps.queueEntries = userData.queueEntries;
      this.lastQueueEntries = userData.queueEntries;
      didUpdate = true;
    }

    if (!jsonEquals(this.lastRoomInvitations, userData.roomInvitations)) {
      lobbyProps.roomInvitations = userData.roomInvitations;
      this.lastRoomInvitations = userData.roomInvitations;
      didUpdate = true;
    }

    if (!didUpdate) {
      return;
    }

    const response: LobbyServerMessage<Config, Loadout, Rating> = {
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
type ConnectionState<Config, Loadout, Rating> = {
  lobbySocket: LobbySocket<Config, Loadout, Rating>;
  matchmakingEntries?: Readonly<MatchmakingEntry<Config, Loadout>>[];
  userChangesReader?: ReadableStreamDefaultReader<
    LobbyUserData<Config, Loadout, Rating>
  >;
};

/**
 * Streams assignment updates to the lobby socket until the stream ends.
 */
async function streamAssignmentsToSocket<Config, Loadout, Rating>(
  stream: ReadableStreamDefaultReader<AssignmentStorageData>,
  lobbySocket: LobbySocket<Config, Loadout, Rating>,
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
async function streamUserChangesToSocket<Config, Loadout, Rating>(
  stream: ReadableStreamDefaultReader<
    LobbyUserData<Config, Loadout, Rating>
  >,
  lobbySocket: LobbySocket<Config, Loadout, Rating>,
  onUserData: (
    userData: LobbyUserData<Config, Loadout, Rating>,
  ) => Promise<void>,
) {
  while (true) {
    const data = await stream.read();
    if (data.done) {
      break;
    }

    lobbySocket.updateUserPropsIfNecessary(data.value);
    await onUserData(data.value);
  }
}

/**
 * Streams room changes to a lobby socket for one room subscription.
 */
async function streamRoomChangesToSocket<Config, Loadout, Rating>(
  roomId: string,
  loadout: Loadout,
  stream: ReadableStreamDefaultReader<RoomWatchEvent<Config, Loadout>>,
  lobbySocket: LobbySocket<Config, Loadout, Rating>,
  onRoomClosed: () => Promise<void>,
) {
  while (true) {
    const data = await stream.read();
    if (data.done) {
      break;
    }

    if (data.value.type === "deleted") {
      lobbySocket.sendRoomEntryRemoved(roomId);
      await onRoomClosed();
      break;
    }

    lobbySocket.sendRoomEntryUpdate({
      roomId,
      numPlayers: data.value.room.numPlayers,
      players: data.value.room.members.map((member) => member.player),
      config: data.value.room.config,
      loadout,
    });
  }
}

export class LobbySocketStore<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Rating,
  Loadout,
> {
  private sockets: Map<Socket, ConnectionState<Config, Loadout, Rating>> =
    new Map();

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
   * Subscribes a socket to lobby channels and starts watching for user changes.
   */
  async subscribe(
    socket: Socket,
    userId: string,
    user: LobbyUserData<Config, Loadout, Rating>,
    allActiveGames: ActiveGame<Config>[],
    allAvailableRooms: AvailableRoom<Config>[],
  ): Promise<void> {
    let connectionState = this.sockets.get(socket);
    if (connectionState == null) {
      const userChangesReader = this.db.watchForLobbyUserChanges(userId)
        .getReader();
      const lobbySocket = new LobbySocket<Config, Loadout, Rating>(
        socket,
        userId,
        user.player,
        user.ratings,
        user.activeGames,
        user.queueEntries,
        user.roomInvitations,
      );
      connectionState = {
        lobbySocket,
        userChangesReader,
      };
      this.sockets.set(socket, connectionState);
      streamUserChangesToSocket(
        userChangesReader,
        lobbySocket,
        async (userData) => {
          await this.syncRoomSubscriptions(socket, userData.roomEntries);
        },
      );
    }

    connectionState.lobbySocket.setSubscriptionBaseline(
      allActiveGames,
      allAvailableRooms,
    );

    await this.syncRoomSubscriptions(socket, user.roomEntries);
  }

  async unsubscribe(socket: Socket) {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null) {
      return;
    }

    // Clean up all matchmaking entries
    const entries = [...(connectionState.matchmakingEntries ?? [])];
    for (const entry of entries) {
      if (entry.type === "queue") {
        await this.cleanupQueueEntry(socket, entry, { removeFromDb: true });
      } else {
        await this.cleanupRoomEntry(socket, entry.roomId, {
          removeFromDb: true,
        });
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
   * Reconciles active room subscriptions with the user's current joined rooms.
   */
  private async syncRoomSubscriptions(
    socket: Socket,
    roomEntries: RoomEntry<Config, Loadout>[],
  ): Promise<void> {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null) {
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

    const currentEntries = [...(connectionState.matchmakingEntries ?? [])];
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
   * Ensures the socket is subscribed to room-specific updates for a room.
   * Uses the current room data to resolve the entry ID and establish watchers.
   */
  private async ensureRoomSubscription(
    socket: Socket,
    roomId: string,
    loadout: Loadout,
    knownEntryId?: string,
  ): Promise<void> {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null) {
      return;
    }

    const entries = connectionState.matchmakingEntries ?? [];
    const existing = entries.find((entry) =>
      entry.type === "room" && entry.roomId === roomId
    );
    if (existing != null && existing.type === "room") {
      return;
    }

    let entryId = knownEntryId;
    let roomSnapshot = await this.db.getRoom(roomId);
    if (roomSnapshot == null) {
      connectionState.lobbySocket.sendRoomEntryRemoved(roomId);
      return;
    }

    if (entryId == null) {
      const member = roomSnapshot.members.find((m) =>
        m.userId === connectionState.lobbySocket.userId
      );
      if (member == null) {
        connectionState.lobbySocket.sendRoomEntryRemoved(roomId);
        return;
      }
      entryId = member.entryId;
    }

    const assignmentsReader = this.db.watchForAssignments(entryId).getReader();
    streamAssignmentsToSocket(assignmentsReader, connectionState.lobbySocket);

    const roomChangesReader = this.db.watchForRoomChanges(roomId).getReader();
    streamRoomChangesToSocket(
      roomId,
      loadout,
      roomChangesReader,
      connectionState.lobbySocket,
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
      connectionState.lobbySocket.sendRoomEntryUpdate({
        roomId,
        numPlayers: roomSnapshot.numPlayers,
        players: roomSnapshot.members.map((member) => member.player),
        config: roomSnapshot.config,
        loadout,
      });
    }

    connectionState.matchmakingEntries = [
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
    socket: Socket,
    queueEntry: Extract<MatchmakingEntry<Config, Loadout>, { type: "queue" }>,
    options: { removeFromDb: boolean },
  ): Promise<void> {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null) {
      return;
    }

    queueEntry.assignmentsReader.cancel();
    queueEntry.assignmentsReader.releaseLock();

    if (options.removeFromDb) {
      await this.db.removeFromQueue(queueEntry.queueId, queueEntry.entryId);
    }

    connectionState.matchmakingEntries = (connectionState.matchmakingEntries ??
      []).filter((entry) => entry !== queueEntry);
  }

  /**
   * Cleans up one room subscription and optionally removes membership in DB.
   */
  private async cleanupRoomEntry(
    socket: Socket,
    roomId: string,
    options: { removeFromDb: boolean; notifyClient?: boolean },
  ): Promise<void> {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null) {
      return;
    }

    const entries = connectionState.matchmakingEntries ?? [];
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

    connectionState.matchmakingEntries = entries.filter((entry) =>
      entry !== roomEntry
    );

    if (options.notifyClient ?? true) {
      connectionState.lobbySocket.sendRoomEntryRemoved(roomId);
    }
  }

  /**
   * Creates a new queue entry, assigns it to the given queue in the database,
   * and stores the socket. Watches for assignments, and when an assignment is
   * made, sends it to the socket.
   */
  public async joinQueue(
    socket: Socket,
    queueId: string,
    userId: string,
    user: Player,
    loadout: Loadout,
  ) {
    const connectionState = this.sockets.get(socket);
    if (!connectionState) {
      return;
    }

    const entryId = ulid();

    const assignmentsReader = this.db.watchForAssignments(entryId).getReader();
    streamAssignmentsToSocket(assignmentsReader, connectionState.lobbySocket);

    await this.db.addToQueue(queueId, entryId, userId, user, loadout);

    // Track this entry so we can clean it up if needed
    const existingEntries = connectionState.matchmakingEntries ?? [];
    connectionState.matchmakingEntries = [
      ...existingEntries,
      {
        type: "queue",
        queueId,
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
    userId: string,
    user: Player,
    loadout: Loadout,
    options?: { consumeInvitation?: boolean },
  ): Promise<boolean> {
    const connectionState = this.sockets.get(socket);
    if (!connectionState) {
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
    await this.cleanupQueueEntry(socket, queueEntry, { removeFromDb: true });
  }

  /**
   * Leaves a specific room.
   */
  async leaveRoom(socket: Socket, roomId: string) {
    await this.cleanupRoomEntry(socket, roomId, { removeFromDb: true });
  }
}
