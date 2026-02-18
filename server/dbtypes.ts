/**
 * Storage contracts for all Deno KV records used by the server runtime.
 *
 * These types are intentionally DB-oriented: they store entity IDs and other
 * normalized values. Public `*ViewData` objects are hydrated separately.
 */
import type { Ulid } from "../types.ts";

/**
 * KV key for authentication token records.
 */
export type TokenStorageKey = ["tokens", token: Ulid];

/**
 * KV key for user records.
 */
export type UserStorageKey = ["users", userId: Ulid];

/**
 * KV key for global active public game list.
 */
export type ActivePublicGamesStorageKey = ["activepublicgames"];

/**
 * KV key for global available public room list.
 */
export type AvailablePublicRoomsStorageKey = ["availablepublicrooms"];

/**
 * KV key for per-user matchmaking state.
 */
export type UserMatchmakingStorageKey = ["usermatchmaking", userId: Ulid];

/**
 * KV key for queue entries.
 */
export type QueueEntryStorageKey = [
  "queueentry",
  queueId: string,
  entryId: Ulid,
];

/**
 * KV key for room records.
 */
export type RoomStorageKey = ["rooms", roomId: Ulid];

/**
 * KV key for game records.
 */
export type GameStorageKey = ["games", gameId: Ulid];

/**
 * Union of all supported KV keys in this module.
 */
export type StorageKey =
  | TokenStorageKey
  | UserStorageKey
  | ActivePublicGamesStorageKey
  | AvailablePublicRoomsStorageKey
  | UserMatchmakingStorageKey
  | QueueEntryStorageKey
  | RoomStorageKey
  | GameStorageKey;

/**
 * Persisted authentication token data.
 */
export type TokenStorageData = {
  userId: Ulid;
  expiration: Date;
};

/**
 * Persisted user profile and rating data.
 */
export type UserStorageData<Config, Loadout, Rating> = {
  userId: Ulid;
  username: string;
  isGuest: boolean;
  ratingsByQueueId: Record<string, Rating>;
  defaultLoadoutsByQueueId: Record<string, Loadout>;
  lastUsedRoomConfig: Config | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Persisted entry in the global active public game list.
 * Contains only in-progress games.
 */
export type ActivePublicGameStorageData<Config> = {
  gameId: Ulid;
  playerUserIds: Ulid[];
  config: Config;
  createdAt: Date;
};

/**
 * Persisted entry in the global available public room list.
 */
export type AvailableRoomStorageData<Config> = {
  roomId: Ulid;
  numPlayers: number;
  playerUserIds: Ulid[];
  config: Config;
};

/**
 * Stored reference to a user's queue entry.
 * Per-user arrays must contain at most one item per queueId.
 */
export type QueueEntryRefStorageData = {
  queueId: string;
  entryId: Ulid;
};

/**
 * Stored reference to a user's room membership.
 */
export type RoomEntryRefStorageData = {
  roomId: Ulid;
  entryId: Ulid;
};

/**
 * Stored incoming invitation reference for a user.
 * At most one reference per roomId.
 */
export type IncomingRoomInvitationRefStorageData = {
  roomId: Ulid;
  invitedAt: Date;
};

/**
 * Stored reference to an active game in a user's matchmaking state.
 * Exactly one origin source is present.
 * Contains only in-progress games.
 */
export type UserActiveGameStorageData =
  & { gameId: Ulid }
  & (
    | { queueEntryId: Ulid; roomId?: undefined }
    | { roomId: Ulid; queueEntryId?: undefined }
  );

/**
 * Persisted per-user matchmaking state.
 */
export type UserMatchmakingStorageData = {
  userId: Ulid;
  queueEntries: QueueEntryRefStorageData[];
  roomEntries: RoomEntryRefStorageData[];
  incomingRoomInvitations: IncomingRoomInvitationRefStorageData[];
  userActiveGames: UserActiveGameStorageData[];
  updatedAt: Date;
};

/**
 * Persisted queue entry row.
 * Runtime enforces uniqueness for active entries on (userId, queueId).
 */
export type QueueEntryStorageData<Loadout> = {
  queueId: string;
  entryId: Ulid;
  userId: Ulid;
  loadout: Loadout;
  createdAt: Date;
};

/**
 * Persisted room membership row within a room.
 */
export type RoomMemberStorageData<Loadout> = {
  entryId: Ulid;
  userId: Ulid;
  loadout: Loadout;
  joinedAt: Date;
};

/**
 * Persisted room row.
 */
export type RoomStorageData<Config, Loadout> = {
  roomId: Ulid;
  // Immutable metadata for record-keeping; does not imply extra privileges.
  createdByUserId: Ulid;
  config: Config;
  numPlayers: number;
  private: boolean;
  members: RoomMemberStorageData<Loadout>[];
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Persisted game row.
 */
export type GameStorageData<Config, GameState, Outcome> = {
  gameId: Ulid;
  config: Config;
  numPlayers: number;
  playerUserIds: Ulid[];
  state: GameState;
  outcome: Outcome | undefined;
  createdAt: Date;
  updatedAt: Date;
};
