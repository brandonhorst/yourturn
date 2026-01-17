import type { ActiveGame, User } from "../types.ts";

export type LobbySocketRequest =
  | { type: "Initialize"; activeGames: ActiveGame[] }
  | { type: "JoinQueue"; queueId: string }
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
    type: "InitializePlayer";
    currentPlayerState: PlayerState;
    currentPublicState: PublicState;
  }
  | { type: "InitializeObserver"; currentPublicState: PublicState }
  | { type: "Move"; move: Move };

export type GameSocketResponse<PlayerState, PublicState> =
  | {
    type: "UpdateGameState";
    mode: "player";
    playerState: PlayerState;
    publicState: PublicState;
  }
  | { type: "UpdateGameState"; mode: "observer"; publicState: PublicState }
  | { type: "MarkComplete" };
