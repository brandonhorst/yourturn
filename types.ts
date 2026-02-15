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
  getUser(token: string | undefined): Promise<{ user: User; token: string }>;

  getInitialActivePublicGames(): Promise<ActiveGame<Config>[]>;

  getInitialAvailablePublicRooms(): Promise<AvailableRoom<Config>[]>;

  getInitialUserViewData(
    user: User,
  ): Promise<UserMatchmakingViewData<Config, Loadout, Rating>>;

  getInitialRoomViewData(
    user: User,
    roomId: string,
  ): Promise<RoomViewData<Config, Loadout>>;

  getInitialGameViewData(
    user: User,
    gameId: string,
  ): Promise<GameViewData<PlayerState, PublicState, Outcome>>;

  configureSocket(user: User, socket: WebSocket): void;

  acceptInvitation(user: User, invitationId: string): void;
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
// deno-lint-ignore no-explicit-any
type StructuredCloneValue = AsStructuredClone<any>;

export type User = {
  userId: string;
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
export interface Game<
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

export type ActiveGame<Config> = {
  gameId: string;
  players: Player[];
  config: Config;
  created: Date;
};

export type AvailableRoom<Config> = {
  roomId: string;
  numPlayers: number;
  players: Player[];
  config: Config;
};

export type RoomInvitation<Config> = {
  invitationId: string;
  roomId: string;
  numPlayers: number;
  config: Config;
  invitedBy: Player;
  invitedAt: Date;
};

export type RoomEntry<Config, Loadout> = {
  roomId: string;
  numPlayers: number;
  players: Player[];
  config: Config;
  loadout: Loadout;
};

export type QueueEntry<Loadout> = {
  queueId: string;
  loadout: Loadout;
};

// Room ViewData and Props

export type RoomViewData<Config, Loadout> = {
  numPlayers: number;
  players: User[];
  config: Config;
  loadout: Loadout;
};

export type RoomProps<Config, Loadout> =
  & RoomViewData<Config, Loadout>
  & {
    leaveRoom: () => void;
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
  outcome: undefined;
};

type CompleteObserverGameViewData<PublicState, Outcome> = {
  players: User[];
  publicState: PublicState;
  playerId: undefined;
  playerState: undefined;
  outcome: Outcome;
};

type IncompleteObserverGameViewData<PublicState> = {
  players: User[];
  publicState: PublicState;
  playerId: undefined;
  playerState: undefined;
  outcome: undefined;
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

export type UserMatchmakingViewData<Config, Loadout, Rating> = {
  userActiveGames: ActiveGame<Config>[];
  ratings: Record<string, Rating>;
  roomEntries: RoomEntry<Config, Loadout>[];
  queueEntries: QueueEntry<Loadout>[];
  roomInvitations: RoomInvitation<Config>[];
};

export type UserMatchmakingProps<Config, Loadout, Rating> =
  & UserMatchmakingViewData<Config, Loadout, Rating>
  & {
    joinQueue: (queueId: string, options: { loadout: Loadout }) => void;
    createAndJoinRoom: (
      options: { config: Config; numPlayers: number; private: boolean },
      player: { loadout: Loadout },
    ) => void;
    createInvitation: (roomId: string) => string;
    joinRoom: (roomId: string, options: { loadout: Loadout }) => void;
    inviteUser: (roomId: string, userId: string) => void;
    commitRoom: (roomId: string) => void;
    leaveQueue: (queueId: string) => void;
    leaveRoom: (roomId: string) => void;
    updateUsername: (username: string) => void;
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
  activePublicGames: ActiveGame<Config>[];
};

export type ActivePublicGamesProps<Config> = ActivePublicGamesViewData<
  Config
>;
