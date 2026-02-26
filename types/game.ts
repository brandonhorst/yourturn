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
 */
export interface GameDefinition<T extends GameTypes> {
  /**
   * Defines the available game queues with their configurations.
   */
  queues: { [id: string]: QueueConfig<T> };

  /**
   * Creates the initial game state when a new game is started.
   */
  setup(o: SetupObject<T>): Readonly<T["GameState"]>;

  /**
   * Validates whether a move is legitimate based on current game state.
   */
  isValidMove(
    state: Readonly<T["GameState"]>,
    o: MoveObject<T>,
  ): boolean;

  /**
   * Validates whether a loadout is acceptable for the given game configuration.
   * When omitted, loadouts are assumed valid.
   */
  isValidLoadout?(loadout: T["Loadout"], config: T["Config"]): boolean;

  /**
   * Validates whether a room configuration is acceptable.
   * When omitted, rooms cannot be created or joined.
   */
  isValidRoom?(config: T["Config"]): boolean;

  /**
   * Processes a player's move and updates the game state accordingly.
   */
  processMove(
    state: Readonly<T["GameState"]>,
    o: MoveObject<T>,
  ): Readonly<T["GameState"]>;

  /**
   * Reserved for future time-based mechanics.
   */
  refreshTimeout?(
    state: Readonly<T["GameState"]>,
    o: RefreshObject<T>,
  ): number | undefined;

  /**
   * Creates a player-specific view of the game state.
   */
  playerState(
    state: Readonly<T["GameState"]>,
    o: PlayerStateObject<T>,
  ): T["PlayerState"];

  /**
   * Creates an observer-specific view of the game state.
   */
  publicState(
    state: Readonly<T["GameState"]>,
    o: PublicStateObject<T>,
  ): T["PublicState"];

  /**
   * Determines the game outcome.
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
   */
  processOutcome(
    outcome: T["Outcome"],
    currentRatings: T["Rating"][],
  ): T["Rating"][];
}
