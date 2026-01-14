import { useCallback, useState } from "preact/hooks";
import { useSocket } from "../client/hookutils.ts";
import type {
  LobbySocketRequest,
  LobbySocketResponse,
} from "../common/types.ts";
import type { LobbyProps, LobbyViewProps } from "../types.ts";

export function useLobbySocket({ socketUrl, initialLobbyProps, navigate }: {
  socketUrl: string;
  initialLobbyProps: LobbyProps;
  navigate: (gameId: string) => void;
}): LobbyViewProps {
  const [activeGames, setActiveGames] = useState(initialLobbyProps.activeGames);
  const [user, setUser] = useState(initialLobbyProps.user);
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
        navigate(response.gameId);
        break;
      case "UserUpdated":
        setUser(response.user);
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

  const updateUsername = useCallback((username: string) => {
    send({ type: "UpdateUsername", username });
  }, [send]);

  return { activeGames, user, joinQueue, isQueued, leaveQueue, updateUsername };
}
