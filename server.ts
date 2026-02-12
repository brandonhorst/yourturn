import type { Game, Server } from "./types.ts";
import { YourturnServer } from "./server/gameserver.ts";

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
  return await YourturnServer.initialize(game);
}
