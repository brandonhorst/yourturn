import type {
  ActivePublicGamesViewData,
  AvailablePublicRoomsViewData,
  GameViewData,
  LobbyViewData,
  RoomEntry,
} from "../types.ts";

export type ClientMessage<Config, Loadout, Move, PlayerState, PublicState> =
  // Active Public Games Channel
  | { type: "SubscribeActivePublicGames"; subscriptionId: string }
  // Available Public Rooms Channel
  | { type: "SubscribeAvailablePublicRooms"; subscriptionId: string }
  // Lobby Channel
  | { type: "SubscribeLobby"; subscriptionId: string }
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
  | { type: "SubscribeGame"; subscriptionId: string; gameId: string }
  | { type: "Move"; gameId: string; move: Move }
  | { type: "Unsubscribe"; subscriptionId: string };

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
    subscriptionId: string;
    lobbyProps: LobbyViewData<Config, Loadout, Rating>;
  }
  | {
    type: "UpdateActivePublicGames";
    subscriptionId: string;
    activePublicGamesProps: ActivePublicGamesViewData<Config>;
  }
  | {
    type: "UpdateAvailablePublicRooms";
    subscriptionId: string;
    availablePublicRoomsProps: AvailablePublicRoomsViewData<Config>;
  }
  | {
    type: "UpdateRoomEntry";
    subscriptionId: string;
    roomEntry: RoomEntry<Config, Loadout>;
  }
  | { type: "RemoveRoomEntry"; subscriptionId: string; roomId: string }
  | { type: "GameAssignment"; subscriptionId: string; gameId: string }
  | { type: "DisplayError"; message: string }
  | {
    type: "UpdateGameState";
    subscriptionId: string;
    gameViewData: GameViewData<PlayerState, PublicState, Outcome>;
  };
