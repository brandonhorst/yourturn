import type { DB, MatchStorageData } from "./db.ts";
import type {
  GameDefinition,
  GameTypes,
  OutcomeObject,
  PlayerStateObject,
  PublicStateObject,
} from "../types.ts";

type GameStateUpdate<T extends GameTypes> = {
  playerState: T["PlayerState"] | undefined;
  publicState: T["PublicState"];
  outcome: T["Outcome"] | undefined;
};

/**
 * Encapsulates game-derived state projection and move processing helpers.
 */
export class GameStateService<
  T extends GameTypes,
> {
  constructor(
    private readonly game: GameDefinition<T>,
  ) {}

  /**
   * Resolves a user's player index for a game, if they are a participant.
   */
  getPlayerId(
    gameData: MatchStorageData<T>,
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
    gameData: MatchStorageData<T>,
    playerId: number,
    timestamp: Date = new Date(),
  ): T["PlayerState"] {
    const state = gameData.gameState;
    const numPlayers = gameData.userIds.length;
    const playerStateObject: PlayerStateObject<T> = {
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
    gameData: MatchStorageData<T>,
    timestamp: Date = new Date(),
  ): T["PublicState"] {
    const state = gameData.gameState;
    const numPlayers = gameData.userIds.length;
    const publicStateObject: PublicStateObject<T> = {
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
    gameData: MatchStorageData<T>,
    playerId: number | undefined,
    options?: { timestamp?: Date; publicState?: T["PublicState"] },
  ): GameStateUpdate<T> {
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
  isValidLoadout(
    loadout: T["Loadout"],
    config: T["Config"],
  ): boolean {
    return this.game.isValidLoadout?.(loadout, config) ?? true;
  }

  /**
   * Validates and applies one move for a player in an active game.
   */
  async handleMove(
    db: DB<T>,
    matchId: string,
    playerId: number,
    move: T["Move"],
  ): Promise<void> {
    await this.updateGameState(db, matchId, playerId, (gameData) => {
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
    db: DB<T>,
    matchId: string,
    actorPlayerId: number,
    computeNewState: (
      gameData: MatchStorageData<T>,
    ) => T["GameState"] | undefined,
  ): Promise<void> {
    const gameData = await db.getMatchStorageData(matchId);
    if (gameData.outcome !== undefined) {
      return;
    }

    const newState = computeNewState(gameData);
    if (newState === undefined) {
      return;
    }

    const outcomeObject: OutcomeObject<T> = {
      config: gameData.config,
      numPlayers: gameData.userIds.length,
    };
    const outcome = this.game.outcome(newState, outcomeObject);

    const newGameData = {
      ...gameData,
      gameState: newState,
      outcome,
    };

    const actorUserId = gameData.userIds[actorPlayerId];
    if (actorUserId == null) {
      throw new Error(`Player ${actorPlayerId} is not in match ${matchId}`);
    }

    await db.updateMatchStorageData(matchId, newGameData, actorUserId);

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
        return db.updateUserStorageData(
          userId,
          { ratings },
          { actorUserId },
        );
      }),
    );
  }
}
