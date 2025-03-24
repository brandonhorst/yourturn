import { useCallback, useState } from "preact/hooks";
import { useSocket } from "../client/hookutils.ts";
import type {
  LobbySocketRequest,
  LobbySocketResponse,
} from "../common/types.ts";
import type { ActiveGame } from "../types.ts";

export function useLobbySocket({ socketUrl, initialActiveGames, navigate }: {
  socketUrl: string;
  initialActiveGames: ActiveGame[];
  navigate: (gameId: string, sessionId: string) => void;
}): {
  activeGames: ActiveGame[];
  joinQueue: (queueId: string) => void;
  isQueued: boolean;
  leaveQueue: () => void;
} {
  const [activeGames, setActiveGames] = useState(initialActiveGames);
  const [isQueued, setIsQueued] = useState(false);

  function onUpdate(response: LobbySocketResponse) {
    switch (response.type) {
      case "QueueJoined":
        setIsQueued(true);
        break;
      case "QueueLeft":
        setIsQueued(false);
        break;
      case "UpdateActiveGames":
        setActiveGames(response.activeGames);
        break;
      case "GameAssignment":
        navigate(response.gameId, response.sessionId);
        break;
    }
  }

  function onClose() {
    setIsQueued(false);
  }

  const send = useSocket<LobbySocketRequest, LobbySocketResponse>(
    true,
    () => new WebSocket(socketUrl),
    { type: "Initialize", activeGames },
    onUpdate,
    onClose,
  );

  const joinQueue = useCallback(
    (queueId: string) => {
      send({ type: "JoinQueue", queueId });
    },
    [send],
  );

  const leaveQueue = useCallback(() => {
    send({ type: "LeaveQueue" });
  }, [send]);

  return { activeGames, joinQueue, isQueued, leaveQueue };
}
