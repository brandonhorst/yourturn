import { useCallback, useEffect, useState } from "preact/hooks";
import type { ClientMessage, ServerMessage } from "../common/sockettypes.ts";
import type { Socket } from "../client/hookutils.ts";
import type { LobbyProps, LobbyViewData } from "../types.ts";
import { ulid } from "@std/ulid";

// Subscribes to a lobby on an already-open socket
export function useLobbySocket<Config, Loadout, Rating>({
  socket,
  initialLobbyProps,
  navigate,
  displayError,
}: {
  socket: Socket;
  initialLobbyProps: LobbyViewData<Config, Loadout, Rating>;
  navigate: (gameId: string) => void;
  displayError: (message: string) => void;
}): LobbyProps<Config, Loadout, Rating> {
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
  const [ratings, setRatings] = useState(initialLobbyProps.ratings);
  const [roomEntries, setRoomEntries] = useState(
    initialLobbyProps.roomEntries,
  );
  const [queueEntries, setQueueEntries] = useState(
    initialLobbyProps.queueEntries,
  );
  const [roomInvitations, setRoomInvitations] = useState(
    initialLobbyProps.roomInvitations,
  );

  useEffect(() => {
    let subscribeSent = false;

    function sendSubscribe() {
      if (subscribeSent) {
        return;
      }

      const request: ClientMessage<
        Config,
        Loadout,
        never,
        never,
        never
      > = {
        type: "SubscribeLobby",
      };
      socket.send(JSON.stringify(request));
      subscribeSent = true;
    }

    function onOpen() {
      sendSubscribe();
    }

    function onMessage(message: string) {
      const response = JSON.parse(message) as ServerMessage<
        Config,
        Loadout,
        Rating,
        never,
        never,
        never
      >;
      switch (response.type) {
        case "UpdateLobbyProps":
          setActiveGames(response.lobbyProps.allActiveGames);
          setAvailableRooms(response.lobbyProps.allAvailableRooms);
          setUserActiveGames(response.lobbyProps.userActiveGames);
          setPlayer(response.lobbyProps.player);
          setRatings(response.lobbyProps.ratings);
          setRoomEntries(response.lobbyProps.roomEntries);
          setQueueEntries(response.lobbyProps.queueEntries);
          setRoomInvitations(response.lobbyProps.roomInvitations);
          break;
        case "UpdateRoomEntry":
          setRoomEntries((existing) => {
            const existingIndex = existing.findIndex((entry) =>
              entry.roomId === response.roomEntry.roomId
            );
            if (existingIndex === -1) {
              return [...existing, response.roomEntry];
            }

            const updated = [...existing];
            updated[existingIndex] = response.roomEntry;
            return updated;
          });
          break;
        case "RemoveRoomEntry":
          setRoomEntries((existing) =>
            existing.filter((entry) => entry.roomId !== response.roomId)
          );
          break;
        case "GameAssignment":
          navigate(response.gameId);
          break;
        case "DisplayError":
          displayError(response.message);
          break;
      }
    }

    socket.addMessageListener(onMessage);
    socket.addOpenListener(onOpen);
    try {
      sendSubscribe();
    } catch {
      // The socket may still be connecting; we'll subscribe once it opens.
    }

    return () => {
      const request: ClientMessage<
        Config,
        Loadout,
        never,
        never,
        never
      > = {
        type: "UnsubscribeLobby",
      };
      try {
        socket.send(JSON.stringify(request));
      } catch {
        // Ignore socket state errors during teardown.
      }
      socket.removeMessageListener(onMessage);
      socket.removeOpenListener(onOpen);
    };
  }, [displayError, navigate, socket]);

  const send = useCallback(
    (request: ClientMessage<Config, Loadout, never, never, never>) => {
      socket.send(JSON.stringify(request));
    },
    [socket],
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

  // Creates a URL-based invitation and returns the generated invitation ID.
  const createInvitation = useCallback((roomId: string) => {
    const invitationId = ulid();
    send({ type: "CreateInvitation", roomId, invitationId });
    return invitationId;
  }, [send]);

  const joinRoom = useCallback(
    (roomId: string, options: { loadout: Loadout }) => {
      send({ type: "JoinRoom", roomId, loadout: options.loadout });
    },
    [send],
  );

  const commitRoom = useCallback((roomId: string) => {
    send({ type: "CommitRoom", roomId });
  }, [send]);

  const inviteUser = useCallback((roomId: string, userId: string) => {
    send({ type: "InviteUser", roomId, userId });
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
    ratings,
    roomEntries,
    queueEntries,
    roomInvitations,
    joinQueue,
    createAndJoinRoom,
    createInvitation,
    joinRoom,
    inviteUser,
    commitRoom,
    leaveQueue,
    leaveRoom,
    updateUsername,
  };
}
