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

export type GameSocketRequest<Move, PlayerState, ObserverState> =
  | { type: "InitializePlayer"; currentPlayerState: PlayerState }
  | { type: "InitializeObserver"; currentObserverState: ObserverState }
  | { type: "Move"; move: Move };

export type GameSocketResponse<PlayerState, ObserverState> =
  | { type: "UpdateGameState"; mode: "player"; playerState: PlayerState }
  | { type: "UpdateGameState"; mode: "observer"; observerState: ObserverState }
  | { type: "MarkComplete" };
