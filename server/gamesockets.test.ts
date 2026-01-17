import { assertEquals } from "@std/assert";
import { DB } from "./db.ts";
import { GameSocketStore } from "./gamesockets.ts";
import { assertSpyCalls, spy } from "@std/testing/mock";
import type { PlayerStateObject, PublicStateObject } from "../types.ts";

const getPlayerState = (
  state: number,
  _o: PlayerStateObject<undefined>,
) => state;

const getPublicState = (
  state: number,
  _o: PublicStateObject<undefined>,
) => state;

function createGameData(
  kv: Deno.Kv,
  gameId: string,
  value: number,
  version: number,
) {
  const gameKey = ["games", gameId];
  const activeGameKey = ["activegames", gameId];
  const activeGameTriggerKey = ["activegametrigger"];

  const playerUserIds = ["user-1", "user-2"];
  const players = [
    { username: "Player 1", isGuest: false },
    { username: "Player 2", isGuest: false },
  ];

  return kv.atomic()
    .set(activeGameTriggerKey, {})
    .set(activeGameKey, {})
    .set(gameKey, {
      config: undefined,
      gameState: value,
      playerUserIds,
      players,
      isComplete: false,
      version,
    })
    .commit()
    .then(() => ({ playerUserIds, players }));
}

Deno.test("registers and unregisters player and observer sockets", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);
  const gameSocketStore = new GameSocketStore<
    undefined,
    number,
    number,
    number
  >(db);

  const socket = { send: spy() };
  const observerSocket = { send: spy() };
  const gameId = "test-game-1";

  gameSocketStore.registerPlayer(
    socket,
    gameId,
    1,
    getPlayerState,
    getPublicState,
  );
  gameSocketStore.registerObserver(
    observerSocket,
    gameId,
    getPlayerState,
    getPublicState,
  );

  gameSocketStore.unregister(socket, gameId);
  gameSocketStore.unregister(observerSocket, gameId);

  kv.close();
});

Deno.test("sends state updates to all player sockets", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);
  const gameId = "test-game-2";

  const { playerUserIds, players } = await createGameData(kv, gameId, 1, 0);
  const gameSocketStore = new GameSocketStore<
    undefined,
    number,
    number,
    number
  >(db);

  const socket1 = { send: spy() };
  const socket2 = { send: spy() };

  gameSocketStore.registerPlayer(
    socket1,
    gameId,
    0,
    getPlayerState,
    getPublicState,
  );
  gameSocketStore.registerPlayer(
    socket2,
    gameId,
    1,
    getPlayerState,
    getPublicState,
  );

  await db.updateGameStorageData(gameId, {
    config: undefined,
    gameState: 1,
    playerUserIds,
    players,
    isComplete: false,
    version: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 1));

  assertSpyCalls(socket1.send, 1);
  assertSpyCalls(socket2.send, 1);

  const message1 = JSON.parse(socket1.send.calls[0].args[0]);
  assertEquals(message1.type, "UpdateGameState");
  assertEquals(message1.mode, "player");
  assertEquals(message1.playerState, 1);
  assertEquals(message1.publicState, 1);

  const message2 = JSON.parse(socket2.send.calls[0].args[0]);
  assertEquals(message2.type, "UpdateGameState");
  assertEquals(message2.mode, "player");
  assertEquals(message2.playerState, 1);
  assertEquals(message2.publicState, 1);

  gameSocketStore.unregister(socket1, gameId);
  gameSocketStore.unregister(socket2, gameId);

  kv.close();
});

Deno.test("sends state updates to all observer sockets", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);
  const gameId = "test-game-3";

  const { playerUserIds, players } = await createGameData(kv, gameId, 1, 0);
  const gameSocketStore = new GameSocketStore<
    undefined,
    number,
    number,
    number
  >(db);

  const socket1 = { send: spy() };
  const socket2 = { send: spy() };

  gameSocketStore.registerObserver(
    socket1,
    gameId,
    getPlayerState,
    getPublicState,
  );
  gameSocketStore.registerObserver(
    socket2,
    gameId,
    getPlayerState,
    getPublicState,
  );

  await db.updateGameStorageData(gameId, {
    config: undefined,
    gameState: 1,
    playerUserIds,
    players,
    isComplete: false,
    version: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 1));

  assertSpyCalls(socket1.send, 1);
  assertSpyCalls(socket2.send, 1);

  const message1 = JSON.parse(socket1.send.calls[0].args[0]);
  assertEquals(message1.type, "UpdateGameState");
  assertEquals(message1.mode, "observer");
  assertEquals(message1.publicState, 1);

  const message2 = JSON.parse(socket2.send.calls[0].args[0]);
  assertEquals(message2.type, "UpdateGameState");
  assertEquals(message2.mode, "observer");
  assertEquals(message2.publicState, 1);

  gameSocketStore.unregister(socket1, gameId);
  gameSocketStore.unregister(socket2, gameId);

  kv.close();
});

Deno.test("only sends updates when player state changes", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);
  const gameId = "test-game-4";

  const { playerUserIds, players } = await createGameData(kv, gameId, 1, 0);
  const gameSocketStore = new GameSocketStore<
    undefined,
    number,
    number,
    number
  >(db);

  const socket = { send: spy() };

  await db.updateGameStorageData(gameId, {
    config: undefined,
    gameState: 1,
    playerUserIds,
    players,
    isComplete: false,
    version: 1,
  });

  gameSocketStore.registerPlayer(
    socket,
    gameId,
    0,
    getPlayerState,
    getPublicState,
  );
  await gameSocketStore.initializePlayer(
    socket,
    gameId,
    1,
    1,
    getPlayerState,
    getPublicState,
  );

  socket.send = spy();

  await db.updateGameStorageData(gameId, {
    config: undefined,
    gameState: 1,
    playerUserIds,
    players,
    isComplete: false,
    version: 2,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  assertSpyCalls(socket.send, 0);

  gameSocketStore.unregister(socket, gameId);

  kv.close();
});

Deno.test("only sends updates when public state changes", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);
  const gameId = "test-game-5";

  const { playerUserIds, players } = await createGameData(kv, gameId, 1, 0);
  const gameSocketStore = new GameSocketStore<
    undefined,
    number,
    number,
    number
  >(db);

  const socket = { send: spy() };

  gameSocketStore.registerObserver(
    socket,
    gameId,
    getPlayerState,
    getPublicState,
  );

  await db.updateGameStorageData(gameId, {
    config: undefined,
    gameState: 1,
    playerUserIds,
    players,
    isComplete: false,
    version: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  await db.updateGameStorageData(gameId, {
    config: undefined,
    gameState: 1,
    playerUserIds,
    players,
    isComplete: false,
    version: 2,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  assertSpyCalls(socket.send, 1);

  gameSocketStore.unregister(socket, gameId);

  kv.close();
});

Deno.test("updates both player and observer sockets together", async () => {
  const kv = await Deno.openKv(":memory:");
  const db = new DB(kv);
  const gameId = "test-game-6";

  const { playerUserIds, players } = await createGameData(kv, gameId, 1, 0);
  const gameSocketStore = new GameSocketStore<
    undefined,
    number,
    number,
    number
  >(db);

  const playerSocket = { send: spy() };
  const observerSocket = { send: spy() };

  gameSocketStore.registerPlayer(
    playerSocket,
    gameId,
    0,
    getPlayerState,
    getPublicState,
  );
  gameSocketStore.registerObserver(
    observerSocket,
    gameId,
    getPlayerState,
    getPublicState,
  );

  await db.updateGameStorageData(gameId, {
    config: undefined,
    gameState: 1,
    playerUserIds,
    players,
    isComplete: false,
    version: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 1));

  assertSpyCalls(playerSocket.send, 1);
  assertSpyCalls(observerSocket.send, 1);

  const playerMessage = JSON.parse(playerSocket.send.calls[0].args[0]);
  assertEquals(playerMessage.mode, "player");
  const observerMessage = JSON.parse(observerSocket.send.calls[0].args[0]);
  assertEquals(observerMessage.mode, "observer");

  gameSocketStore.unregister(playerSocket, gameId);
  gameSocketStore.unregister(observerSocket, gameId);

  kv.close();
});
