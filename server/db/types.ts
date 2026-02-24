import type { ActiveGame, PlayerSnapshot, QueueEntry } from "../../types.ts";

export type QueueEntryValue<Loadout, Rating> = {
  timestamp: Date;
  userId: string;
  playerSnapshot: PlayerSnapshot<Rating>;
  loadout: Loadout;
  assignmentSubscriptionId?: string;
};

export type RoomMember<Loadout, Rating> = {
  entryId: string;
  timestamp: Date;
  userId: string;
  playerSnapshot: PlayerSnapshot<Rating>;
  loadout: Loadout;
  assignmentSubscriptionId?: string;
};

export type RoomStorageData<Config, Loadout, Rating> = {
  numPlayers: number;
  config: Config;
  private: boolean;
  members: RoomMember<Loadout, Rating>[];
};

export type RoomWatchEvent<Config, Loadout, Rating> =
  | { type: "updated"; room: RoomStorageData<Config, Loadout, Rating> }
  | { type: "deleted" };

export type GameStorageData<Config, GameState, Outcome, Rating> = {
  config: Config;
  queueId?: string;
  gameState: GameState;
  userIds: string[];
  players: PlayerSnapshot<Rating>[];
  outcome: Outcome | undefined;
};

export type GameAssignmentNotification = {
  gameId: string;
  subscriptionId?: string;
};

export type JoinedRoom<Loadout> = {
  roomId: string;
  loadout: Loadout;
};

export type UserStorageData<Rating> = {
  username: string;
  isGuest: boolean;
  description: string;
  ratings: Record<string, Rating>;
};

export type UserMatchmakingStorageData<Config, Loadout, Rating> = {
  activeGames: ActiveGame<Config, Rating>[];
  joinedRooms: JoinedRoom<Loadout>[];
  queueEntries: QueueEntry<Loadout>[];
};

export type ActiveUserStorageData<Rating> = {
  playerSnapshot: PlayerSnapshot<Rating>;
  connectionCount: number;
};
