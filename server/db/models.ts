import type {
  ActiveMatch,
  CompletedMatchSnapshot,
  GameTypes,
  PlayerSnapshot,
  QueueEntry,
  UserProfileViewData,
} from "../../types/mod.ts";

export type RoomMember<T extends GameTypes> = {
  entryId: string;
  timestamp: Date;
  userId: string;
  playerSnapshot: PlayerSnapshot<T>;
  loadout: T["Loadout"];
  assignmentSubscriptionId?: string;
};

export type RoomStorageData<T extends GameTypes> = {
  numPlayers: number;
  config: T["Config"];
  private: boolean;
  members: RoomMember<T>[];
};

export type RoomWatchEvent<T extends GameTypes> =
  | { type: "updated"; room: RoomStorageData<T> }
  | { type: "deleted" };

export type MatchStorageData<T extends GameTypes> = {
  config: T["Config"];
  queueId?: string;
  gameState: T["GameState"];
  userIds: string[];
  players: PlayerSnapshot<T>[];
  outcome: T["Outcome"] | undefined;
};

export type MatchAssignmentNotification = {
  matchId: string;
  subscriptionId?: string;
};

export type JoinedRoom<T extends GameTypes> = {
  roomId: string;
  loadout: T["Loadout"];
};

export type UserStorageData<T extends GameTypes> = {
  username: string;
  isGuest: boolean;
  description: string;
  ratings: Record<string, T["Rating"]>;
};

export type UserMatchmakingStorageData<T extends GameTypes> = {
  activeMatches: ActiveMatch<T>[];
  joinedRooms: JoinedRoom<T>[];
  queueEntries: QueueEntry<T>[];
};

export type ActiveUserStorageData<T extends GameTypes> = {
  playerSnapshot: PlayerSnapshot<T>;
  connectionCount: number;
};

/**
 * Converts canonical stored user data into socket-safe user profile view data.
 */
export function userStorageDataToUserProfileViewData<
  T extends GameTypes,
>(
  userId: string,
  userStorageData: UserStorageData<T>,
  completedMatches: CompletedMatchSnapshot<T>[],
): UserProfileViewData<T> {
  return {
    userId,
    username: userStorageData.username,
    isGuest: userStorageData.isGuest,
    description: userStorageData.description,
    rating: userStorageData.ratings,
    completedMatches,
  };
}

/**
 * Converts user profile view data into a frozen player snapshot.
 */
export function userProfileViewDataToPlayerSnapshot<T extends GameTypes>(
  userProfileViewData: UserProfileViewData<T>,
): PlayerSnapshot<T> {
  return {
    userId: userProfileViewData.userId,
    username: userProfileViewData.username,
    isGuest: userProfileViewData.isGuest,
    rating: userProfileViewData.rating,
  };
}
