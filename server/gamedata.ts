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

export function getPlayerId<C, S>(
  gameData: GameStorageData<C, S>,
  sessionId: string,
): number {
  const playerId = gameData.sessionTokens[sessionId];
  return playerId;
}

export function getPlayerState<C, S, P>(
  gameData: GameStorageData<C, S>,
  playerStateLogic: (s: S, o: PlayerStateObject<C>) => P,
  playerId: number,
): P {
  const state = gameData.gameState;
  const playerStateObject: PlayerStateObject<C> = {
    config: gameData.config,
    playerId,
    isComplete: gameData.isComplete,
    players: gameData.players,
    timestamp: new Date(),
  };
  const playerState = playerStateLogic(state, playerStateObject);
  return playerState;
}

export function getObserverState<C, S, O>(
  gameData: GameStorageData<C, S>,
  observerStateLogic: (s: S, o: ObserverStateObject<C>) => O,
): O {
  const state = gameData.gameState;
  const observerStateObject: ObserverStateObject<C> = {
    isComplete: gameData.isComplete,
    players: gameData.players,
    config: gameData.config,
    timestamp: new Date(),
  };
  const observerState = observerStateLogic(state, observerStateObject);
  return observerState;
}

async function updateGameState<C, S, M, P, O>(
  db: DB,
  game: Game<C, S, M, P, O>,
  gameId: string,
  computeNewState: (gameData: GameStorageData<C, S>) => S | undefined,
) {
  const gameData = await db.getGameStorageData<C, S>(gameId);
  if (gameData.isComplete) {
    return;
  }

  const newState = computeNewState(gameData);
  if (newState === undefined) {
    return;
  }

  const isCompleteObject: IsCompleteObject<C> = {
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
    const refreshObject: RefreshObject<C> = {
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

export async function handleMove<C, S, M, P, O>(
  db: DB,
  game: Game<C, S, M, P, O>,
  gameId: string,
  playerId: number,
  move: M,
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

export async function handleRefresh<C, S, M, P, O>(
  db: DB,
  game: Game<C, S, M, P, O>,
  gameId: string,
) {
  await updateGameState(db, game, gameId, (gameData) => {
    const state = gameData.gameState;

    // If game.refersh is not provided, just return and do the update as normal.
    if (!game.refresh) {
      return state;
    }

    const refreshData: RefreshObject<C> = {
      timestamp: new Date(),
      players: gameData.players,
      config: gameData.config,
    };

    return game.refresh(state, refreshData);
  });
}
