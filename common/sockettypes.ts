import type {
  ActivePublicGamesViewData,
  AvailablePublicRoomsViewData,
  GameViewData,
  RoomViewData,
  UserMatchmakingViewData,
} from "../types.ts";

export type SocketClientMessage<
  Config,
  Move,
  PublicState,
  PlayerState,
  Loadout,
  Rating,
> =
  // Subscription
  | {
    type: "SubscribeUserMatchmaking";
    currentViewData: UserMatchmakingViewData<Config, Loadout, Rating>;
  }
  | { type: "UnsubscribeUserMatchmaking" }
  | {
    type: "SubscribeGame";
    currentViewData: GameViewData<Config, Loadout, Rating>;
  }
  | { type: "UnsubscribeGame" }
  | {
    type: "SubscribeRoom";
    currentViewData: RoomViewData<Config, Loadout>;
  }
  | { type: "UnsubscribeRoom" }
  | {
    type: "SubscribeActivePublicGames";
    currentViewData: ActivePublicGamesViewData<Config>;
  }
  | { type: "UnsubscribeActivePublicGames" }
  | {
    type: "SubscribeAvailablePublicRooms";
    currentViewData: AvailablePublicRoomsViewData<Config>;
  }
  | { type: "UnsubscribeAvailablePublicRooms" }
  // UserMatchmaking actions
  | { type: "JoinQueue"; queueId: string; loadout: Loadout }
  | {
    type: "CreateAndJoinRoom";
    config: Config;
    numPlayers: number;
    private: boolean;
    loadout: Loadout;
  }
  | { type: "JoinRoom"; roomId: string; loadout: Loadout }
  | { type: "LeaveQueue"; queueId: string }
  // Room actions
  | { type: "LeaveRoom"; roomId: string }
  | { type: "CommitRoom"; roomId: string }
  | { type: "InviteUser"; roomId: string; userId: string }
  | { type: "CreateInvitation"; roomId: string; invitationId: string }
  // Game actions
  | { type: "PerformMove"; move: Move };

export type SocketServerMessage<
  Config,
  PlayerState,
  PublicState,
  Outcome,
  Loadout,
  Rating,
> =
  | {
    type: "UpdateUserMatchmaking";
    viewData: Partial<UserMatchmakingViewData<Config, Loadout, Rating>>;
  }
  | {
    type: "UpdateRoom";
    viewData: Partial<RoomViewData<Config, Loadout>>;
  }
  | {
    type: "UpdateGame";
    viewData: Partial<GameViewData<PlayerState, PublicState, Outcome>>;
  }
  | {
    type: "UpdateActivePublicGames";
    viewData: Partial<ActivePublicGamesViewData<Config>>;
  }
  | {
    type: "UpdateAvailablePublicRooms";
    viewData: Partial<AvailablePublicRoomsViewData<Config>>;
  }
  | { type: "GameAssignment"; gameId: string };
