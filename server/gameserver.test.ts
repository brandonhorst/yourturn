import { assert, assertEquals, assertExists } from "@std/assert";
import type { Game } from "../types.ts";
import { DB, type GameStorageData } from "./db.ts";
import { GameSocketStore } from "./gamesockets.ts";
import { LobbySocketStore } from "./lobbysockets.ts";
import { Server } from "./gameserver.ts";

type TestConfig = { mode: string };
type TestGameState = { value: number };
type TestMove = { delta: number };
type TestPlayerState = { playerId: number; value: number };
type TestPublicState = { value: number };
type TestOutcome = "done";
type TestLoadout = { color: string };

const testGame: Game<
  TestConfig,
  TestGameState,
  TestMove,
  TestPlayerState,
  TestPublicState,
  TestOutcome,
  TestLoadout
> = {
  queues: {
    default: { numPlayers: 2, config: { mode: "standard" } },
  },
  setup: () => ({ value: 0 }),
  isValidMove: () => true,
  processMove: (state, move) => ({ value: state.value + move.move.delta }),
  playerState: (state, o) => ({ playerId: o.playerId, value: state.value }),
  publicState: (state) => ({ value: state.value }),
  outcome: () => undefined,
};

function getGameKey(gameId: string) {
  return ["games", gameId];
}

function buildServer(kv: Deno.Kv) {
  const db = new DB(kv);
  const activeGamesStream = db.watchForActiveGameListChanges();
  const availableRoomsStream = db.watchForAvailableRoomListChanges<
    TestConfig,
    TestLoadout
  >();
  const lobbySocketStore = new LobbySocketStore(
    db,
    activeGamesStream,
    availableRoomsStream,
  );
  const gameSocketStore = new GameSocketStore<
    TestConfig,
    TestGameState,
    TestPlayerState,
    TestPublicState,
    TestOutcome
  >(db);

  return {
    db,
    server: new Server(
      testGame,
      db,
      lobbySocketStore,
      gameSocketStore,
    ),
  };
}

Deno.test("getInitialLobbyProps creates a guest token when missing", async () => {
  const kv = await Deno.openKv(":memory:");
  const { db, server } = await buildServer(kv);

  const result = await server.getInitialLobbyProps(undefined);

  assertExists(result.token);
  assertEquals(result.props.activeGames, []);
  assertEquals(result.props.availableRooms, []);
  assertEquals(result.props.user.isGuest, true);
  assert(result.props.user.username.startsWith("guest-"));

  const tokenData = await db.getToken(result.token);
  assertExists(tokenData);
  const storedUser = await db.getUser(tokenData.userId);
  assertExists(storedUser);

  kv.close();
});

Deno.test("getInitialLobbyProps uses existing user for valid token", async () => {
  const kv = await Deno.openKv(":memory:");
  const { db, server } = await buildServer(kv);

  const userId = "user-123";
  const user = { username: "tester", isGuest: false };
  const token = "token-123";
  const expiration = new Date(Date.now() + 60_000);

  await db.storeUser(userId, user);
  await db.storeToken(token, { userId, expiration });

  const result = await server.getInitialLobbyProps(token);

  assertEquals(result.token, token);
  assertEquals(result.props.user, user);
  assertEquals(result.props.activeGames, []);
  assertEquals(result.props.availableRooms, []);

  kv.close();
});

Deno.test("getInitialGameProps returns player state for matching token", async () => {
  const kv = await Deno.openKv(":memory:");
  const { db, server } = await buildServer(kv);

  const userId = "user-1";
  const token = "token-1";
  const expiration = new Date(Date.now() + 60_000);
  await db.storeToken(token, { userId, expiration });

  const gameId = "game-1";
  const players = [
    { username: "player-1", isGuest: false },
    { username: "player-2", isGuest: false },
  ];
  const gameData: GameStorageData<
    TestConfig,
    TestGameState,
    TestOutcome
  > = {
    config: { mode: "standard" },
    gameState: { value: 7 },
    playerUserIds: [userId, "user-2"],
    players,
    outcome: undefined,
    version: 0,
  };

  await kv.set(getGameKey(gameId), gameData);

  const result = await server.getInitialGameProps(gameId, token);

  assertEquals(result.playerId, 0);
  assertEquals(result.publicState, { value: 7 });
  assertEquals(result.playerState, { playerId: 0, value: 7 });
  assertEquals(result.players, players);

  kv.close();
});
