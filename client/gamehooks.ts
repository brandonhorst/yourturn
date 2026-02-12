import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type {
  GameClientMessage,
  GameServerMessage,
} from "../common/sockettypes.ts";
import type { Socket } from "../client/hookutils.ts";
import type { GameProps, GameViewProps } from "../types.ts";

// Subscribes an already-open game socket
export function useGameSocket<Move, PlayerState, PublicState, Outcome>(
  socket: Socket,
  initialGameProps: GameProps<PlayerState, PublicState, Outcome>,
): GameViewProps<Move, PlayerState, PublicState, Outcome> {
  const playerId = initialGameProps.playerId;
  const players = initialGameProps.players;
  const [chat, setChat] = useState(initialGameProps.chat);
  const [playerState, setPlayerState] = useState<PlayerState | undefined>(
    initialGameProps.playerState,
  );
  const [publicState, setPublicState] = useState<PublicState>(
    initialGameProps.publicState,
  );
  const [outcome, setOutcome] = useState<Outcome | undefined>(
    initialGameProps.outcome,
  );
  const chatRef = useRef(chat);
  const playerStateRef = useRef(playerState);
  const publicStateRef = useRef(publicState);
  const outcomeRef = useRef(outcome);

  chatRef.current = chat;
  playerStateRef.current = playerState;
  publicStateRef.current = publicState;
  outcomeRef.current = outcome;

  useEffect(() => {
    let subscribeSent = false;

    function sendSubscribe() {
      if (subscribeSent || outcomeRef.current !== undefined) {
        return;
      }

      const request: GameClientMessage<Move, PlayerState, PublicState> = {
        type: "Subscribe",
        currentPublicState: publicStateRef.current,
        currentPlayerState: playerStateRef.current,
        currentChat: chatRef.current,
      };
      socket.send(JSON.stringify(request));
      subscribeSent = true;
    }

    function onOpen() {
      sendSubscribe();
    }

    function onMessage(event: MessageEvent) {
      const response = JSON.parse(event.data) as GameServerMessage<
        PlayerState,
        PublicState,
        Outcome
      >;
      switch (response.type) {
        case "UpdateGameState":
          setOutcome(response.outcome);
          setPublicState(response.publicState);
          setPlayerState(response.playerState);
          setChat(response.chat);
          if (response.outcome !== undefined) {
            socket.close();
          }
          break;
      }
    }

    socket.addEventListener("message", onMessage);
    socket.addEventListener("open", onOpen);
    if (outcomeRef.current === undefined) {
      try {
        sendSubscribe();
      } catch {
        // The socket may still be connecting; we'll subscribe once it opens.
      }
    }

    return () => {
      socket.removeEventListener?.("message", onMessage);
      socket.removeEventListener?.("open", onOpen);
    };
  }, [socket]);

  const send = useCallback(
    (request: GameClientMessage<Move, PlayerState, PublicState>) => {
      socket.send(JSON.stringify(request));
    },
    [socket],
  );

  const performCallback = useCallback((move: Move) => {
    const request: GameClientMessage<Move, PlayerState, PublicState> = {
      type: "Move",
      move,
    };
    send(request);
  }, [send]);
  const perform = playerId == null ? undefined : performCallback;

  const sendChatMessage = useCallback((message: string) => {
    const request: GameClientMessage<Move, PlayerState, PublicState> = {
      type: "ChatMessage",
      message,
    };
    send(request);
  }, [send]);

  return {
    players: players,
    publicState: publicState,
    playerId: initialGameProps.playerId,
    playerState: playerState,
    chat,
    perform,
    sendChatMessage,
    outcome: outcome,
  } as GameViewProps<Move, PlayerState, PublicState, Outcome>;
}
