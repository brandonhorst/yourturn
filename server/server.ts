import type {
  ActiveMatch,
  ActivePublicMatch,
  ActivePublicMatchesViewData,
  ActiveUsersViewData,
  AvailablePublicRoomsViewData,
  GameDefinition,
  GameTypes,
  MatchViewData,
  PlayerSnapshot,
  Server,
  UserActiveMatch,
  UserMatchmakingViewData,
  UserProfileViewData,
} from "../types.ts";
import type { ClientMessage, ServerMessage } from "../common/sockettypes.ts";
import { GameStateService } from "./gamestateservice.ts";
import {
  type DB,
  type MatchStorageData,
  userProfileViewDataToPlayerSnapshot,
} from "./db.ts";
import type { SocketStore } from "./sockets.ts";
import { ulid } from "@std/ulid";

const tokenTtlMs = 1000 * 60 * 60 * 24 * 30;

export class ServerController<T extends GameTypes> implements Server<T> {
  private gameStateService: GameStateService<T>;

  constructor(
    private game: GameDefinition<T>,
    private db: DB<T>,
    private socketStore: SocketStore<T>,
  ) {
    this.gameStateService = new GameStateService(this.game);
    this.socketStore.setGameStateService(this.gameStateService);
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

    const userActiveMatches = await this.buildUserActiveMatchViews(
      userId,
      userMatchmakingData.activeMatches,
    );

    return {
      props: {
        userActiveMatches,
        roomIds: userMatchmakingData.joinedRooms.map((joinedRoom) =>
          joinedRoom.roomId
        ),
        queueEntries: userMatchmakingData.queueEntries,
      },
      token: reconnectToken,
    };
  }

  /**
   * Builds view data for the active public matches channel.
   */
  async getActivePublicMatchesViewData(): Promise<
    ActivePublicMatchesViewData<T>
  > {
    const allActiveMatches = await this.db.getAllActivePublicMatches();
    const projectedMatches = await this.buildActivePublicMatchViews(
      allActiveMatches,
    );
    return {
      allActiveMatches: projectedMatches,
    };
  }

  /**
   * Builds view data for the active public users channel.
   */
  async getActivePublicUsersViewData(): Promise<
    ActiveUsersViewData<T>
  > {
    const allActiveUsers = await this.db.getAllActivePublicUsers();
    return {
      allActiveUsers,
    };
  }

  /**
   * Builds view data for the available public rooms channel.
   */
  async getAvailablePublicRoomsViewData(): Promise<
    AvailablePublicRoomsViewData<T>
  > {
    const allAvailableRooms = await this.db.getAllAvailablePublicRooms();
    return {
      allAvailableRooms,
    };
  }

  /**
   * Builds view data for one canonical user profile fetch.
   */
  async getUserProfileViewData(
    userId: string,
  ): Promise<UserProfileViewData<T>> {
    if (userId === "") {
      throw new Error("Missing UserProfile user ID");
    }

    const userProfile = await this.db.getUserProfileViewData(userId);
    if (userProfile == null) {
      throw new Error("Unknown UserProfile user");
    }
    return userProfile;
  }

  /**
   * Builds match view data for a viewer or player.
   */
  async getMatchViewData(
    matchId: string,
    userId: string,
  ): Promise<MatchViewData<T>> {
    if (userId === "") {
      throw new Error("Missing match user id");
    }

    const gameData = await this.db.getMatchStorageData(matchId);

    const playerId = this.gameStateService.getPlayerId(gameData, userId);
    return this.buildMatchViewData(gameData, playerId);
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
      players: gameData.players,
      playerId,
      playerState: gameStateUpdate.playerState,
      publicState: gameStateUpdate.publicState,
      outcome: gameStateUpdate.outcome,
    } as MatchViewData<T>;
  }

  /**
   * Loads match storage records for a set of match IDs.
   */
  private async getMatchDataById(
    matchIds: string[],
  ): Promise<
    Map<string, MatchStorageData<T>>
  > {
    const uniqueMatchIds = [...new Set(matchIds)];
    const matchEntries = await Promise.all(
      uniqueMatchIds.map(async (matchId) => {
        try {
          const gameData = await this.db.getMatchStorageData(matchId);
          return [matchId, gameData] as const;
        } catch {
          return undefined;
        }
      }),
    );
    const matchDataById = new Map<
      string,
      MatchStorageData<T>
    >();
    for (const matchEntry of matchEntries) {
      if (matchEntry == null) {
        continue;
      }
      matchDataById.set(matchEntry[0], matchEntry[1]);
    }
    return matchDataById;
  }

  /**
   * Projects active public matches using the latest match game state.
   */
  private async buildActivePublicMatchViews(
    activeMatches: ActiveMatch<T>[],
  ): Promise<ActivePublicMatch<T>[]> {
    const timestamp = new Date();
    const matchDataById = await this.getMatchDataById(
      activeMatches.map((activeMatch) => activeMatch.matchId),
    );
    const projectedMatches: ActivePublicMatch<T>[] = [];

    for (const activeMatch of activeMatches) {
      const gameData = matchDataById.get(activeMatch.matchId);
      if (gameData == null) {
        continue;
      }

      projectedMatches.push({
        ...activeMatch,
        publicState: this.gameStateService.getPublicState(gameData, timestamp),
      });
    }

    return projectedMatches;
  }

  /**
   * Projects user-active matches with both public and private player state.
   */
  private async buildUserActiveMatchViews(
    userId: string,
    activeMatches: ActiveMatch<T>[],
  ): Promise<UserActiveMatch<T>[]> {
    const timestamp = new Date();
    const matchDataById = await this.getMatchDataById(
      activeMatches.map((activeMatch) => activeMatch.matchId),
    );
    const projectedMatches: UserActiveMatch<T>[] = [];

    for (const activeMatch of activeMatches) {
      const gameData = matchDataById.get(activeMatch.matchId);
      if (gameData == null) {
        continue;
      }

      const playerId = this.gameStateService.getPlayerId(gameData, userId);
      if (playerId == null) {
        continue;
      }

      projectedMatches.push({
        ...activeMatch,
        publicState: this.gameStateService.getPublicState(gameData, timestamp),
        privateState: this.gameStateService.getPlayerState(
          gameData,
          playerId,
          timestamp,
        ),
      });
    }

    return projectedMatches;
  }

  /**
   * Validates and normalizes optional account user profile updates.
   */
  private normalizeUserProfileUpdate(
    profileUpdate: { description?: string },
  ): { description: string } {
    if (profileUpdate.description === undefined) {
      throw new Error("Provide a description.");
    }

    return { description: profileUpdate.description };
  }

  /**
   * Configures one websocket to handle account profile, matchmaking, list,
   * room, and match channel messages, plus one-shot profile fetch requests.
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
     * Fetches the latest player snapshot for room and queue actions.
     */
    const getPlayerSnapshot = async (): Promise<
      PlayerSnapshot<T> | null
    > => {
      const userProfileViewData = await this.db.getUserProfileViewData(userId);
      if (userProfileViewData == null) {
        return null;
      }
      return userProfileViewDataToPlayerSnapshot(userProfileViewData);
    };

    /**
     * Initializes active-public-user presence for this websocket connection.
     */
    const initializeSocketPresence = async (): Promise<void> => {
      const playerSnapshot = await getPlayerSnapshot();
      if (playerSnapshot == null) {
        return;
      }
      await this.db.incrementActivePublicUserConnection(userId, playerSnapshot);
    };

    const socketPresenceReady = initializeSocketPresence().catch((err) => {
      console.error("Failed to initialize socket presence", err);
    });

    /**
     * Refreshes active-public-user TTL for inbound activity.
     */
    const touchSocketPresence = async (): Promise<void> => {
      await socketPresenceReady;
      try {
        await this.db.touchActivePublicUser(userId);
      } catch (err) {
        console.error("Failed to refresh socket presence", err);
      }
    };

    /**
     * Resolves the user's player ID for a specific game.
     */
    const getPlayerIdForMatch = async (
      matchId: string,
    ): Promise<number | undefined> => {
      const gameData = await this.db.getMatchStorageData(matchId);
      return this.gameStateService.getPlayerId(gameData, userId);
    };

    /**
     * Cleans up all channel subscriptions when the socket closes.
     */
    const handleSocketClose = async () => {
      await socketPresenceReady;
      try {
        await this.db.decrementActivePublicUserConnection(userId);
      } catch (err) {
        console.error("Failed to decrement socket presence", err);
      }
      await this.socketStore.unsubscribeSocket(socket);
    };

    /**
     * Routes any client message to the matching channel handler.
     */
    const handleSocketMessage = async (event: MessageEvent) => {
      const request: ClientMessage<T> = JSON.parse(event.data);

      if (
        request.type === "SubscribeAccountUserProfile" ||
        request.type === "FetchUserProfile" ||
        request.type === "UpdateAccountUserProfile" ||
        request.type === "SubscribeUserMatchmaking" ||
        request.type === "SubscribeActivePublicMatches" ||
        request.type === "SubscribeActivePublicUsers" ||
        request.type === "SubscribeAvailablePublicRooms" ||
        request.type === "SubscribeRoom" ||
        request.type === "JoinQueue" ||
        request.type === "CreateAndJoinRoom" ||
        request.type === "JoinRoom" ||
        request.type === "CommitRoom" ||
        request.type === "LeaveQueue" ||
        request.type === "LeaveRoom" ||
        request.type === "SubscribeMatch" ||
        request.type === "Move"
      ) {
        await touchSocketPresence();
      }

      switch (request.type) {
        case "SubscribeAccountUserProfile": {
          const latestUserProfile = await this.db.getUserProfileViewData(
            userId,
          );
          if (latestUserProfile == null) {
            sendDisplayError("Unknown AccountUserProfile user.");
            break;
          }

          await this.socketStore.subscribeAccountUserProfile(
            socket,
            request.subscriptionId,
            userId,
            latestUserProfile,
          );
          break;
        }
        case "FetchUserProfile":
          socket.send(
            JSON.stringify(
              {
                type: "FetchUserProfileResult",
                requestId: request.requestId,
                userProfile: await this.db.getUserProfileViewData(
                  request.userId,
                ),
              } satisfies ServerMessage<T>,
            ),
          );
          break;
        case "UpdateAccountUserProfile":
          try {
            const normalizedUpdate = this.normalizeUserProfileUpdate({
              description: request.description,
            });
            await this.db.updateUserProfile(userId, normalizedUpdate);
          } catch (err) {
            if (err instanceof Error) {
              if (
                err.message === "Provide a description."
              ) {
                sendDisplayError(err.message);
                break;
              }
            }
            console.error("Failed to update account user profile", err);
            sendDisplayError("Unable to update account user profile.");
          }
          break;
        case "SubscribeUserMatchmaking": {
          const latestUserData = await this.db.getUserMatchmakingStorageData(
            userId,
          );
          if (latestUserData == null) {
            sendDisplayError("Unknown UserMatchmaking user.");
            break;
          }

          await this.socketStore.subscribeUserMatchmaking(
            socket,
            request.subscriptionId,
            userId,
            latestUserData,
          );
          break;
        }
        case "SubscribeActivePublicMatches":
          await this.socketStore.subscribeActivePublicMatches(
            socket,
            request.subscriptionId,
          );
          break;
        case "SubscribeActivePublicUsers":
          await this.socketStore.subscribeActivePublicUsers(
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

          const playerSnapshot = await getPlayerSnapshot();
          if (playerSnapshot == null) {
            sendDisplayError("Unknown UserMatchmaking user.");
            break;
          }

          try {
            await this.socketStore.joinQueue(
              socket,
              request.queueId,
              userId,
              playerSnapshot,
              request.loadout,
              request.assignmentSubscriptionId,
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

          const playerSnapshot = await getPlayerSnapshot();
          if (playerSnapshot == null) {
            sendDisplayError("Unknown UserMatchmaking user.");
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
              playerSnapshot,
              request.loadout,
              request.assignmentSubscriptionId,
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

          const playerSnapshot = await getPlayerSnapshot();
          if (playerSnapshot == null) {
            sendDisplayError("Unknown UserMatchmaking user.");
            break;
          }

          let joined = false;
          try {
            joined = await this.socketStore.joinRoom(
              socket,
              request.roomId,
              userId,
              playerSnapshot,
              request.loadout,
              request.assignmentSubscriptionId,
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
        case "SubscribeMatch":
          try {
            const playerId = await getPlayerIdForMatch(request.matchId);
            await this.socketStore.subscribeMatch(
              socket,
              request.subscriptionId,
              request.matchId,
              playerId,
            );
          } catch (err) {
            console.error("Failed to subscribe match socket", err);
            await this.socketStore.unsubscribe(socket, request.subscriptionId);
            sendDisplayError("Unable to subscribe to match.");
          }
          break;
        case "Unsubscribe":
          await this.socketStore.unsubscribe(socket, request.subscriptionId);
          break;
        case "Move":
          try {
            const playerId = await getPlayerIdForMatch(request.matchId);
            if (playerId == null) {
              break;
            }
            await this.gameStateService.handleMove(
              this.db,
              request.matchId,
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
