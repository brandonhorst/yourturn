import { useCallback, useState } from "preact/hooks";
import { useSocket } from "../client/hookutils.ts";
import type {
  GameClientMessage,
  GameServerMessage,
} from "../common/sockettypes.ts";
import type { GameProps, GameViewProps } from "../types.ts";

// Opens an auto-reconnecting WebSocket to a given Game URL.
// Returns an always up-to-date view of the game and optionally a move handler.
// Closes the socket if the game completes.
export function useGameSocket<Move, PlayerState, PublicState, Outcome>(
  socketUrl: string,
  initialGameProps: GameProps<PlayerState, PublicState, Outcome>,
): GameViewProps<Move, PlayerState, PublicState, Outcome> {
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

  function onMessage(
    response: GameServerMessage<PlayerState, PublicState, Outcome>,
    close: () => void,
  ) {
    switch (response.type) {
      case "UpdateGameState":
        setOutcome(response.outcome);
        setPublicState(response.publicState);
        setPlayerState(response.playerState);
        if (response.outcome !== undefined) {
          close();
        }
        break;
    }
  }

  const send = useSocket<
    GameClientMessage<Move, PlayerState, PublicState>,
    GameServerMessage<PlayerState, PublicState, Outcome>
  >(
    initialGameProps.outcome === undefined,
    () => new WebSocket(socketUrl),
    {
      type: "Initialize",
      currentPublicState: publicState,
      currentPlayerState: playerState,
    },
    onMessage,
  );

  const performCallback = useCallback((move: Move) => {
    const request: GameClientMessage<Move, PlayerState, PublicState> = {
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
  } as GameViewProps<Move, PlayerState, PublicState, Outcome>;
}
