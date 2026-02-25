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

export type PlayerSnapshot<Rating> = {
  userId: string;
  username: string;
  isGuest: boolean;
  rating: Record<string, Rating>;
};

export type CompletedMatchSnapshot<Config, Outcome, Rating> = {
  matchId: string;
  queueId?: string;
  players: PlayerSnapshot<Rating>[];
  config: Config;
  outcome: Outcome;
  completed: Date;
};

export type UserProfileViewData<Config, Outcome, Rating> = {
  userId: string;
  username: string;
  isGuest: boolean;
  rating: Record<string, Rating>;
  description: string;
  completedMatches: CompletedMatchSnapshot<Config, Outcome, Rating>[];
};

export type UserProfileUpdate = {
  description?: string;
};

export type TokenData = {
  userId: string;
  expiration: Date;
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
export interface Server<
  Config,
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Rating,
  Loadout,
> {
  getUserMatchmakingViewData(
    userId: string,
  ): Promise<
    { props: UserMatchmakingViewData<Config, Loadout, Rating>; token: string }
  >;
  getActivePublicMatchesViewData(): Promise<
    ActivePublicMatchesViewData<Config, Rating>
  >;
  getActivePublicUsersViewData(): Promise<ActiveUsersViewData<Rating>>;
  getAvailablePublicRoomsViewData(): Promise<
    AvailablePublicRoomsViewData<Config, Rating>
  >;
  getUserProfileViewData(
    userId: string,
  ): Promise<UserProfileViewData<Config, Outcome, Rating>>;
  getMatchViewData(
    matchId: string,
    userId: string,
  ): Promise<MatchViewData<PlayerState, PublicState, Outcome, Rating>>;
  configureSocket(socket: WebSocket, userId: string): void;
  resolveToken(token: string | undefined): Promise<string>;
}

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
 * @template Outcome - Outcome type representing game results (must be JSON serializable)
 * @template Rating - Rating type representing a player's ranking (must be JSON serializable)
 * @template Loadout - Player loadout data provided during queue join (must be JSON serializable)
 */
export interface GameDefinition<
  Config extends StructuredCloneValue,
  GameState extends StructuredCloneValue,
  Move extends JSONValue,
  PlayerState extends JSONValue,
  PublicState extends JSONValue,
  Outcome extends JSONValue,
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
   * Reserved for future time-based mechanics.
   *
   * @param state - Current immutable game state
   * @param o - Refresh object containing configuration, timestamp, and player count
   * @returns Timeout in milliseconds or undefined
   */
  refreshTimeout?(
    state: Readonly<GameState>,
    o: RefreshObject<Config>,
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

// ViewData and Props

export type ActiveMatch<Config, Rating> = {
  matchId: string;
  players: PlayerSnapshot<Rating>[];
  config: Config;
  created: Date;
};

export type AvailableRoom<Config, Rating> = {
  roomId: string;
  numPlayers: number;
  players: PlayerSnapshot<Rating>[];
  config: Config;
};

export type RoomEntry<Config, Loadout, Rating> = {
  roomId: string;
  numPlayers: number;
  players: PlayerSnapshot<Rating>[];
  config: Config;
  loadout: Loadout;
};

export type QueueEntry<Loadout> = {
  queueId: string;
  loadout: Loadout;
};

export type ActivePublicMatchesViewData<Config, Rating> = {
  allActiveMatches: ActiveMatch<Config, Rating>[];
};

export type ActiveUsersViewData<Rating> = {
  allActiveUsers: PlayerSnapshot<Rating>[];
};

export type AvailablePublicRoomsViewData<Config, Rating> = {
  allAvailableRooms: AvailableRoom<Config, Rating>[];
};

export type UserMatchmakingViewData<Config, Loadout, Rating> = {
  userActiveMatches: ActiveMatch<Config, Rating>[];
  roomIds: string[];
  queueEntries: QueueEntry<Loadout>[];
};

type CompletePlayerViewData<PlayerState, PublicState, Outcome, Rating> = {
  players: PlayerSnapshot<Rating>[];
  publicState: PublicState;
  playerId: number;
  playerState: PlayerState;
  outcome: Outcome;
};

type IncompletePlayerViewData<PlayerState, PublicState, Rating> = {
  players: PlayerSnapshot<Rating>[];
  publicState: PublicState;
  playerId: number;
  playerState: PlayerState;
  outcome: undefined;
};

type CompleteObserverViewData<PublicState, Outcome, Rating> = {
  players: PlayerSnapshot<Rating>[];
  publicState: PublicState;
  playerId: undefined;
  playerState: undefined;
  outcome: Outcome;
};

type IncompleteObserverViewData<PublicState, Rating> = {
  players: PlayerSnapshot<Rating>[];
  publicState: PublicState;
  playerId: undefined;
  playerState: undefined;
  outcome: undefined;
};

export type MatchViewData<PlayerState, PublicState, Outcome, Rating> =
  | CompletePlayerViewData<PlayerState, PublicState, Outcome, Rating>
  | IncompletePlayerViewData<PlayerState, PublicState, Rating>
  | CompleteObserverViewData<PublicState, Outcome, Rating>
  | IncompleteObserverViewData<PublicState, Rating>;

type IncompletePlayerProps<Move, PlayerState, PublicState, Rating> =
  & IncompletePlayerViewData<PlayerState, PublicState, Rating>
  & { perform: (move: Move) => void };

type CompletePlayerProps<PlayerState, PublicState, Outcome, Rating> =
  & CompletePlayerViewData<PlayerState, PublicState, Outcome, Rating>
  & { perform: undefined };

type ObserveProps<PublicState, Outcome, Rating> =
  & (
    | CompleteObserverViewData<PublicState, Outcome, Rating>
    | IncompleteObserverViewData<
      PublicState,
      Rating
    >
  )
  & { perform: undefined };

export type MatchProps<Move, PlayerState, PublicState, Outcome, Rating> =
  | CompletePlayerProps<PlayerState, PublicState, Outcome, Rating>
  | IncompletePlayerProps<Move, PlayerState, PublicState, Rating>
  | ObserveProps<PublicState, Outcome, Rating>;

export type UserMatchmakingProps<Config, Loadout, Rating> =
  & UserMatchmakingViewData<Config, Loadout, Rating>
  & {
    joinQueue: (queueId: string, options: { loadout: Loadout }) => void;
    leaveQueue: (queueId: string) => void;
    createAndJoinRoom: (
      options: { config: Config; numPlayers: number; private: boolean },
      player: { loadout: Loadout },
    ) => void;
    joinRoom: (roomId: string, options: { loadout: Loadout }) => void;
  };

export type AccountUserProfileProps<Config, Outcome, Rating> =
  & UserProfileViewData<Config, Outcome, Rating>
  & {
    update: (changes: UserProfileUpdate) => void;
  };

export type RoomProps<Config, Loadout, Rating> =
  & RoomEntry<Config, Loadout, Rating>
  & {
    commitRoom: () => void;
    leaveRoom: () => void;
  };
