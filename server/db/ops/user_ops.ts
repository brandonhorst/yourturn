import {
  logServer,
  serializeLogValue,
  type ServerLogLevel,
} from "@/server/logging.ts";
import type {
  CompletedMatchSnapshot,
  GameTypes,
  UserProfileViewData,
} from "@/types/mod.ts";
import {
  USER_COMPLETED_MATCHES_BATCH_SIZE,
  USER_COMPLETED_MATCHES_READ_LIMIT,
} from "../constants.ts";
import type { DbContext } from "../context.ts";
import type { UserOps } from "../contracts.ts";
import {
  getUserByUsernameKey,
  getUserCompletedMatchesKey,
  getUserKey,
} from "../keys.ts";
import {
  type UserStorageData,
  userStorageDataToUserProfileViewData,
} from "../models.ts";

const USER_OPS_LOG_MODULE = "server.db.user";

/**
 * Deno KV implementation of user profile and identity operations.
 */
export class KvUserOps<T extends GameTypes> implements UserOps<T> {
  constructor(
    private readonly context: DbContext<T>,
  ) {}

  /**
   * Emits one log entry for user DB operations.
   */
  private log(level: ServerLogLevel, message: string): void {
    logServer(USER_OPS_LOG_MODULE, level, message);
  }

  /**
   * Creates one new user record and username index entry.
   */
  async createNewUserStorageData(
    userId: string,
    data: UserStorageData<T>,
  ): Promise<void> {
    const normalizedData = this.context.normalizeUserStorageData(data);
    this.log(
      "INFO",
      `createNewUserStorageData request=${
        serializeLogValue({ userId, data: normalizedData })
      }`,
    );
    const userKey = getUserKey(userId);
    const usernameKey = getUserByUsernameKey(normalizedData.username);
    const transaction = this.context.kv.atomic()
      .check({ key: userKey, versionstamp: null })
      .check({ key: usernameKey, versionstamp: null })
      .set(userKey, normalizedData)
      .set(usernameKey, userId);
    this.context.setAuditLogEntryOnOperation(transaction, {
      type: "CreateNewUserStorageData",
      userId,
      username: normalizedData.username,
      isGuest: normalizedData.isGuest,
    });
    const res = await transaction.commit();
    if (!res.ok) {
      throw new Error(
        `User ${userId} or username ${normalizedData.username} already exists`,
      );
    }
    this.log(
      "INFO",
      `createNewUserStorageData completed=${
        serializeLogValue({ userId, username: normalizedData.username })
      }`,
    );
  }

  /**
   * Upserts user storage data while keeping username index consistent.
   */
  async updateUserStorageData(
    userId: string,
    data: Partial<UserStorageData<T>>,
    options?: { actorUserId?: string },
  ): Promise<void> {
    this.log(
      "INFO",
      `updateUserStorageData request=${
        serializeLogValue({ userId, data, options })
      }`,
    );
    const actorUserId = options?.actorUserId ?? userId;
    await this.context.repeatUntilTransactionSucceeds(async (transaction) => {
      const entry = await this.context.kv.get<UserStorageData<T>>(
        getUserKey(userId),
      );
      if (entry.value == null) {
        throw new Error(`Updating unstored user ${userId}`);
      }
      const existingData = this.context.normalizeUserStorageData(entry.value);

      const updatedData = this.context.normalizeUserStorageData({
        ...existingData,
        ...data,
      });

      const previousUsername = existingData.username;
      const updatedUsername = updatedData.username;
      const previousUsernameEntry = await this.context.kv.get<string>(
        getUserByUsernameKey(previousUsername),
      );
      if (previousUsernameEntry.value !== userId) {
        throw new Error(
          `Username index for ${previousUsername} is not owned by ${userId}`,
        );
      }

      transaction
        .check(entry)
        .set(getUserKey(userId), updatedData);

      if (previousUsername !== updatedUsername) {
        const updatedUsernameEntry = await this.context.kv.get<string>(
          getUserByUsernameKey(updatedUsername),
        );
        if (
          updatedUsernameEntry.value != null &&
          updatedUsernameEntry.value !== userId
        ) {
          throw new Error(`Username ${updatedUsername} already exists`);
        }

        transaction
          .check(previousUsernameEntry)
          .check(updatedUsernameEntry)
          .delete(getUserByUsernameKey(previousUsername))
          .set(getUserByUsernameKey(updatedUsername), userId);
      } else {
        transaction
          .check(previousUsernameEntry)
          .set(getUserByUsernameKey(previousUsername), userId);
      }
      this.context.setAuditLogEntryOnOperation(transaction, {
        type: "UpdateUserStorageData",
        userId: actorUserId,
      });
    });
    this.log(
      "INFO",
      `updateUserStorageData completed=${
        serializeLogValue({ userId, actorUserId })
      }`,
    );
  }

  /**
   * Updates mutable profile fields exposed to account users.
   */
  async updateUserProfile(
    userId: string,
    profile: {
      description?: string;
      starUserId?: string;
      unstarUserId?: string;
    },
  ): Promise<void> {
    this.log(
      "INFO",
      `updateUserProfile request=${serializeLogValue({ userId, profile })}`,
    );
    if (
      profile.description === undefined &&
      profile.starUserId === undefined &&
      profile.unstarUserId === undefined
    ) {
      this.log(
        "INFO",
        `updateUserProfile noop=${serializeLogValue({ userId })}`,
      );
      return;
    }

    await this.context.repeatUntilTransactionSucceeds(async (transaction) => {
      const userKey = getUserKey(userId);
      const userEntry = await this.context.kv.get<UserStorageData<T>>(userKey);
      if (userEntry.value == null) {
        throw new Error(`Updating unstored user ${userId}`);
      }
      const existingUser = this.context.normalizeUserStorageData(
        userEntry.value,
      );

      const nextStarredUserIds = [...existingUser.starredUserIds];
      if (profile.starUserId !== undefined) {
        if (nextStarredUserIds.includes(profile.starUserId)) {
          throw new Error("User already starred.");
        }
        nextStarredUserIds.push(profile.starUserId);
      }

      let updatedStarredUserIds = nextStarredUserIds;
      if (profile.unstarUserId !== undefined) {
        updatedStarredUserIds = nextStarredUserIds.filter((starredUserId) =>
          starredUserId !== profile.unstarUserId
        );
      }

      const updatedUser = this.context.normalizeUserStorageData({
        ...existingUser,
        description: profile.description ?? existingUser.description,
        starredUserIds: updatedStarredUserIds,
      });

      const usernameKey = getUserByUsernameKey(existingUser.username);
      const usernameEntry = await this.context.kv.get<string>(usernameKey);
      if (usernameEntry.value !== userId) {
        throw new Error(
          `Username index for ${existingUser.username} is not owned by ${userId}`,
        );
      }

      transaction
        .check(userEntry)
        .check(usernameEntry)
        .set(userKey, updatedUser)
        .set(usernameKey, userId);
      this.context.setAuditLogEntryOnOperation(transaction, {
        type: "UpdateUserStorageData",
        userId,
      });
    });

    this.log(
      "INFO",
      `updateUserProfile completed=${serializeLogValue({ userId })}`,
    );
  }

  /**
   * Fetches canonical user storage data by id.
   */
  async getUserStorageData(
    userId: string,
  ): Promise<UserStorageData<T> | null> {
    this.log(
      "INFO",
      `getUserStorageData request=${serializeLogValue({ userId })}`,
    );
    const entry = await this.context.kv.get<UserStorageData<T>>(
      getUserKey(userId),
    );
    const userData = entry.value == null
      ? null
      : this.context.normalizeUserStorageData(entry.value);
    this.log(
      "INFO",
      `getUserStorageData response=${
        serializeLogValue({ userId, user: userData })
      }`,
    );
    return userData;
  }

  /**
   * Fetches projected user profile view data.
   */
  async getUserProfileViewData(
    userId: string,
  ): Promise<UserProfileViewData<T> | null> {
    this.log(
      "INFO",
      `getUserProfileViewData request=${serializeLogValue({ userId })}`,
    );
    const userStorageData = await this.getUserStorageData(userId);
    if (userStorageData == null) {
      this.log(
        "INFO",
        `getUserProfileViewData response=${
          serializeLogValue({ userId, userProfile: null })
        }`,
      );
      return null;
    }
    const completedMatches = await this.getUserCompletedMatches(userId);
    const userProfile = userStorageDataToUserProfileViewData(
      userId,
      userStorageData,
      completedMatches,
    );
    this.log(
      "INFO",
      `getUserProfileViewData response=${
        serializeLogValue({ userId, userProfile })
      }`,
    );
    return userProfile;
  }

  /**
   * Watches user storage and completed history for one user profile.
   */
  watchForUserProfileChanges(
    userId: string,
  ): ReadableStream<UserProfileViewData<T>> {
    this.log(
      "INFO",
      `watchForUserProfileChanges request=${serializeLogValue({ userId })}`,
    );
    const userKey = getUserKey(userId);
    const completedMatchesKey = getUserCompletedMatchesKey(userId);
    const stream = this.context.kv.watch<[UserStorageData<T>, Deno.KvU64]>([
      userKey,
      completedMatchesKey,
    ]);
    return stream.pipeThrough(
      new TransformStream({
        transform: async (_events, controller) => {
          const userProfile = await this.getUserProfileViewData(userId);
          if (userProfile == null) {
            return;
          }
          controller.enqueue(userProfile);
        },
      }),
    );
  }

  /**
   * Checks whether a username already has an index entry.
   */
  async usernameExists(username: string): Promise<boolean> {
    this.log(
      "INFO",
      `usernameExists request=${serializeLogValue({ username })}`,
    );
    const entry = await this.context.kv.get<string>(
      getUserByUsernameKey(username),
    );
    const exists = entry.value != null;
    this.log(
      "INFO",
      `usernameExists response=${serializeLogValue({ username, exists })}`,
    );
    return exists;
  }

  /**
   * Fetches one user's completed matches in reverse chronological order.
   */
  private async getUserCompletedMatches(
    userId: string,
  ): Promise<CompletedMatchSnapshot<T>[]> {
    const completedMatchesKey = getUserCompletedMatchesKey(userId);
    const completedMatchEntries = await Array.fromAsync(
      this.context.kv.list<CompletedMatchSnapshot<T>>(
        { prefix: completedMatchesKey },
        {
          limit: USER_COMPLETED_MATCHES_READ_LIMIT,
          batchSize: USER_COMPLETED_MATCHES_BATCH_SIZE,
          reverse: true,
        },
      ),
    );

    return completedMatchEntries
      .filter((entry) => entry.key.length === completedMatchesKey.length + 1)
      .map((entry) => entry.value);
  }
}
