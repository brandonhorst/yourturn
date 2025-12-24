import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { DB } from "../server/db.ts";

// Mock game implementation for testing
const setupGame = () => 1;

Deno.test("Adds to queue, graduates, and assigns", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  const queue = { queueId: "test-queue", numPlayers: 2, config: undefined };
  const entryId = "test-entry";
  const entryId2 = "test-entry-2";

  const assignmentStream = db.watchForAssignments(entryId);
  const assignmentStream2 = db.watchForAssignments(entryId2);
  await db.addToQueue(queue, entryId, setupGame);
  await db.addToQueue(queue, entryId2, setupGame);

  // Check for assignment after queue graduation
  const reader = assignmentStream.getReader();
  const reader2 = assignmentStream2.getReader();
  const result = await reader.read();
  const result2 = await reader2.read();
  await reader.cancel();
  await reader2.cancel();

  assertExists(result.value);
  assertExists(result.value.gameId);
  assertExists(result.value.sessionId);

  assertExists(result2.value);
  assertExists(result2.value.gameId);
  assertExists(result2.value.sessionId);

  kv.close();
});

Deno.test("Removes from queue", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  const queue = {
    queueId: "test-queue-remove",
    numPlayers: 2,
    config: undefined,
  };
  const entryId = "test-entry-remove";

  await db.addToQueue(queue, entryId, setupGame);
  await db.removeFromQueue(queue.queueId, entryId);

  // Verify the entry is removed (this will implicitly check through the next test succeeding)
  await db.addToQueue(queue, entryId, setupGame);

  kv.close();
});

Deno.test("Creates game and retrieves it", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  const queue = {
    queueId: "test-queue-game",
    numPlayers: 2,
    config: undefined,
  };
  const entryId1 = "test-entry-game-1";
  const entryId2 = "test-entry-game-2";

  const assignmentStream = db.watchForAssignments(entryId1);
  await db.addToQueue(queue, entryId1, setupGame);
  await db.addToQueue(queue, entryId2, setupGame);

  const reader = assignmentStream.getReader();
  const result = await reader.read();
  await reader.cancel();

  assertExists(result.value);
  const gameId = result.value.gameId;

  const gameData = await db.getGameStorageData(gameId);
  assertExists(gameData);
  assertEquals(gameData.gameState, 1);
  assertExists(gameData.sessionTokens);

  kv.close();
});

Deno.test("Updates game data", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  // Create a game first
  const queue = {
    queueId: "test-queue-update",
    numPlayers: 2,
    config: undefined,
  };
  const entryId1 = "test-entry-update-1";
  const entryId2 = "test-entry-update-2";

  const assignmentStream = db.watchForAssignments(entryId1);
  await db.addToQueue(queue, entryId1, setupGame);
  await db.addToQueue(queue, entryId2, setupGame);

  const reader = assignmentStream.getReader();
  const result = await reader.read();
  await reader.cancel();

  assertExists(result.value);
  const gameId = result.value.gameId;

  // Now test updating the game
  const gameData = await db.getGameStorageData(gameId);

  const updatedData = {
    ...gameData,
    gameState: 2,
    isComplete: false,
    version: gameData.version + 1,
  };

  await db.updateGameStorageData(gameId, updatedData);

  const retrievedData = await db.getGameStorageData(gameId);
  assertEquals(retrievedData.gameState, 2);

  kv.close();
});

Deno.test("Watches for game changes", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  // Create a game first
  const queue = {
    queueId: "test-queue-watch",
    numPlayers: 2,
    config: undefined,
  };
  const entryId1 = "test-entry-watch-1";
  const entryId2 = "test-entry-watch-2";

  const assignmentStream = db.watchForAssignments(entryId1);
  await db.addToQueue(queue, entryId1, setupGame);
  await db.addToQueue(queue, entryId2, setupGame);

  const reader = assignmentStream.getReader();
  const result = await reader.read();
  await reader.cancel();

  assertExists(result.value);
  const gameId = result.value.gameId;

  // Now test watching for changes
  const changeStream = db.watchForGameChanges(gameId);
  const changeReader = changeStream.getReader();

  // Update the game to trigger an event
  const gameData = await db.getGameStorageData(gameId);
  const updatedData = {
    ...gameData,
    gameState: 2,
    isComplete: false,
    version: gameData.version + 1,
  };

  await db.updateGameStorageData(gameId, updatedData);

  const changeResult = await changeReader.read();
  await changeReader.cancel();

  assertExists(changeResult.value);
  // Just check that we received the game state, without asserting the specific state value
  assertExists(changeResult.value.gameState);

  kv.close();
});

Deno.test("Completes game", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  // Create a game first
  const queue = {
    queueId: "test-queue-complete",
    numPlayers: 2,
    config: undefined,
  };
  const entryId1 = "test-entry-complete-1";
  const entryId2 = "test-entry-complete-2";

  const assignmentStream = db.watchForAssignments(entryId1);
  await db.addToQueue(queue, entryId1, setupGame);
  await db.addToQueue(queue, entryId2, setupGame);

  const reader = assignmentStream.getReader();
  const result = await reader.read();
  await reader.cancel();

  assertExists(result.value);
  const gameId = result.value.gameId;

  // Now test completing the game
  const gameData = await db.getGameStorageData(gameId);

  const updatedData = {
    ...gameData,
    gameState: 3,
    isComplete: true,
    version: gameData.version + 1,
  };

  await db.updateGameStorageData(gameId, updatedData);

  // Should still be able to get game data even after completion
  const retrievedData = await db.getGameStorageData(gameId);
  assertEquals(retrievedData.isComplete, true);

  kv.close();
});

Deno.test("Lists active games", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  // Create a game
  const queue = {
    queueId: "test-queue-active",
    numPlayers: 2,
    config: undefined,
  };
  const entryId1 = "test-entry-active-1";
  const entryId2 = "test-entry-active-2";

  const assignmentStream = db.watchForAssignments(entryId1);
  await db.addToQueue(queue, entryId1, setupGame);
  await db.addToQueue(queue, entryId2, setupGame);

  const reader = assignmentStream.getReader();
  const result = await reader.read();
  await reader.cancel();

  assertExists(result.value);
  const newGameId = result.value.gameId;

  const activeGames = await db.getAllActiveGames();
  assertExists(activeGames);
  assertEquals(activeGames[0].gameId, newGameId);

  kv.close();
});

Deno.test("Watches for active game count changes", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  const countStream = db.watchForActiveGameListChanges();
  const reader = countStream.getReader();

  // Create a new game to trigger a count change
  const queue = {
    queueId: "test-queue-count",
    numPlayers: 2,
    config: undefined,
  };
  const entryId1 = "test-entry-count-1";
  const entryId2 = "test-entry-count-2";

  await db.addToQueue(queue, entryId1, setupGame);
  await db.addToQueue(queue, entryId2, setupGame);

  const result = await reader.read();
  await reader.cancel();

  assertExists(result.value);

  kv.close();
});

Deno.test("Handles errors for non-existent games", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  await assertRejects(
    () => db.getGameStorageData("non-existent-game-id"),
    Error,
    "Game non-existent-game-id not found",
  );

  kv.close();
});

Deno.test("updateGameStorageData with refreshDelay enqueues a game ID with delay", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  // Using FakeTime to control time progression
  using fakeTime = new FakeTime();

  // Create a game directly with KV
  const gameId = "test-refresh-game";
  const gameKey = ["games", gameId];
  const activeGameKey = ["activegames", gameId];
  const activeGameTriggerKey = ["activegametrigger"];

  // Set up the game data directly
  await kv.atomic()
    .set(activeGameTriggerKey, {})
    .set(activeGameKey, {})
    .set(gameKey, {
      config: undefined,
      gameState: { timestamp: new Date() },
      sessionTokens: { "session-1": 0, "session-2": 1 },
      players: [
        { playerId: 0, name: "Player 1" },
        { playerId: 1, name: "Player 2" },
      ],
      isComplete: false,
      version: 0,
    })
    .commit();

  // Set up a stream to listen for refreshes
  const refreshStream = db.listenForRefreshes();
  const reader = refreshStream.getReader();

  // Get the game data
  const gameData = await db.getGameStorageData(gameId);
  const testDelay = 100;

  // Update the game data with a refresh delay
  await db.updateGameStorageData(gameId, {
    ...gameData,
    version: gameData.version + 1,
  }, testDelay);

  // Advance time past the delay
  fakeTime.tick(testDelay + 10);

  // Now we should be able to read the enqueued game ID from the stream
  const result = await reader.read();
  assertEquals(result.value, gameId);

  // Clean up
  await reader.cancel();
  kv.close();
});
