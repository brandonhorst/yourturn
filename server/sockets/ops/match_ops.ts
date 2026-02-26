import type { MatchStorageData } from "@/server/db/mod.ts";
import { logServer, serializeLogValue } from "@/server/logging.ts";
import type { GameTypes } from "@/types/mod.ts";
import type { MatchSocketOps, UnsubscribeSubscription } from "../contracts.ts";
import type { SocketStoreContext } from "../context.ts";
import { buildMatchViewData, closeReader, sendServerMessage } from "../wire.ts";

const SOCKET_MATCH_LOG_MODULE = "server.sockets.match";

/**
 * Match channel subscription and stream fan-out operations.
 */
export class SocketMatchOps<T extends GameTypes> implements MatchSocketOps<T> {
  constructor(
    private readonly context: SocketStoreContext<T>,
  ) {}

  /**
   * Subscribes one logical match channel instance on a websocket.
   */
  async subscribeMatch(
    socket: WebSocket,
    subscriptionId: string,
    matchId: string,
    unsubscribeSubscription: UnsubscribeSubscription,
    playerId?: number,
  ): Promise<void> {
    logServer(
      SOCKET_MATCH_LOG_MODULE,
      "INFO",
      `subscribeMatch request=${
        serializeLogValue({ subscriptionId, matchId, playerId })
      }`,
    );
    await unsubscribeSubscription();

    const gameStateService = this.context.requireGameStateService();
    const connectionState = this.context.getOrCreateSocketConnection(socket);

    if (!this.context.matchConnections.has(matchId)) {
      this.createMatchConnection(matchId);
    }

    const matchConnection = this.context.matchConnections.get(matchId);
    if (matchConnection == null) {
      throw new Error(`Match connection ${matchId} not found`);
    }

    matchConnection.matchSubscriptions.set(subscriptionId, {
      subscriptionId,
      socket,
      playerId,
    });
    connectionState.subscriptions.set(subscriptionId, {
      type: "Match",
      matchId,
    });

    const gameData = await this.context.db.getMatchStorageData(matchId);
    const gameStateUpdate = gameStateService.buildGameStateUpdate(
      gameData,
      playerId,
    );

    sendServerMessage<T>(socket, {
      type: "UpdateMatchState",
      subscriptionId,
      matchViewData: buildMatchViewData(
        gameData.chatThreadId,
        gameData.players,
        playerId,
        gameStateUpdate,
      ),
    });
    logServer(
      SOCKET_MATCH_LOG_MODULE,
      "INFO",
      `subscribeMatch sent initial state=${
        serializeLogValue({ subscriptionId, matchId, playerId })
      }`,
    );
  }

  /**
   * Removes one match subscription from its match stream.
   */
  unsubscribeMatchSubscription(
    subscriptionId: string,
    matchId: string,
  ): void {
    const matchConnection = this.context.matchConnections.get(matchId);
    if (matchConnection == null) {
      return;
    }

    const wasRemoved = matchConnection.matchSubscriptions.delete(
      subscriptionId,
    );
    if (!wasRemoved) {
      return;
    }

    if (matchConnection.matchSubscriptions.size === 0) {
      closeReader(matchConnection.changesReader);
      this.context.matchConnections.delete(matchId);
    }
  }

  /**
   * Creates and registers one match connection stream.
   */
  private createMatchConnection(
    matchId: string,
  ): void {
    const changesReader = this.context.db.watchForMatchChanges(matchId)
      .getReader();

    this.context.matchConnections.set(matchId, {
      matchSubscriptions: new Map(),
      changesReader,
    });

    void this.streamMatchChangesToSockets(matchId, changesReader);
  }

  /**
   * Streams one match channel's updates to all subscribed sockets.
   */
  private async streamMatchChangesToSockets(
    matchId: string,
    changesReader: ReadableStreamDefaultReader<
      MatchStorageData<T>
    >,
  ): Promise<void> {
    const gameStateService = this.context.requireGameStateService();
    try {
      while (true) {
        const data = await changesReader.read();
        if (data.done) {
          break;
        }

        const matchConnection = this.context.matchConnections.get(matchId);
        if (matchConnection == null) {
          break;
        }

        const gameData = data.value;
        const timestamp = new Date();

        const nextPublicState = gameStateService.getPublicState(
          gameData,
          timestamp,
        );

        for (
          const gameSubscription of matchConnection.matchSubscriptions.values()
        ) {
          const gameStateUpdate = gameStateService.buildGameStateUpdate(
            gameData,
            gameSubscription.playerId,
            {
              timestamp,
              publicState: nextPublicState,
            },
          );

          sendServerMessage<T>(
            gameSubscription.socket,
            {
              type: "UpdateMatchState",
              subscriptionId: gameSubscription.subscriptionId,
              matchViewData: buildMatchViewData(
                gameData.chatThreadId,
                gameData.players,
                gameSubscription.playerId,
                gameStateUpdate,
              ),
            },
          );
        }
      }
    } catch {
      // Reader cancellation is expected during unsubscribe.
    }
  }
}
