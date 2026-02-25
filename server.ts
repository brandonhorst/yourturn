import type {
  ActiveMatch,
  GameDefinition,
  GameTypes,
  PlayerSnapshot,
  Server,
} from "./types.ts";
import { DB } from "./server/db.ts";
import { SocketStore } from "./server/sockets.ts";
import { ServerController } from "./server/server.ts";

export async function initializeServer<T extends GameTypes>(
  game: GameDefinition<T>,
): Promise<Server<T>> {
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

  return new ServerController(
    game,
    db,
    socketStore,
  );
}
