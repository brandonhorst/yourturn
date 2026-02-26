import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ClientMessage, ServerMessage } from "../../protocol/mod.ts";
import type {
  GameTypes,
  MatchProps,
  MatchViewData,
  Socket,
} from "../../types/mod.ts";

/**
 * Subscribes to one match and returns player/observer match props.
 */
export function useMatchChannel<T extends GameTypes>(
  socket: Socket,
  matchId: string,
  initialMatchProps: MatchViewData<T>,
): MatchProps<T> {
  const playerId = initialMatchProps.playerId;
  const players = initialMatchProps.players;
  const [playerState, setPlayerState] = useState<
    T["PlayerState"] | undefined
  >(
    initialMatchProps.playerState,
  );
  const [publicState, setPublicState] = useState<T["PublicState"]>(
    initialMatchProps.publicState,
  );
  const [outcome, setOutcome] = useState<T["Outcome"] | undefined>(
    initialMatchProps.outcome,
  );
  const outcomeRef = useRef(outcome);

  outcomeRef.current = outcome;

  useEffect(() => {
    const subscriptionId = crypto.randomUUID();
    let didUnsubscribe = false;

    /**
     * Sends the match subscription request for this hook instance.
     */
    function sendSubscribe() {
      if (outcomeRef.current !== undefined || didUnsubscribe) {
        return;
      }

      const request: ClientMessage<T> = {
        type: "SubscribeMatch",
        subscriptionId,
        matchId,
      };
      socket.send(JSON.stringify(request));
    }

    /**
     * Sends a one-time unsubscribe for this hook instance.
     */
    function sendUnsubscribe() {
      if (didUnsubscribe) {
        return;
      }

      didUnsubscribe = true;
      const request: ClientMessage<T> = {
        type: "Unsubscribe",
        subscriptionId,
      };
      try {
        socket.send(JSON.stringify(request));
      } catch {
        // Ignore socket state errors during teardown.
      }
    }

    function onOpen() {
      sendSubscribe();
    }

    function onMessage(message: string) {
      const response = JSON.parse(message) as ServerMessage<T>;
      switch (response.type) {
        case "UpdateMatchState":
          if (response.subscriptionId !== subscriptionId) {
            break;
          }

          setOutcome(response.matchViewData.outcome);
          setPublicState(response.matchViewData.publicState);
          setPlayerState(response.matchViewData.playerState);
          if (response.matchViewData.outcome !== undefined) {
            sendUnsubscribe();
          }
          break;
      }
    }

    socket.addMessageListener(onMessage);
    socket.addOpenListener(onOpen);
    if (outcomeRef.current === undefined) {
      try {
        sendSubscribe();
      } catch {
        // The socket may still be connecting; subscription will be sent on open.
      }
    }

    return () => {
      sendUnsubscribe();
      socket.removeMessageListener(onMessage);
      socket.removeOpenListener(onOpen);
    };
  }, [matchId, socket]);

  const send = useCallback(
    (request: ClientMessage<T>) => {
      socket.send(JSON.stringify(request));
    },
    [socket],
  );

  const performCallback = useCallback((move: T["Move"]) => {
    const request: ClientMessage<T> = {
      type: "Move",
      matchId,
      move,
    };
    send(request);
  }, [matchId, send]);
  const perform = playerId == null ? undefined : performCallback;

  return {
    players,
    publicState,
    playerId: initialMatchProps.playerId,
    playerState,
    perform,
    outcome,
  } as MatchProps<T>;
}
