import { assertEquals, assertExists } from "@std/assert";
import { DB } from "../../server/db.ts";
import { LobbySocketStore } from "../../server/lobbysockets.ts";
import { assertSpyCalls, spy } from "@std/testing/mock";
import type { Game, QueueConfig } from "../../types.ts";

const user1 = { username: "guest-0001", isGuest: true };
const user2 = { username: "guest-0002", isGuest: true };
const user3 = { username: "guest-0003", isGuest: true };
const loadout = undefined;
type TestConfig = { mode: string } | undefined;
type TestGameState = number;
type TestMove = { delta: number };
type TestPlayerState = number;
type TestPublicState = number;
type TestLoadout = undefined;
type TestOutcome = undefined;
type TestRating = number;

const defaultRatings = { default: 1000 };

// Creates user records for tests that need to attach games to users.
async function seedUsers<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Loadout,
  Outcome,
>(
  db: DB<
    Config,
    GameState,
    Move,
    PlayerState,
    PublicState,
    Outcome,
    TestRating,
    Loadout
  >,
  users: Array<{ userId: string; player: typeof user1 }>,
): Promise<void> {
  for (const user of users) {
    await db.createNewUserStorageData(user.userId, {
      player: user.player,
      activeGames: [],
      ratings: defaultRatings,
      joinedRooms: [],
      queueEntries: [],
      roomInvitations: [],
    });
  }
}

// Builds user storage data for a test player.
function buildUserStorageData(player: typeof user1) {
  return {
    player,
    activeGames: [],
    ratings: defaultRatings,
    roomEntries: [],
    queueEntries: [],
    roomInvitations: [],
  };
}

// Builds a minimal game stub with the provided queues for queue-based tests.
function buildTestGame(
  queues: Record<string, QueueConfig<TestConfig>> = {},
): Game<
  TestConfig,
  TestGameState,
  TestMove,
  TestPlayerState,
  TestPublicState,
  TestOutcome,
  TestRating,
  TestLoadout
> {
  return {
    queues,
    setup: () => 1,
    isValidMove: () => true,
    processMove: (state) => state,
    playerState: () => 1,
    publicState: () => 1,
    outcome: () => undefined,
    initialRating: () => 1000,
    processOutcome: (_outcome, currentRatings) => currentRatings,
  };
}

Deno.test("subscribes and unsubscribes a socket", async () => {
  const kv = await Deno.openKv(":memory:");
  const game = buildTestGame();
  const db = new DB<
    TestConfig,
    TestGameState,
    TestMove,
    TestPlayerState,
    TestPublicState,
    TestOutcome,
    TestRating,
    TestLoadout
  >(kv, game);
  const activeGamesStream = db.watchForActiveGameListChanges();
  const availableRoomsStream = db.watchForAvailableRoomListChanges();
  const lobbySocketStore = new LobbySocketStore<
    TestConfig,
    TestGameState,
    TestMove,
    TestPlayerState,
    TestPublicState,
    TestOutcome,
    TestRating,
    TestLoadout
  >(
    db,
    activeGamesStream,
    availableRoomsStream,
  );

  await db.createNewUserStorageData("user-1", {
    player: user1,
    activeGames: [],
    ratings: defaultRatings,
    joinedRooms: [],
    queueEntries: [],
    roomInvitations: [],
  });
  const userData = await db.getLobbyUserData("user-1");
  assertExists(userData);

  // Subscribe a socket
  const socket = { send: spy() };
  lobbySocketStore.subscribe(socket, "user-1", userData, [], []);

  // Unsubscribe the socket
  await lobbySocketStore.unsubscribe(socket);

  // Unsubscribe should be a no-op after first unsubscribe
  await lobbySocketStore.unsubscribe(socket);

  kv.close();
});

Deno.test("joins and leaves a queue", async () => {
  const kv = await Deno.openKv(":memory:");
  const queue = {
    queueId: "test-queue",
    numPlayers: 2,
    config: undefined,
    queueType: "ranked" as const,
  };
  const game = buildTestGame({
    [queue.queueId]: {
      numPlayers: queue.numPlayers,
      config: queue.config,
      queueType: queue.queueType,
    },
  });
  const db = new DB<
    TestConfig,
    TestGameState,
    TestMove,
    TestPlayerState,
    TestPublicState,
    TestOutcome,
    TestRating,
    TestLoadout
  >(kv, game);
  const activeGamesStream = db.watchForActiveGameListChanges();
  const availableRoomsStream = db.watchForAvailableRoomListChanges();
  const lobbySocketStore = new LobbySocketStore<
    TestConfig,
    TestGameState,
    TestMove,
    TestPlayerState,
    TestPublicState,
    TestOutcome,
    TestRating,
    TestLoadout
  >(
    db,
    activeGamesStream,
    availableRoomsStream,
  );

  await seedUsers(db, [{ userId: "user-1", player: user1 }]);

  // Create a socket and register it
  const socket = { send: spy() };
  lobbySocketStore.subscribe(
    socket,
    "user-1",
    buildUserStorageData(user1),
    [],
    [],
  );

  // Join a queue
  await lobbySocketStore.joinQueue(
    socket,
    queue.queueId,
    "user-1",
    user1,
    loadout,
  );

  // Verify the socket has a queue entry associated with it
  // We can't directly access the private fields, but we can test functionality

  // Leave the queue
  await lobbySocketStore.leaveQueue(socket, queue.queueId);

  // Verify we can join again (which would fail if not properly removed)
  await lobbySocketStore.joinQueue(
    socket,
    queue.queueId,
    "user-1",
    user1,
    loadout,
  );

  // Clean up
  await lobbySocketStore.leaveQueue(socket, queue.queueId);
  await lobbySocketStore.unsubscribe(socket);

  kv.close();
});

Deno.test("when two sockets join a queue, assignments are made", async () => {
  const kv = await Deno.openKv(":memory:");
  const queue = {
    queueId: "test-queue-assignments",
    numPlayers: 2,
    config: undefined,
    queueType: "ranked" as const,
  };
  const game = buildTestGame({
    [queue.queueId]: {
      numPlayers: queue.numPlayers,
      config: queue.config,
      queueType: queue.queueType,
    },
  });
  const db = new DB<
    TestConfig,
    TestGameState,
    TestMove,
    TestPlayerState,
    TestPublicState,
    TestOutcome,
    TestRating,
    TestLoadout
  >(kv, game);
  const activeGamesStream = db.watchForActiveGameListChanges();
  const availableRoomsStream = db.watchForAvailableRoomListChanges();
  const lobbySocketStore = new LobbySocketStore<
    TestConfig,
    TestGameState,
    TestMove,
    TestPlayerState,
    TestPublicState,
    TestOutcome,
    TestRating,
    TestLoadout
  >(
    db,
    activeGamesStream,
    availableRoomsStream,
  );

  await seedUsers(db, [
    { userId: "user-1", player: user1 },
    { userId: "user-2", player: user2 },
  ]);

  // Create two sockets and register them
  const socket1 = { send: spy() };
  const socket2 = { send: spy() };

  lobbySocketStore.subscribe(
    socket1,
    "user-1",
    buildUserStorageData(user1),
    [],
    [],
  );
  lobbySocketStore.subscribe(
    socket2,
    "user-2",
    buildUserStorageData(user2),
    [],
    [],
  );

  // Join the same queue with both sockets
  // Use Promise.all to join both queues concurrently
  await Promise.all([
    lobbySocketStore.joinQueue(
      socket1,
      queue.queueId,
      "user-1",
      user1,
      loadout,
    ),
    lobbySocketStore.joinQueue(
      socket2,
      queue.queueId,
      "user-2",
      user2,
      loadout,
    ),
  ]);

  // Wait to make sure the watches are sent
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Verify both sockets received messages
  assertSpyCalls(socket1.send, 4);
  assertSpyCalls(socket2.send, 4);

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
  await lobbySocketStore.unsubscribe(socket1);
  await lobbySocketStore.unsubscribe(socket2);

  kv.close();
});

Deno.test("active games are broadcasted to all sockets", async () => {
  const kv = await Deno.openKv(":memory:");
  const queue = {
    queueId: "test-queue-broadcast",
    numPlayers: 2,
    config: undefined,
    queueType: "ranked" as const,
  };
  const game = buildTestGame({
    [queue.queueId]: {
      numPlayers: queue.numPlayers,
      config: queue.config,
      queueType: queue.queueType,
    },
  });
  const db = new DB<
    TestConfig,
    TestGameState,
    TestMove,
    TestPlayerState,
    TestPublicState,
    TestOutcome,
    TestRating,
    TestLoadout
  >(kv, game);
  const activeGamesStream = db.watchForActiveGameListChanges();
  const availableRoomsStream = db.watchForAvailableRoomListChanges();
  const lobbySocketStore = new LobbySocketStore<
    TestConfig,
    TestGameState,
    TestMove,
    TestPlayerState,
    TestPublicState,
    TestOutcome,
    TestRating,
    TestLoadout
  >(
    db,
    activeGamesStream,
    availableRoomsStream,
  );

  await seedUsers(db, [
    { userId: "user-1", player: user1 },
    { userId: "user-2", player: user2 },
  ]);

  // Create and register sockets
  const socket1 = { send: spy() };
  const socket2 = { send: spy() };

  lobbySocketStore.subscribe(
    socket1,
    "user-1",
    buildUserStorageData(user1),
    [],
    [],
  );
  lobbySocketStore.subscribe(
    socket2,
    "user-2",
    buildUserStorageData(user2),
    [],
    [],
  );

  // Create a game by having two sockets join a queue
  await Promise.all([
    lobbySocketStore.joinQueue(
      socket1,
      queue.queueId,
      "user-1",
      user1,
      loadout,
    ),
    lobbySocketStore.joinQueue(
      socket2,
      queue.queueId,
      "user-2",
      user2,
      loadout,
    ),
  ]);

  // Wait to make sure the watches are sent
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Find UpdateLobbyProps message with allActiveGames
  let message1, message2;

  for (let i = 0; i < socket1.send.calls.length; i++) {
    const msg = JSON.parse(socket1.send.calls[i].args[0]);
    if (msg.type === "UpdateLobbyProps" && msg.lobbyProps?.allActiveGames) {
      message1 = msg;
      break;
    }
  }

  for (let i = 0; i < socket2.send.calls.length; i++) {
    const msg = JSON.parse(socket2.send.calls[i].args[0]);
    if (msg.type === "UpdateLobbyProps" && msg.lobbyProps?.allActiveGames) {
      message2 = msg;
      break;
    }
  }

  // Verify the active games message was received and has game IDs
  assertExists(message1);
  assertExists(message2);
  assertEquals(message1.type, "UpdateLobbyProps");
  assertEquals(message2.type, "UpdateLobbyProps");
  assertExists(message1.lobbyProps?.allActiveGames);
  assertExists(message2.lobbyProps?.allActiveGames);

  // Both sockets should have the same list of active games
  assertEquals(
    JSON.stringify(message1.lobbyProps.allActiveGames),
    JSON.stringify(message2.lobbyProps.allActiveGames),
  );

  // Clean up
  await lobbySocketStore.unsubscribe(socket1);
  await lobbySocketStore.unsubscribe(socket2);

  kv.close();
});

Deno.test("players can join a three-player queue and graduate to a game", async () => {
  const kv = await Deno.openKv(":memory:");
  const queue = {
    queueId: "test-queue-three-players",
    numPlayers: 3,
    config: undefined,
    queueType: "ranked" as const,
  };
  const game = buildTestGame({
    [queue.queueId]: {
      numPlayers: queue.numPlayers,
      config: queue.config,
      queueType: queue.queueType,
    },
  });
  const db = new DB<
    TestConfig,
    TestGameState,
    TestMove,
    TestPlayerState,
    TestPublicState,
    TestOutcome,
    TestRating,
    TestLoadout
  >(kv, game);
  const activeGamesStream = db.watchForActiveGameListChanges();
  const availableRoomsStream = db.watchForAvailableRoomListChanges();
  const lobbySocketStore = new LobbySocketStore<
    TestConfig,
    TestGameState,
    TestMove,
    TestPlayerState,
    TestPublicState,
    TestOutcome,
    TestRating,
    TestLoadout
  >(
    db,
    activeGamesStream,
    availableRoomsStream,
  );

  await seedUsers(db, [
    { userId: "user-1", player: user1 },
    { userId: "user-2", player: user2 },
    { userId: "user-3", player: user3 },
  ]);

  // Create three sockets and register them
  const socket1 = { send: spy() };
  const socket2 = { send: spy() };
  const socket3 = { send: spy() };

  lobbySocketStore.subscribe(
    socket1,
    "user-1",
    buildUserStorageData(user1),
    [],
    [],
  );
  lobbySocketStore.subscribe(
    socket2,
    "user-2",
    buildUserStorageData(user2),
    [],
    [],
  );
  lobbySocketStore.subscribe(
    socket3,
    "user-3",
    buildUserStorageData(user3),
    [],
    [],
  );

  // Join the same queue with all three sockets
  // Join queues
  await lobbySocketStore.joinQueue(
    socket1,
    queue.queueId,
    "user-1",
    user1,
    loadout,
  );
  await lobbySocketStore.joinQueue(
    socket2,
    queue.queueId,
    "user-2",
    user2,
    loadout,
  );
  await lobbySocketStore.joinQueue(
    socket3,
    queue.queueId,
    "user-3",
    user3,
    loadout,
  );

  // Wait a bit for updates to propagate (graduation happens asynchronously)
  await new Promise((resolve) => setTimeout(resolve, 150));

  // Verify that all players graduated from the queue (queueEntries should be empty)
  const userData1 = await db.getUserStorageData("user-1");
  const userData2 = await db.getUserStorageData("user-2");
  const userData3 = await db.getUserStorageData("user-3");

  assertExists(userData1);
  assertExists(userData2);
  assertExists(userData3);

  // All players should have graduated from the queue
  assertEquals(userData1.queueEntries.length, 0);
  assertEquals(userData2.queueEntries.length, 0);
  assertEquals(userData3.queueEntries.length, 0);

  // Verify a game was created
  const allActiveGames = await db.getAllActiveGames();
  assertEquals(allActiveGames.length, 1);
  assertEquals(allActiveGames[0].players.length, 3);

  // Clean up
  await lobbySocketStore.unsubscribe(socket1);
  await lobbySocketStore.unsubscribe(socket2);
  await lobbySocketStore.unsubscribe(socket3);

  kv.close();
});

Deno.test("players can create and leave a room", async () => {
  const kv = await Deno.openKv(":memory:");
  const game = buildTestGame();
  const db = new DB<
    TestConfig,
    TestGameState,
    TestMove,
    TestPlayerState,
    TestPublicState,
    TestOutcome,
    TestRating,
    TestLoadout
  >(kv, game);
  const activeGamesStream = db.watchForActiveGameListChanges();
  const availableRoomsStream = db.watchForAvailableRoomListChanges();
  const lobbySocketStore = new LobbySocketStore<
    TestConfig,
    TestGameState,
    TestMove,
    TestPlayerState,
    TestPublicState,
    TestOutcome,
    TestRating,
    TestLoadout
  >(
    db,
    activeGamesStream,
    availableRoomsStream,
  );

  await seedUsers(db, [{ userId: "user-1", player: user1 }]);

  const socket = { send: spy() };
  lobbySocketStore.subscribe(
    socket,
    "user-1",
    buildUserStorageData(user1),
    [],
    [],
  );

  // Create a room and get its ID by checking the available rooms
  await lobbySocketStore.createAndJoinRoom(
    socket,
    { numPlayers: 2, config: { mode: "test" }, private: false },
    "user-1",
    user1,
    loadout,
  );

  // Wait a bit for the room to be created
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Get the room ID from available rooms
  const rooms = await db.getAllAvailableRooms();
  assertEquals(rooms.length, 1);
  const roomId = rooms[0].roomId;

  // Verify user's joinedRooms was updated
  const userData = await db.getUserStorageData("user-1");
  assertExists(userData);
  assertEquals(userData.joinedRooms.length, 1);
  assertEquals(userData.joinedRooms[0].roomId, roomId);

  // Leave the room
  await lobbySocketStore.leaveRoom(socket, roomId);

  // Wait a bit for the update
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Verify user's joinedRooms was cleared
  const updatedUserData = await db.getUserStorageData("user-1");
  assertExists(updatedUserData);
  assertEquals(updatedUserData.joinedRooms.length, 0);

  await lobbySocketStore.unsubscribe(socket);
  kv.close();
});
