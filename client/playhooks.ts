import { useCallback, useState } from "preact/hooks";
import { useSocket } from "../client/hookutils.ts";
import type { PlaySocketRequest, PlaySocketResponse } from "../common/types.ts";
import type { PlayerProps, PlayerViewProps } from "../types.ts";

// Opens an auto-reconnecting WebSocket to a given Play URL.
// Returns an always up-to-date PlayerState,
// and a function to perform a move. Closes the socket if the game completes.
export function usePlaySocket<Move, PlayerState, Player>(
  socketUrl: string,
  initialPlayerProps: PlayerProps<PlayerState, Player>,
): PlayerViewProps<Move, PlayerState, Player> {
  const [playerState, setPlayerState] = useState<PlayerState>(
    initialPlayerProps.playerState,
  );
  const [isComplete, setIsComplete] = useState<boolean>(
    initialPlayerProps.isComplete,
  );
  const playerId = initialPlayerProps.playerId;
  const players = initialPlayerProps.players;

  // Handler for socket messages
  function onMessage(
    response: PlaySocketResponse<PlayerState>,
    close: () => void,
  ) {
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
    PlaySocketRequest<Move, PlayerState>,
    PlaySocketResponse<PlayerState>
  >(
    !initialPlayerProps.isComplete,
    () => new WebSocket(socketUrl),
    { type: "Initialize", currentPlayerState: playerState },
    onMessage,
  );

  const perform = useCallback((move: Move) => {
    const request: PlaySocketRequest<Move, PlayerState> = {
      type: "Move",
      move,
    };
    send(request);
  }, [send]);

  return { playerId, playerState, perform, isComplete, players };
}
