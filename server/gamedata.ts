import type { DB, GameStorageData } from "./db.ts";
import type {
  ActiveGame,
  AvailableRoom,
  ChatMessage,
  Game,
  OutcomeObject,
  PlayerStateObject,
  PublicStateObject,
} from "../types.ts";

export async function fetchActiveGames<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Loadout,
  Outcome,
  Rating,
>(
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
): Promise<ActiveGame<Config>[]> {
  return await db.getAllActiveGames();
}

export async function fetchAvailableRooms<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Loadout,
  Outcome,
  Rating,
>(
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
): Promise<AvailableRoom<Config>[]> {
  return await db.getAllAvailableRooms();
}

export function getPlayerId<Config, GameState, Outcome>(
  gameData: GameStorageData<Config, GameState, Outcome>,
  userId: string,
): number | undefined {
  const playerId = gameData.userIds.indexOf(userId);
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
  const numPlayers = gameData.userIds.length;
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
  const numPlayers = gameData.userIds.length;
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
  Rating,
  Loadout,
>(
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
  game: Game<
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
    gameData: GameStorageData<Config, GameState, Outcome>,
  ) => GameState | undefined,
) {
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
  const outcome = game.outcome(newState, outcomeObject);

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

  const queueConfig = game.queues[queueId];
  if (queueConfig?.queueType !== "ranked") {
    return;
  }

  const userEntries = await Promise.all(
    gameData.userIds.map((userId) => db.getUserStorageData(userId)),
  );

  const currentRatings = userEntries.map((entry) =>
    entry?.ratings[queueId] ?? game.initialRating()
  );
  const updatedRatings = game.processOutcome(outcome, currentRatings);

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

export async function handleMove<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Rating,
  Loadout,
>(
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
  game: Game<
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
) {
  await updateGameState(db, game, gameId, (gameData) => {
    const moveData = {
      playerId,
      timestamp: new Date(),
      move,
      config: gameData.config,
      numPlayers: gameData.userIds.length,
    };

    const state = gameData.gameState;
    if (!game.isValidMove(state, moveData)) {
      return undefined;
    }

    return game.processMove(state, moveData);
  });
}

/**
 * Appends a chat message to the game's chat log.
 */
export async function handleChatMessage<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Rating,
  Loadout,
>(
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
  userId: string,
  message: string,
): Promise<void> {
  const [gameData, userData] = await Promise.all([
    db.getGameStorageData(gameId),
    db.getUserStorageData(userId),
  ]);

  if (userData == null) {
    return;
  }

  const chatMessage: ChatMessage = {
    player: userData.player,
    message,
  };

  const updatedChat = [...gameData.chat, chatMessage];
  const newGameData: GameStorageData<Config, GameState, Outcome> = {
    ...gameData,
    chat: updatedChat,
  };

  await db.updateGameStorageData(gameId, newGameData);
}
