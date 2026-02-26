import type { UserMatchmakingStorageData } from "@/server/db/mod.ts";
import { logServer, serializeLogValue } from "@/server/logging.ts";
import type { GameTypes, UserMatchmakingViewData } from "@/types/mod.ts";
import type {
  PresenceSocketOps,
  QueueSocketOps,
  UnsubscribeSubscription,
  UserMatchmakingSocketOps,
} from "../contracts.ts";
import type { SocketStoreContext } from "../context.ts";
import type { UserMatchmakingConnectionState } from "../state.ts";
import { closeReader, sendServerMessage } from "../wire.ts";

const SOCKET_USER_MATCHMAKING_LOG_MODULE = "server.sockets.user_matchmaking";

/**
 * UserMatchmaking subscription and projection operations.
 */
export class SocketUserMatchmakingOps<T extends GameTypes>
  implements UserMatchmakingSocketOps<T> {
  constructor(
    private readonly context: SocketStoreContext<T>,
    private readonly queueOps: QueueSocketOps<T>,
    private readonly presenceOps: PresenceSocketOps<T>,
  ) {}

  /**
   * Subscribes one logical UserMatchmaking channel instance on a websocket.
   */
  async subscribeUserMatchmaking(
    socket: WebSocket,
    subscriptionId: string,
    userId: string,
    userData: UserMatchmakingStorageData<T>,
    unsubscribeSubscription: UnsubscribeSubscription,
  ): Promise<void> {
    logServer(
      SOCKET_USER_MATCHMAKING_LOG_MODULE,
      "INFO",
      `subscribeUserMatchmaking request=${
        serializeLogValue({ subscriptionId, userId, userData })
      }`,
    );
    const existingConnection = this.context.sockets.get(socket);
    const existingSubscription = existingConnection?.subscriptions.get(
      subscriptionId,
    );

    if (
      existingSubscription?.type === "UserMatchmaking" &&
      existingConnection != null &&
      existingConnection.userMatchmaking != null
    ) {
      const connectionUserId = existingConnection.userMatchmaking.userId;
      existingConnection.userMatchmaking.subscriptionIds.add(subscriptionId);
      await this.sendUserMatchmakingSnapshot(
        socket,
        subscriptionId,
        connectionUserId,
        userData,
      );
      return;
    }

    await unsubscribeSubscription();

    const connectionState = this.context.getOrCreateSocketConnection(socket);

    if (connectionState.userMatchmaking == null) {
      const userChangesReader = this.context.db.watchForUserMatchmakingChanges(
        userId,
      ).getReader();

      connectionState.userMatchmaking = {
        userId,
        subscriptionIds: new Set(),
        userChangesReader,
        queueSubscriptions: new Map(),
      };
      void this.streamUserChangesToSocket(socket, userId, userChangesReader);
    }

    const userMatchmakingState = connectionState.userMatchmaking;
    if (userMatchmakingState == null) {
      throw new Error("UserMatchmaking connection state was not initialized");
    }

    userMatchmakingState.subscriptionIds.add(subscriptionId);
    connectionState.subscriptions.set(subscriptionId, {
      type: "UserMatchmaking",
    });

    await this.sendUserMatchmakingSnapshot(
      socket,
      subscriptionId,
      userId,
      userData,
    );
  }

  /**
   * Unsubscribes one UserMatchmaking subscription and tears down
   * UserMatchmaking streams when last.
   */
  async unsubscribeUserMatchmakingSubscription(
    socket: WebSocket,
    subscriptionId: string,
  ): Promise<void> {
    const connectionState = this.context.sockets.get(socket);
    if (connectionState == null || connectionState.userMatchmaking == null) {
      return;
    }

    const userMatchmakingState = connectionState.userMatchmaking;
    userMatchmakingState.subscriptionIds.delete(subscriptionId);

    if (userMatchmakingState.subscriptionIds.size > 0) {
      return;
    }

    await this.cleanupUserMatchmakingConnection(socket, userMatchmakingState);
  }

  /**
   * Cleans up shared UserMatchmaking resources after the last
   * UserMatchmaking subscription is gone.
   */
  private async cleanupUserMatchmakingConnection(
    socket: WebSocket,
    userMatchmakingState: UserMatchmakingConnectionState<T>,
  ): Promise<void> {
    for (const queueId of [...userMatchmakingState.queueSubscriptions.keys()]) {
      await this.queueOps.cleanupQueueSubscription(socket, queueId, {
        removeFromDb: true,
      });
    }

    closeReader(userMatchmakingState.userChangesReader);

    const connectionState = this.context.sockets.get(socket);
    if (connectionState != null) {
      connectionState.userMatchmaking = undefined;
    }
  }

  /**
   * Streams UserMatchmaking updates for one websocket.
   */
  private async streamUserChangesToSocket(
    socket: WebSocket,
    userId: string,
    userChangesReader: ReadableStreamDefaultReader<
      UserMatchmakingStorageData<T>
    >,
  ): Promise<void> {
    try {
      while (true) {
        const data = await userChangesReader.read();
        if (data.done) {
          break;
        }

        const userData = data.value;
        await this.sendUserMatchmakingSnapshotToSubscriptions(
          socket,
          userId,
          userData,
        );
      }
    } catch {
      // Reader cancellation is expected during unsubscribe.
    }
  }

  /**
   * Builds one full UserMatchmaking payload with derived match state.
   */
  private async buildUserMatchmakingProps(
    userId: string,
    userData: UserMatchmakingStorageData<T>,
  ): Promise<UserMatchmakingViewData<T>> {
    const userActiveMatches = await this.presenceOps.buildUserActiveMatchViews(
      userId,
      userData.activeMatches,
    );
    return {
      userActiveMatches,
      roomIds: userData.joinedRooms.map((joinedRoom) => joinedRoom.roomId),
      queueEntries: userData.queueEntries,
    };
  }

  /**
   * Sends one UserMatchmaking payload update to one subscription.
   */
  private sendUserMatchmakingUpdate(
    socket: WebSocket,
    subscriptionId: string,
    userMatchmakingProps: UserMatchmakingViewData<T>,
  ): void {
    sendServerMessage<T>(socket, {
      type: "UpdateUserMatchmakingProps",
      subscriptionId,
      userMatchmakingProps,
    });
  }

  /**
   * Sends one full UserMatchmaking snapshot to one subscription ID.
   */
  private async sendUserMatchmakingSnapshot(
    socket: WebSocket,
    subscriptionId: string,
    userId: string,
    userData: UserMatchmakingStorageData<T>,
  ): Promise<void> {
    const userMatchmakingProps = await this.buildUserMatchmakingProps(
      userId,
      userData,
    );
    this.sendUserMatchmakingUpdate(
      socket,
      subscriptionId,
      userMatchmakingProps,
    );
  }

  /**
   * Sends the latest UserMatchmaking snapshot to each active UserMatchmaking subscription.
   */
  private async sendUserMatchmakingSnapshotToSubscriptions(
    socket: WebSocket,
    userId: string,
    userData: UserMatchmakingStorageData<T>,
  ): Promise<void> {
    const userMatchmakingProps = await this.buildUserMatchmakingProps(
      userId,
      userData,
    );
    for (
      const subscriptionId of this.getUserMatchmakingSubscriptionIds(socket)
    ) {
      this.sendUserMatchmakingUpdate(
        socket,
        subscriptionId,
        userMatchmakingProps,
      );
    }
  }

  /**
   * Returns all active UserMatchmaking subscription IDs for a socket.
   */
  private getUserMatchmakingSubscriptionIds(socket: WebSocket): string[] {
    const connectionState = this.context.sockets.get(socket);
    if (connectionState == null || connectionState.userMatchmaking == null) {
      return [];
    }

    return [...connectionState.userMatchmaking.subscriptionIds];
  }
}
