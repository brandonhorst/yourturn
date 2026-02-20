import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ClientMessage, ServerMessage } from "../common/sockettypes.ts";
import type { Socket } from "../client/hookutils.ts";
import type { LobbyProps, LobbyViewData } from "../types.ts";
import { ulid } from "@std/ulid";

// Subscribes an already-open lobby socket
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
  const allActiveGamesRef = useRef(allActiveGames);
  const allAvailableRoomsRef = useRef(allAvailableRooms);

  allActiveGamesRef.current = allActiveGames;
  allAvailableRoomsRef.current = allAvailableRooms;

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
        allActiveGames: allActiveGamesRef.current,
        allAvailableRooms: allAvailableRoomsRef.current,
      };
      socket.send(JSON.stringify(request));
      subscribeSent = true;
    }

    function onOpen() {
      sendSubscribe();
    }

    function onMessage(event: MessageEvent) {
      const response = JSON.parse(event.data) as ServerMessage<
        Config,
        Loadout,
        Rating,
        never,
        never,
        never
      >;
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
          if (response.lobbyProps.ratings != null) {
            setRatings(response.lobbyProps.ratings);
          }
          if (response.lobbyProps.userActiveGames != null) {
            setUserActiveGames(response.lobbyProps.userActiveGames);
          }
          if (response.lobbyProps.queueEntries != null) {
            setQueueEntries(response.lobbyProps.queueEntries);
          }
          if (response.lobbyProps.roomInvitations != null) {
            setRoomInvitations(response.lobbyProps.roomInvitations);
          }
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

    function onClose() {
      // Clear joined queues and rooms on socket close.
      setRoomEntries([]);
      setQueueEntries([]);
      setRoomInvitations([]);
    }

    socket.addEventListener("message", onMessage);
    socket.addEventListener("open", onOpen);
    socket.addEventListener("close", onClose);
    try {
      sendSubscribe();
    } catch {
      // The socket may still be connecting; we'll subscribe once it opens.
    }

    return () => {
      socket.removeEventListener?.("message", onMessage);
      socket.removeEventListener?.("open", onOpen);
      socket.removeEventListener?.("close", onClose);
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
