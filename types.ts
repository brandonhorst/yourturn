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

export type User = {
  username: string;
  isGuest: boolean;
};

export type TokenData = {
  userId: string;
  expiration: Date;
};

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
 * @template Loadout - Player loadout data provided during queue join (must be JSON serializable)
 */
export interface Game<
  Config extends StructuredCloneValue,
  GameState extends StructuredCloneValue,
  Move extends JSONValue,
  PlayerState extends JSONValue,
  PublicState extends JSONValue,
  Outcome extends JSONValue,
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
   * Creates a player-specific view of the game state.
   * Can be used to hide information from players and provide a UI-friendly representation.
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
   * Can be used to hide information from observers and provide a UI-friendly representation.
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
}

export type ActiveGame = {
  gameId: string;
};

export type LobbyProps = {
  activeGames: ActiveGame[];
  user: User;
};

type CompletePlayerProps<PlayerState, PublicState, Outcome> = {
  players: User[];
  publicState: PublicState;
  playerId: number;
  playerState: PlayerState;
  outcome: Outcome;
};

type IncompletePlayerProps<PlayerState, PublicState> = {
  players: User[];
  publicState: PublicState;
  playerId: number;
  playerState: PlayerState;
  outcome: undefined;
};

type CompleteObserverProps<PublicState, Outcome> = {
  players: User[];
  publicState: PublicState;
  playerId: undefined;
  playerState: undefined;
  outcome: Outcome;
};

type IncompleteObserverProps<PublicState> = {
  players: User[];
  publicState: PublicState;
  playerId: undefined;
  playerState: undefined;
  outcome: undefined;
};

export type GameProps<PlayerState, PublicState, Outcome> =
  | CompletePlayerProps<PlayerState, PublicState, Outcome>
  | IncompletePlayerProps<PlayerState, PublicState>
  | CompleteObserverProps<PublicState, Outcome>
  | IncompleteObserverProps<PublicState>;

type IncompletePlayerViewProps<Move, PlayerState, PublicState> =
  & IncompletePlayerProps<PlayerState, PublicState>
  & { perform: (move: Move) => void };

type CompletePlayerViewProps<PlayerState, PublicState, Outcome> =
  & CompletePlayerProps<PlayerState, PublicState, Outcome>
  & { perform: undefined };

type ObserveViewProps<PublicState, Outcome> =
  & (
    | CompleteObserverProps<PublicState, Outcome>
    | IncompleteObserverProps<
      PublicState
    >
  )
  & { perform: undefined };

export type GameViewProps<Move, PlayerState, PublicState, Outcome> =
  | CompletePlayerViewProps<PlayerState, PublicState, Outcome>
  | IncompletePlayerViewProps<Move, PlayerState, PublicState>
  | ObserveViewProps<PublicState, Outcome>;

export type LobbyViewProps<Loadout> =
  & LobbyProps
  & {
    joinQueue: (queueId: string, options: { loadout: Loadout }) => void;
    isQueued: boolean;
    leaveQueue: () => void;
    updateUsername: (username: string) => void;
  };
