import type { GameTypes } from "./game.ts";

export type PlayerSnapshot<T extends GameTypes> = {
  userId: string;
  username: string;
  isGuest: boolean;
  rating: Record<string, T["Rating"]>;
};

export type CompletedMatchSnapshot<T extends GameTypes> = {
  matchId: string;
  queueId?: string;
  players: PlayerSnapshot<T>[];
  config: T["Config"];
  outcome: T["Outcome"];
  completed: Date;
};

export type UserProfileViewData<T extends GameTypes> = {
  userId: string;
  username: string;
  isGuest: boolean;
  rating: Record<string, T["Rating"]>;
  description: string;
  completedMatches: CompletedMatchSnapshot<T>[];
};

export type UserProfileUpdate = {
  description?: string;
};

export type TokenData = {
  userId: string;
  expiration: Date;
};

/**
 * Compact audit payload written alongside DB mutation transactions.
 * `userId` identifies the actor that initiated the mutation.
 */
export type AuditLogEntryPayload =
  | {
    type: "AddToQueue";
    userId: string;
    queueId: string;
    entryId: string;
  }
  | {
    type: "RemoveFromQueue";
    userId: string;
    queueId: string;
    entryId: string;
  }
  | {
    type: "CreateRoom";
    userId: string;
    roomId: string;
    private: boolean;
  }
  | {
    type: "AddToRoom";
    userId: string;
    roomId: string;
    entryId: string;
  }
  | {
    type: "RemoveFromRoom";
    userId: string;
    roomId: string;
    entryId: string;
  }
  | {
    type: "CommitRoom";
    userId: string;
    roomId: string;
    matchId: string;
  }
  | {
    type: "GraduateQueue";
    userId: string;
    queueId: string;
    matchId: string;
  }
  | {
    type: "UpdateMatchStorageData";
    userId: string;
    matchId: string;
    completedMatchEntryId?: string;
  }
  | {
    type: "CreateNewUserStorageData";
    userId: string;
    username: string;
    isGuest: boolean;
  }
  | {
    type: "UpdateUserStorageData";
    userId: string;
  }
  | {
    type: "UpdateUserMatchmakingStorageData";
    userId: string;
  };

/**
 * Audit log entry persisted under one KV key.
 */
export type AuditLogEntry = {
  id: string;
  payload: AuditLogEntryPayload;
};

export type ActiveMatch<T extends GameTypes> = {
  matchId: string;
  players: PlayerSnapshot<T>[];
  config: T["Config"];
  created: Date;
};

export type ActivePublicMatch<T extends GameTypes> =
  & ActiveMatch<T>
  & { publicState: T["PublicState"] };

export type UserActiveMatch<T extends GameTypes> =
  & ActivePublicMatch<T>
  & { privateState: T["PlayerState"] };

export type AvailableRoom<T extends GameTypes> = {
  roomId: string;
  numPlayers: number;
  players: PlayerSnapshot<T>[];
  config: T["Config"];
};

export type RoomEntry<T extends GameTypes> = {
  roomId: string;
  numPlayers: number;
  players: PlayerSnapshot<T>[];
  config: T["Config"];
  loadout: T["Loadout"];
};

export type QueueEntry<T extends GameTypes> = {
  queueId: string;
  loadout: T["Loadout"];
};
