type AsJson<T> = T extends string | number | boolean | null ? T
  // deno-lint-ignore ban-types
  : T extends Function ? never
  : T extends object ? { [K in keyof T]: AsJson<T[K]> }
  : never;

type AsStructuredClone<T> = T extends
  | string
  | number
  | boolean
  | null
  | DataView
  | Error
  | EvalError
  | RangeError
  | ReferenceError
  | SyntaxError
  | TypeError
  | URIError
  | bigint
  | ArrayBuffer
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array
  | Date ? T
  // deno-lint-ignore ban-types
  : T extends Function ? never
  : T extends object ? { [K in keyof T]: AsJson<T[K]> }
  : T extends Map<infer K, infer V>
    ? Map<AsStructuredClone<K>, AsStructuredClone<V>>
  : T extends Set<infer U> ? Set<AsStructuredClone<U>>
  : never;

// deno-lint-ignore no-explicit-any
export type JSONValue = AsJson<any>;
// deno-lint-ignore no-explicit-any
type StructuredCloneValue = AsStructuredClone<any>;

/**
 * Game-specific type bundle shared across server, socket messages, and hooks.
 * Consumers provide one concrete object type and reuse it everywhere.
 */
export type GameTypes = {
  Config: StructuredCloneValue;
  GameState: StructuredCloneValue;
  Move: JSONValue;
  PlayerState: JSONValue;
  PublicState: JSONValue;
  Outcome: JSONValue;
  Rating: JSONValue;
  Loadout: JSONValue;
};

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

export type SocketMessageListener = (message: string) => void;
export type SocketOpenListener = () => void;

export interface Socket {
  // Registers a handler for incoming WebSocket message events.
  addMessageListener: (handler: SocketMessageListener) => void;
  // Removes a previously registered message handler.
  removeMessageListener: (handler: SocketMessageListener) => void;
  // Registers a handler for the WebSocket open event.
  addOpenListener: (handler: SocketOpenListener) => void;
  // Removes a previously registered open handler.
  removeOpenListener: (handler: SocketOpenListener) => void;
  send: (data: string) => void;
}

/**
 * Public server API returned by initializeServer.
 *
 * Exposes methods for bootstrapping socket subscriptions and fetching initial
 * channel payloads used by client hooks.
 */
export interface Server<T extends GameTypes> {
  getUserMatchmakingViewData(
    userId: string,
  ): Promise<
    {
      props: UserMatchmakingViewData<T>;
      token: string;
    }
  >;
  getActivePublicMatchesViewData(): Promise<
    ActivePublicMatchesViewData<T>
  >;
  getActivePublicUsersViewData(): Promise<ActiveUsersViewData<T>>;
  getAvailablePublicRoomsViewData(): Promise<
    AvailablePublicRoomsViewData<T>
  >;
  getUserProfileViewData(
    userId: string,
  ): Promise<UserProfileViewData<T>>;
  getMatchViewData(
    matchId: string,
    userId: string,
  ): Promise<MatchViewData<T>>;
  configureSocket(socket: WebSocket, userId: string): void;
  resolveToken(token: string | undefined): Promise<string>;
}

export type SetupObject<T extends GameTypes> = {
  timestamp: Date;
  numPlayers: number;
  config: T["Config"];
  loadouts: T["Loadout"][];
};

export type MoveObject<T extends GameTypes> = {
  config: T["Config"];
  move: T["Move"];
  playerId: number;
  timestamp: Date;
  numPlayers: number;
};

export type RefreshObject<T extends GameTypes> = {
  config: T["Config"];
  timestamp: Date;
  numPlayers: number;
};

export type PlayerStateObject<T extends GameTypes> = {
  config: T["Config"];
  playerId: number;
  numPlayers: number;
  timestamp: Date;
};
export type PublicStateObject<T extends GameTypes> = {
  config: T["Config"];
  numPlayers: number;
  timestamp: Date;
};

export type OutcomeObject<T extends GameTypes> = {
  config: T["Config"];
  numPlayers: number;
};

export type QueueConfig<T extends GameTypes> = {
  numPlayers: number;
  config: T["Config"];
  queueType: "ranked" | "unranked";
};

/**
 * Core interface for implementing turn-based multiplayer games.
 *
 * @template T - Bundle containing Config, GameState, Move, PlayerState,
 * PublicState, Outcome, Rating, and Loadout.
 */
export interface GameDefinition<T extends GameTypes> {
  /**
   * Defines the available game queues with their configurations.
   * Used for game initialization.
   */
  queues: { [id: string]: QueueConfig<T> };

  /**
   * Creates the initial game state when a new game is started.
   *
   * @param o - Setup object containing configuration, player count, and timestamp
   * @returns Immutable initial game state
   */
  setup(o: SetupObject<T>): Readonly<T["GameState"]>;

  /**
   * Validates whether a move is legitimate based on current game state.
   * Prevents invalid moves from being processed.
   *
   * @param state - Current immutable game state
   * @param o - Move object containing the move, player ID, configuration, timestamp, and player count
   * @returns True if the move is valid, false otherwise
   */
  isValidMove(
    state: Readonly<T["GameState"]>,
    o: MoveObject<T>,
  ): boolean;

  /**
   * Validates whether a loadout is acceptable for the given game configuration.
   * When omitted, loadouts are assumed valid.
   *
   * @param loadout - Player loadout data supplied during queue join
   * @param config - Configuration for the selected mode
   * @returns True if the loadout is valid, false otherwise
   */
  isValidLoadout?(loadout: T["Loadout"], config: T["Config"]): boolean;

  /**
   * Validates whether a room configuration is acceptable.
   * When omitted, rooms cannot be created or joined.
   *
   * @param config - Configuration for the room being created or joined
   * @returns True if the room configuration is valid, false otherwise
   */
  isValidRoom?(config: T["Config"]): boolean;

  /**
   * Processes a player's move and updates the game state accordingly.
   * Only called if isValidMove returns true for the given move.
   *
   * @param state - Current immutable game state
   * @param o - Move object containing the move, player ID, configuration, timestamp, and player count
   * @returns Updated immutable game state
   */
  processMove(
    state: Readonly<T["GameState"]>,
    o: MoveObject<T>,
  ): Readonly<T["GameState"]>;

  /**
   * Reserved for future time-based mechanics.
   *
   * @param state - Current immutable game state
   * @param o - Refresh object containing configuration, timestamp, and player count
   * @returns Timeout in milliseconds or undefined
   */
  refreshTimeout?(
    state: Readonly<T["GameState"]>,
    o: RefreshObject<T>,
  ): number | undefined;

  /**
   * Creates a player-specific view of the game state. It will be
   * provided to Player clients, alongside the PublicState.
   *
   * @param state - Current immutable game state
   * @param o - Player state object containing player ID, configuration, and player count
   * @returns Player-specific state representation
   */
  playerState(
    state: Readonly<T["GameState"]>,
    o: PlayerStateObject<T>,
  ): T["PlayerState"];

  /**
   * Creates an observer-specific view of the game state.
   *
   * @param state - Current immutable game state
   * @param o - Observer state object containing configuration and player count
   * @returns Observer-specific state representation
   */
  publicState(
    state: Readonly<T["GameState"]>,
    o: PublicStateObject<T>,
  ): T["PublicState"];

  /**
   * Determines the game outcome.
   * When a non-undefined value is returned, no further moves will be accepted.
   *
   * @param state - Current immutable game state
   * @param o - Outcome check object containing configuration and player count
   * @returns Outcome value or undefined if the game is still in progress
   */
  outcome(state: Readonly<T["GameState"]>, o: OutcomeObject<T>):
    | T["Outcome"]
    | undefined;

  /**
   * Returns the initial rating for a new player.
   */
  initialRating(): T["Rating"];

  /**
   * Processes the game outcome and returns updated ratings for all players.
   *
   * @param outcome - Outcome value for the completed game
   * @param currentRatings - Current ratings for each player, in player order
   * @returns Updated ratings for each player, in player order
   */
  processOutcome(
    outcome: T["Outcome"],
    currentRatings: T["Rating"][],
  ): T["Rating"][];
}

// ViewData and Props

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
  players: PlayerSnapshot<T>[];
  publicState: T["PublicState"];
  playerId: number;
  playerState: T["PlayerState"];
  outcome: T["Outcome"];
};

type IncompletePlayerViewData<T extends GameTypes> = {
  players: PlayerSnapshot<T>[];
  publicState: T["PublicState"];
  playerId: number;
  playerState: T["PlayerState"];
  outcome: undefined;
};

type CompleteObserverViewData<T extends GameTypes> = {
  players: PlayerSnapshot<T>[];
  publicState: T["PublicState"];
  playerId: undefined;
  playerState: undefined;
  outcome: T["Outcome"];
};

type IncompleteObserverViewData<T extends GameTypes> = {
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
