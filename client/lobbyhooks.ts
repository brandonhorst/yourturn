import { useCallback, useState } from "preact/hooks";
import { useSocket } from "../client/hookutils.ts";
import type {
  LobbyClientMessage,
  LobbyServerMessage,
} from "../common/sockettypes.ts";
import type { LobbyProps, LobbyViewProps } from "../types.ts";

export function useLobbySocket<Config, Loadout>({
  socketUrl,
  initialLobbyProps,
  navigate,
  displayError,
}: {
  socketUrl: string;
  initialLobbyProps: LobbyProps<Config, Loadout>;
  navigate: (gameId: string) => void;
  displayError: (message: string) => void;
}): LobbyViewProps<Config, Loadout> {
  const [allActiveGames, setActiveGames] = useState(
    initialLobbyProps.allActiveGames,
  );
  const [allAvailableRooms, setAvailableRooms] = useState(
    initialLobbyProps.allAvailableRooms,
  );
  const [userActiveGames, setUserActiveGames] = useState(
    initialLobbyProps.userActiveGames,
  );
  const [player, setPlayer] = useState(initialLobbyProps.player);
  const [roomEntries, setRoomEntries] = useState(
    initialLobbyProps.roomEntries,
  );
  const [queueEntries, setQueueEntries] = useState(
    initialLobbyProps.queueEntries,
  );

  function onUpdate(response: LobbyServerMessage<Config, Loadout>) {
    switch (response.type) {
      case "UpdateLobbyProps":
        if (response.lobbyProps.allActiveGames != null) {
          setActiveGames(response.lobbyProps.allActiveGames);
        }
        if (response.lobbyProps.allAvailableRooms != null) {
          setAvailableRooms(response.lobbyProps.allAvailableRooms);
        }
        if (response.lobbyProps.player != null) {
          setPlayer(response.lobbyProps.player);
        }
        if (response.lobbyProps.userActiveGames != null) {
          setUserActiveGames(response.lobbyProps.userActiveGames);
        }
        if (response.lobbyProps.roomEntries != null) {
          setRoomEntries(response.lobbyProps.roomEntries);
        }
        if (response.lobbyProps.queueEntries != null) {
          setQueueEntries(response.lobbyProps.queueEntries);
        }
        break;
      case "GameAssignment":
        navigate(response.gameId);
        break;
      case "DisplayError":
        displayError(response.message);
        break;
    }
  }

  function onClose() {
    // Clear joined queues and rooms on socket close
    setRoomEntries([]);
    setQueueEntries([]);
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

  const leaveQueue = useCallback((queueId: string) => {
    send({ type: "LeaveQueue", queueId });
  }, [send]);

  const leaveRoom = useCallback((roomId: string) => {
    send({ type: "LeaveRoom", roomId });
  }, [send]);

  const updateUsername = useCallback((username: string) => {
    send({ type: "UpdateUsername", username });
  }, [send]);

  return {
    allActiveGames,
    allAvailableRooms,
    userActiveGames,
    player,
    roomEntries,
    queueEntries,
    joinQueue,
    createAndJoinRoom,
    joinRoom,
    commitRoom,
    leaveQueue,
    leaveRoom,
    updateUsername,
  };
}
