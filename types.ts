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

export type SetupObject<Config> = {
  timestamp: Date;
  players: User[];
  config: Config;
};

export type MoveObject<Config, Move> = {
  config: Config;
  move: Move;
  playerId: number;
  timestamp: Date;
  players: User[];
};

export type RefreshObject<Config> = {
  config: Config;
  timestamp: Date;
  players: User[];
};

export type PlayerStateObject<Config> = {
  config: Config;
  playerId: number;
  isComplete: boolean;
  players: User[];
  timestamp: Date;
};
export type ObserverStateObject<Config> = {
  config: Config;
  isComplete: boolean;
  players: User[];
  timestamp: Date;
};

export type IsCompleteObject<Config> = {
  config: Config;
  players: User[];
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
 * @template PlayerState - Player state type representing game state visible to a specific player (must be JSON serializable)
 * @template ObserverState - Observer state type representing game state visible to observers (must be JSON serializable)
 */
export interface Game<
  Config extends StructuredCloneValue,
  GameState extends StructuredCloneValue,
  Move extends JSONValue,
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
  setup(o: SetupObject<Config>): Readonly<GameState>;

  /**
   * Validates whether a move is legitimate based on current game state.
   * Prevents invalid moves from being processed.
   *
   * @param state - Current immutable game state
   * @param o - Move object containing the move, player ID, configuration, timestamp, and player information
   * @returns True if the move is valid, false otherwise
   */
  isValidMove(state: Readonly<GameState>, o: MoveObject<Config, Move>): boolean;

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
    o: MoveObject<Config, Move>,
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
    o: RefreshObject<Config>,
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
    o: RefreshObject<Config>,
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
    o: PlayerStateObject<Config>,
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
    o: ObserverStateObject<Config>,
  ): ObserverState;

  /**
   * Determines whether the game has ended.
   * When true, no further moves will be accepted.
   *
   * @param state - Current immutable game state
   * @param o - Completion check object containing configuration and player information
   * @returns True if the game is complete, false otherwise
   */
  isComplete(state: Readonly<GameState>, o: IsCompleteObject<Config>): boolean;
}

export type ActiveGame = {
  gameId: string;
};

export type LobbyProps = {
  activeGames: ActiveGame[];
  user: User;
};

type PlayerProps<PlayerState> = {
  mode: "player";
  isComplete: boolean;
  players: User[];
  playerId: number;
  playerState: PlayerState;
};

type ObserverProps<ObserverState> = {
  mode: "observer";
  isComplete: boolean;
  players: User[];
  observerState: ObserverState;
};

export type GameProps<PlayerState, ObserverState> =
  | PlayerProps<PlayerState>
  | ObserverProps<ObserverState>;

type PlayerViewProps<Move, PlayerState> = PlayerProps<PlayerState> & {
  perform?: (move: Move) => void;
};

type ObserveViewProps<ObserverState> = ObserverProps<ObserverState>;

export type GameViewProps<Move, PlayerState, ObserverState> =
  | PlayerViewProps<Move, PlayerState>
  | ObserveViewProps<ObserverState>;

export type LobbyViewProps = LobbyProps & {
  joinQueue: (queueId: string) => void;
  isQueued: boolean;
  leaveQueue: () => void;
  updateUsername: (username: string) => void;
};
