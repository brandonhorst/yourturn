import type {
  ActiveMatch,
  GameDefinition,
  PlayerSnapshot,
  Server,
} from "./types.ts";
import { DB } from "./server/db.ts";
import { SocketStore } from "./server/sockets.ts";
import { ServerController } from "./server/server.ts";

export async function initializeServer<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Rating,
  Loadout,
>(
  game: GameDefinition<
    Config,
    GameState,
    Move,
    PlayerState,
    PublicState,
    Outcome,
    Rating,
    Loadout
  >,
): Promise<
  Server<
    Config,
    Move,
    PlayerState,
    PublicState,
    Outcome,
    Rating,
    Loadout
  >
> {
  const kv = await Deno.openKv();
  const db = new DB<
    Config,
    GameState,
    Move,
    PlayerState,
    PublicState,
    Outcome,
    Rating,
    Loadout
  >(kv, game);

  const activePublicMatchesStream: ReadableStream<
    ActiveMatch<Config, Rating>[]
  > = db
    .watchForActivePublicMatchesListChanges();
  const activePublicUsersStream: ReadableStream<PlayerSnapshot<Rating>[]> = db
    .watchForActivePublicUsersListChanges();
  const availableRoomsStream = db.watchForAvailablePublicRoomListChanges();

  const socketStore = new SocketStore<
    Config,
    GameState,
    Move,
    PlayerState,
    PublicState,
    Outcome,
    Rating,
    Loadout
  >(
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
