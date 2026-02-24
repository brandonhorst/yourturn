import type {
  ActivePublicGamesViewData,
  ActiveUsersViewData,
  AvailablePublicRoomsViewData,
  GameViewData,
  RoomEntry,
  UserMatchmakingViewData,
  UserProfileViewData,
} from "@/types.ts";

export type ClientMessage<Config, Loadout, Move, PlayerState, PublicState> =
  // Active Public Games Channel
  | { type: "SubscribeActivePublicGames"; subscriptionId: string }
  // Active Public Users Channel
  | { type: "SubscribeActivePublicUsers"; subscriptionId: string }
  // Available Public Rooms Channel
  | { type: "SubscribeAvailablePublicRooms"; subscriptionId: string }
  // Account User Profile Channel
  | { type: "SubscribeAccountUserProfile"; subscriptionId: string }
  | {
    type: "UpdateAccountUserProfile";
    description?: string;
  }
  // User Profile Channel
  | { type: "SubscribeUserProfile"; subscriptionId: string; userId: string }
  // UserMatchmaking channel
  | { type: "SubscribeUserMatchmaking"; subscriptionId: string }
  | {
    type: "JoinQueue";
    queueId: string;
    loadout: Loadout;
    assignmentSubscriptionId?: string;
  }
  | {
    type: "CreateAndJoinRoom";
    config: Config;
    numPlayers: number;
    private: boolean;
    loadout: Loadout;
    assignmentSubscriptionId?: string;
  }
  | {
    type: "JoinRoom";
    roomId: string;
    loadout: Loadout;
    assignmentSubscriptionId?: string;
  }
  | { type: "LeaveQueue"; queueId: string }
  // Room Channel
  | { type: "SubscribeRoom"; subscriptionId: string; roomId: string }
  | { type: "CommitRoom"; roomId: string }
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
    type: "UpdateAccountUserProfileProps";
    subscriptionId: string;
    accountUserProfileProps: UserProfileViewData<Rating>;
  }
  | {
    type: "UpdateUserProfileProps";
    subscriptionId: string;
    userProfileProps: UserProfileViewData<Rating>;
  }
  | {
    type: "UpdateUserMatchmakingProps";
    subscriptionId: string;
    userMatchmakingProps: UserMatchmakingViewData<Config, Loadout, Rating>;
  }
  | {
    type: "UpdateActivePublicGames";
    subscriptionId: string;
    activePublicGamesProps: ActivePublicGamesViewData<Config, Rating>;
  }
  | {
    type: "UpdateActivePublicUsers";
    subscriptionId: string;
    activePublicUsersProps: ActiveUsersViewData<Rating>;
  }
  | {
    type: "UpdateAvailablePublicRooms";
    subscriptionId: string;
    availablePublicRoomsProps: AvailablePublicRoomsViewData<Config, Rating>;
  }
  | {
    type: "UpdateRoomEntry";
    subscriptionId: string;
    roomEntry: RoomEntry<Config, Loadout, Rating>;
  }
  | { type: "RemoveRoomEntry"; subscriptionId: string; roomId: string }
  | { type: "GameAssignment"; subscriptionId: string; gameId: string }
  | { type: "DisplayError"; message: string }
  | {
    type: "UpdateGameState";
    subscriptionId: string;
    gameViewData: GameViewData<PlayerState, PublicState, Outcome, Rating>;
  };
