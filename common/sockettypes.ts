import type { ActiveGame, AvailableRoom, LobbyProps } from "../types.ts";

export type LobbyClientMessage<Config, Loadout> =
  | {
    type: "Initialize";
    allActiveGames: ActiveGame<Config>[];
    allAvailableRooms: AvailableRoom<Config>[];
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
  | { type: "LeaveQueue"; queueId: string }
  | { type: "LeaveRoom"; roomId: string }
  | { type: "UpdateUsername"; username: string };

export type LobbyServerMessage<Config, Loadout> =
  | {
    type: "UpdateLobbyProps";
    lobbyProps: Partial<LobbyProps<Config, Loadout>>;
  }
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
