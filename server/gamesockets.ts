import type { DB, GameStorageData } from "./db.ts";
import { jsonEquals, type Socket } from "./socketutils.ts";
import type { PlayerStateObject, PublicStateObject } from "../types.ts";
import { assert } from "@std/assert";
import type { GameSocketResponse } from "../common/sockettypes.ts";
import { getPlayerState, getPublicState } from "./gamedata.ts";

type GameSocketEntry<PlayerState, PublicState, Outcome> = {
  playerId: number | undefined;
  lastPlayerState: PlayerState | undefined;
  lastPublicState: PublicState | undefined;
  lastOutcome: Outcome | undefined;
  socket: Socket;
};

type GameConnection<Config, GameState, PlayerState, PublicState, Outcome> = {
  sockets: GameSocketEntry<PlayerState, PublicState, Outcome>[];
  changesReader: ReadableStreamDefaultReader<
    GameStorageData<Config, GameState, Outcome>
  >;
};

export class GameSocketStore<
  Config,
  GameState,
  PlayerState,
  PublicState,
  Outcome,
  Loadout,
> {
  private connections: Map<
    string,
    GameConnection<Config, GameState, PlayerState, PublicState, Outcome>
  > = new Map();

  constructor(private db: DB<Config, GameState, Loadout, Outcome>) {}

  register(
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
    playerId?: number,
  ) {
    if (!this.hasGame(gameId)) {
      this.createGame(gameId, playerStateLogic, publicStateLogic);
    }
    this.addSocket(gameId, socket, playerId);
  }

  async initialize(
    socket: Socket,
    gameId: string,
    publicState: PublicState,
    playerState: PlayerState | undefined,
    playerStateLogic: (
      s: GameState,
      o: PlayerStateObject<Config>,
    ) => PlayerState,
    publicStateLogic: (
      s: GameState,
      o: PublicStateObject<Config>,
    ) => PublicState,
  ) {
    const connection = this.getConnection(gameId);
    const gameSocket = connection.sockets.find((s) => s.socket === socket);
    assert(gameSocket != null);
    gameSocket.lastPlayerState = playerState;
    gameSocket.lastPublicState = publicState;
    gameSocket.lastOutcome = undefined;

    const gameData = await this.db.getGameStorageData(gameId);
    const newPlayerState = gameSocket.playerId == null
      ? undefined
      : getPlayerState(
        gameData,
        playerStateLogic,
        gameSocket.playerId,
      );
    const newPublicState = getPublicState(
      gameData,
      publicStateLogic,
    );

    updateSocketIfNecessary(
      gameSocket,
      newPlayerState,
      newPublicState,
      gameData.outcome,
    );
    return;
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
    stream: ReadableStreamDefaultReader<
      GameStorageData<Config, GameState, Outcome>
    >,
  ) {
    while (true) {
      const data = await stream.read();
      if (data.done) {
        break;
      }

      const connection = this.getConnection(gameId);
      const state = data.value.gameState;

      const outcome = data.value.outcome;
      const timestamp = new Date();

      const publicState = publicStateLogic(state, {
        config: data.value.config,
        numPlayers: data.value.playerUserIds.length,
        timestamp,
      });

      for (const socket of connection.sockets) {
        let playerState: PlayerState | undefined;

        if (socket.playerId != null) {
          playerState = playerStateLogic(state, {
            playerId: socket.playerId,
            config: data.value.config,
            numPlayers: data.value.playerUserIds.length,
            timestamp,
          });
        }
        updateSocketIfNecessary(
          socket,
          playerState,
          publicState,
          outcome,
        );
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
    const changesReader = this.db.watchForGameChanges(gameId).getReader();
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
      PublicState,
      Outcome
    > = {
      sockets: [],
      changesReader,
    };
    this.connections.set(gameId, connection);
  }

  private addSocket(
    gameId: string,
    socket: Socket,
    playerId: number | undefined = undefined,
  ): void {
    const connection = this.getConnection(gameId);
    connection.sockets.push({
      socket,
      playerId,
      lastPlayerState: undefined,
      lastPublicState: undefined,
      lastOutcome: undefined,
    });
  }

  private deleteSocket(gameId: string, socket: Socket): void {
    const connection = this.getConnection(gameId);
    connection.sockets = connection.sockets.filter((s) => s.socket !== socket);
    if (connection.sockets.length === 0) {
      connection.changesReader.cancel();
      connection.changesReader.releaseLock();
      this.connections.delete(gameId);
    }
  }

  private getConnection(
    gameId: string,
  ): GameConnection<Config, GameState, PlayerState, PublicState, Outcome> {
    const connection = this.connections.get(gameId);
    assert(connection != null);
    return connection;
  }
}

function updateSocketIfNecessary<PlayerState, PublicState, Outcome>(
  socket: GameSocketEntry<PlayerState, PublicState, Outcome>,
  playerState: PlayerState | undefined,
  publicState: PublicState,
  outcome: Outcome | undefined,
) {
  if (
    jsonEquals(socket.lastPlayerState, playerState) &&
    jsonEquals(socket.lastPublicState, publicState) &&
    jsonEquals(socket.lastOutcome, outcome)
  ) {
    return;
  }

  const response: GameSocketResponse<PlayerState, PublicState, Outcome> = {
    type: "UpdateGameState",
    playerState,
    publicState,
    outcome,
  };
  socket.lastPlayerState = playerState;
  socket.lastPublicState = publicState;
  socket.lastOutcome = outcome;
  socket.socket.send(JSON.stringify(response));
  return;
}
