import { ulid } from "@std/ulid";
import type {
  ActiveGame,
  AvailableRoom,
  ChatMessage,
  Game,
  Player,
  QueueConfig,
  QueueEntry,
  RoomEntry,
  RoomInvitation,
  TokenData,
} from "../types.ts";
import { assert } from "@std/assert";

type QueueEntryValue<Loadout> = {
  timestamp: Date;
  userId: string;
  user: Player;
  loadout: Loadout;
};

export type RoomStorageData<Config, Loadout> = {
  numPlayers: number;
  config: Config;
  private: boolean;
  members: RoomMember<Loadout>[];
};

type RoomMember<Loadout> = {
  entryId: string;
  timestamp: Date;
  userId: string;
  player: Player;
  loadout: Loadout;
};

export type GameStorageData<Config, GameState, Outcome> = {
  config: Config;
  queueId?: string;
  gameState: GameState;
  userIds: string[];
  players: Player[];
  outcome: Outcome | undefined;
  chat: ChatMessage[];
};

export type AssignmentStorageData = {
  gameId: string;
};

export type UserStorageData<Config, Loadout, Rating> = {
  player: Player;
  activeGames: ActiveGame<Config>[];
  ratings: Record<string, Rating>;
  roomEntries: RoomEntry<Config, Loadout>[];
  queueEntries: QueueEntry<Loadout>[];
  roomInvitations: RoomInvitation<Config>[];
};

function getQueuePrefix(queueId: string) {
  return ["queueentry", queueId];
}

function getQueueEntryKey(queueId: string, entryId: string) {
  return ["queueentry", queueId, entryId];
}
function getRoomPrefix() {
  return ["rooms"];
}
function getRoomKey(roomId: string) {
  return ["rooms", roomId];
}
// Builds the KV key for a URL-based room invitation.
function getRoomInvitationKey(invitationId: string) {
  return ["roominvitations", invitationId];
}
function getAssignmentKey(entryId: string) {
  return ["assignments", entryId];
}
function getRoomListTriggerKey() {
  return ["roomlisttrigger"];
}
function getActiveGamesKey() {
  return ["activegames"];
}
function getGameKey(gameId: string) {
  return ["games", gameId];
}
function getUserKey(userId: string) {
  return ["users", userId];
}
function getUserByUsernameKey(username: string) {
  return ["usersByUsername", username];
}
function getTokenKey(token: string) {
  return ["tokens", token];
}

export class DB<
  Config,
  GameState,
  Move,
  PlayerState,
  PublicState,
  Outcome,
  Rating,
  Loadout,
> {
  private kv: Deno.Kv;
  private game: Game<
    Config,
    GameState,
    Move,
    PlayerState,
    PublicState,
    Outcome,
    Rating,
    Loadout
  >;

  constructor(
    kv: Deno.Kv,
    game: Game<
      Config,
      GameState,
      Move,
      PlayerState,
      PublicState,
      Outcome,
      Rating,
      Loadout
    >,
  ) {
    this.kv = kv;
    this.game = game;
  }

  /**
   * Repeats a transaction operation until it succeeds.
   * Creates a new Deno.AtomicOperation and passes it to the provided function.
   * The function should build up operations on the transaction by mutating it.
   * The function may be async to perform reads before building the transaction.
   * This will keep retrying until the transaction commits successfully.
   */
  private async repeatUntilTransactionSucceeds(
    fn: (transaction: Deno.AtomicOperation) => void | Promise<void>,
  ): Promise<void> {
    let ok = false;
    while (!ok) {
      const transaction = this.kv.atomic();
      await fn(transaction);
      ok = (await transaction.commit()).ok;
    }
  }

  /**
   * Fetches queue configuration for a queue ID or throws if it is missing.
   */
  private getQueueConfig(queueId: string): QueueConfig<Config> {
    const queueConfig = this.game.queues[queueId];
    if (queueConfig == null) {
      throw new Error(`Queue ${queueId} not found`);
    }
    return queueConfig;
  }

  public async addToQueue(
    queueId: string,
    entryId: string,
    userId: string,
    user: Player,
    loadout: Loadout,
  ): Promise<void> {
    const queueConfig = this.getQueueConfig(queueId);
    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const entryKey = getQueueEntryKey(queueId, entryId);
      const userEntry = await this.kv.get<
        UserStorageData<Config, Loadout, Rating>
      >(
        getUserKey(userId),
      );
      if (userEntry.value == null) {
        throw new Error(`User ${userId} not found`);
      }

      const queueEntry: QueueEntry<Loadout> = {
        queueId,
        loadout,
      };
      const updatedUser: UserStorageData<Config, Loadout, Rating> = {
        ...userEntry.value,
        queueEntries: [...userEntry.value.queueEntries, queueEntry],
      };

      transaction
        .check({ key: entryKey, versionstamp: null })
        .set(entryKey, { timestamp: new Date(), userId, user, loadout })
        .check(userEntry)
        .set(getUserKey(userId), updatedUser);
    });

    await this.maybeGraduateFromQueue(queueId, queueConfig);
  }

  public async removeFromQueue(
    queueId: string,
    entryId: string,
  ): Promise<void> {
    const entryKey = getQueueEntryKey(queueId, entryId);

    // First get the entry to find the userId
    const entry = await this.kv.get<QueueEntryValue<Loadout>>(entryKey);
    if (entry.value == null) {
      // Entry already removed, nothing to do
      return;
    }

    const userId = entry.value.userId;

    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const userEntry = await this.kv.get<
        UserStorageData<Config, Loadout, Rating>
      >(
        getUserKey(userId),
      );
      if (userEntry.value == null) {
        throw new Error(`User ${userId} not found`);
      }

      const updatedQueues = userEntry.value.queueEntries.filter(
        (q) => q.queueId !== queueId,
      );
      const updatedUser: UserStorageData<Config, Loadout, Rating> = {
        ...userEntry.value,
        queueEntries: updatedQueues,
      };

      transaction
        .delete(entryKey)
        .check(userEntry)
        .set(getUserKey(userId), updatedUser);
    });
  }

  public async createRoom(
    roomId: string,
    roomConfig: {
      numPlayers: number;
      config: Config;
      private: boolean;
    },
  ): Promise<void> {
    const roomKey = getRoomKey(roomId);
    const roomListTriggerKey = getRoomListTriggerKey();
    const roomData: RoomStorageData<Config, Loadout> = {
      numPlayers: roomConfig.numPlayers,
      config: roomConfig.config,
      private: roomConfig.private,
      members: [],
    };

    await this.repeatUntilTransactionSucceeds((transaction) => {
      transaction
        .check({ key: roomKey, versionstamp: null })
        .set(roomKey, roomData)
        .set(roomListTriggerKey, {});
    });
  }

  public async getRoom(
    roomId: string,
  ): Promise<RoomStorageData<Config, Loadout> | null> {
    const entry = await this.kv.get<RoomStorageData<Config, Loadout>>(
      getRoomKey(roomId),
    );
    return entry.value;
  }

  public async addToRoom(
    roomId: string,
    entryId: string,
    userId: string,
    user: Player,
    loadout: Loadout,
    options?: { consumeInvitation?: boolean },
  ): Promise<void> {
    const roomKey = getRoomKey(roomId);
    const roomListTriggerKey = getRoomListTriggerKey();

    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const roomEntry = await this.kv.get<
        RoomStorageData<Config, Loadout>
      >(
        roomKey,
      );
      if (roomEntry.value == null) {
        throw new Error(`Room ${roomId} not found`);
      }
      const currentMembers = roomEntry.value.members;
      if (currentMembers.some((member) => member.userId === userId)) {
        throw new Error(`User ${userId} already in room ${roomId}`);
      }
      if (currentMembers.length >= roomEntry.value.numPlayers) {
        throw new Error(`Room ${roomId} is full`);
      }

      const userEntry = await this.kv.get<
        UserStorageData<Config, Loadout, Rating>
      >(
        getUserKey(userId),
      );
      if (userEntry.value == null) {
        throw new Error(`User ${userId} not found`);
      }

      const updatedRoom: RoomStorageData<Config, Loadout> = {
        ...roomEntry.value,
        members: [
          ...currentMembers,
          { entryId, timestamp: new Date(), userId, player: user, loadout },
        ],
      };

      // Create the room entry object to add to roomEntries
      const roomEntry2: RoomEntry<Config, Loadout> = {
        roomId,
        numPlayers: roomEntry.value.numPlayers,
        players: updatedRoom.members.map((m) => m.player),
        config: roomEntry.value.config,
        loadout,
      };

      const currentInvitations = userEntry.value.roomInvitations ?? [];
      const invitationsToConsume = options?.consumeInvitation
        ? currentInvitations.filter((invitation) =>
          invitation.roomId === roomId
        )
        : [];
      const updatedInvitations = options?.consumeInvitation
        ? currentInvitations.filter((invitation) =>
          invitation.roomId !== roomId
        )
        : currentInvitations;
      const updatedUser: UserStorageData<Config, Loadout, Rating> = {
        ...userEntry.value,
        roomEntries: [...userEntry.value.roomEntries, roomEntry2],
        roomInvitations: updatedInvitations,
      };

      transaction
        .check(roomEntry)
        .set(roomKey, updatedRoom)
        .set(roomListTriggerKey, {})
        .check(userEntry)
        .set(getUserKey(userId), updatedUser);
      for (const invitation of invitationsToConsume) {
        transaction.delete(getRoomInvitationKey(invitation.invitationId));
      }
    });
  }

  /**
   * Creates or replaces a room invitation for a user.
   * Validates room existence, inviter membership, and invitee eligibility.
   */
  public async inviteUserToRoom(
    roomId: string,
    inviterUserId: string,
    inviteeUserId: string,
  ): Promise<void> {
    if (inviterUserId === inviteeUserId) {
      throw new Error("Cannot invite yourself to a room");
    }

    const roomKey = getRoomKey(roomId);
    const inviteeKey = getUserKey(inviteeUserId);

    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const [roomEntry, inviterEntry, inviteeEntry] = await Promise.all([
        this.kv.get<RoomStorageData<Config, Loadout>>(roomKey),
        this.kv.get<UserStorageData<Config, Loadout, Rating>>(
          getUserKey(inviterUserId),
        ),
        this.kv.get<UserStorageData<Config, Loadout, Rating>>(inviteeKey),
      ]);

      if (roomEntry.value == null) {
        throw new Error(`Room ${roomId} not found`);
      }
      if (inviterEntry.value == null) {
        throw new Error(`User ${inviterUserId} not found`);
      }
      if (inviteeEntry.value == null) {
        throw new Error(`User ${inviteeUserId} not found`);
      }

      const members = roomEntry.value.members;
      const inviterIsMember = members.some((member) =>
        member.userId === inviterUserId
      );
      if (!inviterIsMember) {
        throw new Error(`User ${inviterUserId} is not in room ${roomId}`);
      }

      const inviteeIsMember = members.some((member) =>
        member.userId === inviteeUserId
      );
      if (inviteeIsMember) {
        throw new Error(`User ${inviteeUserId} already in room ${roomId}`);
      }

      const invitationId = ulid();
      const invitation: RoomInvitation<Config> = {
        invitationId,
        roomId,
        numPlayers: roomEntry.value.numPlayers,
        config: roomEntry.value.config,
        invitedBy: inviterEntry.value.player,
        invitedAt: new Date(),
      };

      const existingInvitations = inviteeEntry.value.roomInvitations ?? [];
      const replacedInvitations = existingInvitations.filter((inv) =>
        inv.roomId === roomId
      );
      const updatedInvitations = [
        ...existingInvitations.filter((inv) => inv.roomId !== roomId),
        invitation,
      ];
      const updatedInvitee: UserStorageData<Config, Loadout, Rating> = {
        ...inviteeEntry.value,
        roomInvitations: updatedInvitations,
      };

      transaction
        .check(roomEntry)
        .check(inviteeEntry)
        .set(inviteeKey, updatedInvitee)
        .check({ key: getRoomInvitationKey(invitationId), versionstamp: null })
        .set(getRoomInvitationKey(invitationId), invitation);
      for (const existingInvitation of replacedInvitations) {
        transaction.delete(
          getRoomInvitationKey(existingInvitation.invitationId),
        );
      }
    });
  }

  /**
   * Creates a URL-based invitation for a room that can be redeemed by ID.
   * Validates room existence and inviter membership before storing.
   */
  public async createRoomInvitation(
    invitationId: string,
    roomId: string,
    inviterUserId: string,
  ): Promise<void> {
    const roomKey = getRoomKey(roomId);
    const invitationKey = getRoomInvitationKey(invitationId);

    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const [roomEntry, inviterEntry, invitationEntry] = await Promise.all([
        this.kv.get<RoomStorageData<Config, Loadout>>(roomKey),
        this.kv.get<UserStorageData<Config, Loadout, Rating>>(
          getUserKey(inviterUserId),
        ),
        this.kv.get<RoomInvitation<Config>>(invitationKey),
      ]);

      if (roomEntry.value == null) {
        throw new Error(`Room ${roomId} not found`);
      }
      if (inviterEntry.value == null) {
        throw new Error(`User ${inviterUserId} not found`);
      }
      if (invitationEntry.value != null) {
        throw new Error(`Invitation ${invitationId} already exists`);
      }

      const members = roomEntry.value.members;
      const inviterIsMember = members.some((member) =>
        member.userId === inviterUserId
      );
      if (!inviterIsMember) {
        throw new Error(`User ${inviterUserId} is not in room ${roomId}`);
      }

      const invitation: RoomInvitation<Config> = {
        invitationId,
        roomId,
        numPlayers: roomEntry.value.numPlayers,
        config: roomEntry.value.config,
        invitedBy: inviterEntry.value.player,
        invitedAt: new Date(),
      };

      transaction
        .check(roomEntry)
        .check(inviterEntry)
        .check({ key: invitationKey, versionstamp: null })
        .set(invitationKey, invitation);
    });
  }

  /**
   * Fetches a URL-based invitation by ID, returning null if it is missing.
   */
  public async getRoomInvitation(
    invitationId: string,
  ): Promise<RoomInvitation<Config> | null> {
    const invitationEntry = await this.kv.get<RoomInvitation<Config>>(
      getRoomInvitationKey(invitationId),
    );
    if (invitationEntry.value == null) {
      return null;
    }
    const roomEntry = await this.kv.get<RoomStorageData<Config, Loadout>>(
      getRoomKey(invitationEntry.value.roomId),
    );
    if (roomEntry.value == null) {
      return null;
    }
    return invitationEntry.value;
  }

  /**
   * Checks if a user has an invitation to a specific room.
   */
  public async hasRoomInvitation(
    userId: string,
    roomId: string,
  ): Promise<boolean> {
    const entry = await this.kv.get<UserStorageData<Config, Loadout, Rating>>(
      getUserKey(userId),
    );
    if (entry.value == null) {
      return false;
    }
    return (entry.value.roomInvitations ?? []).some((invitation) =>
      invitation.roomId === roomId
    );
  }

  /**
   * Removes a room invitation from a user's stored data if present.
   */
  public async removeRoomInvitation(
    userId: string,
    roomId: string,
  ): Promise<void> {
    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const userEntry = await this.kv.get<
        UserStorageData<Config, Loadout, Rating>
      >(
        getUserKey(userId),
      );
      if (userEntry.value == null) {
        throw new Error(`User ${userId} not found`);
      }

      const existingInvitations = userEntry.value.roomInvitations ?? [];
      const invitationsToRemove = existingInvitations.filter((invitation) =>
        invitation.roomId === roomId
      );
      const nextInvitations = existingInvitations.filter((invitation) =>
        invitation.roomId !== roomId
      );
      if (nextInvitations.length === existingInvitations.length) {
        return;
      }

      const updatedUser: UserStorageData<Config, Loadout, Rating> = {
        ...userEntry.value,
        roomInvitations: nextInvitations,
      };

      transaction
        .check(userEntry)
        .set(getUserKey(userId), updatedUser);
      for (const invitation of invitationsToRemove) {
        transaction.delete(getRoomInvitationKey(invitation.invitationId));
      }
    });
  }

  public async removeFromRoom(
    roomId: string,
    entryId: string,
  ): Promise<void> {
    const roomKey = getRoomKey(roomId);
    const roomListTriggerKey = getRoomListTriggerKey();

    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const roomEntry = await this.kv.get<
        RoomStorageData<Config, Loadout>
      >(
        roomKey,
      );
      if (roomEntry.value == null) {
        throw new Error(`Attempted to remove from non-existant room ${roomId}`);
      }
      const members = roomEntry.value.members;
      const memberIndex = members.findIndex(
        (member) => member.entryId === entryId,
      );
      if (memberIndex === -1) {
        throw new Error(
          `Attempted to remove non-existing entry ${entryId} room ${roomId}`,
        );
      }

      const userId = members[memberIndex].userId;
      const userEntry = await this.kv.get<
        UserStorageData<Config, Loadout, Rating>
      >(
        getUserKey(userId),
      );
      if (userEntry.value == null) {
        throw new Error(`User ${userId} not found`);
      }

      const nextMembers = members.toSpliced(memberIndex, 1);

      // Remove this room from the user's roomEntries
      const updatedRooms = userEntry.value.roomEntries.filter(
        (r) => r.roomId !== roomId,
      );
      const updatedUser: UserStorageData<Config, Loadout, Rating> = {
        ...userEntry.value,
        roomEntries: updatedRooms,
      };

      transaction
        .check(roomEntry)
        .set(roomListTriggerKey, {})
        .check(userEntry)
        .set(getUserKey(userId), updatedUser);

      if (nextMembers.length === 0) {
        transaction.delete(roomKey);
      } else {
        transaction.set(roomKey, {
          ...roomEntry.value,
          members: nextMembers,
        });
      }
    });
  }

  // Creates a new game record and updates global and user-specific active game lists
  // by mutating the provided transaction.
  private async createNewGameOnOperation(
    transaction: Deno.AtomicOperation,
    options: {
      activeGamesKey: Deno.KvKey;
      config: Config;
      gameId: string;
      loadouts: Loadout[];
      queueId?: string;
      userIds: string[];
    },
  ): Promise<void> {
    const gameKey = getGameKey(options.gameId);
    const timestamp = new Date();
    // Fetch active games and user records needed to build the new game state.
    const userKeys = options.userIds.map((userId) => getUserKey(userId));
    const [activeGamesEntry, userEntries] = await Promise.all([
      this.kv.get<ActiveGame<Config>[]>(options.activeGamesKey),
      this.kv.getMany<UserStorageData<Config, Loadout, Rating>[]>(userKeys),
    ]);

    // Validate that all users exist.
    for (const userEntry of userEntries) {
      assert(userEntry.value != null);
    }
    const players = userEntries.map((userEntry) => userEntry.value!.player);

    // Build the new game state and active game payloads.
    const setupObject = {
      timestamp,
      numPlayers: options.userIds.length,
      config: options.config,
      loadouts: options.loadouts,
    };
    const gameState = this.game.setup(setupObject);
    const gameStorageData: GameStorageData<Config, GameState, Outcome> = {
      config: options.config,
      queueId: options.queueId,
      gameState,
      userIds: options.userIds,
      players,
      outcome: undefined,
      chat: [],
    };

    // Build the new allActiveGames
    const allActiveGames = activeGamesEntry.value ?? [];
    const activeGame: ActiveGame<Config> = {
      gameId: options.gameId,
      players,
      config: options.config,
      created: timestamp,
    };
    const activeGamesNext = [...allActiveGames, activeGame];

    // Mutate the provided transaction with game + active lists + user updates.
    transaction
      .check(activeGamesEntry)
      .set(options.activeGamesKey, activeGamesNext)
      .check({ key: gameKey, versionstamp: null })
      .set(gameKey, gameStorageData);

    for (const userEntry of userEntries) {
      const userActiveGamesNext = [
        ...userEntry.value!.activeGames ?? [],
        activeGame,
      ];

      const updatedUser: UserStorageData<Config, Loadout, Rating> = {
        ...userEntry.value!,
        activeGames: userActiveGamesNext,
      };

      transaction
        .check(userEntry)
        .set(userEntry.key, updatedUser);
    }
  }

  public async commitRoom(
    roomId: string,
  ): Promise<void> {
    const roomKey = getRoomKey(roomId);
    const roomListTriggerKey = getRoomListTriggerKey();
    const activeGamesKey = getActiveGamesKey();

    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const roomEntry = await this.kv.get<RoomStorageData<Config, Loadout>>(
        roomKey,
      );
      if (roomEntry.value == null) {
        throw new Error(`Room ${roomId} not found`);
      }
      const members = roomEntry.value.members;
      if (members.length < roomEntry.value.numPlayers) {
        throw new Error(`Room ${roomId} does not have enough players`);
      }

      const userIds: string[] = [];
      const loadouts: Loadout[] = [];
      for (let i = 0; i < roomEntry.value.numPlayers; i++) {
        userIds[i] = members[i].userId;
        loadouts[i] = members[i].loadout;
      }

      const config = roomEntry.value.config;
      const gameId = ulid();
      await this.createNewGameOnOperation(
        transaction,
        {
          activeGamesKey,
          config,
          gameId,
          loadouts,
          userIds,
        },
      );

      transaction
        .check(roomEntry)
        .set(roomListTriggerKey, {})
        .delete(roomKey);

      // Fetch all user entries to update their joinedRooms
      const userKeys = userIds.map((userId) => getUserKey(userId));
      const userEntries = await this.kv.getMany<
        UserStorageData<Config, Loadout, Rating>[]
      >(userKeys);

      for (let i = 0; i < roomEntry.value.numPlayers; i++) {
        const member = members[i];
        const entryId = member.entryId;
        const assignmentKey = getAssignmentKey(entryId);
        const assignmentValue: AssignmentStorageData = { gameId };

        const userEntry = userEntries[i];
        if (userEntry.value == null) {
          throw new Error(`User ${userIds[i]} not found`);
        }

        // Remove this room from the user's roomEntries
        const updatedRooms = userEntry.value.roomEntries.filter(
          (r) => r.roomId !== roomId,
        );
        const updatedUser: UserStorageData<Config, Loadout, Rating> = {
          ...userEntry.value,
          roomEntries: updatedRooms,
        };

        transaction
          .check({ key: assignmentKey, versionstamp: null })
          .set(assignmentKey, assignmentValue)
          .check(userEntry)
          .set(userKeys[i], updatedUser);
      }
    });
  }

  private async maybeGraduateFromQueue(
    queueId: string,
    queueConfig: QueueConfig<Config>,
  ): Promise<void> {
    const queuePrefix = getQueuePrefix(queueId);
    const activeGamesKey = getActiveGamesKey();

    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      // Get desired queue entries, if they exist
      const queueEntries = await Array.fromAsync(
        this.kv.list<QueueEntryValue<Loadout>>(
          { prefix: queuePrefix },
          { limit: queueConfig.numPlayers },
        ),
      );
      // If the queue doesn't have enough entrants, stop
      if (queueEntries.length < queueConfig.numPlayers) {
        return; // Nothing to do
      }

      // Initialize Game Storage Data
      const userIds: string[] = [];

      for (let i = 0; i < queueConfig.numPlayers; i++) {
        userIds[i] = queueEntries[i].value.userId;
      }
      const loadouts: Loadout[] = [];
      for (let i = 0; i < queueConfig.numPlayers; i++) {
        loadouts[i] = queueEntries[i].value.loadout;
      }
      const gameId = ulid();
      await this.createNewGameOnOperation(
        transaction,
        {
          activeGamesKey,
          config: queueConfig.config,
          gameId,
          loadouts,
          queueId,
          userIds,
        },
      );

      // Fetch all user entries to update their joinedQueues
      const userKeys = userIds.map((userId) => getUserKey(userId));
      const userEntries = await this.kv.getMany<
        UserStorageData<Config, Loadout, Rating>[]
      >(userKeys);

      // For each player
      for (let i = 0; i < queueEntries.length; i++) {
        const entry = queueEntries[i];
        const entryId = entry.key[2] as string;
        const assignmentKey = getAssignmentKey(entryId);
        const assignmentValue: AssignmentStorageData = {
          gameId,
        };

        const userEntry = userEntries[i];
        if (userEntry.value == null) {
          throw new Error(`User ${userIds[i]} not found`);
        }

        // Remove this queue from the user's queueEntries
        const updatedQueues = userEntry.value.queueEntries.filter(
          (q) => q.queueId !== queueId,
        );
        const updatedUser: UserStorageData<Config, Loadout, Rating> = {
          ...userEntry.value,
          queueEntries: updatedQueues,
        };

        // Delete their queue entry, add an assignment, and update user data
        transaction
          .check(entry)
          .delete(entry.key)
          .check({ key: assignmentKey, versionstamp: null })
          .set(assignmentKey, assignmentValue)
          .check(userEntry)
          .set(userKeys[i], updatedUser);
      }
    });
  }

  public watchForAssignments(
    entryId: string,
  ): ReadableStream<AssignmentStorageData> {
    const key = getAssignmentKey(entryId);
    const stream = this.kv.watch([key]);
    return stream.pipeThrough(
      new TransformStream({
        transform(events, controller) {
          const data = events[0].value as AssignmentStorageData;
          if (data != null) {
            controller.enqueue(data);
          }
        },
      }),
    );
  }

  /**
   * Updates game storage data.
   * @param gameId The ID of the game to update
   * @param gameData The updated game data
   */
  public async updateGameStorageData(
    gameId: string,
    gameData: GameStorageData<Config, GameState, Outcome>,
  ): Promise<void> {
    const gameKey = getGameKey(gameId);
    const activeGamesKey = getActiveGamesKey();

    const entry = await this.kv.get<
      GameStorageData<Config, GameState, Outcome>
    >(
      gameKey,
    );
    if (entry.value == null) {
      throw new Error(`Appending moves to unstored ${gameId}`);
    }

    let transaction = this.kv.atomic()
      .check(entry)
      .set(gameKey, gameData);

    if (gameData.outcome !== undefined) {
      const activeGamesEntry = await this.kv.get<ActiveGame<Config>[]>(
        activeGamesKey,
      );
      const allActiveGames = activeGamesEntry.value ?? [];
      const activeGamesNext = allActiveGames.filter((game) =>
        game.gameId !== gameId
      );
      transaction = transaction
        .check(activeGamesEntry)
        .set(activeGamesKey, activeGamesNext);
    }

    const res = await transaction.commit();

    if (!res.ok) {
      throw new Error(`Failed to update game ${gameId}`);
    }
  }

  public async getGameStorageData(
    gameId: string,
  ): Promise<GameStorageData<Config, GameState, Outcome>> {
    const gameKey = getGameKey(gameId);
    const entry = await this.kv.get<
      GameStorageData<Config, GameState, Outcome>
    >(
      gameKey,
    );
    if (entry.value == null) {
      throw new Error(`Game ${gameId} not found`);
    } else {
      return entry.value;
    }
  }

  public watchForGameChanges(
    gameId: string,
  ): ReadableStream<GameStorageData<Config, GameState, Outcome>> {
    const gameKey = getGameKey(gameId);
    const stream = this.kv.watch<GameStorageData<Config, GameState, Outcome>[]>(
      [gameKey],
    );
    return stream.pipeThrough(
      new TransformStream({
        transform(events, controller) {
          const data = events[0].value;
          if (data != null) {
            controller.enqueue(data);
          }
        },
      }),
    );
  }

  public async getAllActiveGames(): Promise<ActiveGame<Config>[]> {
    const entry = await this.kv.get<ActiveGame<Config>[]>(
      getActiveGamesKey(),
    );
    return entry.value ?? [];
  }

  // Watches for changes to the active game list key.
  public watchForActiveGameListChanges(): ReadableStream<ActiveGame<Config>[]> {
    const activeGamesKey = getActiveGamesKey();
    const stream = this.kv.watch([activeGamesKey]);
    return stream.pipeThrough(
      new TransformStream({
        transform: (events, controller) => {
          const data = events[0].value as ActiveGame<Config>[] | null;
          controller.enqueue(data ?? []);
        },
      }),
    );
  }

  public async getAllAvailableRooms(): Promise<AvailableRoom<Config>[]> {
    const roomPrefix = getRoomPrefix();
    const iter = this.kv.list<RoomStorageData<Config, Loadout>>(
      { prefix: roomPrefix },
    );
    const rooms: AvailableRoom<Config>[] = [];

    for await (const res of iter) {
      const roomId = res.key[res.key.length - 1] as string;
      const room = res.value;
      if (room.private) {
        continue;
      }
      const players = (room.members ?? []).map((member) => member.player);
      rooms.push({
        roomId,
        numPlayers: room.numPlayers,
        players,
        config: room.config,
      });
    }

    return rooms;
  }

  public watchForAvailableRoomListChanges(): ReadableStream<
    AvailableRoom<Config>[]
  > {
    const roomListTriggerKey = getRoomListTriggerKey();
    const stream = this.kv.watch([roomListTriggerKey]);
    return stream.pipeThrough(
      new TransformStream({
        transform: async (_events, controller) => {
          const rooms = await this.getAllAvailableRooms();
          controller.enqueue(rooms);
        },
      }),
    );
  }

  // Creates a new user record and username index entry if neither already exists.
  public async createNewUserStorageData(
    userId: string,
    data: UserStorageData<Config, Loadout, Rating>,
  ): Promise<void> {
    const userKey = getUserKey(userId);
    const usernameKey = getUserByUsernameKey(data.player.username);
    const res = await this.kv.atomic()
      .check({ key: userKey, versionstamp: null })
      .check({ key: usernameKey, versionstamp: null })
      .set(userKey, data)
      .set(usernameKey, userId)
      .commit();
    if (!res.ok) {
      throw new Error(
        `User ${userId} or username ${data.player.username} already exists`,
      );
    }
  }

  // Upserts user storage data and keeps the username index in sync.
  public async updateUserStorageData(
    userId: string,
    data: Partial<UserStorageData<Config, Loadout, Rating>>,
  ): Promise<void> {
    await this.repeatUntilTransactionSucceeds(async (transaction) => {
      const entry = await this.kv.get<UserStorageData<Config, Loadout, Rating>>(
        getUserKey(userId),
      );
      if (entry.value == null) {
        throw new Error(`Updating unstored user ${userId}`);
      }
      const existingData = entry.value;

      const updatedData: UserStorageData<Config, Loadout, Rating> = {
        ...existingData,
        ...data,
      };

      const previousUsername = existingData.player.username;
      const updatedUsername = updatedData.player.username;
      transaction
        .check(entry)
        .set(getUserKey(userId), updatedData);
      if (previousUsername !== updatedUsername) {
        transaction
          .delete(getUserByUsernameKey(previousUsername))
          .set(getUserByUsernameKey(updatedUsername), userId);
      } else {
        transaction.set(getUserByUsernameKey(previousUsername), userId);
      }
    });
  }

  // Fetches the stored user data for a userId, if present.
  public async getUserStorageData(
    userId: string,
  ): Promise<UserStorageData<Config, Loadout, Rating> | null> {
    const entry = await this.kv.get<UserStorageData<Config, Loadout, Rating>>(
      getUserKey(userId),
    );
    return entry.value;
  }

  // Watches for changes to a single user's stored data.
  public watchForUserChanges(
    userId: string,
  ): ReadableStream<UserStorageData<Config, Loadout, Rating>> {
    const userKey = getUserKey(userId);
    const stream = this.kv.watch<UserStorageData<Config, Loadout, Rating>[]>([
      userKey,
    ]);
    return stream.pipeThrough(
      new TransformStream({
        transform(events, controller) {
          const data = events[0].value;
          if (data != null) {
            controller.enqueue(data);
          }
        },
      }),
    );
  }

  public async usernameExists(username: string): Promise<boolean> {
    const entry = await this.kv.get<string>(getUserByUsernameKey(username));
    return entry.value != null;
  }

  public async storeToken(token: string, tokenData: TokenData): Promise<void> {
    const res = await this.kv.atomic()
      .set(getTokenKey(token), tokenData)
      .commit();
    if (!res.ok) {
      throw new Error(`Failed to store token`);
    }
  }

  public async getToken(token: string): Promise<TokenData | null> {
    const entry = await this.kv.get<TokenData>(getTokenKey(token));
    return entry.value ?? null;
  }
}
