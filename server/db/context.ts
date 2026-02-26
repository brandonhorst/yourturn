import { ulid } from "@std/ulid";
import type {
  AuditLogEntry,
  AuditLogEntryPayload,
  GameDefinition,
  GameTypes,
  QueueConfig,
} from "@/types/mod.ts";
import {
  PUBLIC_LIST_BATCH_SIZE,
  PUBLIC_LIST_READ_LIMIT,
  U64_MAX,
} from "./constants.ts";
import { getAuditLogEntryKey } from "./keys.ts";
import type { UserStorageData } from "./models.ts";

/**
 * Shared database helpers used by DB operation objects.
 */
export class DbContext<T extends GameTypes> {
  constructor(
    readonly kv: Deno.Kv,
    readonly game: GameDefinition<T>,
  ) {}

  /**
   * Repeats one transaction builder until commit succeeds.
   */
  async repeatUntilTransactionSucceeds(
    fn: (transaction: Deno.AtomicOperation) => void | Promise<void>,
  ): Promise<void> {
    let ok = false;
    while (!ok) {
      const transaction = this.kv.atomic();
      await fn(transaction);
      ok = (await transaction.commit()).ok;
    }
  }

  /**
   * Fetches queue configuration by queue id.
   */
  getQueueConfig(queueId: string): QueueConfig<T> {
    const queueConfig = this.game.queues[queueId];
    if (queueConfig == null) {
      throw new Error(`Queue ${queueId} not found`);
    }
    return queueConfig;
  }

  /**
   * Ensures user storage data has defaults for runtime fields.
   */
  normalizeUserStorageData(
    userStorageData: UserStorageData<T>,
  ): UserStorageData<T> {
    return {
      ...userStorageData,
      starredUserIds: userStorageData.starredUserIds ?? [],
    };
  }

  /**
   * Reads one snapshot batch for a direct-child index prefix.
   */
  async listSingleBatch<V>(
    prefix: Deno.KvKey,
  ): Promise<Deno.KvEntry<V>[]> {
    const entries = await Array.fromAsync(
      this.kv.list<V>(
        { prefix },
        {
          limit: PUBLIC_LIST_READ_LIMIT,
          batchSize: PUBLIC_LIST_BATCH_SIZE,
        },
      ),
    );
    return entries.filter((entry) => entry.key.length === prefix.length + 1);
  }

  /**
   * Mutates an indexed-list root counter by +1, 0, or -1 via a u64 sum.
   */
  mutateIndexedListRootCountOnOperation(
    transaction: Deno.AtomicOperation,
    key: Deno.KvKey,
    delta: -1 | 0 | 1,
  ): void {
    const sumValue = delta === -1 ? U64_MAX : BigInt(delta);
    transaction.mutate({
      type: "sum",
      key,
      value: new Deno.KvU64(sumValue),
    });
  }

  /**
   * Appends one audit log entry to the provided transaction.
   */
  setAuditLogEntryOnOperation(
    transaction: Deno.AtomicOperation,
    payload: AuditLogEntryPayload,
  ): void {
    const id = ulid();
    const logEntryKey = getAuditLogEntryKey(id);
    const logEntry: AuditLogEntry = { id, payload };
    transaction
      .check({ key: logEntryKey, versionstamp: null })
      .set(logEntryKey, logEntry);
  }
}
