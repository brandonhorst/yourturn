import type { PlayerSnapshot, UserProfileViewData } from "@/types.ts";
import type { UserStorageData } from "@/server/db/types.ts";

/**
 * Converts canonical stored user data into socket-safe user profile view data.
 */
export function userStorageDataToUserProfileViewData<Rating>(
  userId: string,
  userStorageData: UserStorageData<Rating>,
): UserProfileViewData<Rating> {
  return {
    userId,
    username: userStorageData.username,
    isGuest: userStorageData.isGuest,
    description: userStorageData.description,
    rating: structuredClone(userStorageData.ratings),
  };
}

/**
 * Converts user profile view data into a frozen player snapshot.
 */
export function userProfileViewDataToPlayerSnapshot<Rating>(
  userProfileViewData: UserProfileViewData<Rating>,
): PlayerSnapshot<Rating> {
  return {
    userId: userProfileViewData.userId,
    username: userProfileViewData.username,
    isGuest: userProfileViewData.isGuest,
    rating: structuredClone(userProfileViewData.rating),
  };
}
