import type {
  ActivePublicGamesViewData,
  AvailablePublicRoomsViewData,
  Game,
  GameViewData,
  LobbyViewData,
  Player,
} from "../types.ts";
import type { ClientMessage } from "../common/sockettypes.ts";
import { GameStateService } from "./gamestateservice.ts";
import type { DB, GameStorageData } from "./db.ts";
import type { SocketStore } from "./sockets.ts";
import { ulid } from "@std/ulid";

const tokenTtlMs = 1000 * 60 * 60 * 24 * 30;

export class Server<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Rating,
  Loadout,
> {
  private gameStateService: GameStateService<
    Config,
    GameState,
    Move,
    PlayerState,
    PublicState,
    Outcome,
    Rating,
    Loadout
  >;

  constructor(
    private game: Game<
      Config,
      GameState,
      Move,
      PlayerState,
      PublicState,
      Outcome,
      Rating,
      Loadout
    >,
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
    private socketStore: SocketStore<
      Config,
      GameState,
      Move,
      PlayerState,
      PublicState,
      Outcome,
      Rating,
      Loadout
    >,
  ) {
    this.gameStateService = new GameStateService(this.game);
    this.socketStore.setGameStateService(this.gameStateService);
  }

  /**
   * Builds the initial lobby payload for an existing user.
   * Returns a fresh auth token that can be used to reconnect later.
   */
  async getInitialLobbyProps(
    userId: string,
  ): Promise<{ props: LobbyViewData<Config, Loadout>; token: string }> {
    if (userId === "") {
      throw new Error("Missing lobby user id");
    }

    const storedUser = await this.db.getLobbyUserData(userId);
    if (storedUser == null) {
      throw new Error("Unknown lobby user");
    }

    const lobbyToken = crypto.randomUUID();
    await this.db.storeToken(lobbyToken, {
      userId,
      expiration: new Date(Date.now() + tokenTtlMs),
    });

    return {
      props: {
        userActiveGames: storedUser.activeGames,
        roomEntries: storedUser.roomEntries,
        queueEntries: storedUser.queueEntries,
      },
      token: lobbyToken,
    };
  }

  /**
   * Builds the initial payload for the active public games channel.
   */
  async getInitialActivePublicGamesProps(): Promise<
    ActivePublicGamesViewData<Config>
  > {
    const allActiveGames = await this.gameStateService.fetchActiveGames(
      this.db,
    );
    return {
      allActiveGames,
    };
  }

  /**
   * Builds the initial payload for the available public rooms channel.
   */
  async getInitialAvailablePublicRoomsProps(): Promise<
    AvailablePublicRoomsViewData<Config>
  > {
    const allAvailableRooms = await this.gameStateService.fetchAvailableRooms(
      this.db,
    );
    return {
      allAvailableRooms,
    };
  }

  /**
   * Builds the initial game payload for a viewer or player.
   */
  async getInitialGameProps(
    gameId: string,
    userId: string,
  ): Promise<GameViewData<PlayerState, PublicState, Outcome>> {
    if (userId === "") {
      throw new Error("Missing game user id");
    }

    const gameData = await this.db.getGameStorageData(gameId);

    const playerId = this.gameStateService.getPlayerId(gameData, userId);
    return this.buildGameViewData(gameData, playerId);
  }

  /**
   * Builds the initial game view payload for a specific player or observer.
   */
  private buildGameViewData(
    gameData: GameStorageData<Config, GameState, Outcome>,
    playerId: number | undefined,
  ): GameViewData<PlayerState, PublicState, Outcome> {
    const gameStateUpdate = this.gameStateService.buildGameStateUpdate(
      gameData,
      playerId,
    );
    return {
      players: gameData.players,
      playerId,
      playerState: gameStateUpdate.playerState,
      publicState: gameStateUpdate.publicState,
      outcome: gameStateUpdate.outcome,
    } as GameViewData<PlayerState, PublicState, Outcome>;
  }

  /**
   * Configures one websocket to handle lobby, room, and game messages.
   */
  configureSocket(
    socket: WebSocket,
    userId: string,
  ) {
    if (userId === "") {
      throw new Error("Missing socket user id");
    }

    /**
     * Sends an error response to the client over this websocket.
     */
    const sendDisplayError = (message: string): void => {
      socket.send(JSON.stringify({ type: "DisplayError", message }));
    };

    /**
     * Fetches the latest lobby user record for room and queue actions.
     */
    const getLobbyUser = async (): Promise<Player | null> => {
      const storedUser = await this.db.getUserStorageData(userId);
      return storedUser?.player ?? null;
    };

    /**
     * Resolves the user's player ID for a specific game.
     */
    const getPlayerIdForGame = async (
      gameId: string,
    ): Promise<number | undefined> => {
      const gameData = await this.db.getGameStorageData(gameId);
      return this.gameStateService.getPlayerId(gameData, userId);
    };

    /**
     * Cleans up all lobby and game subscriptions when the socket closes.
     */
    const handleSocketClose = async () => {
      await this.socketStore.unsubscribeSocket(socket);
    };

    /**
     * Routes any client message to the matching lobby or game handler.
     */
    const handleSocketMessage = async (event: MessageEvent) => {
      const request: ClientMessage<
        Config,
        Loadout,
        Move,
        PlayerState,
        PublicState
      > = JSON.parse(event.data);

      switch (request.type) {
        case "SubscribeLobby": {
          const latestUserData = await this.db.getLobbyUserData(userId);
          if (latestUserData == null) {
            sendDisplayError("Unknown lobby user.");
            break;
          }

          await this.socketStore.subscribeLobby(
            socket,
            request.subscriptionId,
            userId,
            latestUserData,
          );
          break;
        }
        case "SubscribeActivePublicGames":
          await this.socketStore.subscribeActivePublicGames(
            socket,
            request.subscriptionId,
          );
          break;
        case "SubscribeAvailablePublicRooms":
          await this.socketStore.subscribeAvailablePublicRooms(
            socket,
            request.subscriptionId,
          );
          break;
        case "SubscribeRoom":
          try {
            await this.socketStore.subscribeRoom(
              socket,
              request.subscriptionId,
              request.roomId,
              userId,
            );
          } catch (err) {
            console.error("Failed to subscribe room socket", err);
            await this.socketStore.unsubscribe(socket, request.subscriptionId);
            sendDisplayError("Unable to subscribe to room.");
          }
          break;
        case "JoinQueue": {
          const queue = this.game.queues[request.queueId];
          if (queue == null) {
            console.log(
              "Attempted to join non-existant queue",
              request.queueId,
            );
            break;
          }

          if (
            !this.gameStateService.isValidLoadout(request.loadout, queue.config)
          ) {
            sendDisplayError("Invalid loadout.");
            break;
          }

          const user = await getLobbyUser();
          if (user == null) {
            sendDisplayError("Unknown lobby user.");
            break;
          }

          try {
            await this.socketStore.joinQueue(
              socket,
              request.queueId,
              userId,
              user,
              request.loadout,
            );
          } catch (err) {
            console.error("Failed to join queue", err);
            sendDisplayError("Unable to join queue.");
          }
          break;
        }
        case "CreateAndJoinRoom": {
          if (!(this.game.isValidRoom?.(request.config) ?? false)) {
            sendDisplayError("Invalid room config.");
            break;
          }

          if (
            !this.gameStateService.isValidLoadout(
              request.loadout,
              request.config,
            )
          ) {
            sendDisplayError("Invalid loadout.");
            break;
          }

          const user = await getLobbyUser();
          if (user == null) {
            sendDisplayError("Unknown lobby user.");
            break;
          }

          try {
            await this.socketStore.createAndJoinRoom(
              socket,
              {
                numPlayers: request.numPlayers,
                config: request.config,
                private: request.private,
              },
              userId,
              user,
              request.loadout,
            );
          } catch (err) {
            console.error("Failed to create and join room", err);
            sendDisplayError("Unable to create room.");
          }
          break;
        }
        case "JoinRoom": {
          const room = await this.db.getRoom(request.roomId);
          if (room == null) {
            sendDisplayError("Room not found.");
            break;
          }
          if (room.members.some((member) => member.userId === userId)) {
            sendDisplayError("You are already in this room.");
            break;
          }
          if (
            !this.gameStateService.isValidLoadout(request.loadout, room.config)
          ) {
            sendDisplayError("Invalid loadout.");
            break;
          }
          if (room.members.length >= room.numPlayers) {
            sendDisplayError("Room is full.");
            break;
          }
          if (room.private) {
            sendDisplayError("Room is private.");
            break;
          }

          const user = await getLobbyUser();
          if (user == null) {
            sendDisplayError("Unknown lobby user.");
            break;
          }

          let joined = false;
          try {
            joined = await this.socketStore.joinRoom(
              socket,
              request.roomId,
              userId,
              user,
              request.loadout,
            );
          } catch (err) {
            console.error("Failed to join room", err);
            sendDisplayError("Unable to join room.");
            break;
          }
          if (!joined) {
            sendDisplayError("Unable to join room.");
          }
          break;
        }
        case "CommitRoom":
          try {
            await this.socketStore.commitRoom(request.roomId, userId);
          } catch (err) {
            console.error("Failed to commit room", err);
            sendDisplayError("Unable to commit room.");
          }
          break;
        case "LeaveQueue":
          try {
            await this.socketStore.leaveQueue(socket, request.queueId);
          } catch (err) {
            console.error("Failed to leave queue", err);
            sendDisplayError("Unable to leave queue.");
          }
          break;
        case "LeaveRoom":
          try {
            await this.socketStore.leaveRoom(socket, request.roomId, userId);
          } catch (err) {
            console.error("Failed to leave room", err);
            sendDisplayError("Unable to leave room.");
          }
          break;
        case "SubscribeGame":
          try {
            const playerId = await getPlayerIdForGame(request.gameId);
            await this.socketStore.subscribeGame(
              socket,
              request.subscriptionId,
              request.gameId,
              playerId,
            );
          } catch (err) {
            console.error("Failed to subscribe game socket", err);
            await this.socketStore.unsubscribe(socket, request.subscriptionId);
            sendDisplayError("Unable to subscribe to game.");
          }
          break;
        case "Unsubscribe":
          await this.socketStore.unsubscribe(socket, request.subscriptionId);
          break;
        case "Move":
          try {
            const playerId = await getPlayerIdForGame(request.gameId);
            if (playerId == null) {
              break;
            }
            await this.gameStateService.handleMove(
              this.db,
              request.gameId,
              playerId,
              request.move,
            );
          } catch (err) {
            console.error("Failed to process move", err);
            sendDisplayError("Unable to process move.");
          }
          break;
      }
    };

    socket.addEventListener("message", handleSocketMessage);
    socket.addEventListener("close", handleSocketClose);
  }

  /**
   * Resolves a token to a valid user ID, creating a guest user when needed.
   */
  public async resolveToken(
    token: string | undefined,
  ): Promise<string> {
    if (token != null && token !== "") {
      const tokenData = await this.db.getToken(token);
      if (tokenData != null && tokenData.expiration > new Date()) {
        const [storedUser, storedMatchmaking] = await Promise.all([
          this.db.getUserStorageData(tokenData.userId),
          this.db.getUserMatchmakingStorageData(tokenData.userId),
        ]);
        if (storedUser != null && storedMatchmaking != null) {
          return tokenData.userId;
        }
      }
    }

    const user = await this.createGuestUser();
    const userId = ulid();
    await this.db.createNewUserStorageData(userId, {
      player: user,
      ratings: this.buildInitialRatings(),
    });
    await this.db.createNewUserMatchmakingStorageData(userId, {
      activeGames: [],
      joinedRooms: [],
      queueEntries: [],
    });
    return userId;
  }

  /**
   * Builds initial ratings for every configured ranked queue.
   */
  private buildInitialRatings(): Record<string, Rating> {
    return this.normalizeRatings({}).ratings;
  }

  /**
   * Ensures ratings exist for every configured ranked queue.
   */
  private normalizeRatings(
    ratings: Record<string, Rating>,
  ): { ratings: Record<string, Rating>; didChange: boolean } {
    const merged = { ...ratings };
    let didChange = false;
    for (const [queueId, queueConfig] of Object.entries(this.game.queues)) {
      if (queueConfig.queueType !== "ranked") {
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(merged, queueId)) {
        merged[queueId] = this.game.initialRating();
        didChange = true;
      }
    }
    return { ratings: merged, didChange };
  }

  /**
   * Creates a unique guest player profile in memory before persistence.
   */
  private async createGuestUser(): Promise<Player> {
    for (let attempt = 0; attempt < 10000; attempt++) {
      const suffix = Math.floor(Math.random() * 10000).toString().padStart(
        4,
        "0",
      );
      const username = `guest-${suffix}`;
      const usernameTaken = await this.db.usernameExists(username);
      if (!usernameTaken) {
        return { username, isGuest: true };
      }
    }

    throw new Error("Failed to create a unique guest username");
  }
}
