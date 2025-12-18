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

export function getPlayerId<C, S, I extends string | number>(
  gameData: GameStorageData<C, S, I>,
  sessionId: string,
): I {
  const playerId = gameData.sessionTokens[sessionId];
  return playerId;
}

export function getPlayerState<C, S, P, I extends string | number>(
  gameData: GameStorageData<C, S, I>,
  playerStateLogic: (s: S, o: PlayerStateObject<C, I>) => P,
  playerId: I,
): P {
  const state = gameData.gameState;
  const playerStateObject: PlayerStateObject<C, I> = {
    config: gameData.config,
    playerId,
    isComplete: gameData.isComplete,
    players: gameData.players,
    timestamp: new Date(),
  };
  const playerState = playerStateLogic(state, playerStateObject);
  return playerState;
}

export function getObserverState<C, S, O, I extends string | number>(
  gameData: GameStorageData<C, S, I>,
  observerStateLogic: (s: S, o: ObserverStateObject<C, I>) => O,
): O {
  const state = gameData.gameState;
  const observerStateObject: ObserverStateObject<C, I> = {
    isComplete: gameData.isComplete,
    players: gameData.players,
    config: gameData.config,
    timestamp: new Date(),
  };
  const observerState = observerStateLogic(state, observerStateObject);
  return observerState;
}

async function updateGameState<C, S, M, P, O, I extends string | number>(
  db: DB,
  game: Game<C, S, M, P, O, I>,
  gameId: string,
  computeNewState: (gameData: GameStorageData<C, S, I>) => S | undefined,
) {
  const gameData = await db.getGameStorageData<C, S, I>(gameId);
  if (gameData.isComplete) {
    return;
  }

  const newState = computeNewState(gameData);
  if (newState === undefined) {
    return;
  }

  const isCompleteObject: IsCompleteObject<C, I> = {
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
    const refreshObject: RefreshObject<C, I> = {
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

export async function handleMove<C, S, M, P, O, I extends string | number>(
  db: DB,
  game: Game<C, S, M, P, O, I>,
  gameId: string,
  playerId: I,
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

export async function handleRefresh<C, S, M, P, O, I extends string | number>(
  db: DB,
  game: Game<C, S, M, P, O, I>,
  gameId: string,
) {
  await updateGameState(db, game, gameId, (gameData) => {
    const state = gameData.gameState;

    // If game.refersh is not provided, just return and do the update as normal.
    if (!game.refresh) {
      return state;
    }

    const refreshData: RefreshObject<C, I> = {
      timestamp: new Date(),
      players: gameData.players,
      config: gameData.config,
    };

    return game.refresh(state, refreshData);
  });
}
