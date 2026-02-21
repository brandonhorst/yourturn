import type {
  ActivePublicGamesViewData,
  AvailablePublicRoomsViewData,
  LobbyViewData,
  RoomEntry,
} from "../types.ts";

export type ClientMessage<Config, Loadout, Move, PlayerState, PublicState> =
  // Active Public Games Channel
  | { type: "SubscribeActivePublicGames" }
  | { type: "UnsubscribeActivePublicGames" }
  // Available Public Rooms Channel
  | { type: "SubscribeAvailablePublicRooms" }
  | { type: "UnsubscribeAvailablePublicRooms" }
  // Lobby Channel
  | { type: "SubscribeLobby" }
  | { type: "UnsubscribeLobby" }
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
  // Game Channel
  | { type: "SubscribeGame"; gameId: string }
  | { type: "Move"; gameId: string; move: Move }
  | { type: "UnsubscribeGame"; gameId: string };

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
    type: "UpdateActivePublicGames";
    activePublicGamesProps: ActivePublicGamesViewData<Config>;
  }
  | {
    type: "UpdateAvailablePublicRooms";
    availablePublicRoomsProps: AvailablePublicRoomsViewData<Config>;
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
