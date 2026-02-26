import type { GameTypes } from "./game.ts";
import type {
  ActivePublicMatch,
  AvailableRoom,
  ChatMessage,
  PlayerSnapshot,
  QueueEntry,
  RoomEntry,
  UserActiveMatch,
  UserProfileUpdate,
  UserProfileViewData,
} from "./domain.ts";

export type ActivePublicMatchesViewData<T extends GameTypes> = {
  allActiveMatches: ActivePublicMatch<T>[];
};

export type ActiveUsersViewData<T extends GameTypes> = {
  allActiveUsers: PlayerSnapshot<T>[];
};

export type AvailablePublicRoomsViewData<T extends GameTypes> = {
  allAvailableRooms: AvailableRoom<T>[];
};

export type UserMatchmakingViewData<T extends GameTypes> = {
  userActiveMatches: UserActiveMatch<T>[];
  roomIds: string[];
  queueEntries: QueueEntry<T>[];
};

type CompletePlayerViewData<T extends GameTypes> = {
  chatThreadId: string;
  players: PlayerSnapshot<T>[];
  publicState: T["PublicState"];
  playerId: number;
  playerState: T["PlayerState"];
  outcome: T["Outcome"];
};

type IncompletePlayerViewData<T extends GameTypes> = {
  chatThreadId: string;
  players: PlayerSnapshot<T>[];
  publicState: T["PublicState"];
  playerId: number;
  playerState: T["PlayerState"];
  outcome: undefined;
};

type CompleteObserverViewData<T extends GameTypes> = {
  chatThreadId: string;
  players: PlayerSnapshot<T>[];
  publicState: T["PublicState"];
  playerId: undefined;
  playerState: undefined;
  outcome: T["Outcome"];
};

type IncompleteObserverViewData<T extends GameTypes> = {
  chatThreadId: string;
  players: PlayerSnapshot<T>[];
  publicState: T["PublicState"];
  playerId: undefined;
  playerState: undefined;
  outcome: undefined;
};

export type MatchViewData<T extends GameTypes> =
  | CompletePlayerViewData<T>
  | IncompletePlayerViewData<T>
  | CompleteObserverViewData<T>
  | IncompleteObserverViewData<T>;

type IncompletePlayerProps<T extends GameTypes> =
  & IncompletePlayerViewData<T>
  & { perform: (move: T["Move"]) => void };

type CompletePlayerProps<T extends GameTypes> =
  & CompletePlayerViewData<T>
  & { perform: undefined };

type ObserveProps<T extends GameTypes> =
  & (
    | CompleteObserverViewData<T>
    | IncompleteObserverViewData<T>
  )
  & { perform: undefined };

export type MatchProps<T extends GameTypes> =
  | CompletePlayerProps<T>
  | IncompletePlayerProps<T>
  | ObserveProps<T>;

export type UserMatchmakingProps<T extends GameTypes> =
  & UserMatchmakingViewData<T>
  & {
    joinQueue: (
      queueId: string,
      options: { loadout: T["Loadout"] },
    ) => void;
    leaveQueue: (queueId: string) => void;
    createAndJoinRoom: (
      options: {
        config: T["Config"];
        numPlayers: number;
        private: boolean;
      },
      player: { loadout: T["Loadout"] },
    ) => void;
    joinRoom: (
      roomId: string,
      options: { loadout: T["Loadout"] },
    ) => void;
  };

export type AccountUserProfileProps<T extends GameTypes> =
  & UserProfileViewData<T>
  & {
    update: (changes: UserProfileUpdate) => void;
  };

export type RoomProps<T extends GameTypes> =
  & RoomEntry<T>
  & {
    commitRoom: () => void;
    leaveRoom: () => void;
  };

export type ChatThreadViewData<T extends GameTypes> = {
  chatMessages: ChatMessage<T>[];
};

export type ChatThreadProps<T extends GameTypes> =
  & ChatThreadViewData<T>
  & {
    sendChatMessage: (message: string) => void;
  };
