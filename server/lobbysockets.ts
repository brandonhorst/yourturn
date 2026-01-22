import type {
  AssignmentStorageData,
  DB,
  QueueConfig,
  RoomStorageData,
} from "./db.ts";
import type { LobbyServerMessage } from "../common/sockettypes.ts";
import type { ActiveGame, Room, SetupObject, User } from "../types.ts";
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

type ConnectionData<Config> = {
  matchmakingEntry?: Readonly<MatchmakingEntry>;
  lastActiveGames: ActiveGame<Config>[];
  lastAvailableRooms: Room<Config>[];
};

async function streamToSocket<Config, Loadout>(
  stream: ReadableStreamDefaultReader<AssignmentStorageData>,
  socket: Socket,
) {
  while (true) {
    const data = await stream.read();
    if (data.done) {
      break;
    }

    const message: LobbyServerMessage<Config, Loadout> = {
      type: "GameAssignment",
      gameId: data.value.gameId,
    };
    socket.send(JSON.stringify(message));
  }
}

export class LobbySocketStore<Config, GameState, Loadout, Outcome> {
  private sockets: Map<Socket, ConnectionData<Config>> = new Map();
  private lastActiveGames: ActiveGame<Config>[] = [];
  private lastAvailableRooms: Room<Config>[] = [];

  constructor(
    private db: DB<Config, GameState, Loadout, Outcome>,
    activeGamesStream: ReadableStream<ActiveGame<Config>[]>,
    availableRoomsStream: ReadableStream<Room<Config>[]>,
  ) {
    this.streamToAllSocketAndStore(activeGamesStream);
    this.streamRoomsToAllSocketAndStore(availableRoomsStream);
  }
  register(socket: Socket) {
    this.sockets.set(socket, {
      lastActiveGames: [],
      lastAvailableRooms: [],
    });
  }

  initialize(
    socket: Socket,
    allActiveGames: ActiveGame<Config>[],
    allAvailableRooms: Room<Config>[],
  ) {
    const connectionData = this.sockets.get(socket);
    if (connectionData == null) {
      return;
    }
    connectionData.lastActiveGames = allActiveGames;
    connectionData.lastAvailableRooms = allAvailableRooms;

    updateActiveGamesIfNecessary(socket, connectionData, this.lastActiveGames);
    updateAvailableRoomsIfNecessary(
      socket,
      connectionData,
      this.lastAvailableRooms,
    );
  }

  async unregister(socket: Socket) {
    await this.leaveMatchmaking(socket);
    this.sockets.delete(socket);
  }

  // Subscribe to the activeGamesStream and send to all registered sockets
  private streamToAllSocketAndStore(
    activeGamesStream: ReadableStream<ActiveGame<Config>[]>,
  ) {
    activeGamesStream.pipeTo(
      new WritableStream({
        write: (allActiveGames: ActiveGame<Config>[]) => {
          this.lastActiveGames = allActiveGames;

          for (const socket of this.allSockets()) {
            updateActiveGamesIfNecessary(
              socket,
              this.sockets.get(socket)!,
              allActiveGames,
            );
          }
        },
      }),
    );
  }

  private streamRoomsToAllSocketAndStore(
    availableRoomsStream: ReadableStream<Room<Config>[]>,
  ) {
    availableRoomsStream.pipeTo(
      new WritableStream({
        write: (allAvailableRooms: Room<Config>[]) => {
          this.lastAvailableRooms = allAvailableRooms;

          for (const socket of this.allSockets()) {
            updateAvailableRoomsIfNecessary(
              socket,
              this.sockets.get(socket)!,
              allAvailableRooms,
            );
          }
        },
      }),
    );
  }

  // Creates a new queue entry, assigns it to the given queue in the database,
  // and stores the socket. Watches for assignments, and when an assignment is
  // made, sends it to the socket.
  public async joinQueue(
    socket: Socket,
    queueConfig: QueueConfig<Config>,
    userId: string,
    user: User,
    loadout: Loadout,
    setupGame: (o: SetupObject<Config, Loadout>) => GameState,
  ) {
    const entryId = ulid();

    const assignmentsReader = this.db.watchForAssignments(entryId).getReader();
    streamToSocket(assignmentsReader, socket);

    const message: LobbyServerMessage<Config, Loadout> = {
      type: "QueueJoined",
      queueId: queueConfig.queueId,
      loadout,
    };
    socket.send(JSON.stringify(message));

    await this.db.addToQueue(
      queueConfig,
      entryId,
      userId,
      user,
      loadout,
      setupGame,
    );

    const connectionData = this.sockets.get(socket);
    if (connectionData) {
      connectionData.matchmakingEntry = {
        type: "queue",
        queueId: queueConfig.queueId,
        entryId,
        assignmentsReader,
      };
    }
  }

  public async createAndJoinRoom(
    socket: Socket,
    roomConfig: { numPlayers: number; config: Config; private: boolean },
    userId: string,
    user: User,
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
      console.error("Failed to create and join room", err);
      socket.send(JSON.stringify(
        {
          type: "DisplayError",
          message: "Unable to create room.",
        },
      ));
    }
  }

  public async joinRoom(
    socket: Socket,
    roomId: string,
    roomConfig: Pick<RoomStorageData<Config, Loadout>, "config">,
    userId: string,
    user: User,
    loadout: Loadout,
  ): Promise<boolean> {
    const entryId = ulid();

    const assignmentsReader = this.db.watchForAssignments(entryId).getReader();
    streamToSocket(assignmentsReader, socket);

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

    const message: LobbyServerMessage<Config, Loadout> = {
      type: "RoomJoined",
      roomId,
      config: roomConfig.config,
      loadout,
    };
    socket.send(JSON.stringify(message));

    const connectionData = this.sockets.get(socket);
    if (connectionData) {
      connectionData.matchmakingEntry = {
        type: "room",
        roomId,
        entryId,
        assignmentsReader,
      };
    }

    return true;
  }

  // Removes the matchmaking entry from the database and stops watching assignments.
  async leaveMatchmaking(socket: Socket) {
    const connectionData = this.sockets.get(socket);
    const matchmakingEntry = connectionData?.matchmakingEntry;

    if (matchmakingEntry == null) {
      return;
    }

    matchmakingEntry.assignmentsReader.cancel();
    matchmakingEntry.assignmentsReader.releaseLock();

    if (matchmakingEntry.type === "queue") {
      await this.db.removeFromQueue(
        matchmakingEntry.queueId,
        matchmakingEntry.entryId,
      );
      const message: LobbyServerMessage<Config, Loadout> = {
        type: "QueueLeft",
      };
      socket.send(JSON.stringify(message));
    } else {
      await this.db.removeFromRoom(
        matchmakingEntry.roomId,
        matchmakingEntry.entryId,
      );
      const message: LobbyServerMessage<Config, Loadout> = {
        type: "RoomLeft",
      };
      socket.send(JSON.stringify(message));
    }

    delete connectionData?.matchmakingEntry;
  }

  allSockets(): Socket[] {
    return [...this.sockets.keys()];
  }
}

function updateActiveGamesIfNecessary<Config, Loadout>(
  socket: Socket,
  connectionData: ConnectionData<Config>,
  allActiveGames: ActiveGame<Config>[],
) {
  if (jsonEquals(connectionData.lastActiveGames, allActiveGames)) {
    return;
  }

  const response: LobbyServerMessage<Config, Loadout> = {
    type: "UpdateLobbyProps",
    lobbyProps: { allActiveGames },
  };
  connectionData.lastActiveGames = allActiveGames;
  socket.send(JSON.stringify(response));
}

function updateAvailableRoomsIfNecessary<Config, Loadout>(
  socket: Socket,
  connectionData: ConnectionData<Config>,
  allAvailableRooms: Room<Config>[],
) {
  if (jsonEquals(connectionData.lastAvailableRooms, allAvailableRooms)) {
    return;
  }

  const response: LobbyServerMessage<Config, Loadout> = {
    type: "UpdateLobbyProps",
    lobbyProps: { allAvailableRooms },
  };
  connectionData.lastAvailableRooms = allAvailableRooms;
  socket.send(JSON.stringify(response));
}
