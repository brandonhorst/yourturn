import type { TokenData, UserProfileViewData } from "@/types.ts";
import { userStorageDataToUserProfileViewData } from "@/server/utils.ts";
import type { UserStorageData } from "@/server/db/types.ts";
import {
  DBBase,
  getTokenKey,
  getUserByUsernameKey,
  getUserKey,
} from "@/server/db/utils.ts";

/**
 * User and auth-token persistence methods.
 */
export class UsersDB<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Rating,
  Loadout,
> extends DBBase<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Rating,
  Loadout
> {
  /**
   * Creates a new user record and username index entry if neither already exists.
   */
  public async createNewUserStorageData(
    userId: string,
    data: UserStorageData<Rating>,
  ): Promise<void> {
    const userKey = getUserKey(userId);
    const usernameKey = getUserByUsernameKey(data.username);
    const res = await this.kv.atomic()
      .check({ key: userKey, versionstamp: null })
      .check({ key: usernameKey, versionstamp: null })
      .set(userKey, data)
      .set(usernameKey, userId)
      .commit();
    if (!res.ok) {
      throw new Error(
        `User ${userId} or username ${data.username} already exists`,
      );
    }
  }

  /**
   * Upserts user storage data and keeps the username index in sync.
   */
  public async updateUserStorageData(
    userId: string,
    data: Partial<UserStorageData<Rating>>,
  ): Promise<void> {
    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const entry = await this.kv.get<UserStorageData<Rating>>(
        getUserKey(userId),
      );
      if (entry.value == null) {
        throw new Error(`Updating unstored user ${userId}`);
      }
      const existingData = entry.value;

      const updatedData: UserStorageData<Rating> = {
        ...existingData,
        ...data,
      };

      const previousUsername = existingData.username;
      const updatedUsername = updatedData.username;
      const previousUsernameEntry = await this.kv.get<string>(
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
        const updatedUsernameEntry = await this.kv.get<string>(
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
    });
  }

  /**
   * Updates canonical user profile fields that are user-editable at runtime.
   */
  public async updateUserProfile(
    userId: string,
    profile: { description?: string },
  ): Promise<void> {
    const profileUpdate: Partial<UserStorageData<Rating>> = {};
    if (profile.description !== undefined) {
      profileUpdate.description = profile.description;
    }
    if (Object.keys(profileUpdate).length === 0) {
      return;
    }

    await this.updateUserStorageData(userId, profileUpdate);
  }

  /**
   * Fetches the stored user data for a userId, if present.
   */
  public async getUserStorageData(
    userId: string,
  ): Promise<UserStorageData<Rating> | null> {
    const entry = await this.kv.get<UserStorageData<Rating>>(
      getUserKey(userId),
    );
    return entry.value;
  }

  /**
   * Fetches the canonical user profile view data for a userId, if present.
   */
  public async getUserProfileViewData(
    userId: string,
  ): Promise<UserProfileViewData<Rating> | null> {
    const userStorageData = await this.getUserStorageData(userId);
    if (userStorageData == null) {
      return null;
    }
    return userStorageDataToUserProfileViewData(userId, userStorageData);
  }

  /**
   * Watches canonical user profile updates for one user.
   */
  public watchForUserProfileChanges(
    userId: string,
  ): ReadableStream<UserProfileViewData<Rating>> {
    const userKey = getUserKey(userId);
    const stream = this.kv.watch<[UserStorageData<Rating>]>([userKey]);
    return stream.pipeThrough(
      new TransformStream({
        transform: (events, controller) => {
          const userStorageData = events[0].value;
          if (userStorageData == null) {
            return;
          }
          controller.enqueue(
            userStorageDataToUserProfileViewData(userId, userStorageData),
          );
        },
      }),
    );
  }

  /**
   * Returns whether the provided username currently exists in the username index.
   */
  public async usernameExists(username: string): Promise<boolean> {
    const entry = await this.kv.get<string>(getUserByUsernameKey(username));
    return entry.value != null;
  }

  /**
   * Persists one reconnect/auth token payload.
   */
  public async storeToken(token: string, tokenData: TokenData): Promise<void> {
    const res = await this.kv.atomic()
      .set(getTokenKey(token), tokenData)
      .commit();
    if (!res.ok) {
      throw new Error("Failed to store token");
    }
  }

  /**
   * Fetches one reconnect/auth token payload, if present.
   */
  public async getToken(token: string): Promise<TokenData | null> {
    const entry = await this.kv.get<TokenData>(getTokenKey(token));
    return entry.value ?? null;
  }
}
