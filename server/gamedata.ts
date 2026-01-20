import type { DB, GameStorageData } from "./db.ts";
import type {
  ActiveGame,
  Game,
  OutcomeObject,
  PlayerStateObject,
  PublicStateObject,
} from "../types.ts";

export async function fetchActiveGames(db: DB): Promise<ActiveGame[]> {
  return await db.getAllActiveGames();
}

export function getPlayerId<Config, GameState, Outcome>(
  gameData: GameStorageData<Config, GameState, Outcome>,
  userId: string,
): number | undefined {
  const playerId = gameData.playerUserIds.indexOf(userId);
  if (playerId === -1) {
    return undefined;
  }
  return playerId;
}

export function getPlayerState<Config, GameState, PlayerState, Outcome>(
  gameData: GameStorageData<Config, GameState, Outcome>,
  playerStateLogic: (
    s: GameState,
    o: PlayerStateObject<Config>,
  ) => PlayerState,
  playerId: number,
): PlayerState {
  const state = gameData.gameState;
  const numPlayers = gameData.playerUserIds.length;
  const playerStateObject: PlayerStateObject<Config> = {
    config: gameData.config,
    playerId,
    numPlayers,
    timestamp: new Date(),
  };
  const playerState = playerStateLogic(state, playerStateObject);
  return playerState;
}

export function getPublicState<Config, GameState, PublicState, Outcome>(
  gameData: GameStorageData<Config, GameState, Outcome>,
  publicStateLogic: (
    s: GameState,
    o: PublicStateObject<Config>,
  ) => PublicState,
): PublicState {
  const state = gameData.gameState;
  const numPlayers = gameData.playerUserIds.length;
  const publicStateObject: PublicStateObject<Config> = {
    config: gameData.config,
    numPlayers,
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
  Outcome,
  Loadout,
>(
  db: DB,
  game: Game<
    Config,
    GameState,
    Move,
    PlayerState,
    PublicState,
    Outcome,
    Loadout
  >,
  gameId: string,
  computeNewState: (
    gameData: GameStorageData<Config, GameState, Outcome>,
  ) => GameState | undefined,
) {
  const gameData = await db.getGameStorageData<Config, GameState, Outcome>(
    gameId,
  );
  if (gameData.outcome !== undefined) {
    return;
  }

  const newState = computeNewState(gameData);
  if (newState === undefined) {
    return;
  }

  const outcomeObject: OutcomeObject<Config> = {
    config: gameData.config,
    numPlayers: gameData.playerUserIds.length,
  };
  const outcome = game.outcome(newState, outcomeObject);
  const isComplete = outcome !== undefined;

  const newGameData = {
    ...gameData,
    gameState: newState,
    outcome,
    version: gameData.version + 1,
  };

  await db.updateGameStorageData(gameId, newGameData);
}

export async function handleMove<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Loadout,
>(
  db: DB,
  game: Game<
    Config,
    GameState,
    Move,
    PlayerState,
    PublicState,
    Outcome,
    Loadout
  >,
  gameId: string,
  playerId: number,
  move: Move,
) {
  await updateGameState(db, game, gameId, (gameData) => {
    const moveData = {
      playerId,
      timestamp: new Date(),
      move,
      config: gameData.config,
      numPlayers: gameData.playerUserIds.length,
    };

    const state = gameData.gameState;
    if (!game.isValidMove(state, moveData)) {
      return undefined;
    }

    return game.processMove(state, moveData);
  });
}
