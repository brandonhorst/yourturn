import type { DB, MatchAssignmentNotification } from "@/server/db/mod.ts";
import { logServer } from "@/server/logging.ts";
import type { GameStateService } from "@/server/services/game_state_service.ts";
import type { GameTypes } from "@/types/mod.ts";
import type {
  MatchConnection,
  RoomConnectionState,
  SocketConnectionState,
  UserMatchmakingConnectionState,
} from "./state.ts";
import { sendServerMessage } from "./wire.ts";

const SOCKET_CONTEXT_LOG_MODULE = "server.sockets.context";

/**
 * Shared mutable socket state and helpers used by socket operation objects.
 */
export class SocketStoreContext<T extends GameTypes> {
  readonly sockets: Map<WebSocket, SocketConnectionState<T>> = new Map();
  readonly activePublicMatchesSubscriptions: Map<string, WebSocket> = new Map();
  readonly activePublicUsersSubscriptions: Map<string, WebSocket> = new Map();
  readonly availablePublicRoomsSubscriptions: Map<string, WebSocket> =
    new Map();
  readonly matchConnections: Map<string, MatchConnection<T>> = new Map();

  private gameStateService?: GameStateService<T>;

  constructor(
    readonly db: DB<T>,
  ) {}

  /**
   * Registers game-derived state helpers shared by match subscriptions.
   */
  setGameStateService(
    gameStateService: GameStateService<T>,
  ): void {
    this.gameStateService = gameStateService;
    logServer(
      SOCKET_CONTEXT_LOG_MODULE,
      "INFO",
      "Registered GameStateService with SocketStore",
    );
  }

  /**
   * Returns the configured match helpers or throws when missing.
   */
  requireGameStateService(): GameStateService<T> {
    if (this.gameStateService == null) {
      throw new Error("SocketStore match state service is not configured");
    }
    return this.gameStateService;
  }

  /**
   * Returns the UserMatchmaking connection state for a socket or throws when
   * absent.
   */
  getUserMatchmakingConnectionState(
    socket: WebSocket,
  ): UserMatchmakingConnectionState<T> {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null || connectionState.userMatchmaking == null) {
      throw new Error("Socket is not subscribed to userMatchmaking");
    }

    return connectionState.userMatchmaking;
  }

  /**
   * Returns a socket connection state, creating one when missing.
   */
  getOrCreateSocketConnection(
    socket: WebSocket,
  ): SocketConnectionState<T> {
    const existing = this.sockets.get(socket);
    if (existing != null) {
      return existing;
    }

    const connectionState: SocketConnectionState<T> = {
      subscriptions: new Map(),
      roomConnections: new Map(),
      chatThreadSubscriptions: new Map(),
      accountUserProfileConnections: new Map(),
    };
    this.sockets.set(socket, connectionState);
    return connectionState;
  }

  /**
   * Returns one room connection tracked for a socket.
   */
  getRoomConnection(
    socket: WebSocket,
    roomId: string,
  ): RoomConnectionState<T> | undefined {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null) {
      return undefined;
    }

    return connectionState.roomConnections.get(roomId);
  }

  /**
   * Sends match assignment messages for each stored assignment target.
   */
  sendMatchAssignmentsToStoredSubscriptions(
    assignments: MatchAssignmentNotification[],
  ): void {
    for (const assignment of assignments) {
      if (assignment.subscriptionId == null) {
        continue;
      }

      this.sendMatchAssignmentToMatchingSubscriptions(
        assignment.subscriptionId,
        assignment.matchId,
      );
    }
  }

  /**
   * Removes socket bookkeeping when no subscriptions remain.
   */
  pruneIdleSocket(socket: WebSocket): void {
    const connectionState = this.sockets.get(socket);
    if (connectionState == null) {
      return;
    }
    if (connectionState.subscriptions.size > 0) {
      return;
    }
    if (connectionState.roomConnections.size > 0) {
      return;
    }
    if (connectionState.chatThreadSubscriptions.size > 0) {
      return;
    }
    if (connectionState.accountUserProfileConnections.size > 0) {
      return;
    }
    if (connectionState.userMatchmaking != null) {
      return;
    }

    this.sockets.delete(socket);
  }

  /**
   * Sends one match assignment message to sockets currently holding the
   * referenced subscription ID.
   */
  private sendMatchAssignmentToMatchingSubscriptions(
    subscriptionId: string,
    matchId: string,
  ): void {
    for (const [socket, connectionState] of this.sockets.entries()) {
      if (!connectionState.subscriptions.has(subscriptionId)) {
        continue;
      }

      sendServerMessage<T>(socket, {
        type: "MatchAssignment",
        subscriptionId,
        matchId,
      });
    }
  }
}
