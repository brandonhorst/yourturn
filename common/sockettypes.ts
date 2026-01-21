import type { ActiveGame, Room, User } from "../types.ts";

export type LobbySocketRequest<Config, Loadout> =
  | {
    type: "Initialize";
    activeGames: ActiveGame<Config>[];
    availableRooms: Room<Config>[];
  }
  | { type: "JoinQueue"; queueId: string; loadout: Loadout }
  | {
    type: "CreateAndJoinRoom";
    config: Config;
    numPlayers: number;
    private: boolean;
    loadout: Loadout;
  }
  | { type: "JoinRoom"; roomId: string; loadout: Loadout }
  | { type: "CommitRoom"; roomId: string }
  | { type: "LeaveMatchmaking" }
  | { type: "UpdateUsername"; username: string };

export type LobbySocketResponse<Config, Loadout> =
  | { type: "QueueJoined"; queueId: string; loadout: Loadout }
  | { type: "RoomJoined"; roomId: string; config: Config; loadout: Loadout }
  | { type: "QueueLeft" }
  | { type: "RoomLeft" }
  | { type: "UpdateActiveGames"; activeGames: ActiveGame<Config>[] }
  | { type: "UpdateAvailableRooms"; availableRooms: Room<Config>[] }
  | { type: "GameAssignment"; gameId: string }
  | { type: "UserUpdated"; user: User }
  | { type: "DisplayError"; message: string };

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
