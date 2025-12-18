import { assertEquals } from "@std/assert";
import { DB } from "../server/db.ts";
import { PlaySocketStore } from "../server/playsockets.ts";
import { assertSpyCalls, spy } from "@std/testing/mock";
import type { PlayerStateObject } from "../types.ts";

// Mock game state and player state types for testing

// Player state getter function
const getPlayerState = (
  state: number,
  _o: PlayerStateObject<undefined, number>,
) => state;

Deno.test("registers and unregisters a socket", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);
  const playSocketStore = new PlaySocketStore<
    undefined,
    number,
    number,
    number
  >(db);

  // Register a socket
  const socket = { send: spy() };
  const gameId = "test-play-game-1";
  const playerId = 1;

  playSocketStore.register(socket, gameId, playerId, getPlayerState);

  // Unregister the socket
  playSocketStore.unregister(socket, gameId);

  // No direct way to check if the socket was unregistered
  // But we can verify no errors occurred during the process

  kv.close();
});

Deno.test("sends state updates to all player sockets", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  // Create a game directly with KV
  const gameId = "test-play-game-2";
  const gameKey = ["games", gameId];
  const activeGameKey = ["activegames", gameId];
  const activeGameTriggerKey = ["activegametrigger"];

  const sessionTokens = { "session-1": 0, "session-2": 1 };
  const players = [
    { playerId: 0, name: "Player 1" },
    { playerId: 1, name: "Player 2" },
  ];

  // Set up the game data directly
  await kv.atomic()
    .set(activeGameTriggerKey, {})
    .set(activeGameKey, {})
    .set(gameKey, {
      config: undefined,
      gameState: 1,
      sessionTokens,
      players,
      isComplete: false,
      version: 0,
    })
    .commit();

  const playSocketStore = new PlaySocketStore<
    undefined,
    number,
    number,
    number
  >(db);

  // Create sockets and register them
  const socket1 = { send: spy() };
  const socket2 = { send: spy() };

  // Register sockets for different players in the same game
  playSocketStore.register(socket1, gameId, 0, getPlayerState);
  playSocketStore.register(socket2, gameId, 1, getPlayerState);

  // Store game state to trigger updates
  await db.updateGameStorageData(gameId, {
    config: undefined,
    gameState: 1,
    sessionTokens,
    players,
    isComplete: false,
    version: 1,
  });

  // Wait to make sure the watches are sent
  await new Promise((resolve) => setTimeout(resolve, 1));

  // Both sockets should receive the same player state (in this test case)
  assertSpyCalls(socket1.send, 1);
  assertSpyCalls(socket2.send, 1);

  // Verify socket1's player state
  const message1 = JSON.parse(socket1.send.calls[0].args[0]);
  assertEquals(message1.type, "UpdatePlayerState");
  assertEquals(message1.playerState, 1);

  // Verify socket2's player state (should be identical with our test implementation)
  const message2 = JSON.parse(socket2.send.calls[0].args[0]);
  assertEquals(message2.type, "UpdatePlayerState");
  assertEquals(message2.playerState, 1);

  // Clean up
  playSocketStore.unregister(socket1, gameId);
  playSocketStore.unregister(socket2, gameId);

  kv.close();
});

Deno.test("only sends updates when state changes", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);
  const playSocketStore = new PlaySocketStore<
    undefined,
    number,
    number,
    number
  >(db);

  // Create a game directly with KV
  const gameId = "test-play-game-3";
  const gameKey = ["games", gameId];
  const activeGameKey = ["activegames", gameId];
  const activeGameTriggerKey = ["activegametrigger"];

  const sessionTokens = { "session-1": 0, "session-2": 1 };
  const players = [
    { playerId: 0, name: "Player 1" },
    { playerId: 1, name: "Player 2" },
  ];

  // Set up the game data directly
  await kv.atomic()
    .set(activeGameTriggerKey, {})
    .set(activeGameKey, {})
    .set(gameKey, {
      config: undefined,
      gameState: 1,
      sessionTokens,
      players,
      isComplete: false,
      version: 0,
    })
    .commit();

  // Create a socket and register it
  const socket = { send: spy() };
  const playerId = 0;

  // Initialize the lastValue so the initial state won't trigger an update
  await db.updateGameStorageData(gameId, {
    config: undefined,
    gameState: 1,
    sessionTokens,
    players,
    isComplete: false,
    version: 1,
  });

  playSocketStore.register(socket, gameId, playerId, getPlayerState);
  // Initialize with the current state to avoid the initial update
  await playSocketStore.initialize(socket, gameId, 1, getPlayerState);

  // Reset the spy after initialization
  socket.send = spy();

  // Store the same state with a new version number
  await db.updateGameStorageData(gameId, {
    config: undefined,
    gameState: 1,
    sessionTokens,
    players,
    isComplete: false,
    version: 2,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Socket should receive no update due to deep equality check
  assertSpyCalls(socket.send, 0);

  // Clean up
  playSocketStore.unregister(socket, gameId);

  kv.close();
});
