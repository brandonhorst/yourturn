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
  C,
  S,
  M,
  P,
  O,
  I,
>(
  game: Game<C, S, M, P, O, I>,
): Promise<Server<C, S, M, P, O, I>> {
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
  const observeSocketStore = new ObserveSocketStore<C, S, O, I>(db);
  const playSocketStore = new PlaySocketStore<C, S, P, I>(db);

  return new Server(
    game,
    db,
    lobbySocketStore,
    observeSocketStore,
    playSocketStore,
  );
}

export type { Server };

class Server<C, S, M, P, O, I> {
  constructor(
    private game: Game<C, S, M, P, O, I>,
    private db: DB,
    private lobbySocketStore: LobbySocketStore,
    private observeSocketStore: ObserveSocketStore<C, S, O, I>,
    private playSocketStore: PlaySocketStore<C, S, P, I>,
  ) {}

  async getInitialActiveGames(): Promise<ActiveGame[]> {
    return await fetchActiveGames(this.db);
  }

  async getInitialPlayerProps(
    gameId: string,
    sessionId: string,
  ): Promise<PlayerProps<P>> {
    const gameData = await this.db.getGameStorageData<C, S, I>(gameId);
    const playerId = getPlayerId(gameData, sessionId);
    const playerState = getPlayerState(
      gameData,
      this.game.playerState,
      playerId,
    );
    return { playerState, isComplete: gameData.isComplete };
  }

  async getInitialObserverProps(
    gameId: string,
  ): Promise<ObserverProps<O>> {
    const gameData = await this.db.getGameStorageData<C, S, I>(gameId);
    const observerState = getObserverState(gameData, this.game.observerState);
    return { observerState, isComplete: gameData.isComplete };
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
            playerIds: queue.playerIds,
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
      const request: ObserveSocketRequest<O> = JSON.parse(event.data);
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
      await this.db.getGameStorageData<C, S, I>(gameId),
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
      const request: PlaySocketRequest<M, P> = JSON.parse(event.data);
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
