import type { GameTypes } from "./game.ts";
import type { UserProfileViewData } from "./domain.ts";
import type {
  ActivePublicMatchesViewData,
  ActiveUsersViewData,
  AvailablePublicRoomsViewData,
  ChatThreadViewData,
  MatchViewData,
  UserMatchmakingViewData,
} from "./views.ts";

/**
 * Public server API returned by `initializeServer`.
 */
export interface Server<T extends GameTypes> {
  getUserMatchmakingViewData(
    userId: string,
  ): Promise<
    {
      props: UserMatchmakingViewData<T>;
      token: string;
    }
  >;

  getActivePublicMatchesViewData(): Promise<
    ActivePublicMatchesViewData<T>
  >;

  getActivePublicUsersViewData(): Promise<ActiveUsersViewData<T>>;

  getAvailablePublicRoomsViewData(): Promise<
    AvailablePublicRoomsViewData<T>
  >;

  getUserProfileViewData(
    userId: string,
  ): Promise<UserProfileViewData<T>>;

  getMatchViewData(
    matchId: string,
    userId: string,
  ): Promise<MatchViewData<T>>;

  getChatThreadMessages(
    chatThreadId: string,
    limit: number,
  ): Promise<ChatThreadViewData<T>>;

  configureSocket(socket: WebSocket, userId: string): void;
  resolveToken(token: string | undefined): Promise<string>;
}
