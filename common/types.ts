import type { ActiveGame } from "../types.ts";

export type LobbySocketRequest =
  | { type: "Initialize"; activeGames: ActiveGame[] }
  | { type: "JoinQueue"; queueId: string }
  | { type: "LeaveQueue" };

export type LobbySocketResponse =
  | { type: "QueueJoined" }
  | { type: "QueueLeft" }
  | { type: "UpdateActiveGames"; activeGames: ActiveGame[] }
  | { type: "GameAssignment"; gameId: string; sessionId: string };

export type PlaySocketRequest<M, P> =
  | { type: "Initialize"; currentPlayerState: P }
  | { type: "Move"; move: M };

export type PlaySocketResponse<P> =
  | { type: "UpdatePlayerState"; playerState: P }
  | { type: "MarkComplete" };

export type ObserveSocketRequest<O> = {
  type: "Initialize";
  currentObserverState: O;
};

export type ObserveSocketResponse<O> =
  | { type: "UpdateObserveState"; observerState: O }
  | { type: "MarkComplete" };
