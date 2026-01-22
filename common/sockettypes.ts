import type { ActiveGame, LobbyProps, Room } from "../types.ts";

export type LobbyClientMessage<Config, Loadout> =
  | {
    type: "Initialize";
    allActiveGames: ActiveGame<Config>[];
    allAvailableRooms: Room<Config>[];
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

export type LobbyServerMessage<Config, Loadout> =
  | { type: "QueueJoined"; queueId: string; loadout: Loadout }
  | { type: "RoomJoined"; roomId: string; config: Config; loadout: Loadout }
  | { type: "QueueLeft" }
  | { type: "RoomLeft" }
  | { type: "UpdateLobbyProps"; lobbyProps: Partial<LobbyProps<Config>> }
  | { type: "GameAssignment"; gameId: string }
  | { type: "DisplayError"; message: string };

export type GameClientMessage<Move, PlayerState, PublicState> =
  | {
    type: "Initialize";
    currentPublicState: PublicState;
    currentPlayerState?: PlayerState;
  }
  | { type: "Move"; move: Move };

export type GameServerMessage<PlayerState, PublicState, Outcome> = {
  type: "UpdateGameState";
  publicState: PublicState;
  playerState: PlayerState | undefined;
  outcome: Outcome | undefined;
};
