import type { ActiveGame, User } from "../types.ts";

export type LobbySocketRequest<Loadout> =
  | { type: "Initialize"; activeGames: ActiveGame[] }
  | { type: "JoinQueue"; queueId: string; loadout: Loadout }
  | { type: "LeaveQueue" }
  | { type: "UpdateUsername"; username: string };

export type LobbySocketResponse =
  | { type: "QueueJoined" }
  | { type: "QueueLeft" }
  | { type: "UpdateActiveGames"; activeGames: ActiveGame[] }
  | { type: "GameAssignment"; gameId: string }
  | { type: "UserUpdated"; user: User };

export type GameSocketRequest<Move, PlayerState, PublicState> =
  | {
    type: "Initialize";
    currentPublicState: PublicState;
    currentPlayerState?: PlayerState;
  }
  | { type: "Move"; move: Move };

export type GameSocketResponse<PlayerState, PublicState, Outcome> = {
  type: "UpdateGameState";
  publicState: PublicState;
  playerState: PlayerState | undefined;
  outcome: Outcome | undefined;
};
