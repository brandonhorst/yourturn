import type { Game } from "../../types.ts";
import { MatchmakingDB } from "./matchmaking.ts";

/**
 * Primary DB facade that composes matchmaking, presence, and user persistence.
 */
export class DB<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Rating,
  Loadout,
> extends MatchmakingDB<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Rating,
  Loadout
> {
  constructor(
    kv: Deno.Kv,
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
  ) {
    super(kv, game);
  }
}
