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
type JSONValue = AsJson<any>;
// deno-lint-ignore no-explicit-any
type StructuredCloneValue = AsStructuredClone<any>;

export type SetupObject<Config, Player> = {
  timestamp: Date;
  players: Player[];
  config: Config;
};

export type MoveObject<Config, M, Player> = {
  config: Config;
  move: M;
  playerId: number;
  timestamp: Date;
  players: Player[];
};

export type RefreshObject<Config, Player> = {
  config: Config;
  timestamp: Date;
  players: Player[];
};

export type PlayerStateObject<Config, Player> = {
  config: Config;
  playerId: number;
  isComplete: boolean;
  players: Player[];
  timestamp: Date;
};
export type ObserverStateObject<Config, Player> = {
  config: Config;
  isComplete: boolean;
  players: Player[];
  timestamp: Date;
};

export type IsCompleteObject<Config, Player> = {
  config: Config;
  players: Player[];
};

export type Mode<Config> = {
  numPlayers: number;
  matchmaking: "queue";
  config: Config;
};

/**
 * Core interface for implementing turn-based multiplayer games.
 *
 * @template Config - Configuration type that defines game setup parameters (must be compatible with structured clone algorithm)
 * @template GameState - Game state type representing the complete state of the game (must be compatible with structured clone algorithm)
 * @template Move - Move type representing actions players can take (must be JSON serializable)
 * @template Player - Player metadata type (must be JSON serializable)
 * @template PlayerState - Player state type representing game state visible to a specific player (must be JSON serializable)
 * @template ObserverState - Observer state type representing game state visible to observers (must be JSON serializable)
 */
export interface Game<
  Config extends StructuredCloneValue,
  GameState extends StructuredCloneValue,
  Move extends JSONValue,
  Player extends JSONValue,
  PlayerState extends JSONValue,
  ObserverState extends JSONValue,
> {
  /**
   * Defines the available game modes with their configurations.
   * Used for matchmaking and game initialization.
   */
  modes: { [id: string]: Mode<Config> };

  /**
   * Creates the initial game state when a new game is started.
   *
   * @param o - Setup object containing configuration, player information, and timestamp
   * @returns Immutable initial game state
   */
  setup(o: SetupObject<Config, Player>): Readonly<GameState>;

  /**
   * Validates whether a move is legitimate based on current game state.
   * Prevents invalid moves from being processed.
   *
   * @param state - Current immutable game state
   * @param o - Move object containing the move, player ID, configuration, timestamp, and player information
   * @returns True if the move is valid, false otherwise
   */
  isValidMove(
    state: Readonly<GameState>,
    o: MoveObject<Config, Move, Player>,
  ): boolean;

  /**
   * Processes a player's move and updates the game state accordingly.
   * Only called if isValidMove returns true for the given move.
   *
   * @param state - Current immutable game state
   * @param o - Move object containing the move, player ID, configuration, timestamp, and player information
   * @returns Updated immutable game state
   */
  processMove(
    state: Readonly<GameState>,
    o: MoveObject<Config, Move, Player>,
  ): Readonly<GameState>;

  /**
   * Determines the timeout in milliseconds for automatic state refreshes. Called
   * after every successful processMove or refresh call.
   * Don't provide this function to disable automatic refreshes.
   *
   * @param state - Current immutable game state
   * @param o - Refresh object containing configuration, timestamp, and player information
   * @returns Timeout in milliseconds or undefined to disable automatic refreshes
   */
  refreshTimeout?(
    state: Readonly<GameState>,
    o: RefreshObject<Config, Player>,
  ): number | undefined;

  /**
   * Updates the game state during automatic refreshes.
   * Called based on the timeout from refreshTimeout, not in response to moves.
   * Can be used for time-based game mechanics.
   *
   * @param state - Current immutable game state
   * @param o - Refresh object containing configuration, timestamp, and player information
   * @returns Updated immutable game state
   */
  refresh?(
    state: Readonly<GameState>,
    o: RefreshObject<Config, Player>,
  ): Readonly<GameState>;

  /**
   * Creates a player-specific view of the game state.
   * Can be used to hide information from players and provide a UI-friendly representation.
   *
   * @param state - Current immutable game state
   * @param o - Player state object containing player ID, game completion status, configuration, and player information
   * @returns Player-specific state representation
   */
  playerState(
    state: Readonly<GameState>,
    o: PlayerStateObject<Config, Player>,
  ): PlayerState;

  /**
   * Creates an observer-specific view of the game state.
   * Can be used to hide information from observers and provide a UI-friendly representation.
   *
   * @param state - Current immutable game state
   * @param o - Observer state object containing game completion status, configuration, and player information
   * @returns Observer-specific state representation
   */
  observerState(
    state: Readonly<GameState>,
    o: ObserverStateObject<Config, Player>,
  ): ObserverState;

  /**
   * Determines whether the game has ended.
   * When true, no further moves will be accepted.
   *
   * @param state - Current immutable game state
   * @param o - Completion check object containing configuration and player information
   * @returns True if the game is complete, false otherwise
   */
  isComplete(
    state: Readonly<GameState>,
    o: IsCompleteObject<Config, Player>,
  ): boolean;
}

export type ActiveGame = {
  gameId: string;
};

export type PlayerProps<P, Player> = {
  playerId: number;
  playerState: P;
  isComplete: boolean;
  players: Player[];
};

export type ObserverProps<O, Player> = {
  observerState: O;
  isComplete: boolean;
  players: Player[];
};

export type PlayerViewProps<M, P, Player> =
  & PlayerProps<P, Player>
  & {
    perform?: (move: M) => void;
  };

export type ObserveViewProps<O, Player> = ObserverProps<
  O,
  Player
>;

export type LobbyViewProps = {
  activeGames: ActiveGame[];
  joinQueue: (queueId: string) => void;
  isQueued: boolean;
  leaveQueue: () => void;
};
