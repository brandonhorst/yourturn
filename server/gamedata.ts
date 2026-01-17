import type { DB, GameStorageData } from "./db.ts";
import type {
  ActiveGame,
  Game,
  IsCompleteObject,
  PlayerStateObject,
  PublicStateObject,
  RefreshObject,
} from "../types.ts";

export async function fetchActiveGames(db: DB): Promise<ActiveGame[]> {
  return await db.getAllActiveGames();
}

export function getPlayerId<Config, GameState>(
  gameData: GameStorageData<Config, GameState>,
  userId: string,
): number | undefined {
  const playerId = gameData.playerUserIds.indexOf(userId);
  if (playerId === -1) {
    return undefined;
  }
  return playerId;
}

export function getPlayerState<Config, GameState, PlayerState>(
  gameData: GameStorageData<Config, GameState>,
  playerStateLogic: (s: GameState, o: PlayerStateObject<Config>) => PlayerState,
  playerId: number,
): PlayerState {
  const state = gameData.gameState;
  const playerStateObject: PlayerStateObject<Config> = {
    config: gameData.config,
    playerId,
    isComplete: gameData.isComplete,
    players: gameData.players,
    timestamp: new Date(),
  };
  const playerState = playerStateLogic(state, playerStateObject);
  return playerState;
}

export function getPublicState<Config, GameState, PublicState>(
  gameData: GameStorageData<Config, GameState>,
  publicStateLogic: (
    s: GameState,
    o: PublicStateObject<Config>,
  ) => PublicState,
): PublicState {
  const state = gameData.gameState;
  const publicStateObject: PublicStateObject<Config> = {
    isComplete: gameData.isComplete,
    players: gameData.players,
    config: gameData.config,
    timestamp: new Date(),
  };
  const publicState = publicStateLogic(state, publicStateObject);
  return publicState;
}

async function updateGameState<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
>(
  db: DB,
  game: Game<Config, GameState, Move, PlayerState, PublicState>,
  gameId: string,
  computeNewState: (
    gameData: GameStorageData<Config, GameState>,
  ) => GameState | undefined,
) {
  const gameData = await db.getGameStorageData<Config, GameState>(gameId);
  if (gameData.isComplete) {
    return;
  }

  const newState = computeNewState(gameData);
  if (newState === undefined) {
    return;
  }

  const isCompleteObject: IsCompleteObject<Config> = {
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
    const refreshObject: RefreshObject<Config> = {
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
  PlayerState,
  PublicState,
>(
  db: DB,
  game: Game<Config, GameState, Move, PlayerState, PublicState>,
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
  PlayerState,
  PublicState,
>(
  db: DB,
  game: Game<Config, GameState, Move, PlayerState, PublicState>,
  gameId: string,
) {
  await updateGameState(db, game, gameId, (gameData) => {
    const state = gameData.gameState;

    // If game.refersh is not provided, just return and do the update as normal.
    if (!game.refresh) {
      return state;
    }

    const refreshData: RefreshObject<Config> = {
      timestamp: new Date(),
      players: gameData.players,
      config: gameData.config,
    };

    return game.refresh(state, refreshData);
  });
}
