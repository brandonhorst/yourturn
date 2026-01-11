import type { AssignmentStorageData, DB, QueueConfig } from "./db.ts";
import type { LobbySocketResponse } from "../common/types.ts";
import type { ActiveGame, SetupObject } from "../types.ts";
import { ulid } from "@std/ulid";
import { deepEquals, type Socket } from "./socketutils.ts";

type QueueEntry = {
  queueId: string;
  entryId: string;
  assignmentsReader: ReadableStreamDefaultReader;
};

type ConnectionData<Config, Player> = {
  queueEntry?: Readonly<QueueEntry>;
  lastValue: ActiveGame<Config, Player>[];
};

async function streamToSocket<Config, Player>(
  stream: ReadableStreamDefaultReader<AssignmentStorageData>,
  socket: Socket,
) {
  while (true) {
    const data = await stream.read();
    if (data.done) {
      break;
    }

    const message: LobbySocketResponse<Config, Player> = {
      type: "GameAssignment",
      sessionId: data.value.sessionId,
      gameId: data.value.gameId,
    };
    socket.send(JSON.stringify(message));
  }
}

export class LobbySocketStore<Config, Player> {
  private sockets: Map<Socket, ConnectionData<Config, Player>> = new Map();
  private lastActiveGames: ActiveGame<Config, Player>[] = [];

  constructor(
    private db: DB,
    activeGamesStream: ReadableStream<ActiveGame<Config, Player>[]>,
  ) {
    this.streamToAllSocketAndStore(activeGamesStream);
  }
  register(socket: Socket) {
    this.sockets.set(socket, { lastValue: [] });
  }

  initialize(socket: Socket, activeGames: ActiveGame<Config, Player>[]) {
    const connectionData = this.sockets.get(socket);
    if (connectionData == null) {
      return;
    }
    connectionData.lastValue = activeGames;

    updateActiveGamesIfNecessary(socket, connectionData, this.lastActiveGames);
  }

  async unregister(socket: Socket) {
    await this.leaveQueue(socket);
    this.sockets.delete(socket);
  }

  // Subscribe to the activeGamesStream and send to all registered sockets
  private streamToAllSocketAndStore(
    activeGamesStream: ReadableStream<ActiveGame<Config, Player>[]>,
  ) {
    activeGamesStream.pipeTo(
      new WritableStream({
        write: (activeGames: ActiveGame<Config, Player>[]) => {
          this.lastActiveGames = activeGames;

          for (const socket of this.allSockets()) {
            updateActiveGamesIfNecessary(
              socket,
              this.sockets.get(socket)!,
              activeGames,
            );
          }
        },
      }),
    );
  }

  // Creates a new queue entry, assigns it to the given queue in the database,
  // and stores the socket. Watches for assignments, and when an assignment is
  // made, sends it to the socket.
  public async joinQueue<GameState>(
    socket: Socket,
    queueConfig: QueueConfig<Config>,
    setupGame: (o: SetupObject<Config, Player>) => GameState,
    player: Player,
  ) {
    const entryId = ulid();

    const assignmentsReader = this.db.watchForAssignments(entryId).getReader();
    streamToSocket<Config, Player>(assignmentsReader, socket);

    const message: LobbySocketResponse<Config, Player> = {
      type: "QueueJoined",
    };
    socket.send(JSON.stringify(message));

    await this.db.addToQueue(queueConfig, entryId, setupGame, player);

    const connectionData = this.sockets.get(socket);
    if (connectionData) {
      connectionData.queueEntry = {
        queueId: queueConfig.queueId,
        entryId,
        assignmentsReader,
      };
    }
  }

  // Removes the queue entry from the database and stops watching for assignments.
  async leaveQueue(socket: Socket) {
    const connectionData = this.sockets.get(socket);
    const queueEntry = connectionData?.queueEntry;

    if (queueEntry == null) {
      return;
    }

    queueEntry.assignmentsReader.cancel();
    queueEntry.assignmentsReader.releaseLock();
    await this.db.removeFromQueue(queueEntry.queueId, queueEntry.entryId);
    delete connectionData?.queueEntry;

    const message: LobbySocketResponse<Config, Player> = { type: "QueueLeft" };
    socket.send(JSON.stringify(message));
  }

  allSockets(): Socket[] {
    return [...this.sockets.keys()];
  }
}

function updateActiveGamesIfNecessary<Config, Player>(
  socket: Socket,
  connectionData: ConnectionData<Config, Player>,
  activeGames: ActiveGame<Config, Player>[],
) {
  if (deepEquals(connectionData.lastValue, activeGames)) {
    return;
  }

  const response: LobbySocketResponse<Config, Player> = {
    type: "UpdateActiveGames",
    activeGames,
  };
  connectionData.lastValue = activeGames;
  socket.send(JSON.stringify(response));
}
