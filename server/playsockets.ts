import type { DB, GameStorageData } from "./db.ts";
import { deepEquals, type Socket } from "./socketutils.ts";
import type { PlayerStateObject } from "../types.ts";
import { assert } from "@std/assert";
import type { PlaySocketResponse } from "../common/types.ts";
import { getPlayerState } from "./gamedata.ts";

type PlaySocket<P, I> = {
  playerId: I;
  lastValue: P | undefined;
  socket: Socket;
};
type PlayConnection<C, S, P, I> = {
  sockets: PlaySocket<P, I>[];
  changesReader: ReadableStreamDefaultReader<GameStorageData<C, S, I>>;
};

export class PlaySocketStore<C, S, P, I> {
  private connections: Map<string, PlayConnection<C, S, P, I>> = new Map();

  constructor(private db: DB) {}

  // Registers a given Socket as being associated with a particular player of a
  // particular game. When the PlayerState associated with this player changes
  // (according to playerStateLogic), a new UpdatePlayerState response will be
  // sent.
  register(
    socket: Socket,
    gameId: string,
    playerId: I,
    playerStateLogic: (s: S, o: PlayerStateObject<C, I>) => P,
  ) {
    if (!this.hasGame(gameId)) {
      this.createGame(gameId, playerStateLogic);
    }
    this.addSocket(gameId, playerId, socket);
  }

  // Registers a PlayerState as the `lastValue` for the given socket. If the current PlayerState
  // differs from this provided PlayerState, a new UpdatePlayerState response
  // will be sent.
  async initialize(
    socket: Socket,
    gameId: string,
    playerState: P,
    playerStateLogic: (s: S, o: PlayerStateObject<C, I>) => P,
  ) {
    const playSocket =
      this.getSockets(gameId).filter((s) => s.socket === socket)[0];
    playSocket.lastValue = playerState;

    const gameData = await this.db.getGameStorageData<C, S, I>(gameId);
    const newPlayerState = getPlayerState(
      gameData,
      playerStateLogic,
      playSocket.playerId,
    );

    updatePlayerStateIfNecessary(playSocket, newPlayerState);
  }

  // Unregisters a socket from a particular game.
  unregister(socket: Socket, gameId: string) {
    this.deleteSocket(gameId, socket);
  }

  private hasGame(gameId: string): boolean {
    return this.connections.has(gameId);
  }

  private async streamToAllSockets(
    gameId: string,
    playerStateLogic: (s: S, o: PlayerStateObject<C, I>) => P,
    stream: ReadableStreamDefaultReader<GameStorageData<C, S, I>>,
  ) {
    while (true) {
      const data = await stream.read();
      if (data.done) {
        break;
      }
      const state = data.value.gameState;
      const sockets = this.getSockets(gameId);
      for (const socket of sockets) {
        const playerId = socket.playerId;
        const playerState = playerStateLogic(state, {
          playerId,
          players: data.value.players,
          isComplete: data.value.isComplete,
          config: data.value.config,
          timestamp: new Date(),
        });
        updatePlayerStateIfNecessary(socket, playerState);
        if (data.value.isComplete) {
          markComplete(socket);
        }
      }
    }
  }

  private createGame(
    gameId: string,
    playerStateLogic: (s: S, o: PlayerStateObject<C, I>) => P,
  ): void {
    const changesReader = this.db.watchForGameChanges<C, S, I>(gameId)
      .getReader();
    this.streamToAllSockets(gameId, playerStateLogic, changesReader);
    const connection: PlayConnection<C, S, P, I> = {
      sockets: [],
      changesReader,
    };
    this.connections.set(gameId, connection);
  }

  // This requires connections.get(gameId) to exist, call hasGame or createGame first.
  private addSocket(
    gameId: string,
    playerId: I,
    socket: Socket,
  ): void {
    const connection = this.connections.get(gameId);
    assert(connection != null);

    connection.sockets.push({ socket, lastValue: undefined, playerId });
  }

  private deleteSocket(gameId: string, socket: Socket): void {
    const connection = this.connections.get(gameId);
    assert(connection != null);
    connection.sockets = connection.sockets.filter((s) => s.socket !== socket);
    if (connection.sockets.length === 0) {
      connection.changesReader.cancel();
      connection.changesReader.releaseLock();
      this.connections.delete(gameId);
    }
  }

  private getSockets(gameId: string): PlaySocket<P, I>[] {
    const connection = this.connections.get(gameId);
    assert(connection != null);
    return connection.sockets;
  }
}

function updatePlayerStateIfNecessary<P, I>(
  playSocket: PlaySocket<P, I>,
  playerState: P,
) {
  if (deepEquals(playSocket.lastValue, playerState)) {
    return;
  }

  const response: PlaySocketResponse<P> = {
    type: "UpdatePlayerState",
    playerState,
  };
  playSocket.lastValue = playerState;
  playSocket.socket.send(JSON.stringify(response));
}

function markComplete<P, I>(
  playSocket: PlaySocket<P, I>,
) {
  const response: PlaySocketResponse<P> = {
    type: "MarkComplete",
  };
  playSocket.socket.send(JSON.stringify(response));
}
