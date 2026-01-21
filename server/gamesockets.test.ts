import { assertEquals, assertExists } from "@std/assert";
import { spy } from "@std/testing/mock";
import { DB, type GameStorageData } from "./db.ts";
import { GameSocketStore } from "./gamesockets.ts";
import type { PlayerStateObject, PublicStateObject, User } from "../types.ts";

const user1: User = { username: "guest-0001", isGuest: true };
const user2: User = { username: "guest-0002", isGuest: true };

type TestConfig = undefined;
type TestState = { value: number };
type TestPlayerState = { playerId: number; value: number };
type TestPublicState = { value: number };
type TestOutcome = "done";
type TestLoadout = undefined;

function getGameKey(gameId: string) {
  return ["games", gameId];
}

function buildGameData(
  value: number,
  outcome?: TestOutcome,
): GameStorageData<TestConfig, TestState, TestOutcome> {
  return {
    config: undefined,
    gameState: { value },
    playerUserIds: ["user-1", "user-2"],
    players: [user1, user2],
    outcome,
  };
}

const playerStateLogic = (
  state: TestState,
  o: PlayerStateObject<TestConfig>,
): TestPlayerState => ({
  playerId: o.playerId,
  value: state.value,
});

const publicStateLogic = (
  state: TestState,
  _o: PublicStateObject<TestConfig>,
): TestPublicState => ({
  value: state.value,
});

Deno.test("initialize sends UpdateGameState when client state is stale", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB<TestConfig, TestState, TestLoadout, TestOutcome>(kv);
  const gameSocketStore = new GameSocketStore<
    TestConfig,
    TestState,
    TestPlayerState,
    TestPublicState,
    TestOutcome,
    TestLoadout
  >(db);

  const gameId = "game-initialize";
  await kv.set(getGameKey(gameId), buildGameData(0));

  const socket = { send: spy() };
  gameSocketStore.register(
    socket,
    gameId,
    playerStateLogic,
    publicStateLogic,
    0,
  );

  await gameSocketStore.initialize(
    socket,
    gameId,
    { value: -1 },
    { playerId: 0, value: -1 },
    playerStateLogic,
    publicStateLogic,
  );

  let updateMessage;
  for (const call of socket.send.calls) {
    const msg = JSON.parse(call.args[0]);
    if (msg.type === "UpdateGameState" && msg.publicState?.value === 0) {
      updateMessage = msg;
      break;
    }
  }

  assertExists(updateMessage);
  assertEquals(updateMessage.playerState?.value, 0);
  assertEquals(updateMessage.publicState.value, 0);
  assertEquals(updateMessage.outcome, undefined);

  gameSocketStore.unregister(socket, gameId);
  kv.close();
});

Deno.test("streams updates to player and observer sockets", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB<TestConfig, TestState, TestLoadout, TestOutcome>(kv);
  const gameSocketStore = new GameSocketStore<
    TestConfig,
    TestState,
    TestPlayerState,
    TestPublicState,
    TestOutcome,
    TestLoadout
  >(db);

  const gameId = "game-stream";
  await kv.set(getGameKey(gameId), buildGameData(0));

  const playerSocket = { send: spy() };
  const observerSocket = { send: spy() };

  gameSocketStore.register(
    playerSocket,
    gameId,
    playerStateLogic,
    publicStateLogic,
    0,
  );
  gameSocketStore.register(
    observerSocket,
    gameId,
    playerStateLogic,
    publicStateLogic,
  );

  await Promise.all([
    gameSocketStore.initialize(
      playerSocket,
      gameId,
      { value: 0 },
      { playerId: 0, value: 0 },
      playerStateLogic,
      publicStateLogic,
    ),
    gameSocketStore.initialize(
      observerSocket,
      gameId,
      { value: 0 },
      undefined,
      playerStateLogic,
      publicStateLogic,
    ),
  ]);

  const updatedData = buildGameData(5, "done");
  await db.updateGameStorageData(gameId, updatedData);

  await new Promise((resolve) => setTimeout(resolve, 100));

  let playerUpdate;
  for (const call of playerSocket.send.calls) {
    const msg = JSON.parse(call.args[0]);
    if (msg.type === "UpdateGameState" && msg.publicState?.value === 5) {
      playerUpdate = msg;
      break;
    }
  }

  let observerUpdate;
  for (const call of observerSocket.send.calls) {
    const msg = JSON.parse(call.args[0]);
    if (msg.type === "UpdateGameState" && msg.publicState?.value === 5) {
      observerUpdate = msg;
      break;
    }
  }

  assertExists(playerUpdate);
  assertExists(observerUpdate);
  assertEquals(playerUpdate.outcome, "done");
  assertEquals(observerUpdate.outcome, "done");
  assertEquals(playerUpdate.playerState.value, 5);
  assertEquals(observerUpdate.playerState, undefined);

  gameSocketStore.unregister(playerSocket, gameId);
  gameSocketStore.unregister(observerSocket, gameId);
  kv.close();
});

Deno.test("unregister stops streaming updates", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB<TestConfig, TestState, TestLoadout, TestOutcome>(kv);
  const gameSocketStore = new GameSocketStore<
    TestConfig,
    TestState,
    TestPlayerState,
    TestPublicState,
    TestOutcome,
    TestLoadout
  >(db);

  const gameId = "game-unregister";
  await kv.set(getGameKey(gameId), buildGameData(0));

  const socket = { send: spy() };
  gameSocketStore.register(
    socket,
    gameId,
    playerStateLogic,
    publicStateLogic,
    0,
  );

  await gameSocketStore.initialize(
    socket,
    gameId,
    { value: 0 },
    { playerId: 0, value: 0 },
    playerStateLogic,
    publicStateLogic,
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  const callCount = socket.send.calls.length;

  gameSocketStore.unregister(socket, gameId);

  await db.updateGameStorageData(gameId, buildGameData(2));
  await new Promise((resolve) => setTimeout(resolve, 100));

  assertEquals(socket.send.calls.length, callCount);

  kv.close();
});
