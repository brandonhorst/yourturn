import type { DB, GameStorageData } from "./db.ts";
import { jsonEquals, type Socket } from "./socketutils.ts";
import type { PlayerStateObject, PublicStateObject } from "../types.ts";
import { assert } from "@std/assert";
import type { GameSocketResponse } from "../common/types.ts";
import { getPlayerState, getPublicState } from "./gamedata.ts";

type PlayerSocket<PlayerState, PublicState> = {
  playerId: number;
  lastPlayerState: PlayerState | undefined;
  lastPublicState: PublicState | undefined;
  socket: Socket;
};

type ObserverSocket<PublicState> = {
  lastValue: PublicState | undefined;
  socket: Socket;
};

type GameConnection<Config, GameState, PlayerState, PublicState> = {
  playerSockets: PlayerSocket<PlayerState, PublicState>[];
  observerSockets: ObserverSocket<PublicState>[];
  changesReader: ReadableStreamDefaultReader<
    GameStorageData<Config, GameState>
  >;
};

export class GameSocketStore<
  Config,
  GameState,
  PlayerState,
  PublicState,
> {
  private connections: Map<
    string,
    GameConnection<Config, GameState, PlayerState, PublicState>
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
    publicStateLogic: (
      s: GameState,
      o: PublicStateObject<Config>,
    ) => PublicState,
  ) {
    if (!this.hasGame(gameId)) {
      this.createGame(gameId, playerStateLogic, publicStateLogic);
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
    publicStateLogic: (
      s: GameState,
      o: PublicStateObject<Config>,
    ) => PublicState,
  ) {
    if (!this.hasGame(gameId)) {
      this.createGame(gameId, playerStateLogic, publicStateLogic);
    }
    this.addObserverSocket(gameId, socket);
  }

  async initializePlayer(
    socket: Socket,
    gameId: string,
    playerState: PlayerState,
    publicState: PublicState,
    playerStateLogic: (
      s: GameState,
      o: PlayerStateObject<Config>,
    ) => PlayerState,
    publicStateLogic: (
      s: GameState,
      o: PublicStateObject<Config>,
    ) => PublicState,
  ) {
    const playerSocket =
      this.getConnection(gameId).playerSockets.filter((s) =>
        s.socket === socket
      )[0];
    playerSocket.lastPlayerState = playerState;
    playerSocket.lastPublicState = publicState;

    const gameData = await this.db.getGameStorageData<Config, GameState>(
      gameId,
    );
    const newPlayerState = getPlayerState(
      gameData,
      playerStateLogic,
      playerSocket.playerId,
    );
    const newPublicState = getPublicState(
      gameData,
      publicStateLogic,
    );

    updatePlayerStateIfNecessary(
      playerSocket,
      newPlayerState,
      newPublicState,
    );
  }

  async initializeObserver(
    socket: Socket,
    gameId: string,
    publicState: PublicState,
    publicStateLogic: (
      s: GameState,
      o: PublicStateObject<Config>,
    ) => PublicState,
  ) {
    const observerSocket =
      this.getConnection(gameId).observerSockets.filter((s) =>
        s.socket === socket
      )[0];
    observerSocket.lastValue = publicState;

    const gameData = await this.db.getGameStorageData<Config, GameState>(
      gameId,
    );
    const newPublicState = getPublicState(
      gameData,
      publicStateLogic,
    );

    updatePublicStateIfNecessary(observerSocket, newPublicState);
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
    publicStateLogic: (
      s: GameState,
      o: PublicStateObject<Config>,
    ) => PublicState,
    stream: ReadableStreamDefaultReader<GameStorageData<Config, GameState>>,
  ) {
    while (true) {
      const data = await stream.read();
      if (data.done) {
        break;
      }

      const connection = this.getConnection(gameId);
      const state = data.value.gameState;

      const hasPlayerSockets = connection.playerSockets.length > 0;
      const hasObserverSockets = connection.observerSockets.length > 0;

      let publicState: PublicState | undefined;
      if (hasPlayerSockets || hasObserverSockets) {
        publicState = publicStateLogic(state, {
          isComplete: data.value.isComplete,
          players: data.value.players,
          config: data.value.config,
          timestamp: new Date(),
        });
      }

      if (hasPlayerSockets) {
        for (const socket of connection.playerSockets) {
          const playerState = playerStateLogic(state, {
            playerId: socket.playerId,
            players: data.value.players,
            isComplete: data.value.isComplete,
            config: data.value.config,
            timestamp: new Date(),
          });
          updatePlayerStateIfNecessary(
            socket,
            playerState,
            publicState as PublicState,
          );
          if (data.value.isComplete) {
            markComplete(socket.socket);
          }
        }
      }

      if (hasObserverSockets) {
        for (const socket of connection.observerSockets) {
          updatePublicStateIfNecessary(socket, publicState as PublicState);
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
    publicStateLogic: (
      s: GameState,
      o: PublicStateObject<Config>,
    ) => PublicState,
  ): void {
    const changesReader = this.db.watchForGameChanges<Config, GameState>(gameId)
      .getReader();
    this.streamToAllSockets(
      gameId,
      playerStateLogic,
      publicStateLogic,
      changesReader,
    );

    const connection: GameConnection<
      Config,
      GameState,
      PlayerState,
      PublicState
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
    connection.playerSockets.push({
      socket,
      lastPlayerState: undefined,
      lastPublicState: undefined,
      playerId,
    });
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
  ): GameConnection<Config, GameState, PlayerState, PublicState> {
    const connection = this.connections.get(gameId);
    assert(connection != null);
    return connection;
  }
}

function updatePlayerStateIfNecessary<PlayerState, PublicState>(
  playerSocket: PlayerSocket<PlayerState, PublicState>,
  playerState: PlayerState,
  publicState: PublicState,
) {
  if (
    jsonEquals(playerSocket.lastPlayerState, playerState) &&
    jsonEquals(playerSocket.lastPublicState, publicState)
  ) {
    return;
  }

  const response: GameSocketResponse<PlayerState, PublicState> = {
    type: "UpdateGameState",
    mode: "player",
    playerState,
    publicState,
  };
  playerSocket.lastPlayerState = playerState;
  playerSocket.lastPublicState = publicState;
  playerSocket.socket.send(JSON.stringify(response));
}

function updatePublicStateIfNecessary<PublicState>(
  observerSocket: ObserverSocket<PublicState>,
  publicState: PublicState,
) {
  if (jsonEquals(observerSocket.lastValue, publicState)) {
    return;
  }

  const response: GameSocketResponse<never, PublicState> = {
    type: "UpdateGameState",
    mode: "observer",
    publicState,
  };
  observerSocket.lastValue = publicState;
  observerSocket.socket.send(JSON.stringify(response));
}

function markComplete(socket: Socket) {
  const response: GameSocketResponse<never, never> = {
    type: "MarkComplete",
  };
  socket.send(JSON.stringify(response));
}
