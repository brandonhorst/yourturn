import { logServer, serializeLogValue } from "@/server/logging.ts";
import type { GameTypes, UserProfileViewData } from "@/types/mod.ts";
import type { UnsubscribeSubscription, UserSocketOps } from "../contracts.ts";
import type { SocketStoreContext } from "../context.ts";
import { closeReader, sendServerMessage } from "../wire.ts";

const SOCKET_USER_LOG_MODULE = "server.sockets.user";

/**
 * Account user profile channel operations.
 */
export class SocketUserOps<T extends GameTypes> implements UserSocketOps<T> {
  constructor(
    private readonly context: SocketStoreContext<T>,
  ) {}

  /**
   * Subscribes one logical AccountUserProfile channel instance on a websocket.
   */
  async subscribeAccountUserProfile(
    socket: WebSocket,
    subscriptionId: string,
    userId: string,
    userProfile: UserProfileViewData<T>,
    unsubscribeSubscription: UnsubscribeSubscription,
  ): Promise<void> {
    logServer(
      SOCKET_USER_LOG_MODULE,
      "INFO",
      `subscribeAccountUserProfile request=${
        serializeLogValue({ subscriptionId, userId, userProfile })
      }`,
    );
    await unsubscribeSubscription();

    const connectionState = this.context.getOrCreateSocketConnection(socket);
    let accountUserProfileConnection = connectionState
      .accountUserProfileConnections.get(
        userId,
      );

    if (accountUserProfileConnection == null) {
      const userChangesReader = this.context.db.watchForUserProfileChanges(
        userId,
      )
        .getReader();
      accountUserProfileConnection = {
        userId,
        subscriptionIds: new Set(),
        userChangesReader,
      };
      connectionState.accountUserProfileConnections.set(
        userId,
        accountUserProfileConnection,
      );
      void this.streamAccountUserProfileChangesToSocket(
        socket,
        userId,
        userChangesReader,
      );
    }

    accountUserProfileConnection.subscriptionIds.add(subscriptionId);
    connectionState.subscriptions.set(subscriptionId, {
      type: "AccountUserProfile",
      userId,
    });

    this.sendAccountUserProfileSnapshot(socket, subscriptionId, userProfile);
  }

  /**
   * Unsubscribes one AccountUserProfile subscription and tears down account
   * profile streams when last.
   */
  unsubscribeAccountUserProfileSubscription(
    socket: WebSocket,
    subscriptionId: string,
    userId: string,
  ): void {
    const connectionState = this.context.sockets.get(socket);
    if (connectionState == null) {
      return;
    }
    const accountUserProfileConnection = connectionState
      .accountUserProfileConnections.get(
        userId,
      );
    if (accountUserProfileConnection == null) {
      return;
    }

    accountUserProfileConnection.subscriptionIds.delete(subscriptionId);
    if (accountUserProfileConnection.subscriptionIds.size > 0) {
      return;
    }

    closeReader(accountUserProfileConnection.userChangesReader);
    connectionState.accountUserProfileConnections.delete(userId);
  }

  /**
   * Streams AccountUserProfile updates for one websocket and target user.
   */
  private async streamAccountUserProfileChangesToSocket(
    socket: WebSocket,
    userId: string,
    userChangesReader: ReadableStreamDefaultReader<
      UserProfileViewData<T>
    >,
  ): Promise<void> {
    try {
      while (true) {
        const data = await userChangesReader.read();
        if (data.done) {
          break;
        }

        this.sendAccountUserProfileSnapshotToSubscriptions(
          socket,
          userId,
          data.value,
        );
      }
    } catch {
      // Reader cancellation is expected during unsubscribe.
    } finally {
      closeReader(userChangesReader);
    }
  }

  /**
   * Sends one full AccountUserProfile snapshot to one subscription ID.
   */
  private sendAccountUserProfileSnapshot(
    socket: WebSocket,
    subscriptionId: string,
    userProfile: UserProfileViewData<T>,
  ): void {
    sendServerMessage<T>(socket, {
      type: "UpdateAccountUserProfileProps",
      subscriptionId,
      accountUserProfileProps: userProfile,
    });
  }

  /**
   * Sends the latest account profile snapshot to each active
   * AccountUserProfile subscription for a user.
   */
  private sendAccountUserProfileSnapshotToSubscriptions(
    socket: WebSocket,
    userId: string,
    userProfile: UserProfileViewData<T>,
  ): void {
    for (
      const subscriptionId of this.getAccountUserProfileSubscriptionIds(
        socket,
        userId,
      )
    ) {
      this.sendAccountUserProfileSnapshot(socket, subscriptionId, userProfile);
    }
  }

  /**
   * Returns all active AccountUserProfile subscription IDs for one socket and
   * user.
   */
  private getAccountUserProfileSubscriptionIds(
    socket: WebSocket,
    userId: string,
  ): string[] {
    const connectionState = this.context.sockets.get(socket);
    if (connectionState == null) {
      return [];
    }
    const accountUserProfileConnection = connectionState
      .accountUserProfileConnections.get(userId);
    if (accountUserProfileConnection == null) {
      return [];
    }
    return [...accountUserProfileConnection.subscriptionIds];
  }
}
