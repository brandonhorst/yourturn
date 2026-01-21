import type { ActiveGame, Game } from "./types.ts";
import { GameSocketStore } from "./server/gamesockets.ts";
import { DB } from "./server/db.ts";
import { LobbySocketStore } from "./server/lobbysockets.ts";
import { Server } from "./server/gameserver.ts";

export async function initializeServer<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Loadout,
>(
  game: Game<
    Config,
    GameState,
    Move,
    PlayerState,
    PublicState,
    Outcome,
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
    Loadout
  >
> {
  const kv = await Deno.openKv();
  const db = new DB<Config, GameState, Loadout, Outcome>(kv);

  const activeGamesStream: ReadableStream<ActiveGame[]> = db
    .watchForActiveGameListChanges();
  const availableRoomsStream = db.watchForAvailableRoomListChanges();

  const lobbySocketStore = new LobbySocketStore<
    Config,
    GameState,
    Loadout,
    Outcome
  >(
    db,
    activeGamesStream,
    availableRoomsStream,
  );
  const gameSocketStore = new GameSocketStore<
    Config,
    GameState,
    PlayerState,
    PublicState,
    Outcome,
    Loadout
  >(db);

  return new Server(
    game,
    db,
    lobbySocketStore,
    gameSocketStore,
  );
}
