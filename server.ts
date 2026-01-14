import type {
  ActiveGame,
  Game,
  LobbyProps,
  ObserverProps,
  PlayerProps,
  User,
} from "./types.ts";
import type {
  LobbySocketRequest,
  LobbySocketResponse,
  ObserveSocketRequest,
  PlaySocketRequest,
} from "./common/types.ts";
import {
  fetchActiveGames,
  getObserverState,
  getPlayerId,
  getPlayerState,
  handleMove,
  handleRefresh,
} from "./server/gamedata.ts";
import { ObserveSocketStore } from "./server/observesockets.ts";
import { PlaySocketStore } from "./server/playsockets.ts";
import { DB } from "./server/db.ts";
import { LobbySocketStore } from "./server/lobbysockets.ts";
import { ulid } from "@std/ulid";

const tokenTtlMs = 1000 * 60 * 60 * 24 * 30;

export async function initializeServer<
  Config,
  GameState,
  Move,
  PlayerState,
  ObserverState,
>(
  game: Game<Config, GameState, Move, PlayerState, ObserverState>,
): Promise<Server<Config, GameState, Move, PlayerState, ObserverState>> {
  const kv = await Deno.openKv();
  const db = new DB(kv);

  const activeGamesStream: ReadableStream<ActiveGame[]> = db
    .watchForActiveGameListChanges();

  // Start the refresh listener if the game implements the refresh mechanism
  if (game.refresh != null) {
    const refreshStream = db.listenForRefreshes();
    (async () => {
      for await (const gameId of refreshStream) {
        await handleRefresh(db, game, gameId);
      }
    })();
  }

  const lobbySocketStore = new LobbySocketStore(db, activeGamesStream);
  const observeSocketStore = new ObserveSocketStore<
    Config,
    GameState,
    ObserverState
  >(db);
  const playSocketStore = new PlaySocketStore<Config, GameState, PlayerState>(
    db,
  );

  return new Server(
    game,
    db,
    lobbySocketStore,
    observeSocketStore,
    playSocketStore,
  );
}

export type { Server };

class Server<Config, GameState, Move, PlayerState, ObserverState> {
  constructor(
    private game: Game<Config, GameState, Move, PlayerState, ObserverState>,
    private db: DB,
    private lobbySocketStore: LobbySocketStore,
    private observeSocketStore: ObserveSocketStore<
      Config,
      GameState,
      ObserverState
    >,
    private playSocketStore: PlaySocketStore<Config, GameState, PlayerState>,
  ) {}

  async getInitialLobbyProps(
    token: string | null,
  ): Promise<{ props: LobbyProps; token: string }> {
    const activeGames = await fetchActiveGames(this.db);
    let user: User | null = null;
    let lobbyToken = token;

    if (token != null) {
      const tokenData = await this.db.getToken(token);
      if (tokenData != null && tokenData.expiration > new Date()) {
        user = await this.db.getUser(tokenData.userId);
      }
    }

    if (user == null) {
      user = await createGuestUser(this.db);
      const userId = ulid();
      lobbyToken = crypto.randomUUID();
      const expiration = new Date(Date.now() + tokenTtlMs);

      await this.db.storeUser(userId, user);
      await this.db.storeToken(lobbyToken, { userId, expiration });
    }

    if (lobbyToken == null) {
      throw new Error("Missing lobby auth token");
    }
    if (user == null) {
      throw new Error("Missing lobby user");
    }

    return { props: { activeGames, user }, token: lobbyToken };
  }

  async getInitialPlayerProps(
    gameId: string,
    sessionId: string,
  ): Promise<PlayerProps<PlayerState>> {
    const gameData = await this.db.getGameStorageData<Config, GameState>(
      gameId,
    );
    const playerId = getPlayerId(gameData, sessionId);
    const playerState = getPlayerState(
      gameData,
      this.game.playerState,
      playerId,
    );
    return {
      playerId,
      playerState,
      isComplete: gameData.isComplete,
      players: gameData.players,
    };
  }

  async getInitialObserverProps(
    gameId: string,
  ): Promise<ObserverProps<ObserverState>> {
    const gameData = await this.db.getGameStorageData<Config, GameState>(
      gameId,
    );
    const observerState = getObserverState(gameData, this.game.observerState);
    return {
      observerState,
      isComplete: gameData.isComplete,
      players: gameData.players,
    };
  }

  async configureLobbySocket(socket: WebSocket, token: string) {
    if (token === "") {
      throw new Error("Missing lobby auth token");
    }

    const tokenData = await this.db.getToken(token);
    if (tokenData == null || tokenData.expiration <= new Date()) {
      throw new Error("Invalid lobby auth token");
    }

    const storedUser = await this.db.getUser(tokenData.userId);
    if (storedUser == null) {
      throw new Error("Unknown lobby user");
    }

    let user = storedUser;
    const userId = tokenData.userId;

    const handleLobbySocketOpen = () => {
      console.log("lobby socket opened");
      this.lobbySocketStore.register(socket);
    };

    const handleLobbySocketMessage = async (event: MessageEvent) => {
      const message = event.data;
      console.log("Lobby Socket Message", message);
      const parsedMessage: LobbySocketRequest = JSON.parse(message);
      switch (parsedMessage.type) {
        case "Initialize":
          this.lobbySocketStore.initialize(socket, parsedMessage.activeGames);
          break;
        case "JoinQueue": {
          const queue = this.game.modes[parsedMessage.queueId];
          if (queue == null) {
            console.log(
              "Attempted to join non-existant queue",
              parsedMessage.queueId,
            );
            return;
          }
          const queueConfig = {
            queueId: parsedMessage.queueId,
            numPlayers: queue.numPlayers,
            config: queue.config,
          };
          await this.lobbySocketStore.joinQueue(
            socket,
            queueConfig,
            user,
            this.game.setup,
          );
          break;
        }
        case "LeaveQueue":
          await this.lobbySocketStore.leaveQueue(socket);
          break;
        case "UpdateUsername": {
          const newUsername = parsedMessage.username;
          if (newUsername === user.username) {
            break;
          }
          const existingUser = await this.db.getUserByUsername(newUsername);
          if (existingUser != null) {
            break;
          }

          const updatedUser: User = { ...user, username: newUsername };
          await this.db.storeUser(userId, updatedUser, user.username);
          user = updatedUser;

          socket.send(JSON.stringify(
            {
              type: "UserUpdated",
              user,
            } satisfies LobbySocketResponse,
          ));
          break;
        }
      }
    };

    const handleLobbySocketClose = async () => {
      console.log("lobby socket closed");
      await this.lobbySocketStore.unregister(socket);
    };

    socket.addEventListener("open", handleLobbySocketOpen);
    socket.addEventListener("message", handleLobbySocketMessage);
    socket.addEventListener("close", handleLobbySocketClose);
  }

  configureObserveSocket(
    socket: WebSocket,
    gameId: string,
  ) {
    const handleObserveSocketOpen = () => {
      console.log("observe socket opened");
      this.observeSocketStore.register(socket, gameId, this.game.observerState);
    };

    const handleObserveSocketMessage = async (event: MessageEvent) => {
      const request: ObserveSocketRequest<ObserverState> = JSON.parse(
        event.data,
      );
      switch (request.type) {
        case "Initialize": {
          await this.observeSocketStore.initialize(
            socket,
            gameId,
            request.currentObserverState,
            this.game.observerState,
          );
        }
      }
    };

    const handleObserveSocketClose = () => {
      this.observeSocketStore.unregister(socket, gameId);
    };

    socket.addEventListener("open", handleObserveSocketOpen);
    socket.addEventListener("message", handleObserveSocketMessage);
    socket.addEventListener("close", handleObserveSocketClose);
  }

  async configurePlaySocket(
    socket: WebSocket,
    gameId: string,
    sessionId: string,
  ) {
    const playerId = getPlayerId(
      await this.db.getGameStorageData<Config, GameState>(gameId),
      sessionId,
    );

    const handlePlaySocketOpen = () => {
      this.playSocketStore.register(
        socket,
        gameId,
        playerId,
        this.game.playerState,
      );
    };

    const handlePlaySocketMessage = async (event: MessageEvent) => {
      const request: PlaySocketRequest<Move, PlayerState> = JSON.parse(
        event.data,
      );
      switch (request.type) {
        case "Initialize":
          await this.playSocketStore.initialize(
            socket,
            gameId,
            request.currentPlayerState,
            this.game.playerState,
          );
          break;
        case "Move":
          await handleMove(this.db, this.game, gameId, playerId, request.move);
          break;
      }
    };

    const handlePlaySocketClose = () => {
      this.playSocketStore.unregister(socket, gameId);
    };

    socket.addEventListener("open", handlePlaySocketOpen);
    socket.addEventListener("message", handlePlaySocketMessage);
    socket.addEventListener("close", handlePlaySocketClose);
  }
}

async function createGuestUser(db: DB): Promise<User> {
  for (let attempt = 0; attempt < 10000; attempt++) {
    const suffix = Math.floor(Math.random() * 10000).toString().padStart(
      4,
      "0",
    );
    const username = `guest-${suffix}`;
    const existingUser = await db.getUserByUsername(username);
    if (existingUser == null) {
      return { username, isGuest: true };
    }
  }

  throw new Error("Failed to create a unique guest username");
}
