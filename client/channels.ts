import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ClientMessage, ServerMessage } from "../common/sockettypes.ts";
import type {
  ActivePublicGamesViewData,
  ActiveUsersViewData,
  AvailablePublicRoomsViewData,
  GameProps,
  GameViewData,
  RoomEntry,
  RoomProps,
  Socket,
  UserMatchmakingProps,
  UserMatchmakingViewData,
  UserViewData,
} from "../types.ts";

// Subscribes to a specific game on an already-open socket.
export function useGameChannel<
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Rating,
>(
  socket: Socket,
  gameId: string,
  initialGameProps: GameViewData<PlayerState, PublicState, Outcome, Rating>,
): GameProps<Move, PlayerState, PublicState, Outcome, Rating> {
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
    const subscriptionId = crypto.randomUUID();
    let didUnsubscribe = false;

    // Sends a game subscription request for this hook instance.
    function sendSubscribe() {
      if (outcomeRef.current !== undefined || didUnsubscribe) {
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
        subscriptionId,
        gameId,
      };
      socket.send(JSON.stringify(request));
    }

    // Sends a one-time unsubscribe for this hook subscription.
    function sendUnsubscribe() {
      if (didUnsubscribe) {
        return;
      }

      didUnsubscribe = true;
      const request: ClientMessage<
        never,
        never,
        Move,
        PlayerState,
        PublicState
      > = {
        type: "Unsubscribe",
        subscriptionId,
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
        Rating,
        PlayerState,
        PublicState,
        Outcome
      >;
      switch (response.type) {
        case "UpdateGameState":
          if (response.subscriptionId !== subscriptionId) {
            break;
          }

          setOutcome(response.gameViewData.outcome);
          setPublicState(response.gameViewData.publicState);
          setPlayerState(response.gameViewData.playerState);
          if (response.gameViewData.outcome !== undefined) {
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
  } as GameProps<Move, PlayerState, PublicState, Outcome, Rating>;
}

// Subscribes to the global active public games channel on an open socket.
export function useActivePublicGamesChannel<Config, Rating>({
  socket,
  initialActivePublicGamesProps,
}: {
  socket: Socket;
  initialActivePublicGamesProps: ActivePublicGamesViewData<Config, Rating>;
}): ActivePublicGamesViewData<Config, Rating> {
  const [allActiveGames, setActiveGames] = useState(
    initialActivePublicGamesProps.allActiveGames,
  );

  useEffect(() => {
    const subscriptionId = crypto.randomUUID();

    // Sends the active public games subscription request for this hook.
    function sendSubscribe() {
      const request: ClientMessage<
        Config,
        never,
        never,
        never,
        never
      > = {
        type: "SubscribeActivePublicGames",
        subscriptionId,
      };
      socket.send(JSON.stringify(request));
    }

    function onOpen() {
      sendSubscribe();
    }

    function onMessage(message: string) {
      const response = JSON.parse(message) as ServerMessage<
        Config,
        never,
        Rating,
        never,
        never,
        never
      >;
      switch (response.type) {
        case "UpdateActivePublicGames":
          if (response.subscriptionId !== subscriptionId) {
            break;
          }

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
        type: "Unsubscribe",
        subscriptionId,
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

// Subscribes to the global active public users channel on an open socket.
export function useActivePublicUsersChannel<Rating>({
  socket,
  initialActivePublicUsersProps,
}: {
  socket: Socket;
  initialActivePublicUsersProps: ActiveUsersViewData<Rating>;
}): ActiveUsersViewData<Rating> {
  const [allActiveUsers, setActiveUsers] = useState(
    initialActivePublicUsersProps.allActiveUsers,
  );

  useEffect(() => {
    const subscriptionId = crypto.randomUUID();

    // Sends the active public users subscription request for this hook.
    function sendSubscribe() {
      const request: ClientMessage<
        never,
        never,
        never,
        never,
        never
      > = {
        type: "SubscribeActivePublicUsers",
        subscriptionId,
      };
      socket.send(JSON.stringify(request));
    }

    function onOpen() {
      sendSubscribe();
    }

    function onMessage(message: string) {
      const response = JSON.parse(message) as ServerMessage<
        never,
        never,
        Rating,
        never,
        never,
        never
      >;
      switch (response.type) {
        case "UpdateActivePublicUsers":
          if (response.subscriptionId !== subscriptionId) {
            break;
          }

          setActiveUsers(response.activePublicUsersProps.allActiveUsers);
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
        never,
        never,
        never,
        never,
        never
      > = {
        type: "Unsubscribe",
        subscriptionId,
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

  return { allActiveUsers };
}

// Subscribes to the global available public rooms channel on an open socket.
export function useAvailablePublicRoomsChannel<Config, Rating>({
  socket,
  initialAvailablePublicRoomsProps,
}: {
  socket: Socket;
  initialAvailablePublicRoomsProps: AvailablePublicRoomsViewData<
    Config,
    Rating
  >;
}): AvailablePublicRoomsViewData<Config, Rating> {
  const [allAvailableRooms, setAvailableRooms] = useState(
    initialAvailablePublicRoomsProps.allAvailableRooms,
  );

  useEffect(() => {
    const subscriptionId = crypto.randomUUID();

    // Sends the available public rooms subscription request for this hook.
    function sendSubscribe() {
      const request: ClientMessage<
        Config,
        never,
        never,
        never,
        never
      > = {
        type: "SubscribeAvailablePublicRooms",
        subscriptionId,
      };
      socket.send(JSON.stringify(request));
    }

    function onOpen() {
      sendSubscribe();
    }

    function onMessage(message: string) {
      const response = JSON.parse(message) as ServerMessage<
        Config,
        never,
        Rating,
        never,
        never,
        never
      >;
      switch (response.type) {
        case "UpdateAvailablePublicRooms":
          if (response.subscriptionId !== subscriptionId) {
            break;
          }

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
        type: "Unsubscribe",
        subscriptionId,
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

// Subscribes to one user profile channel on an already-open socket.
export function useUserProfileChannel<Rating>({
  socket,
  userId,
  initialUserProfileProps,
}: {
  socket: Socket;
  userId: string;
  initialUserProfileProps: UserViewData<Rating>;
}): UserViewData<Rating> {
  const [userProfile, setUserProfile] = useState(initialUserProfileProps);

  useEffect(() => {
    setUserProfile(initialUserProfileProps);
  }, [initialUserProfileProps]);

  useEffect(() => {
    const subscriptionId = crypto.randomUUID();

    // Sends the user profile subscription request for this hook instance.
    function sendSubscribe() {
      const request: ClientMessage<
        never,
        never,
        never,
        never,
        never
      > = {
        type: "SubscribeUserProfile",
        subscriptionId,
        userId,
      };
      socket.send(JSON.stringify(request));
    }

    function onOpen() {
      sendSubscribe();
    }

    function onMessage(message: string) {
      const response = JSON.parse(message) as ServerMessage<
        never,
        never,
        Rating,
        never,
        never,
        never
      >;
      switch (response.type) {
        case "UpdateUserProfileProps":
          if (response.subscriptionId !== subscriptionId) {
            break;
          }
          setUserProfile(response.userProfileProps);
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
        never,
        never,
        never,
        never,
        never
      > = {
        type: "Unsubscribe",
        subscriptionId,
      };
      try {
        socket.send(JSON.stringify(request));
      } catch {
        // Ignore socket state errors during teardown.
      }
      socket.removeMessageListener(onMessage);
      socket.removeOpenListener(onOpen);
    };
  }, [socket, userId]);

  return userProfile;
}

// Subscribes to UserMatchmaking on an already-open socket.
export function useUserMatchmakingChannel<Config, Loadout, Rating>({
  socket,
  initialUserMatchmakingProps,
  navigate,
  displayError,
}: {
  socket: Socket;
  initialUserMatchmakingProps: UserMatchmakingViewData<Config, Loadout, Rating>;
  navigate: (gameId: string) => void;
  displayError: (message: string) => void;
}): UserMatchmakingProps<Config, Loadout, Rating> {
  const [userActiveGames, setUserActiveGames] = useState(
    initialUserMatchmakingProps.userActiveGames,
  );
  const [roomIds, setRoomIds] = useState(
    initialUserMatchmakingProps.roomIds,
  );
  const [queueEntries, setQueueEntries] = useState(
    initialUserMatchmakingProps.queueEntries,
  );
  const subscriptionIdRef = useRef<string>(crypto.randomUUID());
  const subscriptionId = subscriptionIdRef.current;

  useEffect(() => {
    // Sends the UserMatchmaking subscription request for this hook instance.
    function sendSubscribe() {
      const request: ClientMessage<
        Config,
        Loadout,
        never,
        never,
        never
      > = {
        type: "SubscribeUserMatchmaking",
        subscriptionId,
      };
      socket.send(JSON.stringify(request));
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
        case "UpdateUserMatchmakingProps":
          if (response.subscriptionId !== subscriptionId) {
            break;
          }

          setUserActiveGames(response.userMatchmakingProps.userActiveGames);
          setRoomIds(response.userMatchmakingProps.roomIds);
          setQueueEntries(response.userMatchmakingProps.queueEntries);
          break;
        case "GameAssignment":
          if (response.subscriptionId !== subscriptionId) {
            break;
          }

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
        type: "Unsubscribe",
        subscriptionId,
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
      send({
        type: "JoinQueue",
        queueId,
        loadout: options.loadout,
        assignmentSubscriptionId: subscriptionId,
      });
    },
    [send, subscriptionId],
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
        assignmentSubscriptionId: subscriptionId,
      });
    },
    [send, subscriptionId],
  );

  const joinRoom = useCallback(
    (roomId: string, options: { loadout: Loadout }) => {
      send({
        type: "JoinRoom",
        roomId,
        loadout: options.loadout,
        assignmentSubscriptionId: subscriptionId,
      });
    },
    [send, subscriptionId],
  );

  const leaveQueue = useCallback((queueId: string) => {
    send({ type: "LeaveQueue", queueId });
  }, [send]);

  return {
    userActiveGames,
    roomIds,
    queueEntries,
    joinQueue,
    createAndJoinRoom,
    joinRoom,
    leaveQueue,
  };
}

// Subscribes to a single joined room on an already-open socket.
export function useRoomChannel<Config, Loadout, Rating>({
  socket,
  roomId,
  initialRoomEntry,
  navigate,
  displayError,
}: {
  socket: Socket;
  roomId: string;
  initialRoomEntry: RoomEntry<Config, Loadout, Rating>;
  navigate: (gameId: string) => void;
  displayError: (message: string) => void;
}): RoomProps<Config, Loadout, Rating> {
  const [roomEntry, setRoomEntry] = useState<
    RoomEntry<Config, Loadout, Rating>
  >(
    initialRoomEntry,
  );

  useEffect(() => {
    setRoomEntry(initialRoomEntry);
  }, [initialRoomEntry]);

  useEffect(() => {
    const subscriptionId = crypto.randomUUID();

    // Sends the room subscription request for this hook instance.
    function sendSubscribe() {
      const request: ClientMessage<
        Config,
        Loadout,
        never,
        never,
        never
      > = {
        type: "SubscribeRoom",
        subscriptionId,
        roomId,
      };
      socket.send(JSON.stringify(request));
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
        case "UpdateRoomEntry":
          if (response.subscriptionId !== subscriptionId) {
            break;
          }

          setRoomEntry(response.roomEntry);
          break;
        case "RemoveRoomEntry":
          if (response.subscriptionId !== subscriptionId) {
            break;
          }

          // Keep the last room snapshot in state; room UI teardown is caller-controlled.
          break;
        case "GameAssignment":
          if (response.subscriptionId !== subscriptionId) {
            break;
          }

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
        type: "Unsubscribe",
        subscriptionId,
      };
      try {
        socket.send(JSON.stringify(request));
      } catch {
        // Ignore socket state errors during teardown.
      }
      socket.removeMessageListener(onMessage);
      socket.removeOpenListener(onOpen);
    };
  }, [displayError, navigate, roomId, socket]);

  const send = useCallback(
    (request: ClientMessage<Config, Loadout, never, never, never>) => {
      socket.send(JSON.stringify(request));
    },
    [socket],
  );

  const commitRoom = useCallback(() => {
    send({ type: "CommitRoom", roomId });
  }, [roomId, send]);

  const leaveRoom = useCallback(() => {
    send({ type: "LeaveRoom", roomId });
  }, [roomId, send]);

  return {
    roomId: roomEntry.roomId,
    numPlayers: roomEntry.numPlayers,
    players: roomEntry.players,
    config: roomEntry.config,
    loadout: roomEntry.loadout,
    commitRoom,
    leaveRoom,
  };
}
