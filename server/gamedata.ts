import type { DB, GameStorageData } from "./db.ts";
import type {
  ActiveGame,
  Game,
  IsCompleteObject,
  ObserverStateObject,
  PlayerStateObject,
  RefreshObject,
} from "../types.ts";

export async function fetchActiveGames(db: DB): Promise<ActiveGame[]> {
  return await db.getAllActiveGames();
}

export function getPlayerId<Config, GameState, Player>(
  gameData: GameStorageData<Config, GameState, Player>,
  sessionId: string,
): number {
  const playerId = gameData.sessionTokens[sessionId];
  return playerId;
}

export function getPlayerState<
  Config,
  GameState,
  Player,
  PlayerState,
>(
  gameData: GameStorageData<Config, GameState, Player>,
  playerStateLogic: (
    s: GameState,
    o: PlayerStateObject<Config, Player>,
  ) => PlayerState,
  playerId: number,
): PlayerState {
  const state = gameData.gameState;
  const playerStateObject: PlayerStateObject<Config, Player> = {
    config: gameData.config,
    playerId,
    isComplete: gameData.isComplete,
    players: gameData.players,
    timestamp: new Date(),
  };
  const playerState = playerStateLogic(state, playerStateObject);
  return playerState;
}

export function getObserverState<
  Config,
  GameState,
  Player,
  ObserverState,
>(
  gameData: GameStorageData<Config, GameState, Player>,
  observerStateLogic: (
    s: GameState,
    o: ObserverStateObject<Config, Player>,
  ) => ObserverState,
): ObserverState {
  const state = gameData.gameState;
  const observerStateObject: ObserverStateObject<Config, Player> = {
    isComplete: gameData.isComplete,
    players: gameData.players,
    config: gameData.config,
    timestamp: new Date(),
  };
  const observerState = observerStateLogic(state, observerStateObject);
  return observerState;
}

async function updateGameState<
  Config,
  GameState,
  Move,
  Player,
  PlayerState,
  ObserverState,
>(
  db: DB,
  game: Game<Config, GameState, Move, Player, PlayerState, ObserverState>,
  gameId: string,
  computeNewState: (
    gameData: GameStorageData<Config, GameState, Player>,
  ) => GameState | undefined,
) {
  const gameData = await db.getGameStorageData<Config, GameState, Player>(
    gameId,
  );
  if (gameData.isComplete) {
    return;
  }

  const newState = computeNewState(gameData);
  if (newState === undefined) {
    return;
  }

  const isCompleteObject: IsCompleteObject<Config, Player> = {
    players: gameData.players,
    config: gameData.config,
  };
  const isComplete = game.isComplete(newState, isCompleteObject);

  const newGameData = {
    ...gameData,
    gameState: newState,
    isComplete,
    version: gameData.version + 1,
  };

  // Calculate refresh timeout if game has a refreshTimeout function
  let refreshDelay: number | undefined;
  if (game.refreshTimeout && !isComplete) {
    const refreshObject: RefreshObject<Config, Player> = {
      timestamp: new Date(),
      players: gameData.players,
      config: gameData.config,
    };

    refreshDelay = game.refreshTimeout(newState, refreshObject);
  }

  // Update game data and schedule refresh in a single atomic transaction
  await db.updateGameStorageData(
    gameId,
    newGameData,
    refreshDelay,
  );
}

export async function handleMove<
  Config,
  GameState,
  Move,
  Player,
  PlayerState,
  ObserverState,
>(
  db: DB,
  game: Game<Config, GameState, Move, Player, PlayerState, ObserverState>,
  gameId: string,
  playerId: number,
  move: Move,
) {
  await updateGameState(db, game, gameId, (gameData) => {
    const moveData = {
      playerId,
      timestamp: new Date(),
      move,
      players: gameData.players,
      config: gameData.config,
    };

    const state = gameData.gameState;
    if (!game.isValidMove(state, moveData)) {
      return undefined;
    }

    return game.processMove(state, moveData);
  });
}

export async function handleRefresh<
  Config,
  GameState,
  Move,
  Player,
  PlayerState,
  ObserverState,
>(
  db: DB,
  game: Game<Config, GameState, Move, Player, PlayerState, ObserverState>,
  gameId: string,
) {
  await updateGameState(db, game, gameId, (gameData) => {
    const state = gameData.gameState;

    // If game.refersh is not provided, just return and do the update as normal.
    if (!game.refresh) {
      return state;
    }

    const refreshData: RefreshObject<Config, Player> = {
      timestamp: new Date(),
      players: gameData.players,
      config: gameData.config,
    };

    return game.refresh(state, refreshData);
  });
}
