import type { ActiveGame, Game, PlayerSnapshot } from "@/types.ts";
import { DB } from "@/server/db/db.ts";
import { SocketStore } from "@/server/sockets.ts";
import { Server } from "@/server/server.ts";

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
  game: Game<
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
    GameState,
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

  const activePublicGamesStream: ReadableStream<ActiveGame<Config, Rating>[]> =
    db
      .watchForActivePublicGamesListChanges();
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
    activePublicGamesStream,
    activePublicUsersStream,
    availableRoomsStream,
  );

  return new Server(
    game,
    db,
    socketStore,
  );
}
