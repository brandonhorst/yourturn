import type {
  ActiveMatch,
  GameDefinition,
  GameTypes,
  PlayerSnapshot,
  Server,
} from "../types/mod.ts";
import { DB } from "./db/mod.ts";
import { logServer } from "./logging.ts";
import { SocketStore } from "./sockets/mod.ts";
import { ServerController } from "./controller/mod.ts";

export async function initializeServer<T extends GameTypes>(
  game: GameDefinition<T>,
): Promise<Server<T>> {
  logServer(
    "server.initialize",
    "INFO",
    `initializeServer called for queues=${
      JSON.stringify(Object.keys(game.queues))
    }`,
  );
  const kv = await Deno.openKv();
  const db = new DB<T>(kv, game);

  const activePublicMatchesStream: ReadableStream<
    ActiveMatch<T>[]
  > = db
    .watchForActivePublicMatchesListChanges();
  const activePublicUsersStream: ReadableStream<
    PlayerSnapshot<T>[]
  > = db.watchForActivePublicUsersListChanges();
  const availableRoomsStream = db.watchForAvailablePublicRoomListChanges();

  const socketStore = new SocketStore<T>(
    db,
    activePublicMatchesStream,
    activePublicUsersStream,
    availableRoomsStream,
  );

  logServer(
    "server.initialize",
    "INFO",
    "initializeServer completed and ServerController created",
  );
  return new ServerController(
    game,
    db,
    socketStore,
  );
}
