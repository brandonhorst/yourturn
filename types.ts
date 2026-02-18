// Server Types

export interface Server<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Rating,
  Loadout,
> {
  /**
   * Returns an authenticated user for a provided token, creating a guest user
   * and new token when no valid token exists.
   */
  getUser(token: string | undefined): Promise<{ user: User; token: Ulid }>;

  /**
   * Returns the initial active public games snapshot for SSR.
   * Throws `ACTIVE_PUBLIC_GAMES_NOT_FOUND` when the snapshot is missing.
   */
  getInitialActivePublicGamesViewData(): Promise<
    ActivePublicGamesViewData<Config>
  >;

  /**
   * Returns the initial available public rooms snapshot for SSR.
   * Throws `AVAILABLE_PUBLIC_ROOMS_NOT_FOUND` when the snapshot is missing.
   */
  getInitialAvailablePublicRoomsViewData(): Promise<
    AvailablePublicRoomsViewData<Config>
  >;

  /**
   * Returns the initial user matchmaking snapshot for SSR.
   * Throws `USER_NOT_FOUND` when user matchmaking data cannot be loaded for the
   * provided user.
   */
  getInitialUserMatchmakingViewData(
    user: User,
  ): Promise<UserMatchmakingViewData<Config, Loadout>>;

  /**
   * Returns the initial room snapshot for SSR.
   * Throws `ROOM_NOT_FOUND` when the room is missing or not accessible to the
   * caller.
   */
  getInitialRoomViewData(
    user: User,
    roomId: Ulid,
  ): Promise<RoomViewData<Config, Loadout>>;

  /**
   * Returns the initial game snapshot for SSR.
   * Throws `GAME_NOT_FOUND` when the game is missing or not accessible to the
   * caller.
   */
  getInitialGameViewData(
    user: User,
    gameId: Ulid,
  ): Promise<GameViewData<PlayerState, PublicState, Outcome>>;

  /**
   * Attaches message handlers for a socket session.
   */
  configureSocket(user: User, socket: WebSocket): void;

  /**
   * Accepts room access into the user's matchmaking state.
   * Intended for non-socket route flows such as URL-scheme invitation links.
   * Idempotent no-op when already accepted, when already in the room, or when
   * the room is public.
   * Throws `ROOM_NOT_FOUND` when the room does not exist.
   */
  acceptInvitation(user: User, roomId: Ulid): Promise<void>;
}

// Client Types

export interface Socket {
  addMessageListener(handler: (message: string) => void): void;
  removeMessageListener(handler: (message: string) => void): void;

  addOpenListener(handler: () => void): void;
  removeOpenListener(handler: () => void): void;

  addCloseListener(handler: () => void): void;
  removeCloseListener(handler: () => void): void;

  close: () => void;
  send: (message: string) => void;
}

// Utility Types
//
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
export type NonNullableJSONValue = Exclude<JSONValue, null>;
// deno-lint-ignore no-explicit-any
type StructuredCloneValue = AsStructuredClone<any>;

/**
 * Server-generated IDs are ULIDs created via `jsr:@std/ulid`.
 */
export type Ulid = string;

export type User = {
  userId: Ulid;
  username: string;
  isGuest: boolean;
};

export type TokenData = {
  userId: Ulid;
  expiration: Date;
};

/**
 * JSON-safe timestamp string. Implementations should encode Date values using
 * ISO 8601 via `toISOString()`.
 */
export type IsoTimestamp = string;

/**
 * Canonical server error codes delivered over socket `ServerError` messages.
 */
export type ServerErrorCode =
  | "AUTH_INVALID"
  | "AUTH_REQUIRED"
  | "USER_NOT_FOUND"
  | "ACTIVE_PUBLIC_GAMES_NOT_FOUND"
  | "AVAILABLE_PUBLIC_ROOMS_NOT_FOUND"
  | "QUEUE_NOT_FOUND"
  | "QUEUE_ALREADY_JOINED"
  | "QUEUE_ENTRY_NOT_FOUND"
  | "ROOM_NOT_FOUND"
  | "ROOM_ALREADY_JOINED"
  | "ROOM_FULL"
  | "ROOM_CONFIG_INVALID"
  | "ROOM_NOT_READY"
  | "GAME_NOT_FOUND"
  | "GAME_ALREADY_COMPLETE"
  | "MOVE_INVALID"
  | "LOADOUT_INVALID"
  | "INTERNAL_ERROR";

export type SetupObject<Config, Loadout> = {
  timestamp: Date;
  numPlayers: number;
  config: Config;
  loadouts: Loadout[];
};

export type MoveObject<Config, Move> = {
  config: Config;
  move: Move;
  playerId: number;
  timestamp: Date;
  numPlayers: number;
};

export type RefreshObject<Config> = {
  config: Config;
  timestamp: Date;
  numPlayers: number;
};

export type PlayerStateObject<Config> = {
  config: Config;
  playerId: number;
  numPlayers: number;
  timestamp: Date;
};
export type PublicStateObject<Config> = {
  config: Config;
  numPlayers: number;
  timestamp: Date;
};

export type OutcomeObject<Config> = {
  config: Config;
  numPlayers: number;
};

export type QueueConfig<Config> = {
  numPlayers: number;
  config: Config;
  queueType: "ranked" | "unranked";
};

/**
 * Core interface for implementing turn-based multiplayer games.
 *
 * @template Config - Configuration type that defines game setup parameters (must be compatible with structured clone algorithm)
 * @template GameState - Game state type representing the complete state of the game (must be compatible with structured clone algorithm)
 * @template Move - Move type representing actions players can take (must be JSON serializable)
 * @template PlayerState - Player state type representing game state visible to a specific player (must be JSON serializable)
 * @template PublicState - Observer state type representing game state visible to observers (must be JSON serializable)
 * @template Outcome - Outcome type representing game results (must be JSON serializable and non-null)
 * @template Rating - Rating type representing a player's ranking (must be JSON serializable)
 * @template Loadout - Player loadout data provided during queue join (must be JSON serializable)
 */
export interface Game<
  Config extends StructuredCloneValue,
  GameState extends StructuredCloneValue,
  Move extends JSONValue,
  PlayerState extends JSONValue,
  PublicState extends JSONValue,
  Outcome extends NonNullableJSONValue,
  Rating extends JSONValue,
  Loadout extends JSONValue,
> {
  /**
   * Defines the available game queues with their configurations.
   * Used for game initialization.
   */
  queues: { [id: string]: QueueConfig<Config> };

  /**
   * Creates the initial game state when a new game is started.
   *
   * @param o - Setup object containing configuration, player count, and timestamp
   * @returns Immutable initial game state
   */
  setup(o: SetupObject<Config, Loadout>): Readonly<GameState>;

  /**
   * Validates whether a move is legitimate based on current game state.
   * Prevents invalid moves from being processed.
   *
   * @param state - Current immutable game state
   * @param o - Move object containing the move, player ID, configuration, timestamp, and player count
   * @returns True if the move is valid, false otherwise
   */
  isValidMove(state: Readonly<GameState>, o: MoveObject<Config, Move>): boolean;

  /**
   * Validates whether a loadout is acceptable for the given game configuration.
   * When omitted, loadouts are assumed valid.
   *
   * @param loadout - Player loadout data supplied during queue join
   * @param config - Configuration for the selected mode
   * @returns True if the loadout is valid, false otherwise
   */
  isValidLoadout?(loadout: Loadout, config: Config): boolean;

  /**
   * Validates whether a room configuration is acceptable.
   * When omitted, rooms cannot be created or joined.
   *
   * @param config - Configuration for the room being created or joined
   * @returns True if the room configuration is valid, false otherwise
   */
  isValidRoom?(config: Config): boolean;

  /**
   * Processes a player's move and updates the game state accordingly.
   * Only called if isValidMove returns true for the given move.
   *
   * @param state - Current immutable game state
   * @param o - Move object containing the move, player ID, configuration, timestamp, and player count
   * @returns Updated immutable game state
   */
  processMove(
    state: Readonly<GameState>,
    o: MoveObject<Config, Move>,
  ): Readonly<GameState>;

  /**
   * Creates a player-specific view of the game state. It will be
   * provided to Player clients, alongside the PublicState.
   *
   * @param state - Current immutable game state
   * @param o - Player state object containing player ID, configuration, and player count
   * @returns Player-specific state representation
   */
  playerState(
    state: Readonly<GameState>,
    o: PlayerStateObject<Config>,
  ): PlayerState;

  /**
   * Creates an observer-specific view of the game state.
   *
   * @param state - Current immutable game state
   * @param o - Observer state object containing configuration and player count
   * @returns Observer-specific state representation
   */
  publicState(
    state: Readonly<GameState>,
    o: PublicStateObject<Config>,
  ): PublicState;

  /**
   * Determines the game outcome.
   * When a non-undefined value is returned, no further moves will be accepted.
   *
   * @param state - Current immutable game state
   * @param o - Outcome check object containing configuration and player count
   * @returns Outcome value or undefined if the game is still in progress
   */
  outcome(state: Readonly<GameState>, o: OutcomeObject<Config>):
    | Outcome
    | undefined;

  /**
   * Returns the initial rating for a new player.
   */
  initialRating(): Rating;

  /**
   * Processes the game outcome and returns updated ratings for all players.
   *
   * @param outcome - Outcome value for the completed game
   * @param currentRatings - Current ratings for each player, in player order
   * @returns Updated ratings for each player, in player order
   */
  processOutcome(outcome: Outcome, currentRatings: Rating[]): Rating[];
}

export type ActivePublicGame<Config> = {
  gameId: Ulid;
  players: User[];
  config: Config;
  created: IsoTimestamp;
};

export type UserActiveGame<Config> =
  & ActivePublicGame<Config>
  & (
    | { queueEntryId: Ulid; roomId?: undefined }
    | { roomId: Ulid; queueEntryId?: undefined }
  );

export type AvailableRoom<Config> = {
  roomId: Ulid;
  numPlayers: number;
  players: User[];
  config: Config;
};

export type RoomInvitation<Config> = {
  roomId: Ulid;
  numPlayers: number;
  config: Config;
  invitedAt: IsoTimestamp;
};

export type RoomEntry<Config, Loadout> = {
  roomId: Ulid;
  numPlayers: number;
  players: User[];
  config: Config;
  yourLoadout: Loadout;
};

export type QueueEntry<Loadout> = {
  entryId: Ulid;
  queueId: string;
  loadout: Loadout;
};

// Room ViewData and Props

export type RoomViewData<Config, Loadout> = {
  numPlayers: number;
  players: User[];
  config: Config;
  yourLoadout: Loadout;
};

export type RoomProps<Config, Loadout> =
  & RoomViewData<Config, Loadout>
  & {
    leaveRoom: () => void;
    commitRoom: () => void;
    inviteUser: (userId: Ulid) => void;
  };

// Game ViewData and Props

type CompletePlayerGameViewData<PlayerState, PublicState, Outcome> = {
  players: User[];
  publicState: PublicState;
  playerId: number;
  playerState: PlayerState;
  outcome: Outcome;
};

type IncompletePlayerGameViewData<PlayerState, PublicState> = {
  players: User[];
  publicState: PublicState;
  playerId: number;
  playerState: PlayerState;
  outcome: null;
};

type CompleteObserverGameViewData<PublicState, Outcome> = {
  players: User[];
  publicState: PublicState;
  playerId: null;
  playerState: null;
  outcome: Outcome;
};

type IncompleteObserverGameViewData<PublicState> = {
  players: User[];
  publicState: PublicState;
  playerId: null;
  playerState: null;
  outcome: null;
};

export type GameViewData<PlayerState, PublicState, Outcome> =
  | CompletePlayerGameViewData<PlayerState, PublicState, Outcome>
  | IncompletePlayerGameViewData<PlayerState, PublicState>
  | CompleteObserverGameViewData<PublicState, Outcome>
  | IncompleteObserverGameViewData<PublicState>;

type IncompletePlayerGameProps<Move, PlayerState, PublicState> =
  & IncompletePlayerGameViewData<PlayerState, PublicState>
  & {
    perform: (move: Move) => void;
  };

type CompletePlayerGameProps<PlayerState, PublicState, Outcome> =
  & CompletePlayerGameViewData<PlayerState, PublicState, Outcome>
  & { perform: undefined };

type ObserverGameProps<PublicState, Outcome> =
  & (
    | CompleteObserverGameViewData<PublicState, Outcome>
    | IncompleteObserverGameViewData<PublicState>
  )
  & { perform: undefined };

export type GameProps<Move, PlayerState, PublicState, Outcome> =
  | CompletePlayerGameProps<PlayerState, PublicState, Outcome>
  | IncompletePlayerGameProps<Move, PlayerState, PublicState>
  | ObserverGameProps<PublicState, Outcome>;

// User Matchmaking ViewData and Props

export type UserMatchmakingViewData<Config, Loadout> = {
  userActiveGames: UserActiveGame<Config>[];
  roomEntries: RoomEntry<Config, Loadout>[];
  queueEntries: QueueEntry<Loadout>[];
  incomingRoomInvitations: RoomInvitation<Config>[];
};

export type UserMatchmakingProps<Config, Loadout> =
  & UserMatchmakingViewData<Config, Loadout>
  & {
    joinQueue: (queueId: string, options: { loadout: Loadout }) => void;
    createAndJoinRoom: (
      options: { config: Config; numPlayers: number; private: boolean },
      player: { loadout: Loadout },
    ) => void;
    joinRoom: (roomId: Ulid, options: { loadout: Loadout }) => void;
    leaveQueue: (queueId: string) => void;
    acceptInvitation: (roomId: Ulid) => void;
  };

// Available Public Rooms ViewData and Props

export type AvailablePublicRoomsViewData<Config> = {
  availablePublicRooms: AvailableRoom<Config>[];
};

export type AvailablePublicRoomsProps<Config> = AvailablePublicRoomsViewData<
  Config
>;

// Active Public Games ViewData and Props

export type ActivePublicGamesViewData<Config> = {
  activePublicGames: ActivePublicGame<Config>[];
};

export type ActivePublicGamesProps<Config> = ActivePublicGamesViewData<
  Config
>;
