import type { LobbyViewData, RoomEntry } from "../types.ts";

export type ClientMessage<Config, Loadout, Move, PlayerState, PublicState> =
  | { type: "SubscribeLobby" }
  | { type: "SubscribeGame" }
  | { type: "Unsubscribe" }
  | { type: "JoinQueue"; queueId: string; loadout: Loadout }
  | {
    type: "CreateAndJoinRoom";
    config: Config;
    numPlayers: number;
    private: boolean;
    loadout: Loadout;
  }
  | { type: "JoinRoom"; roomId: string; loadout: Loadout }
  | { type: "InviteUser"; roomId: string; userId: string }
  | { type: "CreateInvitation"; roomId: string; invitationId: string }
  | { type: "CommitRoom"; roomId: string }
  | { type: "LeaveQueue"; queueId: string }
  | { type: "LeaveRoom"; roomId: string }
  | { type: "UpdateUsername"; username: string }
  | { type: "Move"; move: Move };

export type ServerMessage<
  Config,
  Loadout,
  Rating,
  PlayerState,
  PublicState,
  Outcome,
> =
  | {
    type: "UpdateLobbyProps";
    lobbyProps: LobbyViewData<Config, Loadout, Rating>;
  }
  | {
    type: "UpdateRoomEntry";
    roomEntry: RoomEntry<Config, Loadout>;
  }
  | { type: "RemoveRoomEntry"; roomId: string }
  | { type: "GameAssignment"; gameId: string }
  | { type: "DisplayError"; message: string }
  | {
    type: "UpdateGameState";
    publicState: PublicState;
    playerState: PlayerState | undefined;
    outcome: Outcome | undefined;
  };
