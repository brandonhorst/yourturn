import { logServer, serializeLogValue } from "@/server/logging.ts";
import type { GameTypes } from "@/types/mod.ts";
import type {
  LifecycleSocketOps,
  SocketOperationDependencies,
} from "../contracts.ts";
import type { SocketStoreContext } from "../context.ts";

const SOCKET_LIFECYCLE_LOG_MODULE = "server.sockets.lifecycle";

/**
 * Socket subscription lifecycle operations shared across all domains.
 */
export class SocketLifecycleOps<T extends GameTypes>
  implements LifecycleSocketOps<T> {
  constructor(
    private readonly context: SocketStoreContext<T>,
    private readonly dependencies: SocketOperationDependencies<T>,
  ) {}

  /**
   * Unsubscribes one logical channel instance identified by subscription ID.
   */
  async unsubscribe(
    socket: WebSocket,
    subscriptionId: string,
  ): Promise<void> {
    logServer(
      SOCKET_LIFECYCLE_LOG_MODULE,
      "INFO",
      `unsubscribe request=${serializeLogValue({ subscriptionId })}`,
    );
    const connectionState = this.context.sockets.get(socket);
    if (connectionState == null) {
      return;
    }

    const subscription = connectionState.subscriptions.get(subscriptionId);
    if (subscription == null) {
      return;
    }

    connectionState.subscriptions.delete(subscriptionId);

    switch (subscription.type) {
      case "AccountUserProfile":
        this.dependencies.userOps.unsubscribeAccountUserProfileSubscription(
          socket,
          subscriptionId,
          subscription.userId,
        );
        break;
      case "UserMatchmaking":
        await this.dependencies.userMatchmakingOps
          .unsubscribeUserMatchmakingSubscription(
            socket,
            subscriptionId,
          );
        break;
      case "Room":
        this.dependencies.roomOps.unsubscribeRoomSubscription(
          socket,
          subscriptionId,
          subscription.roomId,
        );
        break;
      case "ActivePublicMatches":
        this.context.activePublicMatchesSubscriptions.delete(subscriptionId);
        break;
      case "ActivePublicUsers":
        this.context.activePublicUsersSubscriptions.delete(subscriptionId);
        break;
      case "AvailablePublicRooms":
        this.context.availablePublicRoomsSubscriptions.delete(subscriptionId);
        break;
      case "ChatThread":
        this.dependencies.chatOps.unsubscribeChatThreadSubscription(
          socket,
          subscriptionId,
        );
        break;
      case "Match":
        this.dependencies.matchOps.unsubscribeMatchSubscription(
          subscriptionId,
          subscription.matchId,
        );
        break;
    }

    this.context.pruneIdleSocket(socket);
  }

  /**
   * Unsubscribes a websocket from all channel subscriptions.
   */
  async unsubscribeSocket(socket: WebSocket): Promise<void> {
    logServer(
      SOCKET_LIFECYCLE_LOG_MODULE,
      "INFO",
      "unsubscribeSocket request={}",
    );
    const connectionState = this.context.sockets.get(socket);
    if (connectionState == null) {
      return;
    }

    for (const subscriptionId of [...connectionState.subscriptions.keys()]) {
      await this.unsubscribe(socket, subscriptionId);
    }

    this.context.pruneIdleSocket(socket);
  }
}
