import type { DB, GameStorageData } from "./db.ts";
import type { Socket } from "./socketutils.ts";
import type { PlayerStateObject, PublicStateObject } from "../types.ts";
import { assert } from "@std/assert";
import type { ServerMessage } from "../common/sockettypes.ts";
import { getPlayerState, getPublicState } from "./gamedata.ts";

/**
 * Represents a connected game socket.
 * Owns the underlying WebSocket and sends game-state updates to the client.
 */
class GameSocket<PlayerState, PublicState, Outcome> {
  constructor(
    private socket: Socket,
    public readonly playerId: number | undefined,
  ) {}

  /**
   * Sends a message through the underlying socket.
   */
  private send(message: string): void {
    this.socket.send(message);
  }

  /**
   * Sends the current game state to the client.
   */
  sendGameState(
    playerState: PlayerState | undefined,
    publicState: PublicState,
    outcome: Outcome | undefined,
  ): void {
    const response: ServerMessage<
      never,
      never,
      never,
      PlayerState,
      PublicState,
      Outcome
    > = {
      type: "UpdateGameState",
      playerState,
      publicState,
      outcome,
    };
    this.send(JSON.stringify(response));
  }
}

/**
 * Connection state for a game.
 * Contains all GameSocket instances for the game and the change stream reader.
 */
type GameConnection<Config, GameState, PlayerState, PublicState, Outcome> = {
  gameSockets: Map<Socket, GameSocket<PlayerState, PublicState, Outcome>>;
  changesReader: ReadableStreamDefaultReader<
    GameStorageData<Config, GameState, Outcome>
  >;
};

/**
 * Streams game state changes to all connected sockets for a game.
 */
async function streamGameChangesToSockets<
  Config,
  GameState,
  PlayerState,
  PublicState,
  Outcome,
>(
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
  getConnection: (
    gameId: string,
  ) => GameConnection<Config, GameState, PlayerState, PublicState, Outcome>,
) {
  while (true) {
    const data = await stream.read();
    if (data.done) {
      break;
    }

    const connection = getConnection(gameId);
    const state = data.value.gameState;
    const outcome = data.value.outcome;
    const timestamp = new Date();

    const publicState = publicStateLogic(state, {
      config: data.value.config,
      numPlayers: data.value.userIds.length,
      timestamp,
    });

    for (const gameSocket of connection.gameSockets.values()) {
      let playerState: PlayerState | undefined;

      if (gameSocket.playerId != null) {
        playerState = playerStateLogic(state, {
          playerId: gameSocket.playerId,
          config: data.value.config,
          numPlayers: data.value.userIds.length,
          timestamp,
        });
      }

      gameSocket.sendGameState(
        playerState,
        publicState,
        outcome,
      );
    }
  }
}

export class GameSocketStore<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Rating,
  Loadout,
> {
  private connections: Map<
    string,
    GameConnection<Config, GameState, PlayerState, PublicState, Outcome>
  > = new Map();

  constructor(
    private db: DB<
      Config,
      GameState,
      Move,
      PlayerState,
      PublicState,
      Outcome,
      Rating,
      Loadout
    >,
  ) {}

  /**
   * Subscribes a socket to the game update channel for a game.
   * Creates the game channel stream if it does not already exist.
   */
  async subscribe(
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
    if (!this.hasSocket(gameId, socket)) {
      this.addSocket(gameId, socket, playerId);
    }
    const connection = this.getConnection(gameId);
    const gameSocket = connection.gameSockets.get(socket);
    assert(gameSocket != null);

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

    gameSocket.sendGameState(
      newPlayerState,
      newPublicState,
      gameData.outcome,
    );
  }

  /**
   * Unsubscribes a socket from a game update channel.
   */
  unsubscribe(socket: Socket, gameId: string) {
    this.deleteSocket(gameId, socket);
  }

  private hasGame(gameId: string): boolean {
    return this.connections.has(gameId);
  }

  /**
   * Creates a game connection and starts streaming game state changes to all sockets.
   */
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
    streamGameChangesToSockets(
      gameId,
      playerStateLogic,
      publicStateLogic,
      changesReader,
      this.getConnection.bind(this),
    );

    const connection: GameConnection<
      Config,
      GameState,
      PlayerState,
      PublicState,
      Outcome
    > = {
      gameSockets: new Map(),
      changesReader,
    };
    this.connections.set(gameId, connection);
  }

  /**
   * Adds a socket to a game connection.
   */
  private addSocket(
    gameId: string,
    socket: Socket,
    playerId: number | undefined = undefined,
  ): void {
    const connection = this.getConnection(gameId);
    const gameSocket = new GameSocket<PlayerState, PublicState, Outcome>(
      socket,
      playerId,
    );
    connection.gameSockets.set(socket, gameSocket);
  }

  private hasSocket(gameId: string, socket: Socket): boolean {
    const connection = this.connections.get(gameId);
    if (connection == null) {
      return false;
    }
    return connection.gameSockets.has(socket);
  }

  /**
   * Removes a socket from a game channel and cleans up if no subscribers remain.
   */
  private deleteSocket(gameId: string, socket: Socket): void {
    const connection = this.connections.get(gameId);
    if (connection == null) {
      return;
    }
    const wasRemoved = connection.gameSockets.delete(socket);
    if (!wasRemoved) {
      return;
    }
    if (connection.gameSockets.size === 0) {
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
