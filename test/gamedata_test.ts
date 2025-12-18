import { assertEquals } from "@std/assert";
import { assertSpyCalls, spy } from "@std/testing/mock";
import { DB } from "../server/db.ts";
import {
  fetchActiveGames,
  getObserverState,
  getPlayerId,
  getPlayerState,
  handleMove,
  handleRefresh,
} from "../server/gamedata.ts";
import type { Game, Player } from "../types.ts";
import type { GameStorageData } from "../server/db.ts";
import { ulid } from "@std/ulid";

// Helper functions for test use only
function getActiveGameKey(gameId: string) {
  return ["activegames", gameId];
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

// Test observer state
type TestObserverState = {
  currentValue: number;
  moves: number;
};

// Game implementation for tests
const testGame: Game<
  TestConfig,
  TestState,
  TestMove,
  TestPlayerState,
  TestObserverState,
  number
> = {
  modes: {
    queue: { playerIds: [0, 1], matchmaking: "queue", config: undefined },
  },

  setup: () => ({ value: 0, moveHistory: [] }),

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

  refresh: (state): TestState => {
    return {
      value: state.value + 1,
      moveHistory: [
        ...state.moveHistory,
        "System: refresh",
      ],
    };
  },

  refreshTimeout: (state): number | undefined => {
    // Return a timeout based on the current value
    if (state.value < 3) {
      return 1000; // 1 second timeout
    }
    return undefined; // No timeout for values >= 3
  },

  playerState: (state, o): TestPlayerState => {
    return {
      playerValue: state.value,
      canMove: !o.isComplete,
    };
  },

  observerState: (state): TestObserverState => {
    return {
      currentValue: state.value,
      moves: state.moveHistory.length,
    };
  },

  isComplete: (state): boolean => {
    return state.value >= 5 || state.value <= -5;
  },
};

Deno.test("fetchActiveGames returns active games from the database", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  // Create some active games
  const id1 = ulid();
  const id2 = ulid();
  const id3 = ulid();

  // Create game storage data
  for (const gameId of [id1, id2, id3]) {
    const players: Player<number>[] = [
      { playerId: 0, name: "Player 1" },
      { playerId: 1, name: "Player 2" },
    ];

    const gameData: GameStorageData<TestConfig, TestState, number> = {
      config: undefined,
      gameState: { value: 0, moveHistory: [] },
      sessionTokens: {},
      players,
      isComplete: false,
      version: 0,
    };

    // Set up active game keys
    await kv.set(getActiveGameKey(gameId), {});
    await kv.set(getGameKey(gameId), gameData);
  }

  const result = await fetchActiveGames(db);

  // Sort arrays for consistent comparison
  assertEquals(result.map((g) => g.gameId).sort(), [id1, id2, id3].sort());

  kv.close();
});

Deno.test("getPlayerState returns correct player state", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  // Create a game with initial value 1
  const gameId = ulid();
  const sessionTokens: { [sessionId: string]: number } = {};
  sessionTokens[ulid()] = 0;
  sessionTokens[ulid()] = 1;

  const players: Player<number>[] = [
    { playerId: 0, name: "Player 1" },
    { playerId: 1, name: "Player 2" },
  ];

  const gameData: GameStorageData<TestConfig, TestState, number> = {
    config: undefined,
    gameState: { value: 1, moveHistory: ["Player 0: increment"] },
    sessionTokens,
    players,
    isComplete: false,
    version: 0,
  };

  // Set up active game key and game data
  await kv.set(getActiveGameKey(gameId), {});
  await kv.set(getGameKey(gameId), gameData);

  for (const token in sessionTokens) {
    const gameData = await db.getGameStorageData<TestConfig, TestState, number>(
      gameId,
    );
    const playerId = getPlayerId(gameData, token);
    const playerState = getPlayerState(
      gameData,
      testGame.playerState,
      playerId,
    );

    assertEquals(playerId, sessionTokens[token]);
    assertEquals(playerState.playerValue, 1);
    assertEquals(playerState.canMove, true);
  }

  kv.close();
});

Deno.test("getPlayerState handles completed games", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  // Create a completed game
  const gameId = ulid();
  const sessionTokens: { [sessionId: string]: number } = {};
  sessionTokens[ulid()] = 0;
  sessionTokens[ulid()] = 1;

  const players: Player<number>[] = [
    { playerId: 0, name: "Player 1" },
    { playerId: 1, name: "Player 2" },
  ];

  const initialGameData: GameStorageData<TestConfig, TestState, number> = {
    config: undefined,
    gameState: { value: 1, moveHistory: ["Player 0: increment"] },
    sessionTokens,
    players,
    isComplete: false,
    version: 0,
  };

  // Set up active game key and game data
  await kv.set(getActiveGameKey(gameId), {});
  await kv.set(getGameKey(gameId), initialGameData);

  // Mark game as complete
  const gameData = await db.getGameStorageData<TestConfig, TestState, number>(
    gameId,
  );
  gameData.isComplete = true;
  gameData.version += 1;
  await db.updateGameStorageData(gameId, gameData);

  const token = Object.keys(sessionTokens)[0];
  const playerId = getPlayerId(gameData, token);
  const playerState = getPlayerState(gameData, testGame.playerState, playerId);

  assertEquals(playerId, sessionTokens[token]);
  assertEquals(playerState.canMove, false);

  kv.close();
});

Deno.test("getObserverState returns correct observer state", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  const gameId = ulid();

  const players: Player<number>[] = [
    { playerId: 0, name: "Player 1" },
    { playerId: 1, name: "Player 2" },
  ];

  const initialGameData: GameStorageData<TestConfig, TestState, number> = {
    config: undefined,
    gameState: { value: 1, moveHistory: ["Player 0: increment"] },
    sessionTokens: {},
    players,
    isComplete: false,
    version: 0,
  };

  // Set up active game key and game data
  await kv.set(getActiveGameKey(gameId), {});
  await kv.set(getGameKey(gameId), initialGameData);

  const gameData = await db.getGameStorageData<TestConfig, TestState, number>(
    gameId,
  );
  const observerState = getObserverState(gameData, testGame.observerState);

  assertEquals(observerState.currentValue, 1);
  assertEquals(observerState.moves, 1);

  kv.close();
});

Deno.test("getObserverState handles completed games", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  // Create a completed game
  const gameId = ulid();

  const players: Player<number>[] = [
    { playerId: 0, name: "Player 1" },
    { playerId: 1, name: "Player 2" },
  ];

  const initialGameData: GameStorageData<TestConfig, TestState, number> = {
    config: undefined,
    gameState: { value: 1, moveHistory: ["Player 0: increment"] },
    sessionTokens: {},
    players,
    isComplete: false,
    version: 0,
  };

  // Set up active game key and game data
  await kv.set(getActiveGameKey(gameId), {});
  await kv.set(getGameKey(gameId), initialGameData);

  // Mark game as complete
  const gameData = await db.getGameStorageData<TestConfig, TestState, number>(
    gameId,
  );
  gameData.isComplete = true;
  gameData.version += 1;
  await db.updateGameStorageData(gameId, gameData);

  const updatedGameData = await db.getGameStorageData<
    TestConfig,
    TestState,
    number
  >(
    gameId,
  );
  const observerState = getObserverState(
    updatedGameData,
    testGame.observerState,
  );

  assertEquals(observerState.currentValue, 1);
  assertEquals(observerState.moves, 1);

  kv.close();
});

Deno.test("handleMove processes valid moves and updates game state", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  // Create a game with initial value 1
  const gameId = ulid();

  const players: Player<number>[] = [
    { playerId: 0, name: "Player 1" },
    { playerId: 1, name: "Player 2" },
  ];

  const gameData: GameStorageData<TestConfig, TestState, number> = {
    config: undefined,
    gameState: { value: 1, moveHistory: ["Player 0: increment"] },
    sessionTokens: {},
    players,
    isComplete: false,
    version: 0,
  };

  // Set up active game key and game data
  await kv.set(getActiveGameKey(gameId), {});
  await kv.set(getGameKey(gameId), gameData);

  const playerId = 0;
  const move = { action: "increment" };

  await handleMove(db, testGame, gameId, playerId, move);

  // Get the updated game state
  const updatedGameData = await db.getGameStorageData<
    TestConfig,
    TestState,
    number
  >(
    gameId,
  );

  assertEquals(updatedGameData.gameState.value, 2);
  assertEquals(updatedGameData.gameState.moveHistory.length, 2);
  assertEquals(updatedGameData.isComplete, false);
  assertEquals(updatedGameData.version, 1); // Version should be incremented to 1 after the first move

  kv.close();
});

Deno.test("handleMove properly marks game as complete when threshold reached", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  // Create a game with value 4 (one increment away from being complete)
  const gameId = ulid();

  const players: Player<number>[] = [
    { playerId: 0, name: "Player 1" },
    { playerId: 1, name: "Player 2" },
  ];

  const gameData: GameStorageData<TestConfig, TestState, number> = {
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
    sessionTokens: {},
    players,
    isComplete: false,
    version: 0,
  };

  // Set up active game key and game data
  await kv.set(getActiveGameKey(gameId), {});
  await kv.set(getGameKey(gameId), gameData);

  const playerId = 0;
  const move = { action: "increment" };

  await handleMove(db, testGame, gameId, playerId, move);

  // Get the updated game state
  const updatedGameData = await db.getGameStorageData<
    TestConfig,
    TestState,
    number
  >(
    gameId,
  );

  assertEquals(updatedGameData.gameState.value, 5);
  assertEquals(updatedGameData.isComplete, true);
  assertEquals(updatedGameData.version, 1); // Version should be incremented to 1 after the move

  kv.close();
});

Deno.test("handleMove rejects invalid moves", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  const gameId = ulid();

  const players: Player<number>[] = [
    { playerId: 0, name: "Player 1" },
    { playerId: 1, name: "Player 2" },
  ];

  const gameData: GameStorageData<TestConfig, TestState, number> = {
    config: undefined,
    gameState: { value: 1, moveHistory: ["Player 0: increment"] },
    sessionTokens: {},
    players,
    isComplete: false,
    version: 0,
  };

  // Set up active game key and game data
  await kv.set(getActiveGameKey(gameId), {});
  await kv.set(getGameKey(gameId), gameData);

  const initialGameData = await db.getGameStorageData<
    TestConfig,
    TestState,
    number
  >(
    gameId,
  );

  const playerId = 0;
  const invalidMove = { action: "invalid_action" };

  await handleMove(db, testGame, gameId, playerId, invalidMove);

  // Get the game state and verify it hasn't changed
  const updatedGameData = await db.getGameStorageData<
    TestConfig,
    TestState,
    number
  >(
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
  const db = new DB(kv);

  // Create a completed game
  const gameId = ulid();

  const players: Player<number>[] = [
    { playerId: 0, name: "Player 1" },
    { playerId: 1, name: "Player 2" },
  ];

  const initialGameData: GameStorageData<TestConfig, TestState, number> = {
    config: undefined,
    gameState: { value: 1, moveHistory: ["Player 0: increment"] },
    sessionTokens: {},
    players,
    isComplete: false,
    version: 0,
  };

  // Set up active game key and game data
  await kv.set(getActiveGameKey(gameId), {});
  await kv.set(getGameKey(gameId), initialGameData);

  // Mark game as complete
  const gameData = await db.getGameStorageData<TestConfig, TestState, number>(
    gameId,
  );
  gameData.isComplete = true;
  gameData.version += 1;
  await db.updateGameStorageData(gameId, gameData);

  // Store initial state
  const completedGameData = await db.getGameStorageData<
    TestConfig,
    TestState,
    number
  >(
    gameId,
  );

  const playerId = 0;
  const move = { action: "increment" };

  await handleMove(db, testGame, gameId, playerId, move);

  // Get the updated game state
  const updatedGameData = await db.getGameStorageData<
    TestConfig,
    TestState,
    number
  >(
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
  assertEquals(updatedGameData.isComplete, true);

  kv.close();
});

Deno.test("handleRefresh updates game state", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  // Create a game with initial value 1
  const gameId = ulid();

  const players: Player<number>[] = [
    { playerId: 0, name: "Player 1" },
    { playerId: 1, name: "Player 2" },
  ];

  const gameData: GameStorageData<TestConfig, TestState, number> = {
    config: undefined,
    gameState: { value: 1, moveHistory: ["Player 0: increment"] },
    sessionTokens: {},
    players,
    isComplete: false,
    version: 0,
  };

  // Set up active game key and game data
  await kv.set(getActiveGameKey(gameId), {});
  await kv.set(getGameKey(gameId), gameData);

  await handleRefresh(db, testGame, gameId);

  // Get the updated game state
  const updatedGameData = await db.getGameStorageData<
    TestConfig,
    TestState,
    number
  >(
    gameId,
  );

  assertEquals(updatedGameData.gameState.value, 2);
  assertEquals(updatedGameData.gameState.moveHistory.length, 2);
  assertEquals(updatedGameData.gameState.moveHistory[1], "System: refresh");
  assertEquals(updatedGameData.isComplete, false);
  assertEquals(updatedGameData.version, 1); // Version should be incremented to 1 after the refresh

  kv.close();
});

Deno.test("handleRefresh properly marks game as complete when threshold reached", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  // Create a game with value 4 (one refresh away from being complete)
  const gameId = ulid();

  const players: Player<number>[] = [
    { playerId: 0, name: "Player 1" },
    { playerId: 1, name: "Player 2" },
  ];

  const gameData: GameStorageData<TestConfig, TestState, number> = {
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
    sessionTokens: {},
    players,
    isComplete: false,
    version: 0,
  };

  // Set up active game key and game data
  await kv.set(getActiveGameKey(gameId), {});
  await kv.set(getGameKey(gameId), gameData);

  await handleRefresh(db, testGame, gameId);

  // Get the updated game state
  const updatedGameData = await db.getGameStorageData<
    TestConfig,
    TestState,
    number
  >(
    gameId,
  );

  assertEquals(updatedGameData.gameState.value, 5);
  assertEquals(updatedGameData.isComplete, true);
  assertEquals(updatedGameData.version, 1); // Version should be incremented to 1 after the refresh

  kv.close();
});

Deno.test("handleRefresh doesn't update completed games", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  // Create a completed game
  const gameId = ulid();

  const players: Player<number>[] = [
    { playerId: 0, name: "Player 1" },
    { playerId: 1, name: "Player 2" },
  ];

  const initialGameData: GameStorageData<TestConfig, TestState, number> = {
    config: undefined,
    gameState: { value: 1, moveHistory: ["Player 0: increment"] },
    sessionTokens: {},
    players,
    isComplete: false,
    version: 0,
  };

  // Set up active game key and game data
  await kv.set(getActiveGameKey(gameId), {});
  await kv.set(getGameKey(gameId), initialGameData);

  // Mark game as complete
  const gameData = await db.getGameStorageData<TestConfig, TestState, number>(
    gameId,
  );
  gameData.isComplete = true;
  gameData.version += 1;
  await db.updateGameStorageData(gameId, gameData);

  // Store initial state
  const completedGameData = await db.getGameStorageData<
    TestConfig,
    TestState,
    number
  >(
    gameId,
  );

  await handleRefresh(db, testGame, gameId);

  // Get the updated game state
  const updatedGameData = await db.getGameStorageData<
    TestConfig,
    TestState,
    number
  >(
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
  assertEquals(updatedGameData.isComplete, true);

  kv.close();
});

Deno.test("handleMove schedules refresh with refreshTimeout", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  // Create a spy on the updateGameStorageData method
  const updateGameStorageDataSpy = spy(db, "updateGameStorageData");

  // Create a game with initial value 1 (below the refreshTimeout threshold of 3)
  const gameId = ulid();

  const players: Player<number>[] = [
    { playerId: 0, name: "Player 1" },
    { playerId: 1, name: "Player 2" },
  ];

  const gameData: GameStorageData<TestConfig, TestState, number> = {
    config: undefined,
    gameState: { value: 1, moveHistory: ["Player 0: increment"] },
    sessionTokens: {},
    players,
    isComplete: false,
    version: 0,
  };

  // Set up active game key and game data
  await kv.set(getActiveGameKey(gameId), {});
  await kv.set(getGameKey(gameId), gameData);

  const playerId = 0;
  const move = { action: "increment" };

  await handleMove(db, testGame, gameId, playerId, move);

  // Check if updateGameStorageData was called with correct parameters including the refreshDelay
  assertSpyCalls(updateGameStorageDataSpy, 1);
  assertEquals(updateGameStorageDataSpy.calls[0].args[0], gameId);
  // Third argument should be the refresh delay (1000)
  assertEquals(updateGameStorageDataSpy.calls[0].args[2], 1000);

  kv.close();
});

Deno.test("handleMove doesn't schedule refresh when refreshTimeout returns undefined", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  // Create a spy on the updateGameStorageData method
  const updateGameStorageDataSpy = spy(db, "updateGameStorageData");

  // Create a game with initial value 3 (at the refreshTimeout threshold, returns undefined)
  const gameId = ulid();
  const players: Player<number>[] = [
    { playerId: 0, name: "Player 1" },
    { playerId: 1, name: "Player 2" },
  ];

  const gameData: GameStorageData<TestConfig, TestState, number> = {
    config: undefined,
    gameState: {
      value: 3,
      moveHistory: [
        "Player 0: increment",
        "Player 1: increment",
        "Player 0: increment",
      ],
    },
    sessionTokens: {},
    players,
    isComplete: false,
    version: 0,
  };

  // Set up active game key and game data
  await kv.set(getActiveGameKey(gameId), {});
  await kv.set(getGameKey(gameId), gameData);

  const playerId = 0;
  const move = { action: "increment" };

  await handleMove(db, testGame, gameId, playerId, move);

  // Check if updateGameStorageData was called with the refresh delay as undefined
  assertSpyCalls(updateGameStorageDataSpy, 1);
  assertEquals(updateGameStorageDataSpy.calls[0].args[0], gameId);
  assertEquals(updateGameStorageDataSpy.calls[0].args[2], undefined);

  kv.close();
});

Deno.test("handleRefresh schedules refresh with refreshTimeout", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  // Create a spy on the updateGameStorageData method
  const updateGameStorageDataSpy = spy(db, "updateGameStorageData");

  // Create a game with initial value 1 (below the refreshTimeout threshold of 3)
  const gameId = ulid();

  const players: Player<number>[] = [
    { playerId: 0, name: "Player 1" },
    { playerId: 1, name: "Player 2" },
  ];

  const gameData: GameStorageData<TestConfig, TestState, number> = {
    config: undefined,
    gameState: { value: 1, moveHistory: ["Player 0: increment"] },
    sessionTokens: {},
    players,
    isComplete: false,
    version: 0,
  };

  // Set up active game key and game data
  await kv.set(getActiveGameKey(gameId), {});
  await kv.set(getGameKey(gameId), gameData);

  await handleRefresh(db, testGame, gameId);

  // Check if updateGameStorageData was called with correct parameters including the refreshDelay
  assertSpyCalls(updateGameStorageDataSpy, 1);
  assertEquals(updateGameStorageDataSpy.calls[0].args[0], gameId);
  assertEquals(updateGameStorageDataSpy.calls[0].args[2], 1000); // Expected delay from refreshTimeout function

  kv.close();
});
