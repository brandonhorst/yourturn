import type { ActiveGame } from "../types.ts";

export type LobbySocketRequest<Config, Player> =
  | { type: "Initialize"; activeGames: ActiveGame<Config, Player>[] }
  | { type: "JoinQueue"; queueId: string }
  | { type: "LeaveQueue" };

export type LobbySocketResponse<Config, Player> =
  | { type: "QueueJoined" }
  | { type: "QueueLeft" }
  | { type: "UpdateActiveGames"; activeGames: ActiveGame<Config, Player>[] }
  | { type: "GameAssignment"; gameId: string; sessionId: string };

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
