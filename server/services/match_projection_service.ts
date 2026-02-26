import type {
  ActiveMatch,
  ActivePublicMatch,
  GameTypes,
  UserActiveMatch,
} from "@/types/mod.ts";
import type { DB, MatchStorageData } from "../db/mod.ts";
import type { GameStateService } from "./game_state_service.ts";

/**
 * Projects stored match metadata into public/user match views.
 */
export class MatchProjectionService<T extends GameTypes> {
  constructor(
    private readonly db: DB<T>,
    private readonly gameStateService: GameStateService<T>,
  ) {}

  /**
   * Projects active public matches with the latest public state.
   */
  async buildActivePublicMatchViews(
    activeMatches: ActiveMatch<T>[],
  ): Promise<ActivePublicMatch<T>[]> {
    const timestamp = new Date();
    const matchDataById = await this.getMatchDataById(
      activeMatches.map((activeMatch) => activeMatch.matchId),
    );
    const projectedMatches: ActivePublicMatch<T>[] = [];

    for (const activeMatch of activeMatches) {
      const gameData = matchDataById.get(activeMatch.matchId);
      if (gameData == null) {
        continue;
      }

      projectedMatches.push({
        ...activeMatch,
        publicState: this.gameStateService.getPublicState(gameData, timestamp),
      });
    }

    return projectedMatches;
  }

  /**
   * Projects user-active matches with both public and private state.
   */
  async buildUserActiveMatchViews(
    userId: string,
    activeMatches: ActiveMatch<T>[],
  ): Promise<UserActiveMatch<T>[]> {
    const timestamp = new Date();
    const matchDataById = await this.getMatchDataById(
      activeMatches.map((activeMatch) => activeMatch.matchId),
    );
    const projectedMatches: UserActiveMatch<T>[] = [];

    for (const activeMatch of activeMatches) {
      const gameData = matchDataById.get(activeMatch.matchId);
      if (gameData == null) {
        continue;
      }

      const playerId = this.gameStateService.getPlayerId(gameData, userId);
      if (playerId == null) {
        continue;
      }

      projectedMatches.push({
        ...activeMatch,
        publicState: this.gameStateService.getPublicState(gameData, timestamp),
        privateState: this.gameStateService.getPlayerState(
          gameData,
          playerId,
          timestamp,
        ),
      });
    }

    return projectedMatches;
  }

  /**
   * Loads match storage records for a set of match IDs.
   */
  private async getMatchDataById(
    matchIds: string[],
  ): Promise<Map<string, MatchStorageData<T>>> {
    const uniqueMatchIds = [...new Set(matchIds)];
    const matchEntries = await Promise.all(
      uniqueMatchIds.map(async (matchId) => {
        try {
          const gameData = await this.db.getMatchStorageData(matchId);
          return [matchId, gameData] as const;
        } catch {
          return undefined;
        }
      }),
    );

    const matchDataById = new Map<string, MatchStorageData<T>>();
    for (const matchEntry of matchEntries) {
      if (matchEntry == null) {
        continue;
      }
      matchDataById.set(matchEntry[0], matchEntry[1]);
    }

    return matchDataById;
  }
}
