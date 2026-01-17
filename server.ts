import type { ActiveGame, Game, GameProps, LobbyProps, User } from "./types.ts";
import type {
  GameSocketRequest,
  LobbySocketRequest,
  LobbySocketResponse,
} from "./common/types.ts";
import {
  fetchActiveGames,
  getPlayerId,
  getPlayerState,
  getPublicState,
  handleMove,
  handleRefresh,
} from "./server/gamedata.ts";
import { GameSocketStore } from "./server/gamesockets.ts";
import { DB } from "./server/db.ts";
import { LobbySocketStore } from "./server/lobbysockets.ts";
import { ulid } from "@std/ulid";

const tokenTtlMs = 1000 * 60 * 60 * 24 * 30;

export async function initializeServer<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
>(
  game: Game<Config, GameState, Move, PlayerState, PublicState>,
): Promise<Server<Config, GameState, Move, PlayerState, PublicState>> {
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
  const gameSocketStore = new GameSocketStore<
    Config,
    GameState,
    PlayerState,
    PublicState
  >(db);

  return new Server(
    game,
    db,
    lobbySocketStore,
    gameSocketStore,
  );
}

export type { Server };

class Server<Config, GameState, Move, PlayerState, PublicState> {
  constructor(
    private game: Game<Config, GameState, Move, PlayerState, PublicState>,
    private db: DB,
    private lobbySocketStore: LobbySocketStore,
    private gameSocketStore: GameSocketStore<
      Config,
      GameState,
      PlayerState,
      PublicState
    >,
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

  async getInitialGameProps(
    gameId: string,
    token: string | undefined,
  ): Promise<GameProps<PlayerState, PublicState>> {
    const gameData = await this.db.getGameStorageData<Config, GameState>(
      gameId,
    );

    let playerId: number | undefined;
    const userId = await this.getUserIdFromToken(token);
    if (userId != null) {
      playerId = getPlayerId(gameData, userId);
    }

    if (playerId != null) {
      const playerState = getPlayerState(
        gameData,
        this.game.playerState,
        playerId,
      );
      const publicState = getPublicState(gameData, this.game.publicState);
      return {
        mode: "player",
        playerId,
        playerState,
        publicState,
        isComplete: gameData.isComplete,
        players: gameData.players,
      };
    } else {
      const publicState = getPublicState(gameData, this.game.publicState);
      return {
        mode: "observer",
        publicState,
        isComplete: gameData.isComplete,
        players: gameData.players,
        playerId: undefined,
      };
    }
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
            userId,
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

  async configureGameSocket(
    socket: WebSocket,
    gameId: string,
    token: string | undefined,
  ) {
    const userId = await this.getUserIdFromToken(token);
    const gameData = await this.db.getGameStorageData<Config, GameState>(
      gameId,
    );
    const playerId = userId == null ? undefined : getPlayerId(gameData, userId);

    if (playerId != null) {
      const handlePlaySocketOpen = () => {
        this.gameSocketStore.registerPlayer(
          socket,
          gameId,
          playerId,
          this.game.playerState,
          this.game.publicState,
        );
      };

      const handlePlaySocketMessage = async (event: MessageEvent) => {
        const request: GameSocketRequest<
          Move,
          PlayerState,
          PublicState
        > = JSON.parse(
          event.data,
        );
        switch (request.type) {
          case "InitializePlayer":
            await this.gameSocketStore.initializePlayer(
              socket,
              gameId,
              request.currentPlayerState,
              request.currentPublicState,
              this.game.playerState,
              this.game.publicState,
            );
            break;
          case "InitializeObserver":
            break;
          case "Move":
            await handleMove(
              this.db,
              this.game,
              gameId,
              playerId,
              request.move,
            );
            break;
        }
      };

      const handlePlaySocketClose = () => {
        this.gameSocketStore.unregister(socket, gameId);
      };

      socket.addEventListener("open", handlePlaySocketOpen);
      socket.addEventListener("message", handlePlaySocketMessage);
      socket.addEventListener("close", handlePlaySocketClose);
      return;
    }

    const handleObserveSocketOpen = () => {
      console.log("observe socket opened");
      this.gameSocketStore.registerObserver(
        socket,
        gameId,
        this.game.playerState,
        this.game.publicState,
      );
    };

    const handleObserveSocketMessage = async (event: MessageEvent) => {
      const request: GameSocketRequest<
        Move,
        PlayerState,
        PublicState
      > = JSON.parse(
        event.data,
      );
      switch (request.type) {
        case "InitializeObserver": {
          await this.gameSocketStore.initializeObserver(
            socket,
            gameId,
            request.currentPublicState,
            this.game.publicState,
          );
          break;
        }
        case "InitializePlayer":
        case "Move":
          break;
      }
    };

    const handleObserveSocketClose = () => {
      this.gameSocketStore.unregister(socket, gameId);
    };

    socket.addEventListener("open", handleObserveSocketOpen);
    socket.addEventListener("message", handleObserveSocketMessage);
    socket.addEventListener("close", handleObserveSocketClose);
  }

  private async getUserIdFromToken(
    token: string | undefined,
  ): Promise<string | undefined> {
    if (token == null || token === "") {
      return;
    }
    const tokenData = await this.db.getToken(token);
    if (tokenData == null || tokenData.expiration <= new Date()) {
      return;
    }
    return tokenData.userId;
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
