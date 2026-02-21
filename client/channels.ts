import { ulid } from "@std/ulid";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ClientMessage, ServerMessage } from "../common/sockettypes.ts";
import type {
  ActivePublicGamesViewData,
  AvailablePublicRoomsViewData,
  GameProps,
  GameViewData,
  LobbyProps,
  LobbyViewData,
  Socket,
} from "../types.ts";

// Subscribes to a specific game on an already-open socket.
export function useGameChannel<Move, PlayerState, PublicState, Outcome>(
  socket: Socket,
  gameId: string,
  initialGameProps: GameViewData<PlayerState, PublicState, Outcome>,
): GameProps<Move, PlayerState, PublicState, Outcome> {
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
  const outcomeRef = useRef(outcome);

  outcomeRef.current = outcome;

  useEffect(() => {
    let isSubscribed = false;

    // Sends the game subscription request at most once per hook lifecycle.
    function sendSubscribe() {
      if (isSubscribed || outcomeRef.current !== undefined) {
        return;
      }

      const request: ClientMessage<
        never,
        never,
        Move,
        PlayerState,
        PublicState
      > = {
        type: "SubscribeGame",
        gameId,
      };
      socket.send(JSON.stringify(request));
      isSubscribed = true;
    }

    // Sends the game unsubscription request only when this hook subscribed.
    function sendUnsubscribe() {
      if (!isSubscribed) {
        return;
      }
      // Mark unsubscribed before sending so teardown can't send twice.
      isSubscribed = false;
      const request: ClientMessage<
        never,
        never,
        Move,
        PlayerState,
        PublicState
      > = {
        type: "UnsubscribeGame",
        gameId,
      };
      try {
        socket.send(JSON.stringify(request));
      } catch {
        // Ignore socket state errors during teardown/unsubscribe attempts.
      }
    }

    function onOpen() {
      sendSubscribe();
    }

    function onMessage(message: string) {
      const response = JSON.parse(message) as ServerMessage<
        never,
        never,
        never,
        PlayerState,
        PublicState,
        Outcome
      >;
      switch (response.type) {
        case "UpdateGameState":
          setOutcome(response.outcome);
          setPublicState(response.publicState);
          setPlayerState(response.playerState);
          if (response.outcome !== undefined) {
            sendUnsubscribe();
          }
          break;
      }
    }

    socket.addMessageListener(onMessage);
    socket.addOpenListener(onOpen);
    if (outcomeRef.current === undefined) {
      try {
        sendSubscribe();
      } catch {
        // The socket may still be connecting; we'll subscribe once it opens.
      }
    }

    return () => {
      sendUnsubscribe();
      socket.removeMessageListener(onMessage);
      socket.removeOpenListener(onOpen);
    };
  }, [gameId, socket]);

  const send = useCallback(
    (
      request: ClientMessage<
        never,
        never,
        Move,
        PlayerState,
        PublicState
      >,
    ) => {
      socket.send(JSON.stringify(request));
    },
    [socket],
  );

  const performCallback = useCallback((move: Move) => {
    const request: ClientMessage<
      never,
      never,
      Move,
      PlayerState,
      PublicState
    > = {
      type: "Move",
      gameId,
      move,
    };
    send(request);
  }, [gameId, send]);
  const perform = playerId == null ? undefined : performCallback;

  return {
    players: players,
    publicState: publicState,
    playerId: initialGameProps.playerId,
    playerState: playerState,
    perform,
    outcome: outcome,
  } as GameProps<Move, PlayerState, PublicState, Outcome>;
}

// Subscribes to the global active public games channel on an open socket.
export function useActivePublicGamesChannel<Config>({
  socket,
  initialActivePublicGamesProps,
}: {
  socket: Socket;
  initialActivePublicGamesProps: ActivePublicGamesViewData<Config>;
}): ActivePublicGamesViewData<Config> {
  const [allActiveGames, setActiveGames] = useState(
    initialActivePublicGamesProps.allActiveGames,
  );

  useEffect(() => {
    let subscribeSent = false;

    function sendSubscribe() {
      if (subscribeSent) {
        return;
      }

      const request: ClientMessage<
        Config,
        never,
        never,
        never,
        never
      > = {
        type: "SubscribeActivePublicGames",
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
        never,
        never,
        never,
        never,
        never
      >;
      switch (response.type) {
        case "UpdateActivePublicGames":
          setActiveGames(response.activePublicGamesProps.allActiveGames);
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
        never,
        never,
        never,
        never
      > = {
        type: "UnsubscribeActivePublicGames",
      };
      try {
        socket.send(JSON.stringify(request));
      } catch {
        // Ignore socket state errors during teardown.
      }
      socket.removeMessageListener(onMessage);
      socket.removeOpenListener(onOpen);
    };
  }, [socket]);

  return { allActiveGames };
}

// Subscribes to the global available public rooms channel on an open socket.
export function useAvailablePublicRoomsChannel<Config>({
  socket,
  initialAvailablePublicRoomsProps,
}: {
  socket: Socket;
  initialAvailablePublicRoomsProps: AvailablePublicRoomsViewData<Config>;
}): AvailablePublicRoomsViewData<Config> {
  const [allAvailableRooms, setAvailableRooms] = useState(
    initialAvailablePublicRoomsProps.allAvailableRooms,
  );

  useEffect(() => {
    let subscribeSent = false;

    function sendSubscribe() {
      if (subscribeSent) {
        return;
      }

      const request: ClientMessage<
        Config,
        never,
        never,
        never,
        never
      > = {
        type: "SubscribeAvailablePublicRooms",
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
        never,
        never,
        never,
        never,
        never
      >;
      switch (response.type) {
        case "UpdateAvailablePublicRooms":
          setAvailableRooms(
            response.availablePublicRoomsProps.allAvailableRooms,
          );
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
        never,
        never,
        never,
        never
      > = {
        type: "UnsubscribeAvailablePublicRooms",
      };
      try {
        socket.send(JSON.stringify(request));
      } catch {
        // Ignore socket state errors during teardown.
      }
      socket.removeMessageListener(onMessage);
      socket.removeOpenListener(onOpen);
    };
  }, [socket]);

  return { allAvailableRooms };
}

// Subscribes to a lobby on an already-open socket.
export function useLobbyChannel<Config, Loadout, Rating>({
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

  return {
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
  };
}
