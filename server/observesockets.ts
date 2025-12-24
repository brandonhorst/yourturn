import type { DB } from "./db.ts";
import type { GameStorageData } from "./db.ts";
import { deepEquals, type Socket } from "./socketutils.ts";
import type { ObserverStateObject } from "../types.ts";
import { assert } from "@std/assert";
import type { ObserveSocketResponse } from "../common/types.ts";
import { getObserverState } from "./gamedata.ts";

type ObserveSocket<O> = {
  lastValue: O | undefined;
  socket: Socket;
};
type ConnectionData<C, S, O> = {
  sockets: ObserveSocket<O>[];
  changesReader: ReadableStreamDefaultReader<GameStorageData<C, S>>;
};

export class ObserveSocketStore<C, S, O> {
  private connections: Map<string, ConnectionData<C, S, O>> = new Map();
  constructor(private db: DB) {}

  // Registers a given Socket as an observer of a
  // particular game. When the ObserverState associated with this game changes
  // (according to observerStateLogic), a new UpdateObserverState response will be
  // sent.
  register(
    socket: Socket,
    gameId: string,
    observerStateLogic: (s: S, o: ObserverStateObject<C>) => O,
  ) {
    // If nothing was previously observing this,
    if (!this.hasGame(gameId)) {
      this.createGame(gameId, observerStateLogic);
    }
    this.addSocket(gameId, socket);
  }

  // Registers an ObserverState as the `lastValue` for the given socket. If the current ObserverState
  // differs from this provided ObserverState, a new UpdateObserverState response
  // will be sent.
  async initialize(
    socket: Socket,
    gameId: string,
    observerState: O,
    observerStateLogic: (s: S, o: ObserverStateObject<C>) => O,
  ) {
    const observeSocket =
      this.getSockets(gameId).filter((s) => s.socket === socket)[0];
    observeSocket.lastValue = observerState;

    const gameData = await this.db.getGameStorageData<C, S>(gameId);
    const newObserverState = getObserverState(gameData, observerStateLogic);

    updateObserverStateIfNecessary(observeSocket, newObserverState);
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
    getObserverState: (s: S, o: ObserverStateObject<C>) => O,
    stream: ReadableStreamDefaultReader<GameStorageData<C, S>>,
  ) {
    while (true) {
      const data = await stream.read();
      if (data.done) {
        break;
      }

      const observerState = getObserverState(data.value.gameState, {
        isComplete: data.value.isComplete,
        players: data.value.players,
        config: data.value.config,
        timestamp: new Date(),
      });

      const sockets = this.getSockets(gameId);
      for (const socket of sockets) {
        updateObserverStateIfNecessary(socket, observerState);
        if (data.value.isComplete) {
          markComplete(socket);
        }
      }
    }
  }

  private createGame(
    gameId: string,
    getObserverState: (s: S, o: ObserverStateObject<C>) => O,
  ): void {
    const changesReader = this.db.watchForGameChanges<C, S>(gameId)
      .getReader();
    this.streamToAllSockets(gameId, getObserverState, changesReader);

    const connection: ConnectionData<C, S, O> = {
      sockets: [],
      changesReader,
    };
    this.connections.set(gameId, connection);
  }

  // This requires connections.get(gameId) to exist, call hasGame or createGame first.
  private addSocket(gameId: string, socket: Socket): void {
    const connection = this.connections.get(gameId);
    assert(connection != null);
    // TODO this should not be undefined, that means it'll always take the
    // first update
    connection.sockets.push({ socket, lastValue: undefined });
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

  private getSockets(gameId: string): ObserveSocket<O>[] {
    const connection = this.connections.get(gameId);
    assert(connection != null);
    return connection.sockets;
  }
}

function updateObserverStateIfNecessary<O>(
  observeSocket: ObserveSocket<O>,
  observerState: O,
) {
  if (deepEquals(observeSocket.lastValue, observerState)) {
    return;
  }

  const response: ObserveSocketResponse<O> = {
    type: "UpdateObserveState",
    observerState,
  };
  observeSocket.lastValue = observerState;
  observeSocket.socket.send(JSON.stringify(response));
}

function markComplete<P>(playSocket: ObserveSocket<P>) {
  const response: ObserveSocketResponse<P> = {
    type: "MarkComplete",
  };
  playSocket.socket.send(JSON.stringify(response));
}
