import { assertEquals } from "@std/assert";
import { DB } from "../server/db.ts";
import { ObserveSocketStore } from "../server/observesockets.ts";
import { assertSpyCalls, spy } from "@std/testing/mock";

// Mock game state and observer state types for testing

// Observer state getter function
const getObserverState = (state: number) => state;

Deno.test("registers and unregisters a socket", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);
  const observeSocketStore = new ObserveSocketStore<
    undefined,
    number,
    number
  >(
    db,
  );

  // Register a socket
  const socket = { send: spy() };
  const gameId = "test-observe-game-1";

  observeSocketStore.register(socket, gameId, getObserverState);

  // Unregister the socket
  observeSocketStore.unregister(socket, gameId);

  // No direct way to check if the socket was unregistered
  // But we can verify no errors occurred during the process

  kv.close();
});

Deno.test("sends state updates to all observer sockets", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);

  // Create a game directly with KV
  const gameId = "test-game-id";
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

  const observeSocketStore = new ObserveSocketStore<
    undefined,
    number,
    number
  >(
    db,
  );

  // Create sockets and register them
  const socket1 = { send: spy() };
  const socket2 = { send: spy() };

  // Register both sockets to observe the same game
  observeSocketStore.register(socket1, gameId, getObserverState);
  observeSocketStore.register(socket2, gameId, getObserverState);

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

  // Both sockets should receive the same observer state
  assertSpyCalls(socket1.send, 1);
  assertSpyCalls(socket2.send, 1);

  // Verify socket1's observed state
  const message1 = JSON.parse(socket1.send.calls[0].args[0]);
  assertEquals(message1.type, "UpdateObserveState");
  assertEquals(message1.observerState, 1);

  // Verify socket2's observed state (should be identical)
  const message2 = JSON.parse(socket2.send.calls[0].args[0]);
  assertEquals(message2.type, "UpdateObserveState");
  assertEquals(message2.observerState, 1);

  // Clean up
  observeSocketStore.unregister(socket1, gameId);
  observeSocketStore.unregister(socket2, gameId);

  kv.close();
});

Deno.test("only sends updates when state changes", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);
  const observeSocketStore = new ObserveSocketStore<
    undefined,
    number,
    number
  >(
    db,
  );

  // Create a game directly with KV
  const gameId = "test-game-id-2";
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

  observeSocketStore.register(socket, gameId, getObserverState);

  // Store the same state multiple times
  await db.updateGameStorageData(gameId, {
    config: undefined,
    gameState: 1,
    sessionTokens,
    players,
    isComplete: false,
    version: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  await db.updateGameStorageData(gameId, {
    config: undefined,
    gameState: 1,
    sessionTokens,
    players,
    isComplete: false,
    version: 2,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Socket should only receive one update due to deep equality check
  assertSpyCalls(socket.send, 1);

  // Clean up
  observeSocketStore.unregister(socket, gameId);

  kv.close();
});
