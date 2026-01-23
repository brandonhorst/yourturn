import type {
  ActiveGame,
  Game,
  GameProps,
  LobbyProps,
  Player,
} from "../types.ts";
import type {
  GameClientMessage,
  LobbyClientMessage,
} from "../common/sockettypes.ts";
import {
  fetchActiveGames,
  fetchAvailableRooms,
  getPlayerId,
  getPlayerState,
  getPublicState,
  handleMove,
} from "./gamedata.ts";
import type { GameSocketStore } from "./gamesockets.ts";
import type { DB } from "./db.ts";
import type { LobbySocketStore } from "./lobbysockets.ts";
import { ulid } from "@std/ulid";

const tokenTtlMs = 1000 * 60 * 60 * 24 * 30;

export class Server<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Outcome,
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
      Loadout
    >,
    private db: DB<Config, GameState, Loadout, Outcome>,
    private lobbySocketStore: LobbySocketStore<
      Config,
      GameState,
      Loadout,
      Outcome
    >,
    private gameSocketStore: GameSocketStore<
      Config,
      GameState,
      PlayerState,
      PublicState,
      Outcome,
      Loadout
    >,
  ) {}

  async getInitialLobbyProps(
    token: string | undefined,
  ): Promise<{ props: LobbyProps<Config>; token: string }> {
    const allActiveGames = await fetchActiveGames(this.db);
    const allAvailableRooms = await fetchAvailableRooms(this.db);
    let user: Player | null = null;
    let userActiveGames: ActiveGame<Config>[] = [];
    let lobbyToken = token;

    if (token != null) {
      const tokenData = await this.db.getToken(token);
      if (tokenData != null && tokenData.expiration > new Date()) {
        const storedUser = await this.db.getUserStorageData(tokenData.userId);
        user = storedUser?.player ?? null;
        userActiveGames = storedUser?.activeGames ?? [];
      }
    }

    if (user == null) {
      user = await this.createGuestUser();
      const userId = ulid();
      lobbyToken = crypto.randomUUID();
      const expiration = new Date(Date.now() + tokenTtlMs);

      // TODO combine these into one call
      await this.db.createNewUserStorageData(userId, {
        player: user,
        activeGames: [],
      });
      await this.db.storeToken(lobbyToken, { userId, expiration });
      userActiveGames = [];
    }

    if (lobbyToken == null) {
      throw new Error("Missing lobby auth token");
    }
    if (user == null) {
      throw new Error("Missing lobby user");
    }

    return {
      props: {
        allActiveGames,
        allAvailableRooms,
        userActiveGames,
        player: user,
      },
      token: lobbyToken,
    };
  }

  async getInitialGameProps(
    gameId: string,
    token: string | undefined,
  ): Promise<GameProps<PlayerState, PublicState, Outcome>> {
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
    } as GameProps<PlayerState, PublicState, Outcome>;
  }

  async configureLobbySocket(socket: WebSocket, token: string) {
    if (token === "") {
      throw new Error("Missing lobby auth token");
    }

    const tokenData = await this.db.getToken(token);
    if (tokenData == null || tokenData.expiration <= new Date()) {
      throw new Error("Invalid lobby auth token");
    }

    const storedUser = await this.db.getUserStorageData(tokenData.userId);
    if (storedUser == null) {
      throw new Error("Unknown lobby user");
    }

    let user = storedUser.player;
    const userId = tokenData.userId;

    const handleLobbySocketOpen = () => {
      console.log("lobby socket opened");
      this.lobbySocketStore.register(socket, userId, storedUser);
    };

    const handleLobbySocketMessage = async (event: MessageEvent) => {
      const message = event.data;
      console.log("Lobby Socket Message", message);
      const parsedMessage: LobbyClientMessage<Config, Loadout> = JSON.parse(
        message,
      );
      switch (parsedMessage.type) {
        case "Initialize":
          this.lobbySocketStore.initialize(
            socket,
            parsedMessage.allActiveGames,
            parsedMessage.allAvailableRooms,
          );
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
            this.game.isValidLoadout?.(
              parsedMessage.loadout,
              queue.config,
            ) ?? false
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
          await this.lobbySocketStore.joinQueue(
            socket,
            queueConfig,
            userId,
            user,
            parsedMessage.loadout,
            this.game.setup,
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

          await this.lobbySocketStore.createAndJoinRoom(
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
            socket.send(JSON.stringify(
              {
                type: "DisplayError",
                message: "Room not found.",
              },
            ));
            return;
          }
          if (
            this.game.isValidLoadout?.(
              parsedMessage.loadout,
              room.config,
            ) ?? false
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
          const joined = await this.lobbySocketStore.joinRoom(
            socket,
            parsedMessage.roomId,
            room,
            userId,
            user,
            parsedMessage.loadout,
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
              this.game.setup,
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
        case "LeaveMatchmaking":
          await this.lobbySocketStore.leaveMatchmaking(socket);
          break;
        case "UpdateUsername": {
          const newUsername = parsedMessage.username;
          if (newUsername === user.username) {
            break;
          }
          const usernameTaken = await this.db.usernameExists(newUsername);
          if (usernameTaken) {
            break;
          }

          const updatedUser: Player = { ...user, username: newUsername };
          await this.db.updateUserStorageData(userId, { player: updatedUser });
          user = updatedUser;

          break;
        }
      }
    };

    const handleLobbySocketClose = async () => {
      console.log("lobby socket closed");
      await this.lobbySocketStore.unregister(socket);
    };

    socket.addEventListener("open", handleLobbySocketOpen);
    socket.addEventListener("message", handleLobbySocketMessage);
    socket.addEventListener("close", handleLobbySocketClose);
  }

  async configureGameSocket(
    socket: WebSocket,
    gameId: string,
    token: string | undefined,
  ) {
    const userId = await this.getUserIdFromToken(token);
    const gameData = await this.db.getGameStorageData(gameId);
    const playerId = userId == null ? undefined : getPlayerId(gameData, userId);

    const handleGameSocketOpen = () => {
      this.gameSocketStore.register(
        socket,
        gameId,
        this.game.playerState,
        this.game.publicState,
        playerId,
      );
    };

    const handleGameSocketMessage = async (event: MessageEvent) => {
      const request: GameClientMessage<
        Move,
        PlayerState,
        PublicState
      > = JSON.parse(
        event.data,
      );
      switch (request.type) {
        case "Initialize":
          await this.gameSocketStore.initialize(
            socket,
            gameId,
            request.currentPublicState,
            playerId == null ? undefined : request.currentPlayerState,
            this.game.playerState,
            this.game.publicState,
          );
          break;
        case "Move":
          if (playerId == null) {
            break;
          }
          await handleMove(
            this.db,
            this.game,
            gameId,
            playerId,
            request.move,
          );
          break;
      }
    };

    const handleGameSocketClose = () => {
      this.gameSocketStore.unregister(socket, gameId);
    };

    socket.addEventListener("open", handleGameSocketOpen);
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
