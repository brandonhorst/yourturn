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
  | { type: "GameAssignment"; gameId: string; sessionId: string }
  | { type: "UserUpdated"; user: User };

export type PlaySocketRequest<Move, PlayerState> =
  | { type: "Initialize"; currentPlayerState: PlayerState }
  | { type: "Move"; move: Move };

export type PlaySocketResponse<PlayerState> =
  | { type: "UpdatePlayerState"; playerState: PlayerState }
  | { type: "MarkComplete" };

export type ObserveSocketRequest<ObserverState> = {
  type: "Initialize";
  currentObserverState: ObserverState;
};

export type ObserveSocketResponse<ObserverState> =
  | { type: "UpdateObserveState"; observerState: ObserverState }
  | { type: "MarkComplete" };
