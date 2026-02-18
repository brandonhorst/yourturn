import type {
  ActivePublicGamesViewData,
  AvailablePublicRoomsViewData,
  GameViewData,
  RoomViewData,
  ServerErrorCode,
  Ulid,
  UserMatchmakingViewData,
} from "../types.ts";

export type SocketClientMessage<
  Config,
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Loadout,
> =
  // Subscription
  | {
    type: "SubscribeUserMatchmaking";
    currentViewData: UserMatchmakingViewData<Config, Loadout>;
  }
  | { type: "UnsubscribeUserMatchmaking" }
  | {
    type: "SubscribeGame";
    gameId: Ulid;
    currentViewData: GameViewData<PlayerState, PublicState, Outcome>;
  }
  | { type: "UnsubscribeGame"; gameId: Ulid }
  | {
    type: "SubscribeRoom";
    roomId: Ulid;
    currentViewData: RoomViewData<Config, Loadout>;
  }
  | { type: "UnsubscribeRoom"; roomId: Ulid }
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
  | { type: "JoinRoom"; roomId: Ulid; loadout: Loadout }
  | { type: "LeaveQueue"; queueId: string }
  | { type: "AcceptInvitation"; roomId: Ulid }
  // Room actions
  | { type: "LeaveRoom"; roomId: Ulid }
  | { type: "CommitRoom"; roomId: Ulid }
  // Direct invitation to a specific user.
  | { type: "InviteUser"; roomId: Ulid; userId: Ulid }
  // Game actions
  | { type: "PerformMove"; gameId: Ulid; move: Move };

export type SocketServerMessage<
  Config,
  PlayerState,
  PublicState,
  Outcome,
  Loadout,
> =
  | {
    type: "UpdateUserMatchmaking";
    viewData: UserMatchmakingViewData<Config, Loadout>;
  }
  | {
    type: "UpdateRoom";
    roomId: Ulid;
    viewData: RoomViewData<Config, Loadout>;
  }
  | {
    type: "UpdateGame";
    gameId: Ulid;
    viewData: GameViewData<PlayerState, PublicState, Outcome>;
  }
  | {
    type: "UpdateActivePublicGames";
    viewData: ActivePublicGamesViewData<Config>;
  }
  | {
    type: "UpdateAvailablePublicRooms";
    viewData: AvailablePublicRoomsViewData<Config>;
  }
  | {
    type: "ServerError";
    code: ServerErrorCode;
    message: string;
  };
