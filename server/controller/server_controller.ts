import { ulid } from "@std/ulid";
import type {
  ActivePublicMatchesViewData,
  ActiveUsersViewData,
  AvailablePublicRoomsViewData,
  ChatThreadViewData,
  GameDefinition,
  GameTypes,
  MatchViewData,
  Server,
  UserMatchmakingViewData,
  UserProfileViewData,
} from "@/types/mod.ts";
import type { DB, MatchStorageData } from "../db/mod.ts";
import { logServer, serializeLogValue } from "../logging.ts";
import { GameStateService } from "../services/game_state_service.ts";
import { MatchProjectionService } from "../services/match_projection_service.ts";
import type { SocketStore } from "../sockets/mod.ts";
import { SocketRouter } from "./socket_router.ts";

const tokenTtlMs = 1000 * 60 * 60 * 24 * 30;
const SERVER_CONTROLLER_LOG_MODULE = "server.controller";

/**
 * Public server API implementation used by consuming applications.
 */
export class ServerController<T extends GameTypes> implements Server<T> {
  private readonly gameStateService: GameStateService<T>;
  private readonly matchProjectionService: MatchProjectionService<T>;
  private readonly socketRouter: SocketRouter<T>;

  constructor(
    private readonly game: GameDefinition<T>,
    private readonly db: DB<T>,
    private readonly socketStore: SocketStore<T>,
  ) {
    this.gameStateService = new GameStateService(this.game);
    this.matchProjectionService = new MatchProjectionService(
      this.db,
      this.gameStateService,
    );
    this.socketRouter = new SocketRouter(
      this.game,
      this.db,
      this.socketStore,
      this.gameStateService,
    );

    this.socketStore.setGameStateService(this.gameStateService);

    logServer(
      SERVER_CONTROLLER_LOG_MODULE,
      "INFO",
      "ServerController initialized",
    );
  }

  /**
   * Builds UserMatchmaking view data for an existing user.
   * Returns a fresh auth token that can be used to reconnect later.
   */
  async getUserMatchmakingViewData(
    userId: string,
  ): Promise<
    {
      props: UserMatchmakingViewData<T>;
      token: string;
    }
  > {
    logServer(
      SERVER_CONTROLLER_LOG_MODULE,
      "INFO",
      `getUserMatchmakingViewData request=${serializeLogValue({ userId })}`,
    );

    if (userId === "") {
      throw new Error("Missing UserMatchmaking user ID");
    }

    const userMatchmakingData = await this.db.getUserMatchmakingStorageData(
      userId,
    );
    if (userMatchmakingData == null) {
      throw new Error("Unknown UserMatchmaking user");
    }

    const reconnectToken = crypto.randomUUID();
    await this.db.storeToken(reconnectToken, {
      userId,
      expiration: new Date(Date.now() + tokenTtlMs),
    });

    const userActiveMatches = await this.matchProjectionService
      .buildUserActiveMatchViews(
        userId,
        userMatchmakingData.activeMatches,
      );

    const response = {
      props: {
        userActiveMatches,
        roomIds: userMatchmakingData.joinedRooms.map((joinedRoom) =>
          joinedRoom.roomId
        ),
        queueEntries: userMatchmakingData.queueEntries,
      },
      token: reconnectToken,
    };

    logServer(
      SERVER_CONTROLLER_LOG_MODULE,
      "INFO",
      `getUserMatchmakingViewData response=${serializeLogValue(response)}`,
    );

    return {
      ...response,
    };
  }

  /**
   * Builds view data for the active public matches channel.
   */
  async getActivePublicMatchesViewData(): Promise<
    ActivePublicMatchesViewData<T>
  > {
    logServer(
      SERVER_CONTROLLER_LOG_MODULE,
      "INFO",
      "getActivePublicMatchesViewData request={}",
    );

    const allActiveMatches = await this.db.getAllActivePublicMatches();
    const projectedMatches = await this.matchProjectionService
      .buildActivePublicMatchViews(
        allActiveMatches,
      );

    const response = {
      allActiveMatches: projectedMatches,
    };

    logServer(
      SERVER_CONTROLLER_LOG_MODULE,
      "INFO",
      `getActivePublicMatchesViewData response=${serializeLogValue(response)}`,
    );

    return response;
  }

  /**
   * Builds view data for the active public users channel.
   */
  async getActivePublicUsersViewData(): Promise<
    ActiveUsersViewData<T>
  > {
    logServer(
      SERVER_CONTROLLER_LOG_MODULE,
      "INFO",
      "getActivePublicUsersViewData request={}",
    );

    const allActiveUsers = await this.db.getAllActivePublicUsers();
    const response = {
      allActiveUsers,
    };

    logServer(
      SERVER_CONTROLLER_LOG_MODULE,
      "INFO",
      `getActivePublicUsersViewData response=${serializeLogValue(response)}`,
    );

    return response;
  }

  /**
   * Builds view data for the available public rooms channel.
   */
  async getAvailablePublicRoomsViewData(): Promise<
    AvailablePublicRoomsViewData<T>
  > {
    logServer(
      SERVER_CONTROLLER_LOG_MODULE,
      "INFO",
      "getAvailablePublicRoomsViewData request={}",
    );

    const allAvailableRooms = await this.db.getAllAvailablePublicRooms();
    const response = {
      allAvailableRooms,
    };

    logServer(
      SERVER_CONTROLLER_LOG_MODULE,
      "INFO",
      `getAvailablePublicRoomsViewData response=${serializeLogValue(response)}`,
    );

    return response;
  }

  /**
   * Builds view data for one canonical user profile fetch.
   */
  async getUserProfileViewData(
    userId: string,
  ): Promise<UserProfileViewData<T>> {
    logServer(
      SERVER_CONTROLLER_LOG_MODULE,
      "INFO",
      `getUserProfileViewData request=${serializeLogValue({ userId })}`,
    );

    if (userId === "") {
      throw new Error("Missing UserProfile user ID");
    }

    const userProfile = await this.db.getUserProfileViewData(userId);
    if (userProfile == null) {
      throw new Error("Unknown UserProfile user");
    }

    logServer(
      SERVER_CONTROLLER_LOG_MODULE,
      "INFO",
      `getUserProfileViewData response=${serializeLogValue(userProfile)}`,
    );

    return userProfile;
  }

  /**
   * Builds match view data for a viewer or player.
   */
  async getMatchViewData(
    matchId: string,
    userId: string,
  ): Promise<MatchViewData<T>> {
    logServer(
      SERVER_CONTROLLER_LOG_MODULE,
      "INFO",
      `getMatchViewData request=${serializeLogValue({ matchId, userId })}`,
    );

    if (userId === "") {
      throw new Error("Missing match user id");
    }

    const gameData = await this.db.getMatchStorageData(matchId);
    const playerId = this.gameStateService.getPlayerId(gameData, userId);
    const matchViewData = this.buildMatchViewData(gameData, playerId);

    logServer(
      SERVER_CONTROLLER_LOG_MODULE,
      "INFO",
      `getMatchViewData response=${serializeLogValue(matchViewData)}`,
    );

    return matchViewData;
  }

  /**
   * Fetches the most recent messages in one chat thread.
   */
  async getChatThreadMessages(
    chatThreadId: string,
    limit: number,
  ): Promise<ChatThreadViewData<T>> {
    logServer(
      SERVER_CONTROLLER_LOG_MODULE,
      "INFO",
      `getChatThreadMessages request=${
        serializeLogValue({ chatThreadId, limit })
      }`,
    );
    const chatMessages = await this.db.getMostRecentChatThreadMessages(
      chatThreadId,
      limit,
    );
    logServer(
      SERVER_CONTROLLER_LOG_MODULE,
      "INFO",
      `getChatThreadMessages response=${
        serializeLogValue({ chatThreadId, count: chatMessages.length })
      }`,
    );
    return { chatMessages };
  }

  /**
   * Builds the initial match view payload for a specific player or observer.
   */
  private buildMatchViewData(
    gameData: MatchStorageData<T>,
    playerId: number | undefined,
  ): MatchViewData<T> {
    const gameStateUpdate = this.gameStateService.buildGameStateUpdate(
      gameData,
      playerId,
    );
    return {
      chatThreadId: gameData.chatThreadId,
      players: gameData.players,
      playerId,
      playerState: gameStateUpdate.playerState,
      publicState: gameStateUpdate.publicState,
      outcome: gameStateUpdate.outcome,
    } as MatchViewData<T>;
  }

  /**
   * Configures one websocket to handle all framework channel messages.
   */
  configureSocket(
    socket: WebSocket,
    userId: string,
  ): void {
    this.socketRouter.configureSocket(socket, userId);
  }

  /**
   * Resolves a token to a valid user ID, creating a guest user when needed.
   */
  async resolveToken(
    token: string | undefined,
  ): Promise<string> {
    logServer(
      SERVER_CONTROLLER_LOG_MODULE,
      "INFO",
      `resolveToken request=${
        serializeLogValue({ hasToken: token != null && token !== "" })
      }`,
    );

    if (token != null && token !== "") {
      const tokenData = await this.db.getToken(token);
      if (tokenData != null && tokenData.expiration > new Date()) {
        const [storedUser, storedMatchmaking] = await Promise.all([
          this.db.getUserStorageData(tokenData.userId),
          this.db.getUserMatchmakingStorageData(tokenData.userId),
        ]);
        if (storedUser != null && storedMatchmaking != null) {
          logServer(
            SERVER_CONTROLLER_LOG_MODULE,
            "INFO",
            `resolveToken reused token for userId=${tokenData.userId}`,
          );
          return tokenData.userId;
        }
      }
    }

    const user = await this.createGuestUser();
    const userId = ulid();
    await this.db.createNewUserStorageData(userId, {
      username: user.username,
      isGuest: user.isGuest,
      description: "",
      ratings: this.buildInitialRatings(),
    });
    await this.db.createNewUserMatchmakingStorageData(userId, {
      activeMatches: [],
      joinedRooms: [],
      queueEntries: [],
    });

    logServer(
      SERVER_CONTROLLER_LOG_MODULE,
      "INFO",
      `resolveToken created guest user=${
        serializeLogValue({ userId, username: user.username })
      }`,
    );

    return userId;
  }

  /**
   * Builds initial ratings for every configured ranked queue.
   */
  private buildInitialRatings(): Record<string, T["Rating"]> {
    return this.normalizeRatings({}).ratings;
  }

  /**
   * Ensures ratings exist for every configured ranked queue.
   */
  private normalizeRatings(
    ratings: Record<string, T["Rating"]>,
  ): { ratings: Record<string, T["Rating"]>; didChange: boolean } {
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
   * Creates a unique guest profile in memory before persistence.
   */
  private async createGuestUser(): Promise<
    { username: string; isGuest: boolean }
  > {
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
