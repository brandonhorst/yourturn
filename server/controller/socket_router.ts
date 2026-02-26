import { ulid } from "@std/ulid";
import type { ClientMessage, ServerMessage } from "../../protocol/mod.ts";
import type {
  GameDefinition,
  GameTypes,
  PlayerSnapshot,
} from "../../types/mod.ts";
import { type DB, userProfileViewDataToPlayerSnapshot } from "../db/mod.ts";
import { logServer, serializeLogValue } from "../logging.ts";
import type { GameStateService } from "../services/game_state_service.ts";
import type { SocketStore } from "../sockets/mod.ts";

const SOCKET_LOG_MODULE = "server.socket";
const SOCKET_ROUTER_LOG_MODULE = "server.socket_router";

/**
 * Routes inbound websocket messages and delegates to channel/store handlers.
 */
export class SocketRouter<T extends GameTypes> {
  constructor(
    private readonly game: GameDefinition<T>,
    private readonly db: DB<T>,
    private readonly socketStore: SocketStore<T>,
    private readonly gameStateService: GameStateService<T>,
  ) {}

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
   * Configures one websocket with all supported yourturn channels.
   */
  configureSocket(
    socket: WebSocket,
    userId: string,
  ): void {
    logServer(
      SOCKET_ROUTER_LOG_MODULE,
      "INFO",
      `configureSocket request=${serializeLogValue({ userId })}`,
    );
    if (userId === "") {
      throw new Error("Missing socket user id");
    }

    const socketConnectionId = ulid();
    logServer(
      SOCKET_LOG_MODULE,
      "INFO",
      `Socket connected payload=${
        serializeLogValue({ socketConnectionId, userId })
      }`,
    );

    /**
     * Sends one server message to the client with an outbound debug log.
     */
    const sendSocketMessage = (message: ServerMessage<T>): void => {
      logServer(
        SOCKET_LOG_MODULE,
        "INFO",
        `Socket outbound message payload=${
          serializeLogValue({
            socketConnectionId,
            userId,
            type: message.type,
            message,
          })
        }`,
      );
      socket.send(JSON.stringify(message));
    };

    /**
     * Sends an error response to the client over this websocket.
     */
    const sendDisplayError = (message: string): void => {
      sendSocketMessage({ type: "DisplayError", message });
    };

    /**
     * Fetches the latest player snapshot for room and queue actions.
     */
    const getPlayerSnapshot = async (): Promise<PlayerSnapshot<T> | null> => {
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
      logServer(
        SOCKET_LOG_MODULE,
        "ERROR",
        `Failed to initialize socket presence error=${
          serializeLogValue(err instanceof Error ? err : String(err))
        }`,
      );
    });

    /**
     * Refreshes active-public-user TTL for inbound activity.
     */
    const touchSocketPresence = async (): Promise<void> => {
      await socketPresenceReady;
      try {
        await this.db.touchActivePublicUser(userId);
      } catch (err) {
        logServer(
          SOCKET_LOG_MODULE,
          "ERROR",
          `Failed to refresh socket presence error=${
            serializeLogValue(err instanceof Error ? err : String(err))
          }`,
        );
      }
    };

    /**
     * Resolves the user's player ID for a specific match.
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
    const handleSocketClose = async (event: CloseEvent) => {
      logServer(
        SOCKET_LOG_MODULE,
        "INFO",
        `Socket disconnected payload=${
          serializeLogValue({
            socketConnectionId,
            userId,
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
          })
        }`,
      );
      await socketPresenceReady;
      try {
        await this.db.decrementActivePublicUserConnection(userId);
      } catch (err) {
        logServer(
          SOCKET_LOG_MODULE,
          "ERROR",
          `Failed to decrement socket presence error=${
            serializeLogValue(err instanceof Error ? err : String(err))
          }`,
        );
      }
      await this.socketStore.unsubscribeSocket(socket);
    };

    /**
     * Routes any client message to the matching channel handler.
     */
    const handleSocketMessage = async (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        logServer(
          SOCKET_LOG_MODULE,
          "WARN",
          `Socket inbound non-string message payload=${
            serializeLogValue({
              socketConnectionId,
              userId,
              dataType: typeof event.data,
            })
          }`,
        );
        return;
      }

      let request: ClientMessage<T>;
      try {
        request = JSON.parse(event.data) as ClientMessage<T>;
      } catch (err) {
        logServer(
          SOCKET_LOG_MODULE,
          "ERROR",
          `Failed to parse socket message payload=${
            serializeLogValue({
              socketConnectionId,
              userId,
              error: err,
              rawMessage: event.data,
            })
          }`,
        );
        sendDisplayError("Invalid socket message.");
        return;
      }

      logServer(
        SOCKET_LOG_MODULE,
        "INFO",
        `Socket inbound message payload=${
          serializeLogValue({
            socketConnectionId,
            userId,
            type: request.type,
            request,
          })
        }`,
      );

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
          sendSocketMessage(
            {
              type: "FetchUserProfileResult",
              requestId: request.requestId,
              userProfile: await this.db.getUserProfileViewData(
                request.userId,
              ),
            } satisfies ServerMessage<T>,
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
            logServer(
              SOCKET_LOG_MODULE,
              "ERROR",
              `Failed to update account user profile error=${
                serializeLogValue(err instanceof Error ? err : String(err))
              }`,
            );
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
            logServer(
              SOCKET_LOG_MODULE,
              "ERROR",
              `Failed to subscribe room socket error=${
                serializeLogValue(err instanceof Error ? err : String(err))
              }`,
            );
            await this.socketStore.unsubscribe(socket, request.subscriptionId);
            sendDisplayError("Unable to subscribe to room.");
          }
          break;
        case "JoinQueue": {
          const queue = this.game.queues[request.queueId];
          if (queue == null) {
            logServer(
              SOCKET_LOG_MODULE,
              "WARN",
              `Attempted to join missing queue payload=${
                serializeLogValue({ queueId: request.queueId, request })
              }`,
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
            logServer(
              SOCKET_LOG_MODULE,
              "ERROR",
              `Failed to join queue error=${
                serializeLogValue(err instanceof Error ? err : String(err))
              }`,
            );
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
            logServer(
              SOCKET_LOG_MODULE,
              "ERROR",
              `Failed to create and join room error=${
                serializeLogValue(err instanceof Error ? err : String(err))
              }`,
            );
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
            logServer(
              SOCKET_LOG_MODULE,
              "ERROR",
              `Failed to join room error=${
                serializeLogValue(err instanceof Error ? err : String(err))
              }`,
            );
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
            logServer(
              SOCKET_LOG_MODULE,
              "ERROR",
              `Failed to commit room error=${
                serializeLogValue(err instanceof Error ? err : String(err))
              }`,
            );
            sendDisplayError("Unable to commit room.");
          }
          break;
        case "LeaveQueue":
          try {
            await this.socketStore.leaveQueue(socket, request.queueId);
          } catch (err) {
            logServer(
              SOCKET_LOG_MODULE,
              "ERROR",
              `Failed to leave queue error=${
                serializeLogValue(err instanceof Error ? err : String(err))
              }`,
            );
            sendDisplayError("Unable to leave queue.");
          }
          break;
        case "LeaveRoom":
          try {
            await this.socketStore.leaveRoom(socket, request.roomId, userId);
          } catch (err) {
            logServer(
              SOCKET_LOG_MODULE,
              "ERROR",
              `Failed to leave room error=${
                serializeLogValue(err instanceof Error ? err : String(err))
              }`,
            );
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
            logServer(
              SOCKET_LOG_MODULE,
              "ERROR",
              `Failed to subscribe match socket error=${
                serializeLogValue(err instanceof Error ? err : String(err))
              }`,
            );
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
            logServer(
              SOCKET_LOG_MODULE,
              "ERROR",
              `Failed to process move error=${
                serializeLogValue(err instanceof Error ? err : String(err))
              }`,
            );
            sendDisplayError("Unable to process move.");
          }
          break;
      }
    };

    socket.addEventListener("message", handleSocketMessage);
    socket.addEventListener("close", handleSocketClose);
  }
}
