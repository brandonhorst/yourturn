import type { DB, GameStorageData } from "./db.ts";
import { jsonEquals, type Socket } from "./socketutils.ts";
import type {
  ChatMessage,
  PlayerStateObject,
  PublicStateObject,
} from "../types.ts";
import { assert } from "@std/assert";
import type { GameServerMessage } from "../common/sockettypes.ts";
import { getPlayerState, getPublicState } from "./gamedata.ts";

/**
 * Represents a connected game socket with cached state for change detection.
 * Owns the underlying WebSocket and contains the "last" values used to detect
 * changes and avoid sending unnecessary updates.
 */
class GameSocket<PlayerState, PublicState, Outcome> {
  private lastPlayerState: PlayerState | undefined = undefined;
  private lastPublicState: PublicState | undefined = undefined;
  private lastOutcome: Outcome | undefined = undefined;
  private lastChat: ChatMessage[] | undefined = undefined;

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
   * Initializes the cached values without sending updates.
   * Used when a socket first connects to establish the baseline state.
   */
  initialize(
    playerState: PlayerState | undefined,
    publicState: PublicState,
    outcome: Outcome | undefined,
    chat: ChatMessage[],
  ): void {
    this.lastPlayerState = playerState;
    this.lastPublicState = publicState;
    this.lastOutcome = outcome;
    this.lastChat = chat;
  }

  /**
   * Updates the game state if it has changed since the last update.
   */
  updateGameStateIfNecessary(
    playerState: PlayerState | undefined,
    publicState: PublicState,
    outcome: Outcome | undefined,
    chat: ChatMessage[],
  ): void {
    if (
      jsonEquals(this.lastPlayerState, playerState) &&
      jsonEquals(this.lastPublicState, publicState) &&
      jsonEquals(this.lastOutcome, outcome) &&
      jsonEquals(this.lastChat, chat)
    ) {
      return;
    }

    const response: GameServerMessage<PlayerState, PublicState, Outcome> = {
      type: "UpdateGameState",
      playerState,
      publicState,
      outcome,
      chat,
    };
    this.lastPlayerState = playerState;
    this.lastPublicState = publicState;
    this.lastOutcome = outcome;
    this.lastChat = chat;
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
    const chat = data.value.chat;
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

      gameSocket.updateGameStateIfNecessary(
        playerState,
        publicState,
        outcome,
        chat,
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
      Loadout
    >,
  ) {}

  /**
   * Registers a socket for a game and starts watching for game changes.
   */
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

  /**
   * Initializes the cached state for a socket and sends an update if the state has changed.
   */
  async initialize(
    socket: Socket,
    gameId: string,
    publicState: PublicState,
    playerState: PlayerState | undefined,
    chat: ChatMessage[],
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
    const gameSocket = connection.gameSockets.get(socket);
    assert(gameSocket != null);

    gameSocket.initialize(playerState, publicState, undefined, chat);

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

    gameSocket.updateGameStateIfNecessary(
      newPlayerState,
      newPublicState,
      gameData.outcome,
      gameData.chat,
    );
  }

  /**
   * Unregisters a socket from a game.
   */
  unregister(socket: Socket, gameId: string) {
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

  /**
   * Removes a socket from a game connection and cleans up if no sockets remain.
   */
  private deleteSocket(gameId: string, socket: Socket): void {
    const connection = this.getConnection(gameId);
    connection.gameSockets.delete(socket);
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
