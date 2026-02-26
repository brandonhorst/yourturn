import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ClientMessage, ServerMessage } from "@/protocol/mod.ts";
import type {
  GameTypes,
  Socket,
  UserMatchmakingProps,
  UserMatchmakingViewData,
} from "@/types/mod.ts";

/**
 * Subscribes to the user's matchmaking channel and exposes queue/room actions.
 */
export function useUserMatchmakingChannel<T extends GameTypes>({
  socket,
  initialUserMatchmakingProps,
  navigate,
  displayError,
}: {
  socket: Socket;
  initialUserMatchmakingProps: UserMatchmakingViewData<T>;
  navigate: (matchId: string) => void;
  displayError: (message: string) => void;
}): UserMatchmakingProps<T> {
  const [userActiveMatches, setUserActiveMatches] = useState(
    initialUserMatchmakingProps.userActiveMatches,
  );
  const [roomIds, setRoomIds] = useState(
    initialUserMatchmakingProps.roomIds,
  );
  const [queueEntries, setQueueEntries] = useState(
    initialUserMatchmakingProps.queueEntries,
  );
  const subscriptionIdRef = useRef<string>(crypto.randomUUID());
  const subscriptionId = subscriptionIdRef.current;

  useEffect(() => {
    /**
     * Sends the user-matchmaking subscribe request for this hook instance.
     */
    function sendSubscribe() {
      const request: ClientMessage<T> = {
        type: "SubscribeUserMatchmaking",
        subscriptionId,
      };
      socket.send(JSON.stringify(request));
    }

    function onOpen() {
      sendSubscribe();
    }

    function onMessage(message: string) {
      const response = JSON.parse(message) as ServerMessage<T>;
      switch (response.type) {
        case "UpdateUserMatchmakingProps":
          if (response.subscriptionId !== subscriptionId) {
            break;
          }

          setUserActiveMatches(response.userMatchmakingProps.userActiveMatches);
          setRoomIds(response.userMatchmakingProps.roomIds);
          setQueueEntries(response.userMatchmakingProps.queueEntries);
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
  }, [displayError, navigate, socket, subscriptionId]);

  const send = useCallback(
    (request: ClientMessage<T>) => {
      socket.send(JSON.stringify(request));
    },
    [socket],
  );

  const joinQueue = useCallback(
    (queueId: string, options: { loadout: T["Loadout"] }) => {
      send({
        type: "JoinQueue",
        queueId,
        loadout: options.loadout,
        assignmentSubscriptionId: subscriptionId,
      });
    },
    [send, subscriptionId],
  );

  const createAndJoinRoom = useCallback(
    (
      options: {
        config: T["Config"];
        numPlayers: number;
        private: boolean;
      },
      player: { loadout: T["Loadout"] },
    ) => {
      send({
        type: "CreateAndJoinRoom",
        config: options.config,
        numPlayers: options.numPlayers,
        private: options.private,
        loadout: player.loadout,
        assignmentSubscriptionId: subscriptionId,
      });
    },
    [send, subscriptionId],
  );

  const joinRoom = useCallback(
    (roomId: string, options: { loadout: T["Loadout"] }) => {
      send({
        type: "JoinRoom",
        roomId,
        loadout: options.loadout,
        assignmentSubscriptionId: subscriptionId,
      });
    },
    [send, subscriptionId],
  );

  const leaveQueue = useCallback((queueId: string) => {
    send({ type: "LeaveQueue", queueId });
  }, [send]);

  return {
    userActiveMatches,
    roomIds,
    queueEntries,
    joinQueue,
    createAndJoinRoom,
    joinRoom,
    leaveQueue,
  };
}
