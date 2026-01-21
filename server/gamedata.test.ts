import { assertEquals } from "@std/assert";
import { DB } from "./db.ts";
import {
  fetchActiveGames,
  getPlayerId,
  getPlayerState,
  getPublicState,
  handleMove,
} from "./gamedata.ts";
import type { Game, User } from "../types.ts";
import type { GameStorageData } from "./db.ts";
import { ulid } from "@std/ulid";

// Helper functions for test use only
function getActiveGamesKey() {
  return ["activegames"];
}

function getGameKey(gameId: string) {
  return ["games", gameId];
}

type TestConfig = undefined;

// Test game state
type TestState = {
  value: number;
  moveHistory: string[];
};

// Test move
type TestMove = {
  action: string;
};

// Test player state
type TestPlayerState = {
  playerValue: number;
  canMove: boolean;
};

// Test public state
type TestPublicState = {
  currentValue: number;
  moves: number;
};

type TestOutcome = "done";
type TestLoadout = undefined;
const defaultPlayers: User[] = [
  { username: "Player 1", isGuest: false },
  { username: "Player 2", isGuest: false },
];
const defaultCreated = new Date("2020-01-01T00:00:00Z");

function buildActiveGame(gameId: string, players = defaultPlayers) {
  return { gameId, players, config: undefined, created: defaultCreated };
}

// Game implementation for tests
const testGame: Game<
  TestConfig,
  TestState,
  TestMove,
  TestPlayerState,
  TestPublicState,
  TestOutcome,
  TestLoadout
> = {
  queues: {
    queue: { numPlayers: 2, config: undefined },
  },

  setup: (_o) => ({ value: 0, moveHistory: [] }),

  processMove: (state, { move, playerId }): TestState => {
    const newValue = move.action === "increment"
      ? state.value + 1
      : state.value - 1;
    return {
      value: newValue,
      moveHistory: [
        ...state.moveHistory,
        `Player ${playerId}: ${move.action}`,
      ],
    };
  },

  isValidMove: (_state, { move }): boolean => {
    return move.action === "increment" || move.action === "decrement";
  },

  playerState: (state): TestPlayerState => {
    const isDone = state.value >= 5 || state.value <= -5;
    return {
      playerValue: state.value,
      canMove: !isDone,
    };
  },

  publicState: (state): TestPublicState => {
    return {
      currentValue: state.value,
      moves: state.moveHistory.length,
    };
  },

  outcome: (state): TestOutcome | undefined => {
    return state.value >= 5 || state.value <= -5 ? "done" : undefined;
  },
};

Deno.test("fetchActiveGames returns active games from the database", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB<TestConfig, TestState, TestLoadout, TestOutcome>(kv);

  // Create some active games
  const id1 = ulid();
  const id2 = ulid();
  const id3 = ulid();

  // Create game storage data
  for (const gameId of [id1, id2, id3]) {
    const players = defaultPlayers;

    const gameData: GameStorageData<TestConfig, TestState, TestOutcome> = {
      config: undefined,
      gameState: { value: 0, moveHistory: [] },
      playerUserIds: [],
      players,
      outcome: undefined,
    };

    await kv.set(getGameKey(gameId), gameData);
  }

  await kv.set(getActiveGamesKey(), [
    buildActiveGame(id1),
    buildActiveGame(id2),
    buildActiveGame(id3),
  ]);

  const result = await fetchActiveGames(db);

  // Sort arrays for consistent comparison
  assertEquals(result.map((g) => g.gameId).sort(), [id1, id2, id3].sort());

  kv.close();
});

Deno.test("getPlayerState returns correct player state", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB<TestConfig, TestState, TestLoadout, TestOutcome>(kv);

  // Create a game with initial value 1
  const gameId = ulid();
  const playerUserIds = ["user-1", "user-2"];

  const players = defaultPlayers;

  const gameData: GameStorageData<TestConfig, TestState, TestOutcome> = {
    config: undefined,
    gameState: { value: 1, moveHistory: ["Player 0: increment"] },
    playerUserIds,
    players,
    outcome: undefined,
  };

  // Set up active game list and game data
  await kv.set(getActiveGamesKey(), [buildActiveGame(gameId, players)]);
  await kv.set(getGameKey(gameId), gameData);

  for (const userId of playerUserIds) {
    const gameData = await db.getGameStorageData(
      gameId,
    );
    const playerId = getPlayerId(gameData, userId);
    if (playerId == null) {
      throw new Error("Missing player id");
    }
    const playerState = getPlayerState(
      gameData,
      testGame.playerState,
      playerId,
    );

    assertEquals(playerId, playerUserIds.indexOf(userId));
    assertEquals(playerState.playerValue, 1);
    assertEquals(playerState.canMove, true);
  }

  kv.close();
});

Deno.test("getPlayerState handles completed games", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB<TestConfig, TestState, TestLoadout, TestOutcome>(kv);

  // Create a completed game
  const gameId = ulid();
  const playerUserIds = ["user-1", "user-2"];

  const players = defaultPlayers;

  const initialGameData: GameStorageData<TestConfig, TestState, TestOutcome> = {
    config: undefined,
    gameState: { value: 5, moveHistory: ["Player 0: increment"] },
    playerUserIds,
    players,
    outcome: undefined,
  };

  // Set up active game list and game data
  await kv.set(getActiveGamesKey(), [buildActiveGame(gameId, players)]);
  await kv.set(getGameKey(gameId), initialGameData);

  // Mark game as complete
  const gameData = await db.getGameStorageData(
    gameId,
  );
  gameData.outcome = "done";
  await db.updateGameStorageData(gameId, gameData);

  const userId = playerUserIds[0];
  const playerId = getPlayerId(gameData, userId);
  if (playerId == null) {
    throw new Error("Missing player id");
  }
  const playerState = getPlayerState(gameData, testGame.playerState, playerId);

  assertEquals(playerId, playerUserIds.indexOf(userId));
  assertEquals(playerState.canMove, false);

  kv.close();
});

Deno.test("getPublicState returns correct public state", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB<TestConfig, TestState, TestLoadout, TestOutcome>(kv);

  const gameId = ulid();

  const players: User[] = [
    { username: "Player 1", isGuest: false },
    { username: "Player 2", isGuest: false },
  ];

  const initialGameData: GameStorageData<TestConfig, TestState, TestOutcome> = {
    config: undefined,
    gameState: { value: 1, moveHistory: ["Player 0: increment"] },
    playerUserIds: [],
    players,
    outcome: undefined,
  };

  // Set up active game list and game data
  await kv.set(getActiveGamesKey(), [buildActiveGame(gameId)]);
  await kv.set(getGameKey(gameId), initialGameData);

  const gameData = await db.getGameStorageData(
    gameId,
  );
  const publicState = getPublicState(gameData, testGame.publicState);

  assertEquals(publicState.currentValue, 1);
  assertEquals(publicState.moves, 1);

  kv.close();
});

Deno.test("getPublicState handles completed games", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB<TestConfig, TestState, TestLoadout, TestOutcome>(kv);

  // Create a completed game
  const gameId = ulid();

  const players: User[] = [
    { username: "Player 1", isGuest: false },
    { username: "Player 2", isGuest: false },
  ];

  const initialGameData: GameStorageData<TestConfig, TestState, TestOutcome> = {
    config: undefined,
    gameState: { value: 1, moveHistory: ["Player 0: increment"] },
    playerUserIds: [],
    players,
    outcome: undefined,
  };

  // Set up active game list and game data
  await kv.set(getActiveGamesKey(), [buildActiveGame(gameId)]);
  await kv.set(getGameKey(gameId), initialGameData);

  // Mark game as complete
  const gameData = await db.getGameStorageData(
    gameId,
  );
  gameData.outcome = "done";
  await db.updateGameStorageData(gameId, gameData);

  const updatedGameData = await db.getGameStorageData(
    gameId,
  );
  const publicState = getPublicState(
    updatedGameData,
    testGame.publicState,
  );

  assertEquals(publicState.currentValue, 1);
  assertEquals(publicState.moves, 1);

  kv.close();
});

Deno.test("handleMove processes valid moves and updates game state", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB<TestConfig, TestState, TestLoadout, TestOutcome>(kv);

  // Create a game with initial value 1
  const gameId = ulid();

  const players: User[] = [
    { username: "Player 1", isGuest: false },
    { username: "Player 2", isGuest: false },
  ];

  const gameData: GameStorageData<TestConfig, TestState, TestOutcome> = {
    config: undefined,
    gameState: { value: 1, moveHistory: ["Player 0: increment"] },
    playerUserIds: [],
    players,
    outcome: undefined,
  };

  // Set up active game list and game data
  await kv.set(getActiveGamesKey(), [buildActiveGame(gameId)]);
  await kv.set(getGameKey(gameId), gameData);

  const playerId = 0;
  const move = { action: "increment" };

  await handleMove(db, testGame, gameId, playerId, move);

  // Get the updated game state
  const updatedGameData = await db.getGameStorageData(
    gameId,
  );

  assertEquals(updatedGameData.gameState.value, 2);
  assertEquals(updatedGameData.gameState.moveHistory.length, 2);
  assertEquals(updatedGameData.outcome, undefined);

  kv.close();
});

Deno.test("handleMove properly marks game as complete when threshold reached", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB<TestConfig, TestState, TestLoadout, TestOutcome>(kv);

  // Create a game with value 4 (one increment away from being complete)
  const gameId = ulid();

  const players: User[] = [
    { username: "Player 1", isGuest: false },
    { username: "Player 2", isGuest: false },
  ];

  const gameData: GameStorageData<TestConfig, TestState, TestOutcome> = {
    config: undefined,
    gameState: {
      value: 4,
      moveHistory: [
        "Player 0: increment",
        "Player 1: increment",
        "Player 0: increment",
        "Player 1: increment",
      ],
    },
    playerUserIds: [],
    players,
    outcome: undefined,
  };

  // Set up active game list and game data
  await kv.set(getActiveGamesKey(), [buildActiveGame(gameId)]);
  await kv.set(getGameKey(gameId), gameData);

  const playerId = 0;
  const move = { action: "increment" };

  await handleMove(db, testGame, gameId, playerId, move);

  // Get the updated game state
  const updatedGameData = await db.getGameStorageData(
    gameId,
  );

  assertEquals(updatedGameData.gameState.value, 5);
  assertEquals(updatedGameData.outcome, "done");

  kv.close();
});

Deno.test("handleMove rejects invalid moves", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB<TestConfig, TestState, TestLoadout, TestOutcome>(kv);

  const gameId = ulid();

  const players: User[] = [
    { username: "Player 1", isGuest: false },
    { username: "Player 2", isGuest: false },
  ];

  const gameData: GameStorageData<TestConfig, TestState, TestOutcome> = {
    config: undefined,
    gameState: { value: 1, moveHistory: ["Player 0: increment"] },
    playerUserIds: [],
    players,
    outcome: undefined,
  };

  // Set up active game list and game data
  await kv.set(getActiveGamesKey(), [buildActiveGame(gameId)]);
  await kv.set(getGameKey(gameId), gameData);

  const initialGameData = await db.getGameStorageData(
    gameId,
  );

  const playerId = 0;
  const invalidMove = { action: "invalid_action" };

  await handleMove(db, testGame, gameId, playerId, invalidMove);

  // Get the game state and verify it hasn't changed
  const updatedGameData = await db.getGameStorageData(
    gameId,
  );

  assertEquals(
    updatedGameData.gameState.value,
    initialGameData.gameState.value,
  );
  assertEquals(
    updatedGameData.gameState.moveHistory.length,
    initialGameData.gameState.moveHistory.length,
  );

  kv.close();
});

Deno.test("handleMove doesn't update completed games", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB<TestConfig, TestState, TestLoadout, TestOutcome>(kv);

  // Create a completed game
  const gameId = ulid();

  const players: User[] = [
    { username: "Player 1", isGuest: false },
    { username: "Player 2", isGuest: false },
  ];

  const initialGameData: GameStorageData<TestConfig, TestState, TestOutcome> = {
    config: undefined,
    gameState: { value: 1, moveHistory: ["Player 0: increment"] },
    playerUserIds: [],
    players,
    outcome: undefined,
  };

  // Set up active game list and game data
  await kv.set(getActiveGamesKey(), [buildActiveGame(gameId)]);
  await kv.set(getGameKey(gameId), initialGameData);

  // Mark game as complete
  const gameData = await db.getGameStorageData(
    gameId,
  );
  gameData.outcome = "done";
  await db.updateGameStorageData(gameId, gameData);

  // Store initial state
  const completedGameData = await db.getGameStorageData(
    gameId,
  );

  const playerId = 0;
  const move = { action: "increment" };

  await handleMove(db, testGame, gameId, playerId, move);

  // Get the updated game state
  const updatedGameData = await db.getGameStorageData(
    gameId,
  );

  // Verify no changes were made
  assertEquals(
    updatedGameData.gameState.value,
    completedGameData.gameState.value,
  );
  assertEquals(
    updatedGameData.gameState.moveHistory.length,
    completedGameData.gameState.moveHistory.length,
  );
  assertEquals(updatedGameData.outcome, "done");

  kv.close();
});
