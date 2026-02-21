import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ClientMessage, ServerMessage } from "../common/sockettypes.ts";
import type { Socket } from "../client/hookutils.ts";
import type { GameProps, GameViewData } from "../types.ts";

// Subscribes to a game on an already-open socket
export function useGameSocket<Move, PlayerState, PublicState, Outcome>(
  socket: Socket,
  initialGameProps: GameViewData<PlayerState, PublicState, Outcome>,
): GameProps<Move, PlayerState, PublicState, Outcome> {
  const playerId = initialGameProps.playerId;
  const players = initialGameProps.players;
  const [playerState, setPlayerState] = useState<PlayerState | undefined>(
    initialGameProps.playerState,
  );
  const [publicState, setPublicState] = useState<PublicState>(
    initialGameProps.publicState,
  );
  const [outcome, setOutcome] = useState<Outcome | undefined>(
    initialGameProps.outcome,
  );
  const outcomeRef = useRef(outcome);

  outcomeRef.current = outcome;

  useEffect(() => {
    let subscribeSent = false;

    function sendSubscribe() {
      if (subscribeSent || outcomeRef.current !== undefined) {
        return;
      }

      const request: ClientMessage<
        never,
        never,
        Move,
        PlayerState,
        PublicState
      > = {
        type: "SubscribeGame",
      };
      socket.send(JSON.stringify(request));
      subscribeSent = true;
    }

    function onOpen() {
      sendSubscribe();
    }

    function onMessage(message: string) {
      const response = JSON.parse(message) as ServerMessage<
        never,
        never,
        never,
        PlayerState,
        PublicState,
        Outcome
      >;
      switch (response.type) {
        case "UpdateGameState":
          setOutcome(response.outcome);
          setPublicState(response.publicState);
          setPlayerState(response.playerState);
          if (response.outcome !== undefined) {
            socket.close();
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
        // The socket may still be connecting; we'll subscribe once it opens.
      }
    }

    return () => {
      const request: ClientMessage<
        never,
        never,
        Move,
        PlayerState,
        PublicState
      > = {
        type: "UnsubscribeGame",
      };
      try {
        socket.send(JSON.stringify(request));
      } catch {
        // Ignore socket state errors during teardown.
      }
      socket.removeMessageListener(onMessage);
      socket.removeOpenListener(onOpen);
    };
  }, [socket]);

  const send = useCallback(
    (
      request: ClientMessage<
        never,
        never,
        Move,
        PlayerState,
        PublicState
      >,
    ) => {
      socket.send(JSON.stringify(request));
    },
    [socket],
  );

  const performCallback = useCallback((move: Move) => {
    const request: ClientMessage<
      never,
      never,
      Move,
      PlayerState,
      PublicState
    > = {
      type: "Move",
      move,
    };
    send(request);
  }, [send]);
  const perform = playerId == null ? undefined : performCallback;

  return {
    players: players,
    publicState: publicState,
    playerId: initialGameProps.playerId,
    playerState: playerState,
    perform,
    outcome: outcome,
  } as GameProps<Move, PlayerState, PublicState, Outcome>;
}
