import type {
  ActivePublicMatchesViewData,
  ActiveUsersViewData,
  AvailablePublicRoomsViewData,
  GameTypes,
  MatchViewData,
  RoomEntry,
  UserMatchmakingViewData,
  UserProfileViewData,
} from "@/types/mod.ts";

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
