import { ulid } from "@std/ulid";
import {
  logServer,
  serializeLogValue,
  type ServerLogLevel,
} from "@/server/logging.ts";
import type {
  GameTypes,
  PlayerSnapshot,
  QueueConfig,
  QueueEntry,
} from "@/types/mod.ts";
import type { DbContext } from "../context.ts";
import type { MatchOps, QueueOps } from "../contracts.ts";
import {
  getQueueEntryKey,
  getQueuePrefix,
  getUserMatchmakingKey,
} from "../keys.ts";
import type {
  MatchAssignmentNotification,
  UserMatchmakingStorageData,
} from "../models.ts";

const QUEUE_OPS_LOG_MODULE = "server.db.queue";

type QueueEntryValue<T extends GameTypes> = {
  timestamp: Date;
  userId: string;
  playerSnapshot: PlayerSnapshot<T>;
  loadout: T["Loadout"];
  assignmentSubscriptionId?: string;
};

/**
 * Deno KV implementation of queue matchmaking operations.
 */
export class KvQueueOps<T extends GameTypes> implements QueueOps<T> {
  constructor(
    private readonly context: DbContext<T>,
    private readonly matchOps: MatchOps<T>,
  ) {}

  /**
   * Emits one log entry for queue DB operations.
   */
  private log(level: ServerLogLevel, message: string): void {
    logServer(QUEUE_OPS_LOG_MODULE, level, message);
  }

  /**
   * Adds one queue entry and attempts immediate queue graduation.
   */
  async addToQueue(
    queueId: string,
    entryId: string,
    userId: string,
    playerSnapshot: PlayerSnapshot<T>,
    loadout: T["Loadout"],
    assignmentSubscriptionId?: string,
  ): Promise<MatchAssignmentNotification[]> {
    this.log(
      "INFO",
      `addToQueue request=${
        serializeLogValue({
          queueId,
          entryId,
          userId,
          playerSnapshot,
          loadout,
          assignmentSubscriptionId,
        })
      }`,
    );
    const queueConfig = this.context.getQueueConfig(queueId);
    await this.context.repeatUntilTransactionSucceeds(async (transaction) => {
      const entryKey = getQueueEntryKey(queueId, entryId);
      const userMatchmakingEntry = await this.context.kv.get<
        UserMatchmakingStorageData<T>
      >(
        getUserMatchmakingKey(userId),
      );
      if (userMatchmakingEntry.value == null) {
        throw new Error(`User ${userId} not found`);
      }

      const queueEntry: QueueEntry<T> = {
        queueId,
        loadout,
      };
      const updatedUserMatchmaking: UserMatchmakingStorageData<T> = {
        ...userMatchmakingEntry.value,
        queueEntries: [...userMatchmakingEntry.value.queueEntries, queueEntry],
      };

      transaction
        .check({ key: entryKey, versionstamp: null })
        .set(entryKey, {
          timestamp: new Date(),
          userId,
          playerSnapshot,
          loadout,
          assignmentSubscriptionId,
        })
        .check(userMatchmakingEntry)
        .set(getUserMatchmakingKey(userId), updatedUserMatchmaking);
      this.context.setAuditLogEntryOnOperation(transaction, {
        type: "AddToQueue",
        userId,
        queueId,
        entryId,
      });
    });

    const assignments = await this.maybeGraduateFromQueue(
      queueId,
      queueConfig,
      userId,
    );
    this.log(
      "INFO",
      `addToQueue result=${
        serializeLogValue({ queueId, entryId, userId, assignments })
      }`,
    );
    return assignments;
  }

  /**
   * Removes one queue entry and updates user queue metadata.
   */
  async removeFromQueue(
    queueId: string,
    entryId: string,
  ): Promise<void> {
    this.log(
      "INFO",
      `removeFromQueue request=${serializeLogValue({ queueId, entryId })}`,
    );
    const entryKey = getQueueEntryKey(queueId, entryId);

    const entry = await this.context.kv.get<QueueEntryValue<T>>(entryKey);
    if (entry.value == null) {
      this.log(
        "INFO",
        `removeFromQueue noop=${serializeLogValue({ queueId, entryId })}`,
      );
      return;
    }

    const userId = entry.value.userId;

    await this.context.repeatUntilTransactionSucceeds(async (transaction) => {
      const userMatchmakingEntry = await this.context.kv.get<
        UserMatchmakingStorageData<T>
      >(
        getUserMatchmakingKey(userId),
      );
      if (userMatchmakingEntry.value == null) {
        throw new Error(`User ${userId} not found`);
      }

      const updatedQueues = userMatchmakingEntry.value.queueEntries.filter(
        (q) => q.queueId !== queueId,
      );
      const updatedUserMatchmaking: UserMatchmakingStorageData<T> = {
        ...userMatchmakingEntry.value,
        queueEntries: updatedQueues,
      };

      transaction
        .delete(entryKey)
        .check(userMatchmakingEntry)
        .set(getUserMatchmakingKey(userId), updatedUserMatchmaking);
      this.context.setAuditLogEntryOnOperation(transaction, {
        type: "RemoveFromQueue",
        userId,
        queueId,
        entryId,
      });
    });
    this.log(
      "INFO",
      `removeFromQueue completed=${
        serializeLogValue({ queueId, entryId, userId })
      }`,
    );
  }

  /**
   * Converts queued entries into a new match when enough players are waiting.
   */
  private async maybeGraduateFromQueue(
    queueId: string,
    queueConfig: QueueConfig<T>,
    userId: string,
  ): Promise<MatchAssignmentNotification[]> {
    this.log(
      "INFO",
      `maybeGraduateFromQueue request=${
        serializeLogValue({
          queueId,
          userId,
          numPlayers: queueConfig.numPlayers,
        })
      }`,
    );
    const queuePrefix = getQueuePrefix(queueId);
    let matchAssignments: MatchAssignmentNotification[] = [];

    await this.context.repeatUntilTransactionSucceeds(async (transaction) => {
      const queueEntries = await Array.fromAsync(
        this.context.kv.list<QueueEntryValue<T>>(
          { prefix: queuePrefix },
          { limit: queueConfig.numPlayers },
        ),
      );
      if (queueEntries.length < queueConfig.numPlayers) {
        matchAssignments = [];
        return;
      }

      const userIds: string[] = [];
      for (let i = 0; i < queueConfig.numPlayers; i++) {
        userIds[i] = queueEntries[i].value.userId;
      }
      const loadouts: T["Loadout"][] = [];
      const playerSnapshots: PlayerSnapshot<T>[] = [];
      for (let i = 0; i < queueConfig.numPlayers; i++) {
        loadouts[i] = queueEntries[i].value.loadout;
        playerSnapshots[i] = queueEntries[i].value.playerSnapshot;
      }
      const matchId = ulid();
      matchAssignments = queueEntries.map((entry) => ({
        matchId,
        subscriptionId: entry.value.assignmentSubscriptionId,
      }));
      await this.matchOps.createNewMatchOnOperation(
        transaction,
        {
          config: queueConfig.config,
          matchId,
          loadouts,
          playerSnapshots,
          queueId,
          userIds,
        },
      );

      const userMatchmakingKeys = userIds.map((queuedUserId) =>
        getUserMatchmakingKey(queuedUserId)
      );
      const userMatchmakingEntries = await this.context.kv.getMany<
        UserMatchmakingStorageData<T>[]
      >(userMatchmakingKeys);

      for (let i = 0; i < queueEntries.length; i++) {
        const entry = queueEntries[i];

        const userMatchmakingEntry = userMatchmakingEntries[i];
        if (userMatchmakingEntry.value == null) {
          throw new Error(`User ${userIds[i]} not found`);
        }

        const updatedQueues = userMatchmakingEntry.value.queueEntries.filter(
          (q) => q.queueId !== queueId,
        );
        const updatedUserMatchmaking: UserMatchmakingStorageData<T> = {
          ...userMatchmakingEntry.value,
          queueEntries: updatedQueues,
        };

        transaction
          .check(entry)
          .delete(entry.key)
          .check(userMatchmakingEntry)
          .set(userMatchmakingKeys[i], updatedUserMatchmaking);
      }
      this.context.setAuditLogEntryOnOperation(transaction, {
        type: "GraduateQueue",
        userId,
        queueId,
        matchId,
      });
    });

    this.log(
      "INFO",
      `maybeGraduateFromQueue result=${
        serializeLogValue({ queueId, userId, matchAssignments })
      }`,
    );
    return matchAssignments;
  }
}
