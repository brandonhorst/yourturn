import { useCallback, useState } from "preact/hooks";
import { useSocket } from "../client/hookutils.ts";
import type { GameSocketRequest, GameSocketResponse } from "../common/types.ts";
import type {
  ObserverProps,
  ObserveViewProps,
  PlayerProps,
  PlayerViewProps,
} from "../types.ts";

type GameProps<PlayerState, ObserverState> =
  | PlayerProps<PlayerState>
  | ObserverProps<ObserverState>;

type GameViewProps<Move, PlayerState, ObserverState> =
  | PlayerViewProps<Move, PlayerState>
  | ObserveViewProps<ObserverState>;

// Opens an auto-reconnecting WebSocket to a given Game URL.
// Returns an always up-to-date view of the game and optionally a move handler.
// Closes the socket if the game completes.
export function useGameSocket<Move, PlayerState, ObserverState>(
  socketUrl: string,
  initialGameProps: GameProps<PlayerState, ObserverState>,
): GameViewProps<Move, PlayerState, ObserverState> {
  const isPlayer = initialGameProps.mode === "player";
  const [playerState, setPlayerState] = useState<PlayerState | undefined>(
    isPlayer ? initialGameProps.playerState : undefined,
  );
  const [observerState, setObserverState] = useState<ObserverState | undefined>(
    isPlayer ? undefined : initialGameProps.observerState,
  );
  const [isComplete, setIsComplete] = useState<boolean>(
    initialGameProps.isComplete,
  );
  const players = initialGameProps.players;

  function onMessage(
    response: GameSocketResponse<PlayerState, ObserverState>,
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
        } else {
          setObserverState(response.observerState);
        }
        break;
    }
  }

  const send = useSocket<
    GameSocketRequest<Move, PlayerState, ObserverState>,
    GameSocketResponse<PlayerState, ObserverState>
  >(
    !initialGameProps.isComplete,
    () => new WebSocket(socketUrl),
    isPlayer
      ? {
        type: "InitializePlayer",
        currentPlayerState: playerState as PlayerState,
      }
      : {
        type: "InitializeObserver",
        currentObserverState: observerState as ObserverState,
      },
    onMessage,
  );

  const perform = useCallback((move: Move) => {
    const request: GameSocketRequest<Move, PlayerState, ObserverState> = {
      type: "Move",
      move,
    };
    send(request);
  }, [send]);

  if (isPlayer) {
    return {
      mode: "player",
      playerId: initialGameProps.playerId,
      playerState: playerState as PlayerState,
      perform,
      isComplete,
      players,
    };
  }

  return {
    mode: "observer",
    observerState: observerState as ObserverState,
    isComplete,
    players,
  };
}
