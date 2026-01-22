import { useCallback, useState } from "preact/hooks";
import { useSocket } from "../client/hookutils.ts";
import type {
  LobbyClientMessage,
  LobbyServerMessage,
} from "../common/sockettypes.ts";
import type {
  CurrentMatchmaking,
  LobbyProps,
  LobbyViewProps,
} from "../types.ts";

export function useLobbySocket<Config, Loadout>({
  socketUrl,
  initialLobbyProps,
  navigate,
  displayError,
}: {
  socketUrl: string;
  initialLobbyProps: LobbyProps<Config>;
  navigate: (gameId: string) => void;
  displayError: (message: string) => void;
}): LobbyViewProps<Config, Loadout> {
  const [allActiveGames, setActiveGames] = useState(
    initialLobbyProps.allActiveGames,
  );
  const [allAvailableRooms, setAvailableRooms] = useState(
    initialLobbyProps.allAvailableRooms,
  );
  const [user, setUser] = useState(initialLobbyProps.user);
  const [currentMatchmaking, setCurrentMatchmaking] = useState<
    CurrentMatchmaking<Config, Loadout> | undefined
  >(undefined);

  function onUpdate(response: LobbyServerMessage<Config, Loadout>) {
    switch (response.type) {
      case "QueueJoined":
        setCurrentMatchmaking({
          type: "queue",
          queueId: response.queueId,
          loadout: response.loadout,
        });
        break;
      case "RoomJoined":
        setCurrentMatchmaking({
          type: "room",
          roomId: response.roomId,
          config: response.config,
          loadout: response.loadout,
        });
        break;
      case "QueueLeft":
      case "RoomLeft":
        setCurrentMatchmaking(undefined);
        break;
      case "UpdateActiveGames":
        setActiveGames(response.allActiveGames);
        break;
      case "UpdateAvailableRooms":
        setAvailableRooms(response.allAvailableRooms);
        break;
      case "GameAssignment":
        navigate(response.gameId);
        break;
      case "UserUpdated":
        setUser(response.user);
        break;
      case "DisplayError":
        displayError(response.message);
        break;
    }
  }

  function onClose() {
    setCurrentMatchmaking(undefined);
  }

  const send = useSocket<
    LobbyClientMessage<Config, Loadout>,
    LobbyServerMessage<Config, Loadout>
  >(
    true,
    () => new WebSocket(socketUrl),
    { type: "Initialize", allActiveGames, allAvailableRooms },
    onUpdate,
    onClose,
  );

  const joinQueue = useCallback(
    (queueId: string, options: { loadout: Loadout }) => {
      send({ type: "JoinQueue", queueId, loadout: options.loadout });
    },
    [send],
  );

  const createAndJoinRoom = useCallback(
    (
      options: { config: Config; numPlayers: number; private: boolean },
      player: { loadout: Loadout },
    ) => {
      send({
        type: "CreateAndJoinRoom",
        config: options.config,
        numPlayers: options.numPlayers,
        private: options.private,
        loadout: player.loadout,
      });
    },
    [send],
  );

  const joinRoom = useCallback(
    (roomId: string, options: { loadout: Loadout }) => {
      send({ type: "JoinRoom", roomId, loadout: options.loadout });
    },
    [send],
  );

  const commitRoom = useCallback((roomId: string) => {
    send({ type: "CommitRoom", roomId });
  }, [send]);

  const leaveMatchmaking = useCallback(() => {
    send({ type: "LeaveMatchmaking" });
  }, [send]);

  const updateUsername = useCallback((username: string) => {
    send({ type: "UpdateUsername", username });
  }, [send]);

  return {
    allActiveGames,
    allAvailableRooms,
    user,
    joinQueue,
    createAndJoinRoom,
    joinRoom,
    commitRoom,
    currentMatchmaking,
    leaveMatchmaking,
    updateUsername,
  };
}
