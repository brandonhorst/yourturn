import type {
  ActivePublicMatchesViewData,
  ActiveUsersViewData,
  AvailablePublicRoomsViewData,
  GameTypes,
  MatchViewData,
  RoomEntry,
  UserMatchmakingViewData,
  UserProfileViewData,
} from "../types.ts";

export type ClientMessage<T extends GameTypes> =
  // Active Public Games Channel
  | { type: "SubscribeActivePublicMatches"; subscriptionId: string }
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
  // One-shot user profile fetch request
  | { type: "FetchUserProfile"; requestId: string; userId: string }
  // UserMatchmaking channel
  | { type: "SubscribeUserMatchmaking"; subscriptionId: string }
  | {
    type: "JoinQueue";
    queueId: string;
    loadout: T["Loadout"];
    assignmentSubscriptionId?: string;
  }
  | {
    type: "CreateAndJoinRoom";
    config: T["Config"];
    numPlayers: number;
    private: boolean;
    loadout: T["Loadout"];
    assignmentSubscriptionId?: string;
  }
  | {
    type: "JoinRoom";
    roomId: string;
    loadout: T["Loadout"];
    assignmentSubscriptionId?: string;
  }
  | { type: "LeaveQueue"; queueId: string }
  // Room Channel
  | { type: "SubscribeRoom"; subscriptionId: string; roomId: string }
  | { type: "CommitRoom"; roomId: string }
  | { type: "LeaveRoom"; roomId: string }
  // Match Channel
  | { type: "SubscribeMatch"; subscriptionId: string; matchId: string }
  | { type: "Move"; matchId: string; move: T["Move"] }
  | { type: "Unsubscribe"; subscriptionId: string };

export type ServerMessage<T extends GameTypes> =
  | {
    type: "UpdateAccountUserProfileProps";
    subscriptionId: string;
    accountUserProfileProps: UserProfileViewData<T>;
  }
  | {
    type: "FetchUserProfileResult";
    requestId: string;
    userProfile: UserProfileViewData<T> | null;
  }
  | {
    type: "UpdateUserMatchmakingProps";
    subscriptionId: string;
    userMatchmakingProps: UserMatchmakingViewData<T>;
  }
  | {
    type: "UpdateActivePublicMatches";
    subscriptionId: string;
    activePublicMatchesProps: ActivePublicMatchesViewData<T>;
  }
  | {
    type: "UpdateActivePublicUsers";
    subscriptionId: string;
    activePublicUsersProps: ActiveUsersViewData<T>;
  }
  | {
    type: "UpdateAvailablePublicRooms";
    subscriptionId: string;
    availablePublicRoomsProps: AvailablePublicRoomsViewData<T>;
  }
  | {
    type: "UpdateRoomEntry";
    subscriptionId: string;
    roomEntry: RoomEntry<T>;
  }
  | { type: "RemoveRoomEntry"; subscriptionId: string; roomId: string }
  | { type: "MatchAssignment"; subscriptionId: string; matchId: string }
  | { type: "DisplayError"; message: string }
  | {
    type: "UpdateMatchState";
    subscriptionId: string;
    matchViewData: MatchViewData<T>;
  };
