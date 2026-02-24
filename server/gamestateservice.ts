import type { DB, GameStorageData } from "./db.ts";
import type {
  Game,
  OutcomeObject,
  PlayerStateObject,
  PublicStateObject,
} from "../types.ts";

type GameStateUpdate<PlayerState, PublicState, Outcome> = {
  playerState: PlayerState | undefined;
  publicState: PublicState;
  outcome: Outcome | undefined;
};

/**
 * Encapsulates game-derived state projection and move processing helpers.
 */
export class GameStateService<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Rating,
  Loadout,
> {
  constructor(
    private readonly game: Game<
      Config,
      GameState,
      Move,
      PlayerState,
      PublicState,
      Outcome,
      Rating,
      Loadout
    >,
  ) {}

  /**
   * Resolves a user's player index for a game, if they are a participant.
   */
  getPlayerId(
    gameData: GameStorageData<Config, GameState, Outcome, Rating>,
    userId: string,
  ): number | undefined {
    const playerId = gameData.userIds.indexOf(userId);
    if (playerId === -1) {
      return undefined;
    }
    return playerId;
  }

  /**
   * Produces a player-scoped view of game state for one participant.
   */
  getPlayerState(
    gameData: GameStorageData<Config, GameState, Outcome, Rating>,
    playerId: number,
    timestamp: Date = new Date(),
  ): PlayerState {
    const state = gameData.gameState;
    const numPlayers = gameData.userIds.length;
    const playerStateObject: PlayerStateObject<Config> = {
      config: gameData.config,
      playerId,
      numPlayers,
      timestamp,
    };
    return this.game.playerState(state, playerStateObject);
  }

  /**
   * Produces the observer-visible view of game state.
   */
  getPublicState(
    gameData: GameStorageData<Config, GameState, Outcome, Rating>,
    timestamp: Date = new Date(),
  ): PublicState {
    const state = gameData.gameState;
    const numPlayers = gameData.userIds.length;
    const publicStateObject: PublicStateObject<Config> = {
      config: gameData.config,
      numPlayers,
      timestamp,
    };
    return this.game.publicState(state, publicStateObject);
  }

  /**
   * Builds update payload fields for one game's public and player-specific view.
   */
  buildGameStateUpdate(
    gameData: GameStorageData<Config, GameState, Outcome, Rating>,
    playerId: number | undefined,
    options?: { timestamp?: Date; publicState?: PublicState },
  ): GameStateUpdate<PlayerState, PublicState, Outcome> {
    const timestamp = options?.timestamp ?? new Date();
    const publicState = options?.publicState ??
      this.getPublicState(gameData, timestamp);
    const playerState = playerId == null
      ? undefined
      : this.getPlayerState(gameData, playerId, timestamp);

    return {
      playerState,
      publicState,
      outcome: gameData.outcome,
    };
  }

  /**
   * Validates a loadout for a config using the game's loadout validator.
   * When a game omits isValidLoadout, every loadout is treated as valid.
   */
  isValidLoadout(loadout: Loadout, config: Config): boolean {
    return this.game.isValidLoadout?.(loadout, config) ?? true;
  }

  /**
   * Validates and applies one move for a player in an active game.
   */
  async handleMove(
    db: DB<
      Config,
      GameState,
      Move,
      PlayerState,
      PublicState,
      Outcome,
      Rating,
      Loadout
    >,
    gameId: string,
    playerId: number,
    move: Move,
  ): Promise<void> {
    await this.updateGameState(db, gameId, (gameData) => {
      const moveData = {
        playerId,
        timestamp: new Date(),
        move,
        config: gameData.config,
        numPlayers: gameData.userIds.length,
      };

      const state = gameData.gameState;
      if (!this.game.isValidMove(state, moveData)) {
        return undefined;
      }

      return this.game.processMove(state, moveData);
    });
  }

  /**
   * Applies a state transition and persists post-game ranked rating updates.
   */
  private async updateGameState(
    db: DB<
      Config,
      GameState,
      Move,
      PlayerState,
      PublicState,
      Outcome,
      Rating,
      Loadout
    >,
    gameId: string,
    computeNewState: (
      gameData: GameStorageData<Config, GameState, Outcome, Rating>,
    ) => GameState | undefined,
  ): Promise<void> {
    const gameData = await db.getGameStorageData(gameId);
    if (gameData.outcome !== undefined) {
      return;
    }

    const newState = computeNewState(gameData);
    if (newState === undefined) {
      return;
    }

    const outcomeObject: OutcomeObject<Config> = {
      config: gameData.config,
      numPlayers: gameData.userIds.length,
    };
    const outcome = this.game.outcome(newState, outcomeObject);

    const newGameData = {
      ...gameData,
      gameState: newState,
      outcome,
    };

    await db.updateGameStorageData(gameId, newGameData);

    if (outcome == null) {
      return;
    }

    const queueId = gameData.queueId;
    if (queueId == null) {
      return;
    }

    const queueConfig = this.game.queues[queueId];
    if (queueConfig?.queueType !== "ranked") {
      return;
    }

    const userEntries = await Promise.all(
      gameData.userIds.map((userId) => db.getUserStorageData(userId)),
    );

    const currentRatings = userEntries.map((entry) =>
      entry?.ratings[queueId] ?? this.game.initialRating()
    );
    const updatedRatings = this.game.processOutcome(outcome, currentRatings);

    if (updatedRatings.length !== gameData.userIds.length) {
      throw new Error("processOutcome returned unexpected ratings length");
    }

    // Persist ratings per user in player order.
    await Promise.all(
      gameData.userIds.map((userId, index) => {
        const entry = userEntries[index];
        if (entry == null) {
          return Promise.resolve();
        }
        const ratings = { ...entry.ratings, [queueId]: updatedRatings[index] };
        return db.updateUserStorageData(userId, { ratings });
      }),
    );
  }
}
