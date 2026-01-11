import type { ActiveGame, Game, ObserverProps, PlayerProps } from "./types.ts";
import type {
  LobbySocketRequest,
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

export async function initializeServer<
  Config,
  GameState,
  Move,
  Player,
  PlayerState,
  ObserverState,
>(
  game: Game<Config, GameState, Move, Player, PlayerState, ObserverState>,
): Promise<
  Server<Config, GameState, Move, Player, PlayerState, ObserverState>
> {
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
    Player,
    ObserverState
  >(db);
  const playSocketStore = new PlaySocketStore<
    Config,
    GameState,
    Player,
    PlayerState
  >(db);

  return new Server(
    game,
    db,
    lobbySocketStore,
    observeSocketStore,
    playSocketStore,
  );
}

export type { Server };

class Server<
  Config,
  GameState,
  Move,
  Player,
  PlayerState,
  ObserverState,
> {
  constructor(
    private game: Game<
      Config,
      GameState,
      Move,
      Player,
      PlayerState,
      ObserverState
    >,
    private db: DB,
    private lobbySocketStore: LobbySocketStore,
    private observeSocketStore: ObserveSocketStore<
      Config,
      GameState,
      Player,
      ObserverState
    >,
    private playSocketStore: PlaySocketStore<
      Config,
      GameState,
      Player,
      PlayerState
    >,
  ) {}

  async getInitialActiveGames(): Promise<ActiveGame[]> {
    return await fetchActiveGames(this.db);
  }

  async getInitialPlayerProps(
    gameId: string,
    sessionId: string,
  ): Promise<PlayerProps<PlayerState, Player>> {
    const gameData = await this.db.getGameStorageData<
      Config,
      GameState,
      Player
    >(gameId);
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
  ): Promise<ObserverProps<ObserverState, Player>> {
    const gameData = await this.db.getGameStorageData<
      Config,
      GameState,
      Player
    >(gameId);
    const observerState = getObserverState(gameData, this.game.observerState);
    return {
      observerState,
      isComplete: gameData.isComplete,
      players: gameData.players,
    };
  }

  configureLobbySocket(socket: WebSocket) {
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
            this.game.setup,
          );
          break;
        }
        case "LeaveQueue":
          await this.lobbySocketStore.leaveQueue(socket);
          break;
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
      await this.db.getGameStorageData<Config, GameState, Player>(gameId),
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
