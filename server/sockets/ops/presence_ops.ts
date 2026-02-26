import { logServer, serializeLogValue } from "@/server/logging.ts";
import type {
  ActiveMatch,
  ActivePublicMatch,
  ActivePublicMatchesViewData,
  ActiveUsersViewData,
  AvailablePublicRoomsViewData,
  AvailableRoom,
  GameTypes,
  PlayerSnapshot,
  UserActiveMatch,
} from "@/types/mod.ts";
import type {
  PresenceSocketOps,
  UnsubscribeSubscription,
} from "../contracts.ts";
import type { SocketStoreContext } from "../context.ts";
import { sendServerMessage } from "../wire.ts";

const SOCKET_PRESENCE_LOG_MODULE = "server.sockets.presence";

/**
 * Active public index subscription and broadcast operations.
 */
export class SocketPresenceOps<T extends GameTypes>
  implements PresenceSocketOps<T> {
  constructor(
    private readonly context: SocketStoreContext<T>,
  ) {}

  /**
   * Subscribes one logical active public matches channel instance.
   */
  async subscribeActivePublicMatches(
    socket: WebSocket,
    subscriptionId: string,
    unsubscribeSubscription: UnsubscribeSubscription,
  ): Promise<void> {
    logServer(
      SOCKET_PRESENCE_LOG_MODULE,
      "INFO",
      `subscribeActivePublicMatches request=${
        serializeLogValue({ subscriptionId })
      }`,
    );
    await unsubscribeSubscription();

    const connectionState = this.context.getOrCreateSocketConnection(socket);
    connectionState.subscriptions.set(subscriptionId, {
      type: "ActivePublicMatches",
    });
    this.context.activePublicMatchesSubscriptions.set(subscriptionId, socket);
    await this.sendActivePublicMatchesSnapshot(socket, subscriptionId);
  }

  /**
   * Subscribes one logical active public users channel instance.
   */
  async subscribeActivePublicUsers(
    socket: WebSocket,
    subscriptionId: string,
    unsubscribeSubscription: UnsubscribeSubscription,
  ): Promise<void> {
    logServer(
      SOCKET_PRESENCE_LOG_MODULE,
      "INFO",
      `subscribeActivePublicUsers request=${
        serializeLogValue({ subscriptionId })
      }`,
    );
    await unsubscribeSubscription();

    const connectionState = this.context.getOrCreateSocketConnection(socket);
    connectionState.subscriptions.set(subscriptionId, {
      type: "ActivePublicUsers",
    });
    this.context.activePublicUsersSubscriptions.set(subscriptionId, socket);
    await this.sendActivePublicUsersSnapshot(socket, subscriptionId);
  }

  /**
   * Subscribes one logical available public rooms channel instance.
   */
  async subscribeAvailablePublicRooms(
    socket: WebSocket,
    subscriptionId: string,
    unsubscribeSubscription: UnsubscribeSubscription,
  ): Promise<void> {
    logServer(
      SOCKET_PRESENCE_LOG_MODULE,
      "INFO",
      `subscribeAvailablePublicRooms request=${
        serializeLogValue({ subscriptionId })
      }`,
    );
    await unsubscribeSubscription();

    const connectionState = this.context.getOrCreateSocketConnection(socket);
    connectionState.subscriptions.set(subscriptionId, {
      type: "AvailablePublicRooms",
    });
    this.context.availablePublicRoomsSubscriptions.set(subscriptionId, socket);
    await this.sendAvailablePublicRoomsSnapshot(socket, subscriptionId);
  }

  /**
   * Broadcasts active match list updates to all active public match subscriptions.
   */
  streamActivePublicMatchesToSockets(
    activeMatchesStream: ReadableStream<ActiveMatch<T>[]>,
  ): void {
    activeMatchesStream.pipeTo(
      new WritableStream({
        write: async (allActiveMatches: ActiveMatch<T>[]) => {
          if (this.context.activePublicMatchesSubscriptions.size === 0) {
            return;
          }
          const projectedMatches = await this.buildActivePublicMatchViews(
            allActiveMatches,
          );
          for (
            const [subscriptionId, socket] of this.context
              .activePublicMatchesSubscriptions.entries()
          ) {
            this.sendActivePublicMatchesUpdate(
              socket,
              subscriptionId,
              projectedMatches,
            );
          }
        },
      }),
    ).catch((err) => {
      logServer(
        SOCKET_PRESENCE_LOG_MODULE,
        "ERROR",
        `Failed to broadcast active match updates error=${
          serializeLogValue(err instanceof Error ? err : String(err))
        }`,
      );
    });
  }

  /**
   * Broadcasts active user list updates to all active public user subscriptions.
   */
  streamActivePublicUsersToSockets(
    activeUsersStream: ReadableStream<PlayerSnapshot<T>[]>,
  ): void {
    activeUsersStream.pipeTo(
      new WritableStream({
        write: (allActiveUsers: PlayerSnapshot<T>[]) => {
          for (
            const [subscriptionId, socket] of this.context
              .activePublicUsersSubscriptions.entries()
          ) {
            this.sendActivePublicUsersUpdate(
              socket,
              subscriptionId,
              allActiveUsers,
            );
          }
        },
      }),
    ).catch((err) => {
      logServer(
        SOCKET_PRESENCE_LOG_MODULE,
        "ERROR",
        `Failed to broadcast active user updates error=${
          serializeLogValue(err instanceof Error ? err : String(err))
        }`,
      );
    });
  }

  /**
   * Broadcasts available room list updates to all public room subscriptions.
   */
  streamAvailablePublicRoomsToSockets(
    availableRoomsStream: ReadableStream<AvailableRoom<T>[]>,
  ): void {
    availableRoomsStream.pipeTo(
      new WritableStream({
        write: (allAvailableRooms: AvailableRoom<T>[]) => {
          for (
            const [subscriptionId, socket] of this.context
              .availablePublicRoomsSubscriptions.entries()
          ) {
            this.sendAvailablePublicRoomsUpdate(
              socket,
              subscriptionId,
              allAvailableRooms,
            );
          }
        },
      }),
    ).catch((err) => {
      logServer(
        SOCKET_PRESENCE_LOG_MODULE,
        "ERROR",
        `Failed to broadcast available room updates error=${
          serializeLogValue(err instanceof Error ? err : String(err))
        }`,
      );
    });
  }

  /**
   * Projects active public matches with up-to-date public state.
   */
  buildActivePublicMatchViews(
    activeMatches: ActiveMatch<T>[],
  ): Promise<ActivePublicMatch<T>[]> {
    return this.context.requireMatchProjectionService()
      .buildActivePublicMatchViews(
        activeMatches,
      );
  }

  /**
   * Projects user-active matches with up-to-date public and private state.
   */
  buildUserActiveMatchViews(
    userId: string,
    activeMatches: ActiveMatch<T>[],
  ): Promise<UserActiveMatch<T>[]> {
    return this.context.requireMatchProjectionService()
      .buildUserActiveMatchViews(
        userId,
        activeMatches,
      );
  }

  /**
   * Sends the latest active public matches snapshot to one subscription.
   */
  private async sendActivePublicMatchesSnapshot(
    socket: WebSocket,
    subscriptionId: string,
  ): Promise<void> {
    const allActiveMatches = await this.context.db.getAllActivePublicMatches();
    const projectedMatches = await this.buildActivePublicMatchViews(
      allActiveMatches,
    );
    this.sendActivePublicMatchesUpdate(
      socket,
      subscriptionId,
      projectedMatches,
    );
  }

  /**
   * Sends one active public matches update payload to one subscription.
   */
  private sendActivePublicMatchesUpdate(
    socket: WebSocket,
    subscriptionId: string,
    allActiveMatches: ActivePublicMatch<T>[],
  ): void {
    const activePublicMatchesProps: ActivePublicMatchesViewData<T> = {
      allActiveMatches,
    };
    sendServerMessage<T>(socket, {
      type: "UpdateActivePublicMatches",
      subscriptionId,
      activePublicMatchesProps,
    });
  }

  /**
   * Sends the latest active public users snapshot to one subscription.
   */
  private async sendActivePublicUsersSnapshot(
    socket: WebSocket,
    subscriptionId: string,
  ): Promise<void> {
    const allActiveUsers = await this.context.db.getAllActivePublicUsers();
    this.sendActivePublicUsersUpdate(socket, subscriptionId, allActiveUsers);
  }

  /**
   * Sends one active public users update payload to one subscription.
   */
  private sendActivePublicUsersUpdate(
    socket: WebSocket,
    subscriptionId: string,
    allActiveUsers: PlayerSnapshot<T>[],
  ): void {
    const activePublicUsersProps: ActiveUsersViewData<T> = {
      allActiveUsers,
    };
    sendServerMessage<T>(socket, {
      type: "UpdateActivePublicUsers",
      subscriptionId,
      activePublicUsersProps,
    });
  }

  /**
   * Sends the latest available public rooms snapshot to one subscription.
   */
  private async sendAvailablePublicRoomsSnapshot(
    socket: WebSocket,
    subscriptionId: string,
  ): Promise<void> {
    const allAvailableRooms = await this.context.db
      .getAllAvailablePublicRooms();
    this.sendAvailablePublicRoomsUpdate(
      socket,
      subscriptionId,
      allAvailableRooms,
    );
  }

  /**
   * Sends one available public rooms update payload to one subscription.
   */
  private sendAvailablePublicRoomsUpdate(
    socket: WebSocket,
    subscriptionId: string,
    allAvailableRooms: AvailableRoom<T>[],
  ): void {
    const availablePublicRoomsProps: AvailablePublicRoomsViewData<T> = {
      allAvailableRooms,
    };
    sendServerMessage<T>(socket, {
      type: "UpdateAvailablePublicRooms",
      subscriptionId,
      availablePublicRoomsProps,
    });
  }
}
