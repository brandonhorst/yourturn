import type { ServerMessage } from "@/protocol/mod.ts";
import type { GameTypes, MatchViewData, PlayerSnapshot } from "@/types/mod.ts";
import { logServer, serializeLogValue } from "../logging.ts";

const SOCKET_WIRE_LOG_MODULE = "server.socket";

/**
 * Serializes and sends one server message over a websocket, with debug logs.
 */
export function sendServerMessage<
  T extends GameTypes,
>(
  socket: WebSocket,
  message: ServerMessage<T>,
): void {
  logServer(
    SOCKET_WIRE_LOG_MODULE,
    "INFO",
    `Socket outbound message payload=${
      serializeLogValue({ type: message.type, message })
    }`,
  );
  socket.send(JSON.stringify(message));
}

/**
 * Cancels and unlocks a stream reader.
 */
export function closeReader<T>(reader: ReadableStreamDefaultReader<T>): void {
  let cancellation: Promise<void> | undefined;
  try {
    cancellation = reader.cancel();
  } catch {
    // Reader may already be closed.
  }
  if (cancellation != null) {
    void cancellation.catch(() => {
      // Reader may already be closed or detached.
    });
  }
  try {
    reader.releaseLock();
  } catch {
    // Reader may already have released its lock.
  }
}

/**
 * Creates a strongly-typed match view payload for one subscriber update.
 */
export function buildMatchViewData<T extends GameTypes>(
  chatThreadId: string,
  players: PlayerSnapshot<T>[],
  playerId: number | undefined,
  gameStateUpdate: {
    playerState: T["PlayerState"] | undefined;
    publicState: T["PublicState"];
    outcome: T["Outcome"] | undefined;
  },
): MatchViewData<T> {
  if (playerId == null) {
    if (gameStateUpdate.outcome === undefined) {
      return {
        chatThreadId,
        players,
        playerId: undefined,
        playerState: undefined,
        publicState: gameStateUpdate.publicState,
        outcome: undefined,
      };
    }

    return {
      chatThreadId,
      players,
      playerId: undefined,
      playerState: undefined,
      publicState: gameStateUpdate.publicState,
      outcome: gameStateUpdate.outcome,
    };
  }

  if (gameStateUpdate.playerState == null) {
    throw new Error(
      `Missing player state for subscribed player ${playerId}`,
    );
  }

  if (gameStateUpdate.outcome === undefined) {
    return {
      chatThreadId,
      players,
      playerId,
      playerState: gameStateUpdate.playerState,
      publicState: gameStateUpdate.publicState,
      outcome: undefined,
    };
  }

  return {
    chatThreadId,
    players,
    playerId,
    playerState: gameStateUpdate.playerState,
    publicState: gameStateUpdate.publicState,
    outcome: gameStateUpdate.outcome,
  };
}
