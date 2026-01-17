import { useCallback, useState } from "preact/hooks";
import { useSocket } from "../client/hookutils.ts";
import type { GameSocketRequest, GameSocketResponse } from "../common/types.ts";
import type { GameProps, GameViewProps } from "../types.ts";

// Opens an auto-reconnecting WebSocket to a given Game URL.
// Returns an always up-to-date view of the game and optionally a move handler.
// Closes the socket if the game completes.
export function useGameSocket<Move, PlayerState, PublicState>(
  socketUrl: string,
  initialGameProps: GameProps<PlayerState, PublicState>,
): GameViewProps<Move, PlayerState, PublicState> {
  const isPlayer = initialGameProps.mode === "player";
  const [playerState, setPlayerState] = useState<PlayerState | undefined>(
    isPlayer ? initialGameProps.playerState : undefined,
  );
  const [publicState, setPublicState] = useState<PublicState>(
    initialGameProps.publicState,
  );
  const [isComplete, setIsComplete] = useState<boolean>(
    initialGameProps.isComplete,
  );
  const players = initialGameProps.players;

  function onMessage(
    response: GameSocketResponse<PlayerState, PublicState>,
    close: () => void,
  ) {
    switch (response.type) {
      case "MarkComplete":
        setIsComplete(true);
        close();
        break;
      case "UpdateGameState":
        if (response.mode === "player") {
          setPlayerState(response.playerState);
          setPublicState(response.publicState);
        } else {
          setPublicState(response.publicState);
        }
        break;
    }
  }

  const send = useSocket<
    GameSocketRequest<Move, PlayerState, PublicState>,
    GameSocketResponse<PlayerState, PublicState>
  >(
    !initialGameProps.isComplete,
    () => new WebSocket(socketUrl),
    isPlayer
      ? {
        type: "InitializePlayer",
        currentPlayerState: playerState as PlayerState,
        currentPublicState: publicState as PublicState,
      }
      : {
        type: "InitializeObserver",
        currentPublicState: publicState as PublicState,
      },
    onMessage,
  );

  const perform = useCallback((move: Move) => {
    const request: GameSocketRequest<Move, PlayerState, PublicState> = {
      type: "Move",
      move,
    };
    send(request);
  }, [send]);

  if (isPlayer && playerState != null) {
    if (isComplete) {
      return {
        mode: "player",
        playerId: initialGameProps.playerId,
        playerState,
        publicState,
        perform: undefined,
        isComplete,
        players,
      };
    } else {
      return {
        mode: "player",
        playerId: initialGameProps.playerId,
        playerState,
        publicState,
        perform,
        isComplete,
        players,
      };
    }
  } else {
    return {
      mode: "observer",
      publicState,
      isComplete,
      players,
      playerId: undefined,
    };
  }
}
