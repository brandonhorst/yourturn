import type { DB, GameStorageData } from "./db.ts";
import { jsonEquals, type Socket } from "./socketutils.ts";
import type { ObserverStateObject, PlayerStateObject } from "../types.ts";
import { assert } from "@std/assert";
import type { GameSocketResponse } from "../common/types.ts";
import { getObserverState, getPlayerState } from "./gamedata.ts";

type PlayerSocket<PlayerState> = {
  playerId: number;
  lastValue: PlayerState | undefined;
  socket: Socket;
};

type ObserverSocket<ObserverState> = {
  lastValue: ObserverState | undefined;
  socket: Socket;
};

type GameConnection<Config, GameState, PlayerState, ObserverState> = {
  playerSockets: PlayerSocket<PlayerState>[];
  observerSockets: ObserverSocket<ObserverState>[];
  changesReader: ReadableStreamDefaultReader<
    GameStorageData<Config, GameState>
  >;
};

export class GameSocketStore<
  Config,
  GameState,
  PlayerState,
  ObserverState,
> {
  private connections: Map<
    string,
    GameConnection<Config, GameState, PlayerState, ObserverState>
  > = new Map();

  constructor(private db: DB) {}

  registerPlayer(
    socket: Socket,
    gameId: string,
    playerId: number,
    playerStateLogic: (
      s: GameState,
      o: PlayerStateObject<Config>,
    ) => PlayerState,
    observerStateLogic: (
      s: GameState,
      o: ObserverStateObject<Config>,
    ) => ObserverState,
  ) {
    if (!this.hasGame(gameId)) {
      this.createGame(gameId, playerStateLogic, observerStateLogic);
    }
    this.addPlayerSocket(gameId, playerId, socket);
  }

  registerObserver(
    socket: Socket,
    gameId: string,
    playerStateLogic: (
      s: GameState,
      o: PlayerStateObject<Config>,
    ) => PlayerState,
    observerStateLogic: (
      s: GameState,
      o: ObserverStateObject<Config>,
    ) => ObserverState,
  ) {
    if (!this.hasGame(gameId)) {
      this.createGame(gameId, playerStateLogic, observerStateLogic);
    }
    this.addObserverSocket(gameId, socket);
  }

  async initializePlayer(
    socket: Socket,
    gameId: string,
    playerState: PlayerState,
    playerStateLogic: (
      s: GameState,
      o: PlayerStateObject<Config>,
    ) => PlayerState,
  ) {
    const playerSocket =
      this.getConnection(gameId).playerSockets.filter((s) =>
        s.socket === socket
      )[0];
    playerSocket.lastValue = playerState;

    const gameData = await this.db.getGameStorageData<Config, GameState>(
      gameId,
    );
    const newPlayerState = getPlayerState(
      gameData,
      playerStateLogic,
      playerSocket.playerId,
    );

    updatePlayerStateIfNecessary(playerSocket, newPlayerState);
  }

  async initializeObserver(
    socket: Socket,
    gameId: string,
    observerState: ObserverState,
    observerStateLogic: (
      s: GameState,
      o: ObserverStateObject<Config>,
    ) => ObserverState,
  ) {
    const observerSocket =
      this.getConnection(gameId).observerSockets.filter((s) =>
        s.socket === socket
      )[0];
    observerSocket.lastValue = observerState;

    const gameData = await this.db.getGameStorageData<Config, GameState>(
      gameId,
    );
    const newObserverState = getObserverState(
      gameData,
      observerStateLogic,
    );

    updateObserverStateIfNecessary(observerSocket, newObserverState);
  }

  unregister(socket: Socket, gameId: string) {
    this.deleteSocket(gameId, socket);
  }

  private hasGame(gameId: string): boolean {
    return this.connections.has(gameId);
  }

  private async streamToAllSockets(
    gameId: string,
    playerStateLogic: (
      s: GameState,
      o: PlayerStateObject<Config>,
    ) => PlayerState,
    observerStateLogic: (
      s: GameState,
      o: ObserverStateObject<Config>,
    ) => ObserverState,
    stream: ReadableStreamDefaultReader<GameStorageData<Config, GameState>>,
  ) {
    while (true) {
      const data = await stream.read();
      if (data.done) {
        break;
      }

      const connection = this.getConnection(gameId);
      const state = data.value.gameState;

      if (connection.playerSockets.length > 0) {
        for (const socket of connection.playerSockets) {
          const playerState = playerStateLogic(state, {
            playerId: socket.playerId,
            players: data.value.players,
            isComplete: data.value.isComplete,
            config: data.value.config,
            timestamp: new Date(),
          });
          updatePlayerStateIfNecessary(socket, playerState);
          if (data.value.isComplete) {
            markComplete(socket.socket);
          }
        }
      }

      if (connection.observerSockets.length > 0) {
        const observerState = observerStateLogic(state, {
          isComplete: data.value.isComplete,
          players: data.value.players,
          config: data.value.config,
          timestamp: new Date(),
        });

        for (const socket of connection.observerSockets) {
          updateObserverStateIfNecessary(socket, observerState);
          if (data.value.isComplete) {
            markComplete(socket.socket);
          }
        }
      }
    }
  }

  private createGame(
    gameId: string,
    playerStateLogic: (
      s: GameState,
      o: PlayerStateObject<Config>,
    ) => PlayerState,
    observerStateLogic: (
      s: GameState,
      o: ObserverStateObject<Config>,
    ) => ObserverState,
  ): void {
    const changesReader = this.db.watchForGameChanges<Config, GameState>(gameId)
      .getReader();
    this.streamToAllSockets(
      gameId,
      playerStateLogic,
      observerStateLogic,
      changesReader,
    );

    const connection: GameConnection<
      Config,
      GameState,
      PlayerState,
      ObserverState
    > = {
      playerSockets: [],
      observerSockets: [],
      changesReader,
    };
    this.connections.set(gameId, connection);
  }

  private addPlayerSocket(
    gameId: string,
    playerId: number,
    socket: Socket,
  ): void {
    const connection = this.getConnection(gameId);
    connection.playerSockets.push({ socket, lastValue: undefined, playerId });
  }

  private addObserverSocket(gameId: string, socket: Socket): void {
    const connection = this.getConnection(gameId);
    connection.observerSockets.push({ socket, lastValue: undefined });
  }

  private deleteSocket(gameId: string, socket: Socket): void {
    const connection = this.getConnection(gameId);
    connection.playerSockets = connection.playerSockets.filter((s) =>
      s.socket !== socket
    );
    connection.observerSockets = connection.observerSockets.filter((s) =>
      s.socket !== socket
    );
    if (
      connection.playerSockets.length === 0 &&
      connection.observerSockets.length === 0
    ) {
      connection.changesReader.cancel();
      connection.changesReader.releaseLock();
      this.connections.delete(gameId);
    }
  }

  private getConnection(
    gameId: string,
  ): GameConnection<Config, GameState, PlayerState, ObserverState> {
    const connection = this.connections.get(gameId);
    assert(connection != null);
    return connection;
  }
}

function updatePlayerStateIfNecessary<PlayerState>(
  playerSocket: PlayerSocket<PlayerState>,
  playerState: PlayerState,
) {
  if (jsonEquals(playerSocket.lastValue, playerState)) {
    return;
  }

  const response: GameSocketResponse<PlayerState, never> = {
    type: "UpdateGameState",
    mode: "player",
    playerState,
  };
  playerSocket.lastValue = playerState;
  playerSocket.socket.send(JSON.stringify(response));
}

function updateObserverStateIfNecessary<ObserverState>(
  observerSocket: ObserverSocket<ObserverState>,
  observerState: ObserverState,
) {
  if (jsonEquals(observerSocket.lastValue, observerState)) {
    return;
  }

  const response: GameSocketResponse<never, ObserverState> = {
    type: "UpdateGameState",
    mode: "observer",
    observerState,
  };
  observerSocket.lastValue = observerState;
  observerSocket.socket.send(JSON.stringify(response));
}

function markComplete(socket: Socket) {
  const response: GameSocketResponse<never, never> = {
    type: "MarkComplete",
  };
  socket.send(JSON.stringify(response));
}
