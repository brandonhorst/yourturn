import { useCallback, useState } from "preact/hooks";
import { useSocket } from "../client/hookutils.ts";
import type { PlaySocketRequest, PlaySocketResponse } from "../common/types.ts";
import type { PlayerProps, PlayerViewProps } from "../types.ts";

// Opens an auto-reconnecting WebSocket to a given Play URL.
// Returns an always up-to-date PlayerState,
// and a function to perform a move. Closes the socket if the game completes.
export function usePlaySocket<M, P>(
  socketUrl: string,
  initialPlayerProps: PlayerProps<P>,
): PlayerViewProps<M, P> {
  const [playerState, setPlayerState] = useState<P>(
    initialPlayerProps.playerState,
  );
  const [isComplete, setIsComplete] = useState<boolean>(
    initialPlayerProps.isComplete,
  );
  const players = initialPlayerProps.players;

  // Handler for socket messages
  function onMessage(response: PlaySocketResponse<P>, close: () => void) {
    switch (response.type) {
      case "MarkComplete":
        setIsComplete(true);
        close();
        break;
      case "UpdatePlayerState":
        setPlayerState(response.playerState);
        break;
    }
  }

  // Open the socket
  const send = useSocket<
    PlaySocketRequest<M, P>,
    PlaySocketResponse<P>
  >(
    !initialPlayerProps.isComplete,
    () => new WebSocket(socketUrl),
    { type: "Initialize", currentPlayerState: playerState },
    onMessage,
  );

  const perform = useCallback((move: M) => {
    const request: PlaySocketRequest<M, P> = { type: "Move", move };
    send(request);
  }, [send]);

  return { playerState, perform, isComplete, players };
}
