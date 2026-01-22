import { assertEquals, assertExists } from "@std/assert";
import { DB } from "./db.ts";
import { LobbySocketStore } from "./lobbysockets.ts";
import { assertSpyCalls, spy } from "@std/testing/mock";

const user1 = { username: "guest-0001", isGuest: true };
const user2 = { username: "guest-0002", isGuest: true };
const user3 = { username: "guest-0003", isGuest: true };
const loadout = undefined;
type TestConfig = { mode: string } | undefined;
type TestGameState = number;
type TestLoadout = undefined;
type TestOutcome = undefined;

Deno.test("registers and unregisters a socket", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB<TestConfig, TestGameState, TestLoadout, TestOutcome>(kv);
  const activeGamesStream = db.watchForActiveGameListChanges();
  const availableRoomsStream = db.watchForAvailableRoomListChanges();
  const lobbySocketStore = new LobbySocketStore<
    TestConfig,
    TestGameState,
    TestLoadout,
    TestOutcome
  >(
    db,
    activeGamesStream,
    availableRoomsStream,
  );

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
  const db = new DB<TestConfig, TestGameState, TestLoadout, TestOutcome>(kv);
  const activeGamesStream = db.watchForActiveGameListChanges();
  const availableRoomsStream = db.watchForAvailableRoomListChanges();
  const lobbySocketStore = new LobbySocketStore<
    TestConfig,
    TestGameState,
    TestLoadout,
    TestOutcome
  >(
    db,
    activeGamesStream,
    availableRoomsStream,
  );

  const setupGame = () => 1;

  // Create a socket and register it
  const socket = { send: spy() };
  lobbySocketStore.register(socket);

  // Join a queue
  const queue = { queueId: "test-queue", numPlayers: 2, config: undefined };
  await lobbySocketStore.joinQueue(
    socket,
    queue,
    "user-1",
    user1,
    loadout,
    setupGame,
  );

  // Verify the socket has a queue entry associated with it
  // We can't directly access the private fields, but we can test functionality

  // Leave the queue
  await lobbySocketStore.leaveMatchmaking(socket);

  // Verify we can join again (which would fail if not properly removed)
  await lobbySocketStore.joinQueue(
    socket,
    queue,
    "user-1",
    user1,
    loadout,
    setupGame,
  );

  // Clean up
  await lobbySocketStore.leaveMatchmaking(socket);
  await lobbySocketStore.unregister(socket);

  kv.close();
});

Deno.test("when two sockets join a queue, assignments are made", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB<TestConfig, TestGameState, TestLoadout, TestOutcome>(kv);
  const activeGamesStream = db.watchForActiveGameListChanges();
  const availableRoomsStream = db.watchForAvailableRoomListChanges();
  const lobbySocketStore = new LobbySocketStore<
    TestConfig,
    TestGameState,
    TestLoadout,
    TestOutcome
  >(
    db,
    activeGamesStream,
    availableRoomsStream,
  );

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
    lobbySocketStore.joinQueue(
      socket1,
      queue,
      "user-1",
      user1,
      loadout,
      setupGame,
    ),
    lobbySocketStore.joinQueue(
      socket2,
      queue,
      "user-2",
      user2,
      loadout,
      setupGame,
    ),
  ]);

  // Wait to make sure the watches are sent
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Verify both sockets received messages
  assertSpyCalls(socket1.send, 3);
  assertSpyCalls(socket2.send, 3);

  // Capture the sent messages - order may be different now, so find by type
  let message1, message2;

  for (let i = 0; i < socket1.send.calls.length; i++) {
    const msg = JSON.parse(socket1.send.calls[i].args[0]);
    if (msg.type === "GameAssignment") {
      message1 = msg;
      break;
    }
  }

  for (let i = 0; i < socket2.send.calls.length; i++) {
    const msg = JSON.parse(socket2.send.calls[i].args[0]);
    if (msg.type === "GameAssignment") {
      message2 = msg;
      break;
    }
  }

  // Verify assignment messages
  assertExists(message1);
  assertExists(message2);
  assertEquals(message1.type, "GameAssignment");
  assertEquals(message2.type, "GameAssignment");

  // Both sockets should be assigned to the same game
  assertEquals(message1.gameId, message2.gameId);

  // Assignments include only the game ID

  // Clean up
  await lobbySocketStore.unregister(socket1);
  await lobbySocketStore.unregister(socket2);

  kv.close();
});

Deno.test("active games are broadcasted to all sockets", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB<TestConfig, TestGameState, TestLoadout, TestOutcome>(kv);
  const activeGamesStream = db.watchForActiveGameListChanges();
  const availableRoomsStream = db.watchForAvailableRoomListChanges();
  const lobbySocketStore = new LobbySocketStore<
    TestConfig,
    TestGameState,
    TestLoadout,
    TestOutcome
  >(
    db,
    activeGamesStream,
    availableRoomsStream,
  );

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
    lobbySocketStore.joinQueue(
      socket1,
      queue,
      "user-1",
      user1,
      loadout,
      setupGame,
    ),
    lobbySocketStore.joinQueue(
      socket2,
      queue,
      "user-2",
      user2,
      loadout,
      setupGame,
    ),
  ]);

  // Wait to make sure the watches are sent
  await new Promise((resolve) => setTimeout(resolve, 100));

  // (JoinQueue + UpdateActiveGames + GameAssignment)
  assertSpyCalls(socket1.send, 3);
  assertSpyCalls(socket2.send, 3);

  // Find UpdateActiveGames message
  let message1, message2;

  for (let i = 0; i < socket1.send.calls.length; i++) {
    const msg = JSON.parse(socket1.send.calls[i].args[0]);
    if (msg.type === "UpdateActiveGames") {
      message1 = msg;
      break;
    }
  }

  for (let i = 0; i < socket2.send.calls.length; i++) {
    const msg = JSON.parse(socket2.send.calls[i].args[0]);
    if (msg.type === "UpdateActiveGames") {
      message2 = msg;
      break;
    }
  }

  // Verify the active games message was received and has game IDs
  assertExists(message1);
  assertExists(message2);
  assertEquals(message1.type, "UpdateActiveGames");
  assertEquals(message2.type, "UpdateActiveGames");
  assertExists(message1.allActiveGames);
  assertExists(message2.allActiveGames);

  // Both sockets should have the same list of active games
  assertEquals(
    JSON.stringify(message1.allActiveGames),
    JSON.stringify(message2.allActiveGames),
  );

  // Clean up
  await lobbySocketStore.unregister(socket1);
  await lobbySocketStore.unregister(socket2);

  kv.close();
});

Deno.test("players can join a three-player queue and receive QueueJoined messages", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB<TestConfig, TestGameState, TestLoadout, TestOutcome>(kv);
  const activeGamesStream = db.watchForActiveGameListChanges();
  const availableRoomsStream = db.watchForAvailableRoomListChanges();
  const lobbySocketStore = new LobbySocketStore<
    TestConfig,
    TestGameState,
    TestLoadout,
    TestOutcome
  >(
    db,
    activeGamesStream,
    availableRoomsStream,
  );

  // Create a simple setup function (not a spy anymore)
  const setupGame = () => 1;

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

  // Join queues
  await lobbySocketStore.joinQueue(
    socket1,
    queue,
    "user-1",
    user1,
    loadout,
    setupGame,
  );
  await lobbySocketStore.joinQueue(
    socket2,
    queue,
    "user-2",
    user2,
    loadout,
    setupGame,
  );
  await lobbySocketStore.joinQueue(
    socket3,
    queue,
    "user-3",
    user3,
    loadout,
    setupGame,
  );

  // Verify QueueJoined messages were sent to all sockets
  assertSpyCalls(socket1.send, 1);
  assertSpyCalls(socket2.send, 1);
  assertSpyCalls(socket3.send, 1);

  const message1 = JSON.parse(socket1.send.calls[0].args[0]);
  const message2 = JSON.parse(socket2.send.calls[0].args[0]);
  const message3 = JSON.parse(socket3.send.calls[0].args[0]);

  assertEquals(message1.type, "QueueJoined");
  assertEquals(message2.type, "QueueJoined");
  assertEquals(message3.type, "QueueJoined");

  // Clean up
  await lobbySocketStore.unregister(socket1);
  await lobbySocketStore.unregister(socket2);
  await lobbySocketStore.unregister(socket3);

  kv.close();
});

Deno.test("players can create and leave a room", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB<TestConfig, TestGameState, TestLoadout, TestOutcome>(kv);
  const activeGamesStream = db.watchForActiveGameListChanges();
  const availableRoomsStream = db.watchForAvailableRoomListChanges();
  const lobbySocketStore = new LobbySocketStore<
    TestConfig,
    TestGameState,
    TestLoadout,
    TestOutcome
  >(
    db,
    activeGamesStream,
    availableRoomsStream,
  );

  const socket = { send: spy() };
  lobbySocketStore.register(socket);

  await lobbySocketStore.createAndJoinRoom(
    socket,
    { numPlayers: 2, config: { mode: "test" }, private: false },
    "user-1",
    user1,
    loadout,
  );

  let joinedMessage;
  for (const call of socket.send.calls) {
    const message = JSON.parse(call.args[0]);
    if (message.type === "RoomJoined") {
      joinedMessage = message;
      break;
    }
  }

  assertExists(joinedMessage);
  assertEquals(joinedMessage.type, "RoomJoined");

  await lobbySocketStore.leaveMatchmaking(socket);

  let leftMessage;
  for (const call of socket.send.calls) {
    const message = JSON.parse(call.args[0]);
    if (message.type === "RoomLeft") {
      leftMessage = message;
      break;
    }
  }

  assertExists(leftMessage);
  assertEquals(leftMessage.type, "RoomLeft");

  await lobbySocketStore.unregister(socket);
  kv.close();
});
