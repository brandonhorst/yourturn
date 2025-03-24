import { assertEquals, assertExists } from "jsr:@std/assert";
import { DB } from "../server/db.ts";
import { LobbySocketStore } from "../server/lobbysockets.ts";
import { assertSpyCalls, spy } from "jsr:@std/testing/mock";
import type { Player } from "../types.ts";

Deno.test("registers and unregisters a socket", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);
  const activeGamesStream = db.watchForActiveGameListChanges();
  const lobbySocketStore = new LobbySocketStore(db, activeGamesStream);

  // Register a socket
  const socket = { send: spy() };
  lobbySocketStore.register(socket);

  // Verify the socket is registered by checking all sockets
  const allSockets = lobbySocketStore.allSockets();
  assertEquals(allSockets.length, 1);
  assertEquals(allSockets[0], socket);

  // Unregister the socket
  await lobbySocketStore.unregister(socket);

  // Verify the socket is unregistered
  assertEquals(lobbySocketStore.allSockets().length, 0);

  kv.close();
});

Deno.test("joins and leaves a queue", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);
  const activeGamesStream = db.watchForActiveGameListChanges();
  const lobbySocketStore = new LobbySocketStore(db, activeGamesStream);

  const setupGame = () => 1;

  // Create a socket and register it
  const socket = { send: spy() };
  lobbySocketStore.register(socket);

  // Join a queue
  const queue = { queueId: "test-queue", numPlayers: 2, config: undefined };
  await lobbySocketStore.joinQueue(socket, queue, setupGame);

  // Verify the socket has a queue entry associated with it
  // We can't directly access the private fields, but we can test functionality

  // Leave the queue
  await lobbySocketStore.leaveQueue(socket);

  // Verify we can join again (which would fail if not properly removed)
  await lobbySocketStore.joinQueue(socket, queue, setupGame);

  // Clean up
  await lobbySocketStore.leaveQueue(socket);
  await lobbySocketStore.unregister(socket);

  kv.close();
});

Deno.test("when two sockets join a queue, assignments are made", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);
  const activeGamesStream = db.watchForActiveGameListChanges();
  const lobbySocketStore = new LobbySocketStore(db, activeGamesStream);

  const setupGame = () => 1;

  // Create two sockets and register them
  const socket1 = { send: spy() };
  const socket2 = { send: spy() };

  lobbySocketStore.register(socket1);
  lobbySocketStore.register(socket2);

  // Join the same queue with both sockets
  const queue = {
    queueId: "test-queue-assignments",
    numPlayers: 2,
    config: undefined,
  };

  // Use Promise.all to join both queues concurrently
  await Promise.all([
    lobbySocketStore.joinQueue(socket1, queue, setupGame),
    lobbySocketStore.joinQueue(socket2, queue, setupGame),
  ]);

  // Wait to make sure the watches are sent
  await new Promise((resolve) => setTimeout(resolve, 1));

  // Verify both sockets received messages
  assertSpyCalls(socket1.send, 3);
  assertSpyCalls(socket2.send, 3);

  // Capture the sent messages
  const message1 = JSON.parse(socket1.send.calls[2].args[0]);
  const message2 = JSON.parse(socket2.send.calls[2].args[0]);

  // Verify assignment messages
  assertEquals(message1.type, "GameAssignment");
  assertEquals(message2.type, "GameAssignment");

  // Both sockets should be assigned to the same game
  assertEquals(message1.gameId, message2.gameId);

  // But with different session IDs
  assertExists(message1.sessionId);
  assertExists(message2.sessionId);
  assertEquals(message1.sessionId !== message2.sessionId, true);

  // Clean up
  await lobbySocketStore.unregister(socket1);
  await lobbySocketStore.unregister(socket2);

  kv.close();
});

Deno.test("active games are broadcasted to all sockets", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);
  const activeGamesStream = db.watchForActiveGameListChanges();
  const lobbySocketStore = new LobbySocketStore(db, activeGamesStream);

  const setupGame = () => 1;

  // Create and register sockets
  const socket1 = { send: spy() };
  const socket2 = { send: spy() };

  lobbySocketStore.register(socket1);
  lobbySocketStore.register(socket2);

  // Create a game by having two sockets join a queue
  const queue = {
    queueId: "test-queue-broadcast",
    numPlayers: 2,
    config: undefined,
  };
  await Promise.all([
    lobbySocketStore.joinQueue(socket1, queue, setupGame),
    lobbySocketStore.joinQueue(socket2, queue, setupGame),
  ]);

  // Wait to make sure the watches are sent
  await new Promise((resolve) => setTimeout(resolve, 1));

  // (JoinQueue + UpdateActiveGames + GameAssignment)
  assertSpyCalls(socket1.send, 3);
  assertSpyCalls(socket2.send, 3);

  // Second call should be UpdateActiveGames
  const i = 1;
  const message1 = JSON.parse(socket1.send.calls[i].args[0]);
  const message2 = JSON.parse(socket2.send.calls[i].args[0]);

  // Verify the active games message was received and has game IDs

  assertEquals(message1.type, "UpdateActiveGames");
  assertEquals(message2.type, "UpdateActiveGames");
  assertExists(message1.activeGames);
  assertExists(message2.activeGames);

  // Both sockets should have the same list of active games
  assertEquals(
    JSON.stringify(message1.ids),
    JSON.stringify(message2.ids),
  );

  // Clean up
  await lobbySocketStore.unregister(socket1);
  await lobbySocketStore.unregister(socket2);

  kv.close();
});

Deno.test("when three sockets join a queue, setup is called with numPlayers=3", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);
  const activeGamesStream = db.watchForActiveGameListChanges();
  const lobbySocketStore = new LobbySocketStore(db, activeGamesStream);

  // Reset spy calls

  const setupGame = spy((_o: { players: Player[] }) => 1);

  // Create three sockets and register them
  const socket1 = { send: spy() };
  const socket2 = { send: spy() };
  const socket3 = { send: spy() };

  lobbySocketStore.register(socket1);
  lobbySocketStore.register(socket2);
  lobbySocketStore.register(socket3);

  // Join the same queue with all three sockets
  const queue = {
    queueId: "test-queue-three-players",
    numPlayers: 3,
    config: undefined,
  };

  // Use Promise.all to join all queues concurrently
  await Promise.all([
    lobbySocketStore.joinQueue(socket1, queue, setupGame),
    lobbySocketStore.joinQueue(socket2, queue, setupGame),
    lobbySocketStore.joinQueue(socket3, queue, setupGame),
  ]);

  // Wait to make sure the watches are sent
  await new Promise((resolve) => setTimeout(resolve, 1));

  // Verify setupGame was called with the numPlayers
  assertSpyCalls(setupGame, 1);
  assertEquals(setupGame.calls[0].args[0].players.length, 3);

  // Verify all sockets received GameAssignment messages
  const message1 = JSON.parse(socket1.send.calls[2].args[0]);
  const message2 = JSON.parse(socket2.send.calls[2].args[0]);
  const message3 = JSON.parse(socket3.send.calls[2].args[0]);

  assertEquals(message1.type, "GameAssignment");
  assertEquals(message2.type, "GameAssignment");
  assertEquals(message3.type, "GameAssignment");

  // All sockets should be assigned to the same game
  assertEquals(message1.gameId, message2.gameId);
  assertEquals(message2.gameId, message3.gameId);

  // But with different session IDs
  assertExists(message1.sessionId);
  assertExists(message2.sessionId);
  assertExists(message3.sessionId);
  assertEquals(message1.sessionId !== message2.sessionId, true);
  assertEquals(message2.sessionId !== message3.sessionId, true);
  assertEquals(message1.sessionId !== message3.sessionId, true);

  // Clean up
  await lobbySocketStore.unregister(socket1);
  await lobbySocketStore.unregister(socket2);
  await lobbySocketStore.unregister(socket3);

  kv.close();
});
