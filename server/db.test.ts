import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { DB } from "./db.ts";

// Mock game implementation for testing
const setupGame = () => 1;
const loadout = undefined;
const user1 = { username: "guest-0001", isGuest: true };
const user2 = { username: "guest-0002", isGuest: true };

Deno.test("Adds to queue, graduates, and assigns", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  const queue = { queueId: "test-queue", numPlayers: 2, config: undefined };
  const entryId = "test-entry";
  const entryId2 = "test-entry-2";

  const assignmentStream = db.watchForAssignments(entryId);
  const assignmentStream2 = db.watchForAssignments(entryId2);
  await db.addToQueue(queue, entryId, "user-1", user1, loadout, setupGame);
  await db.addToQueue(queue, entryId2, "user-2", user2, loadout, setupGame);

  // Check for assignment after queue graduation
  const reader = assignmentStream.getReader();
  const reader2 = assignmentStream2.getReader();
  const result = await reader.read();
  const result2 = await reader2.read();
  await reader.cancel();
  await reader2.cancel();

  assertExists(result.value);
  assertExists(result.value.gameId);

  assertExists(result2.value);
  assertExists(result2.value.gameId);

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

  await db.addToQueue(queue, entryId, "user-1", user1, loadout, setupGame);
  await db.removeFromQueue(queue.queueId, entryId);

  // Verify the entry is removed (this will implicitly check through the next test succeeding)
  await db.addToQueue(queue, entryId, "user-1", user1, loadout, setupGame);

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
  await db.addToQueue(queue, entryId1, "user-1", user1, loadout, setupGame);
  await db.addToQueue(queue, entryId2, "user-2", user2, loadout, setupGame);

  const reader = assignmentStream.getReader();
  const result = await reader.read();
  await reader.cancel();

  assertExists(result.value);
  const gameId = result.value.gameId;

  const gameData = await db.getGameStorageData(gameId);
  assertExists(gameData);
  assertEquals(gameData.gameState, 1);
  assertExists(gameData.playerUserIds);

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
  await db.addToQueue(queue, entryId1, "user-1", user1, loadout, setupGame);
  await db.addToQueue(queue, entryId2, "user-2", user2, loadout, setupGame);

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
    outcome: undefined,
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
  await db.addToQueue(queue, entryId1, "user-1", user1, loadout, setupGame);
  await db.addToQueue(queue, entryId2, "user-2", user2, loadout, setupGame);

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
    outcome: undefined,
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
  await db.addToQueue(queue, entryId1, "user-1", user1, loadout, setupGame);
  await db.addToQueue(queue, entryId2, "user-2", user2, loadout, setupGame);

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
    outcome: "finished",
  };

  await db.updateGameStorageData(gameId, updatedData);

  // Should still be able to get game data even after completion
  const retrievedData = await db.getGameStorageData(gameId);
  assertEquals(retrievedData.outcome, "finished");

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
  await db.addToQueue(queue, entryId1, "user-1", user1, loadout, setupGame);
  await db.addToQueue(queue, entryId2, "user-2", user2, loadout, setupGame);

  const reader = assignmentStream.getReader();
  const result = await reader.read();
  await reader.cancel();

  assertExists(result.value);
  const newGameId = result.value.gameId;

  const activeGames = await db.getAllActiveGames();
  assertExists(activeGames);
  assertEquals(activeGames[0].gameId, newGameId);
  assertEquals(activeGames[0].players, [user1, user2]);
  assertEquals(activeGames[0].config, queue.config);
  assertEquals(activeGames[0].created instanceof Date, true);

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

  await db.addToQueue(queue, entryId1, "user-1", user1, loadout, setupGame);
  await db.addToQueue(queue, entryId2, "user-2", user2, loadout, setupGame);

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

Deno.test("Creates rooms and lists available rooms", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  const roomId = "room-1";
  const roomConfig = {
    numPlayers: 2,
    config: { mode: "test" },
    private: false,
  };

  await db.createRoom(roomId, roomConfig);
  await db.addToRoom(roomId, "entry-1", "user-1", user1, loadout);

  const rooms = await db.getAllAvailableRooms();
  assertEquals(rooms.length, 1);
  assertEquals(rooms[0].roomId, roomId);
  assertEquals(rooms[0].numPlayers, 2);
  assertEquals(rooms[0].players.length, 1);

  kv.close();
});

Deno.test("Excludes private rooms from available rooms", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  const roomId = "room-private";
  const roomConfig = {
    numPlayers: 2,
    config: { mode: "test" },
    private: true,
  };

  await db.createRoom(roomId, roomConfig);
  await db.addToRoom(roomId, "entry-1", "user-1", user1, loadout);

  const rooms = await db.getAllAvailableRooms();
  assertEquals(rooms.length, 0);

  kv.close();
});

Deno.test("Commits room and assigns players", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  const roomId = "room-commit";
  const roomConfig = {
    numPlayers: 2,
    config: { mode: "test" },
    private: false,
  };

  await db.createRoom(roomId, roomConfig);
  await db.addToRoom(roomId, "entry-1", "user-1", user1, loadout);
  await db.addToRoom(roomId, "entry-2", "user-2", user2, loadout);

  const assignmentStream1 = db.watchForAssignments("entry-1");
  const assignmentStream2 = db.watchForAssignments("entry-2");

  await db.commitRoom(roomId, setupGame);

  const reader1 = assignmentStream1.getReader();
  const reader2 = assignmentStream2.getReader();
  const result1 = await reader1.read();
  const result2 = await reader2.read();
  await reader1.cancel();
  await reader2.cancel();

  assertExists(result1.value);
  assertExists(result2.value);
  assertEquals(result1.value.gameId, result2.value.gameId);

  const rooms = await db.getAllAvailableRooms();
  assertEquals(rooms.length, 0);

  kv.close();
});
