import type {
  ActiveGame,
  Game,
  GameViewData,
  LobbyViewData,
  Player,
  QueueEntry,
  RoomEntry,
} from "../types.ts";
import type { ClientMessage } from "../common/sockettypes.ts";
import {
  fetchActiveGames,
  fetchAvailableRooms,
  getPlayerId,
  getPlayerState,
  getPublicState,
  handleMove,
} from "./gamedata.ts";
import type { DB } from "./db.ts";
import type { SocketStore } from "./sockets.ts";
import { ulid } from "@std/ulid";

const tokenTtlMs = 1000 * 60 * 60 * 24 * 30;

export class Server<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Rating,
  Loadout,
> {
  constructor(
    private game: Game<
      Config,
      GameState,
      Move,
      PlayerState,
      PublicState,
      Outcome,
      Rating,
      Loadout
    >,
    private db: DB<
      Config,
      GameState,
      Move,
      PlayerState,
      PublicState,
      Outcome,
      Rating,
      Loadout
    >,
    private socketStore: SocketStore<
      Config,
      GameState,
      Move,
      PlayerState,
      PublicState,
      Outcome,
      Rating,
      Loadout
    >,
  ) {}

  async getInitialLobbyProps(
    token: string | undefined,
    invitationId?: string,
  ): Promise<{ props: LobbyViewData<Config, Loadout, Rating>; token: string }> {
    const allActiveGames = await fetchActiveGames(this.db);
    const allAvailableRooms = await fetchAvailableRooms(this.db);
    let user: Player | null = null;
    let userId: string | null = null;
    let userActiveGames: ActiveGame<Config>[] = [];
    let roomEntries: RoomEntry<Config, Loadout>[] = [];
    let queueEntries: QueueEntry<Loadout>[] = [];
    let roomInvitations: LobbyViewData<
      Config,
      Loadout,
      Rating
    >["roomInvitations"] = [];
    let ratings: Record<string, Rating> = {};
    let lobbyToken = token;
    const invitation = invitationId == null
      ? null
      : await this.db.getRoomInvitation(invitationId);

    if (token != null) {
      const tokenData = await this.db.getToken(token);
      if (tokenData != null && tokenData.expiration > new Date()) {
        const storedUser = await this.db.getLobbyUserData(
          tokenData.userId,
        );
        user = storedUser?.player ?? null;
        userId = tokenData.userId;
        userActiveGames = storedUser?.activeGames ?? [];
        roomEntries = storedUser?.roomEntries ?? [];
        queueEntries = storedUser?.queueEntries ?? [];
        roomInvitations = storedUser?.roomInvitations ?? [];
        const normalized = this.normalizeRatings(storedUser?.ratings ?? {});
        ratings = normalized.ratings;
        if (normalized.didChange && userId != null) {
          await this.db.updateUserStorageData(userId, { ratings });
        }
      }
    }

    if (user == null) {
      user = await this.createGuestUser();
      userId = ulid();
      lobbyToken = crypto.randomUUID();
      const expiration = new Date(Date.now() + tokenTtlMs);

      // TODO combine these into one call
      await this.db.createNewUserStorageData(userId, {
        player: user,
        activeGames: [],
        ratings: this.buildInitialRatings(),
        joinedRooms: [],
        queueEntries: [],
        roomInvitations: invitation == null ? [] : [invitation],
      });
      await this.db.storeToken(lobbyToken, { userId, expiration });
      userActiveGames = [];
      roomEntries = [];
      queueEntries = [];
      roomInvitations = invitation == null ? [] : [invitation];
      ratings = this.buildInitialRatings();
    }

    if (lobbyToken == null) {
      throw new Error("Missing lobby auth token");
    }
    if (user == null) {
      throw new Error("Missing lobby user");
    }
    if (userId == null) {
      throw new Error("Missing lobby user id");
    }

    if (invitation != null) {
      const hasInvitation = roomInvitations.some((invite) =>
        invite.roomId === invitation.roomId
      );
      if (!hasInvitation) {
        // Ensure the invitation is available in the user's lobby props and storage.
        const mergedInvitations = [...roomInvitations, invitation];
        roomInvitations = mergedInvitations;
        await this.db.updateUserStorageData(userId, {
          roomInvitations: mergedInvitations,
        });
      }
    }

    return {
      props: {
        allActiveGames,
        allAvailableRooms,
        userActiveGames,
        player: user,
        ratings,
        roomEntries,
        queueEntries,
        roomInvitations,
      },
      token: lobbyToken,
    };
  }

  async getInitialGameProps(
    gameId: string,
    token: string | undefined,
  ): Promise<GameViewData<PlayerState, PublicState, Outcome>> {
    const gameData = await this.db.getGameStorageData(gameId);

    let playerId: number | undefined;
    const userId = await this.getUserIdFromToken(token);
    if (userId != null) {
      playerId = getPlayerId(gameData, userId);
    }

    const publicState = getPublicState(gameData, this.game.publicState);
    const playerState = playerId == null ? undefined : getPlayerState(
      gameData,
      this.game.playerState,
      playerId,
    );

    return {
      players: gameData.players,
      publicState,
      playerId,
      playerState,
      outcome: gameData.outcome,
    } as GameViewData<PlayerState, PublicState, Outcome>;
  }

  async configureLobbySocket(socket: WebSocket, token: string) {
    if (token === "") {
      throw new Error("Missing lobby auth token");
    }

    const tokenData = await this.db.getToken(token);
    if (tokenData == null || tokenData.expiration <= new Date()) {
      throw new Error("Invalid lobby auth token");
    }

    const storedUser = await this.db.getLobbyUserData(tokenData.userId);
    if (storedUser == null) {
      throw new Error("Unknown lobby user");
    }

    const user = storedUser.player;
    const userId = tokenData.userId;
    let subscribed = false;

    const handleLobbySocketOpen = () => {
      console.log("lobby socket opened");
    };

    const handleLobbySocketMessage = async (event: MessageEvent) => {
      const message = event.data;
      console.log("Lobby Socket Message", message);
      const parsedMessage: ClientMessage<
        Config,
        Loadout,
        Move,
        PlayerState,
        PublicState
      > = JSON.parse(message);
      switch (parsedMessage.type) {
        case "SubscribeLobby": {
          const latestUserData = await this.db.getLobbyUserData(userId);
          if (latestUserData == null) {
            socket.send(JSON.stringify(
              {
                type: "DisplayError",
                message: "Unknown lobby user.",
              },
            ));
            break;
          }
          await this.socketStore.subscribeLobby(
            socket,
            userId,
            latestUserData,
          );
          subscribed = true;
          break;
        }
        case "UnsubscribeLobby":
          await this.socketStore.unsubscribeLobby(socket);
          subscribed = false;
          break;
        case "JoinQueue": {
          const queue = this.game.queues[parsedMessage.queueId];
          if (queue == null) {
            console.log(
              "Attempted to join non-existant queue",
              parsedMessage.queueId,
            );
            return;
          }
          if (
            !(this.game.isValidLoadout?.(
              parsedMessage.loadout,
              queue.config,
            ) ?? false)
          ) {
            socket.send(JSON.stringify(
              {
                type: "DisplayError",
                message: "Invalid loadout.",
              },
            ));
            return;
          }
          const queueConfig = {
            queueId: parsedMessage.queueId,
            numPlayers: queue.numPlayers,
            config: queue.config,
          };
          await this.socketStore.joinQueue(
            socket,
            queueConfig.queueId,
            userId,
            user,
            parsedMessage.loadout,
          );
          break;
        }
        case "CreateAndJoinRoom": {
          if (!(this.game.isValidRoom?.(parsedMessage.config) ?? false)) {
            socket.send(JSON.stringify(
              {
                type: "DisplayError",
                message: "Invalid room config.",
              },
            ));
            return;
          }

          if (
            !(this.game.isValidLoadout?.(
              parsedMessage.loadout,
              parsedMessage.config,
            ) ?? false)
          ) {
            socket.send(JSON.stringify(
              {
                type: "DisplayError",
                message: "Invalid loadout.",
              },
            ));
            return;
          }

          await this.socketStore.createAndJoinRoom(
            socket,
            {
              numPlayers: parsedMessage.numPlayers,
              config: parsedMessage.config,
              private: parsedMessage.private,
            },
            userId,
            user,
            parsedMessage.loadout,
          );
          break;
        }
        case "JoinRoom": {
          const room = await this.db.getRoom(parsedMessage.roomId);
          if (room == null) {
            await this.db.removeRoomInvitation(userId, parsedMessage.roomId);
            socket.send(JSON.stringify(
              {
                type: "DisplayError",
                message: "Room not found.",
              },
            ));
            return;
          }
          if (room.members.some((member) => member.userId === userId)) {
            socket.send(JSON.stringify(
              {
                type: "DisplayError",
                message: "You are already in this room.",
              },
            ));
            return;
          }
          if (
            !(this.game.isValidLoadout?.(
              parsedMessage.loadout,
              room.config,
            ) ?? false)
          ) {
            socket.send(JSON.stringify(
              {
                type: "DisplayError",
                message: "Invalid loadout.",
              },
            ));
            return;
          }
          if (room.members.length >= room.numPlayers) {
            socket.send(JSON.stringify(
              {
                type: "DisplayError",
                message: "Room is full.",
              },
            ));
            return;
          }
          const hasInvitation = await this.db.hasRoomInvitation(
            userId,
            parsedMessage.roomId,
          );
          if (room.private && !hasInvitation) {
            socket.send(JSON.stringify(
              {
                type: "DisplayError",
                message: "Room is private.",
              },
            ));
            return;
          }
          const joined = await this.socketStore.joinRoom(
            socket,
            parsedMessage.roomId,
            userId,
            user,
            parsedMessage.loadout,
            { consumeInvitation: hasInvitation },
          );
          if (!joined) {
            socket.send(JSON.stringify(
              {
                type: "DisplayError",
                message: "Unable to join room.",
              },
            ));
          }
          break;
        }
        case "CommitRoom": {
          try {
            await this.db.commitRoom(
              parsedMessage.roomId,
            );
          } catch (err) {
            console.error("Failed to commit room", err);
            socket.send(JSON.stringify(
              {
                type: "DisplayError",
                message: "Unable to commit room.",
              },
            ));
          }
          break;
        }
        case "InviteUser": {
          try {
            await this.db.inviteUserToRoom(
              parsedMessage.roomId,
              userId,
              parsedMessage.userId,
            );
          } catch (err) {
            console.error("Failed to invite user", err);
            socket.send(JSON.stringify(
              {
                type: "DisplayError",
                message: "Unable to invite user.",
              },
            ));
          }
          break;
        }
        case "CreateInvitation": {
          try {
            await this.db.createRoomInvitation(
              parsedMessage.invitationId,
              parsedMessage.roomId,
              userId,
            );
          } catch (err) {
            console.error("Failed to create invitation", err);
            socket.send(JSON.stringify(
              {
                type: "DisplayError",
                message: "Unable to create invitation.",
              },
            ));
          }
          break;
        }
        case "LeaveQueue":
          await this.socketStore.leaveQueue(socket, parsedMessage.queueId);
          break;
        case "LeaveRoom":
          await this.socketStore.leaveRoom(socket, parsedMessage.roomId);
          break;
      }
    };

    const handleLobbySocketClose = async () => {
      console.log("lobby socket closed");
      if (!subscribed) {
        return;
      }
      await this.socketStore.unsubscribeLobby(socket);
    };

    socket.addEventListener("open", handleLobbySocketOpen);
    socket.addEventListener("message", handleLobbySocketMessage);
    socket.addEventListener("close", handleLobbySocketClose);
  }

  async configureGameSocket(
    socket: WebSocket,
    token: string | undefined,
  ) {
    const userId = await this.getUserIdFromToken(token);
    const subscribedGameIds = new Set<string>();
    const playerIdsByGame = new Map<string, number | undefined>();

    /**
     * Resolves and memoizes the user's player ID for a specific game.
     */
    const getPlayerIdForGame = async (
      gameId: string,
    ): Promise<number | undefined> => {
      const cachedPlayerId = playerIdsByGame.get(gameId);
      if (cachedPlayerId !== undefined || playerIdsByGame.has(gameId)) {
        return cachedPlayerId;
      }
      if (userId == null) {
        playerIdsByGame.set(gameId, undefined);
        return;
      }

      const gameData = await this.db.getGameStorageData(gameId);
      const playerId = getPlayerId(gameData, userId);
      playerIdsByGame.set(gameId, playerId);
      return playerId;
    };

    const handleGameSocketMessage = async (event: MessageEvent) => {
      const request: ClientMessage<
        Config,
        Loadout,
        Move,
        PlayerState,
        PublicState
      > = JSON.parse(event.data);
      switch (request.type) {
        case "SubscribeGame":
          try {
            const playerId = await getPlayerIdForGame(request.gameId);
            await this.socketStore.subscribeGame(
              socket,
              request.gameId,
              this.game.playerState,
              this.game.publicState,
              playerId,
            );
            subscribedGameIds.add(request.gameId);
          } catch (err) {
            console.error("Failed to subscribe game socket", err);
            this.socketStore.unsubscribeGame(socket, request.gameId);
            subscribedGameIds.delete(request.gameId);
            socket.send(JSON.stringify(
              {
                type: "DisplayError",
                message: "Unable to subscribe to game.",
              },
            ));
          }
          break;
        case "UnsubscribeGame":
          this.socketStore.unsubscribeGame(socket, request.gameId);
          subscribedGameIds.delete(request.gameId);
          break;
        case "Move":
          try {
            const playerId = await getPlayerIdForGame(request.gameId);
            if (playerId == null) {
              break;
            }
            await handleMove(
              this.db,
              this.game,
              request.gameId,
              playerId,
              request.move,
            );
          } catch (err) {
            console.error("Failed to process move", err);
            socket.send(JSON.stringify(
              {
                type: "DisplayError",
                message: "Unable to process move.",
              },
            ));
          }
          break;
      }
    };

    const handleGameSocketClose = () => {
      for (const subscribedGameId of subscribedGameIds) {
        this.socketStore.unsubscribeGame(socket, subscribedGameId);
      }
      subscribedGameIds.clear();
    };

    socket.addEventListener("message", handleGameSocketMessage);
    socket.addEventListener("close", handleGameSocketClose);
  }

  private async getUserIdFromToken(
    token: string | undefined,
  ): Promise<string | undefined> {
    if (token == null || token === "") {
      return;
    }
    const tokenData = await this.db.getToken(token);
    if (tokenData == null || tokenData.expiration <= new Date()) {
      return;
    }
    return tokenData.userId;
  }

  /**
   * Builds initial ratings for every configured ranked queue.
   */
  private buildInitialRatings(): Record<string, Rating> {
    return this.normalizeRatings({}).ratings;
  }

  /**
   * Ensures ratings exist for every configured ranked queue.
   */
  private normalizeRatings(
    ratings: Record<string, Rating>,
  ): { ratings: Record<string, Rating>; didChange: boolean } {
    const merged = { ...ratings };
    let didChange = false;
    for (const [queueId, queueConfig] of Object.entries(this.game.queues)) {
      if (queueConfig.queueType !== "ranked") {
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(merged, queueId)) {
        merged[queueId] = this.game.initialRating();
        didChange = true;
      }
    }
    return { ratings: merged, didChange };
  }

  private async createGuestUser(): Promise<Player> {
    for (let attempt = 0; attempt < 10000; attempt++) {
      const suffix = Math.floor(Math.random() * 10000).toString().padStart(
        4,
        "0",
      );
      const username = `guest-${suffix}`;
      const usernameTaken = await this.db.usernameExists(username);
      if (!usernameTaken) {
        return { username, isGuest: true };
      }
    }

    throw new Error("Failed to create a unique guest username");
  }
}
