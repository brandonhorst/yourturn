import { ulid } from "@std/ulid";
import { logServer, serializeLogValue } from "@/server/logging.ts";
import type { GameTypes, PlayerSnapshot } from "@/types/mod.ts";
import type { QueueSocketOps } from "../contracts.ts";
import type { SocketStoreContext } from "../context.ts";

const SOCKET_QUEUE_LOG_MODULE = "server.sockets.queue";

/**
 * Queue matchmaking action operations.
 */
export class SocketQueueOps<T extends GameTypes> implements QueueSocketOps<T> {
  constructor(
    private readonly context: SocketStoreContext<T>,
  ) {}

  /**
   * Adds a user to a queue and dispatches any immediate match assignments.
   */
  async joinQueue(
    socket: WebSocket,
    queueId: string,
    userId: string,
    playerSnapshot: PlayerSnapshot<T>,
    loadout: T["Loadout"],
    assignmentSubscriptionId?: string,
  ): Promise<void> {
    logServer(
      SOCKET_QUEUE_LOG_MODULE,
      "INFO",
      `joinQueue request=${
        serializeLogValue({
          queueId,
          userId,
          playerSnapshot,
          loadout,
          assignmentSubscriptionId,
        })
      }`,
    );
    const userMatchmakingState = this.context.getUserMatchmakingConnectionState(
      socket,
    );

    if (userMatchmakingState.queueSubscriptions.has(queueId)) {
      await this.cleanupQueueSubscription(socket, queueId, {
        removeFromDb: true,
      });
    }

    const entryId = ulid();
    const matchAssignments = await this.context.db.addToQueue(
      queueId,
      entryId,
      userId,
      playerSnapshot,
      loadout,
      assignmentSubscriptionId,
    );

    if (matchAssignments.length === 0) {
      userMatchmakingState.queueSubscriptions.set(queueId, {
        queueId,
        entryId,
      });
    } else {
      userMatchmakingState.queueSubscriptions.delete(queueId);
    }

    this.context.sendMatchAssignmentsToStoredSubscriptions(matchAssignments);
    logServer(
      SOCKET_QUEUE_LOG_MODULE,
      "INFO",
      `joinQueue result=${
        serializeLogValue({ queueId, userId, assignments: matchAssignments })
      }`,
    );
  }

  /**
   * Leaves one queue and removes its stored queue entry state.
   */
  async leaveQueue(socket: WebSocket, queueId: string): Promise<void> {
    logServer(
      SOCKET_QUEUE_LOG_MODULE,
      "INFO",
      `leaveQueue request=${serializeLogValue({ queueId })}`,
    );
    await this.cleanupQueueSubscription(socket, queueId, {
      removeFromDb: true,
    });
  }

  /**
   * Cleans up one queue subscription and optionally removes it from storage.
   */
  async cleanupQueueSubscription(
    socket: WebSocket,
    queueId: string,
    options: { removeFromDb: boolean },
  ): Promise<void> {
    const connectionState = this.context.sockets.get(socket);
    if (connectionState == null || connectionState.userMatchmaking == null) {
      return;
    }

    const userMatchmakingState = connectionState.userMatchmaking;
    const queueSubscription = userMatchmakingState.queueSubscriptions.get(
      queueId,
    );
    if (queueSubscription == null) {
      return;
    }

    if (options.removeFromDb) {
      try {
        await this.context.db.removeFromQueue(
          queueSubscription.queueId,
          queueSubscription.entryId,
        );
      } catch (err) {
        logServer(
          SOCKET_QUEUE_LOG_MODULE,
          "ERROR",
          `Failed to remove queue subscription error=${
            serializeLogValue(err instanceof Error ? err : String(err))
          }`,
        );
      }
    }

    userMatchmakingState.queueSubscriptions.delete(queueId);
  }
}
