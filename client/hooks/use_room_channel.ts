import { useCallback, useEffect, useState } from "preact/hooks";
import type { ClientMessage, ServerMessage } from "../../protocol/mod.ts";
import type {
  GameTypes,
  RoomEntry,
  RoomProps,
  Socket,
} from "../../types/mod.ts";

/**
 * Subscribes to one joined room and exposes room lifecycle actions.
 */
export function useRoomChannel<T extends GameTypes>({
  socket,
  roomId,
  initialRoomEntry,
  navigate,
  displayError,
}: {
  socket: Socket;
  roomId: string;
  initialRoomEntry: RoomEntry<T>;
  navigate: (matchId: string) => void;
  displayError: (message: string) => void;
}): RoomProps<T> {
  const [roomEntry, setRoomEntry] = useState<RoomEntry<T>>(
    initialRoomEntry,
  );

  useEffect(() => {
    setRoomEntry(initialRoomEntry);
  }, [initialRoomEntry]);

  useEffect(() => {
    const subscriptionId = crypto.randomUUID();

    /**
     * Sends one room subscribe request for this hook instance.
     */
    function sendSubscribe() {
      const request: ClientMessage<T> = {
        type: "SubscribeRoom",
        subscriptionId,
        roomId,
      };
      socket.send(JSON.stringify(request));
    }

    function onOpen() {
      sendSubscribe();
    }

    function onMessage(message: string) {
      const response = JSON.parse(message) as ServerMessage<T>;

      switch (response.type) {
        case "UpdateRoomEntry":
          if (response.subscriptionId !== subscriptionId) {
            break;
          }

          setRoomEntry(response.roomEntry);
          break;
        case "RemoveRoomEntry":
          if (response.subscriptionId !== subscriptionId) {
            break;
          }

          // Keep the last room snapshot in state; room UI teardown is caller-controlled.
          break;
        case "MatchAssignment":
          if (response.subscriptionId !== subscriptionId) {
            break;
          }

          navigate(response.matchId);
          break;
        case "DisplayError":
          displayError(response.message);
          break;
      }
    }

    socket.addMessageListener(onMessage);
    socket.addOpenListener(onOpen);
    try {
      sendSubscribe();
    } catch {
      // The socket may still be connecting; subscription will be sent on open.
    }

    return () => {
      const request: ClientMessage<T> = {
        type: "Unsubscribe",
        subscriptionId,
      };
      try {
        socket.send(JSON.stringify(request));
      } catch {
        // Ignore socket state errors during teardown.
      }
      socket.removeMessageListener(onMessage);
      socket.removeOpenListener(onOpen);
    };
  }, [displayError, navigate, roomId, socket]);

  const send = useCallback(
    (request: ClientMessage<T>) => {
      socket.send(JSON.stringify(request));
    },
    [socket],
  );

  const commitRoom = useCallback(() => {
    send({ type: "CommitRoom", roomId });
  }, [roomId, send]);

  const leaveRoom = useCallback(() => {
    send({ type: "LeaveRoom", roomId });
  }, [roomId, send]);

  return {
    roomId: roomEntry.roomId,
    numPlayers: roomEntry.numPlayers,
    players: roomEntry.players,
    config: roomEntry.config,
    loadout: roomEntry.loadout,
    commitRoom,
    leaveRoom,
  };
}
