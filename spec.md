# `yourturn` Reimplementation Spec (Approximate)

## 1. Scope and goals

This spec describes the current architecture and behavior of the `yourturn`.

The project is a Deno module with three public entry points, already defined:

- `./server` (`server.ts`)
- `./hooks` (`hooks.ts`)
- `./types` (`types.ts`)

It is a framework for developing turn-based multiplayer browser games. It
provides:

- user authentication, with guest user support
- turn based game framework with Generics (game state, moves, public and private
  state views, etc)
- server-side game runtime + matchmaking over WebSockets backed by Deno KV
- client-side Preact hooks for creating and communicating over sockets
- shared type contracts for games, views, and socket payloads

### 1.1 Generic Explantions

Developers are intended to create a `Game` object and define the following
generic properties:

- Config: Configuration options for the game (e.g. game length, ruleset, board
  size)
- GameState: Server-side representation of the game state (stored to the DB)
  (e.g. deck contents)
- Move: Representation of an individual player action
- PlayerState: Representation of player-specific information (non-public) (e.g.
  hand contents)
- PublicState: Representation of public game state information (e.g. score)
- Outcome: Representation of the game outcome (e.g. winner)
- Rating: Representation of player rating, which is client-implementable (e.g.
  Elo, Glicko, etc)
- Loadout: Representation of a players pre-game choices (e.g. deck, starting
  position)

### 1.2 Authentication Concepts

- A "User" represents a user account.
- A "token" is a string that can point to a "TokenData" object stored in the DB
  to represent a User's authentication status. It is intended that developers
  will store it to a cookie.

### 1.3 Matchmaking Concepts

- A "Game" represents an instance of a Game that has already started (and may
  already have completed).
- A "Queue" is defined statically by the developer, with a set Config. It is
  used for automatic matchmaking, and can be used to support ranked play.
- A "QueueEntry" represents a user's entry into a Queue.
- An "Assignment" represents a user's assignment to a Game, after "graduating"
  from a Queue.
- A "Room" is used for individual matchmaking, either by users joining public
  rooms, or being invited to rooms. Once full, a Room can be "committed" to
  create a Game.
- An "Invitation" represents a request to join a Room.
- An "ActiveGame" represents a game that is currently in progress.
- An "AvailableRoom" represents a room that is currently available for joining.

### 1.4 Data Concepts

- "ViewData" objects are JSON-serializable data required to render the various
  UIs. They are used for initial page rendering with the `getInitial*ViewData`
  methods, and can be subscribed to with sockets to process changes.
- "Props" objects are provided to the actual Preact components, and include
  ViewData objects as well as additional convenience accessors, and functions
  for communicating over a socket.

## 3. WebSocket protocol

All socket payloads are JSON and discriminated by `type`. These are not part of
the public API, but are already defined in `./common/sockettypes.ts`.

`SocketClientMessage` are messages sent from the client to the server, and
`SocketServerMessage` are messages sent from the server to the client.

### 3.1 Subscription model

- `Subscribe*` messages kick off watching the db for changes
- client sends current snapshot on subscribe; server uses this as baseline to
  avoid redundant initial updates
- `Unsubscribe*` messages detaches from current stream group

## 4. Server runtime behavior

`InternalServer` class (in `server/gameserver.ts`) is the main orchestrator.

- opens Deno KV with `Deno.openKv()`
- creates `DB` instance, injecting KV
- creates two KV-backed global streams:
  - active public game list changes
  - available public room list changes
- creates `SocketStore`
- returns `Server` wrapper that exposes high-level server methods for auth,
  socket setup, and SSR

###

### 4.1 `getInitialUserViewData(user)`

- always fetches global lists: active games and available rooms
- if token exists and is unexpired, loads existing user lobby data
- if no valid user:
  - creates guest user (`guest-0000` style, random 4-digit suffix, retries up to
    10k)
  - generates new token (`crypto.randomUUID()`)
  - stores token with 30-day TTL (`expiration` timestamp only; cleanup is
    logical on read)
  - initializes ratings for all ranked queues via `initialRating()`
  - if `invitationId` provided and exists, includes invitation in new user data
- if valid user + `invitationId` exists and missing from user invitations,
  merges it and persists
- returns `{ props: LobbyProps, token }`

### 4.2 `getInitialGameProps(gameId, token)`

- loads `GameStorageData`
- resolves `playerId` from token user membership in `gameData.userIds`
- computes public state via `game.publicState`
- computes player state only when `playerId` exists
- returns union-compatible `GameProps`

### 4.3 `configureSocket(socket, token)`

- resolves `userId` from token once
- registers `message` and `close` listeners
- `close` always unsubscribes current subscription
- per-message validation/enforcement:
  - lobby-only operations require current subscription `lobby` and valid
    `userId`/user
  - join/create room/loadout validation delegates to
    `game.isValidRoom`/`game.isValidLoadout`
  - queue existence validated against `game.queues`
  - room privacy enforced via invitation checks
  - move only allowed during `game` subscription (requires player membership)
- errors are generally surfaced via `{ type: "DisplayError", message }`

## 5. Client hook behavior

### 5.1 `useSocket`

Signature:

```ts
export function useSocket<Req, Res>(
  shouldOpen: boolean,
  socketUrl: string,
  initializeMessage: Req,
  onMessage: (res: Res, close: () => void) => void,
  onClose?: () => void,
): Socket;
```

Behavior:

- opens `WebSocket(socketUrl)` when mounted and `shouldOpen` is true
- sends `initializeMessage` on open
- parses every incoming message as JSON and forwards to `onMessage`
- reconnects on unexpected close with exponential backoff:
  - delay `min(30000, 2^attempt - 1)` milliseconds
  - attempts reset to 0 on successful open
- exposes `addEventListener`, `removeEventListener`, `send`, `close`

### 5.2 `useLobbySocket`

- attaches to an already-open socket
- sends `SubscribeLobby` once per effect lifecycle (on open and best-effort
  immediately)
- handles server lobby messages:
  - partial lobby prop updates
  - display error -> callback
- returns full `LobbyProps` with command wrappers that send corresponding client
  messages
- `createInvitation` generates `invitationId` locally using ULID and returns it

### 5.3 `useGameSocket`

- attaches to an already-open socket
- sends `SubscribeGame` if game not complete locally
- handles `UpdateGameState` and updates local state
- closes socket when `outcome` becomes defined
- `perform` is available only for player sessions (`playerId != null`)

### 5.4 `userRoomSocket`

- attaches to an already-open socket
- sends `SubscribeRoom` once per effect lifecycle (on open and best-effort
  immediately)
- handles `UpdateRoom` and updates local state
- closes socket if room is deleted or committed

## 6. Persistence model (Deno KV keyspace)

This repo uses key prefixes as table-like partitions.

### 6.1 Keyspaces and values

- `['queueentry', queueId, entryId]` -> `QueueEntryValue<Loadout>`
  - `{ timestamp, userId, user: Player, loadout }`
- `['rooms', roomId]` -> `RoomStorageData<Config, Loadout>`
  - `{ numPlayers, config, private, members: RoomMember[] }`
- `['roominvitations', invitationId]` -> `RoomInvitation<Config>`
- `['assignments', entryId]` -> `AssignmentStorageData`
  - `{ gameId }`
- `['roomlisttrigger']` -> marker object for room list invalidation
- `['activegames']` -> `ActiveGame<Config>[]`
- `['games', gameId]` -> `GameStorageData<Config, GameState, Outcome>`
  - `{ config, queueId?, gameState, userIds, players, outcome }`
- `['users', userId]` -> `UserStorageData<Config, Loadout, Rating>`
  - `{ player, activeGames, ratings, joinedRooms, queueEntries, roomInvitations }`
- `['usersByUsername', username]` -> `userId`
- `['tokens', token]` -> `TokenData`

### 6.2 Derived/hydrated lobby shape

`LobbyUserData` is not stored directly. It is derived from `UserStorageData` by
hydrating:

- `joinedRooms` + room records -> `roomEntries`

### 6.3 Transactional pattern

Mutable operations use optimistic retries via:

```ts
async function repeatUntilTransactionSucceeds(
  fn: (transaction: Deno.AtomicOperation) => void | Promise<void>,
): Promise<void> {
  let ok = false;
  while (!ok) {
    const transaction = this.kv.atomic();
    await fn(transaction);
    ok = (await transaction.commit()).ok;
  }
}
```

The callback issues `.check(...)` guards and writes; if commit fails, retries
indefinitely.

## 7. Matchmaking, rooms, and game lifecycle

### 7.1 Queue flow

- `addToQueue`:
  - asserts queue exists
  - inserts queue entry
  - appends queue record to user `queueEntries`
  - then calls `maybeGraduateFromQueue`
- `maybeGraduateFromQueue`:
  - reads first `numPlayers` queue entries
  - if enough entrants:
    - creates game via shared helper
    - deletes consumed queue entries
    - stores assignment per `entryId`
    - removes queue from each user's `queueEntries`

### 7.2 Room flow

- `createRoom` creates room with empty members and toggles room list trigger
- `addToRoom` validates existence/capacity/non-membership, appends member,
  updates user joined rooms, optionally consumes invitations
- `removeFromRoom` removes member by `entryId`; deletes room when last member
  leaves; toggles room list trigger
- `commitRoom` requires enough members and:
  - creates game from first `numPlayers` members
  - writes assignment for each member entry
  - removes room membership from each user's `joinedRooms`
  - deletes room and toggles room list trigger

### 7.3 Invitation flow

- direct user invitations (`inviteUserToRoom`) create a new invitation ID,
  replace prior invite for same room in invitee list, and store invitation key
- URL invitations (`createRoomInvitation`) use caller-provided `invitationId`
- `getRoomInvitation` returns `null` if invitation missing or room missing
- invitation consumption during join removes both user invitation(s) for room
  and corresponding `roominvitations/*` records

### 7.4 Game state and ratings

- moves are validated with `isValidMove`; invalid moves are ignored
- valid moves call `processMove`; game record updated with new state
- outcome recomputed after each valid state update
- when outcome becomes defined:
  - game removed from global active game list
  - if game came from ranked queue (`queueId` + `queueType: 'ranked'`):
    - current ratings loaded per player (`existing or initialRating()`)
    - `processOutcome(outcome, ratings)` called
    - length must match player count
    - per-user ratings updated at key `ratings[queueId]`

## 8. Stream/watch infrastructure

### 8.1 DB watchers

- `watchForAssignments(entryId)` -> emits assignment when present
- `watchForRoomChanges(roomId)`-> emits`{type:'updated', room}` or
  `{type:'deleted'}`
- `watchForGameChanges(gameId)` -> emits non-null game data updates
- `watchForLobbyUserChanges(userId)` -> emits hydrated `LobbyUserData`
- `watchForActiveGameListChanges()` -> emits `ActiveGame[]` (defaults to `[]`)
- `watchForAvailableRoomListChanges()` -> watches room trigger and emits full
  recomputed room list

### 8.2 Socket store

`SocketStore` keeps per-socket connection state:

- cached last values for diff-based updates
- user changes reader
- matchmaking entries (queue/room subscriptions)

Responsibilities:

- subscribe/unsubscribe lobby sockets
- fan out global active-game/available-room streams
- watch user stream and send `UpdateLobbyProps` diffs
- maintain per-room watchers for joined rooms
- emit `UpdateRoomEntry`/`RemoveRoomEntry`
- emit `GameAssignment` when assignment stream fires
- map `gameId -> { gameSockets, changesReader }`
- each socket stores `playerId` and last sent snapshot
- on game changes:
  - compute shared `publicState` once
  - compute `playerState` per subscribed player socket
  - send `UpdateGameState` only when JSON snapshot changed
- per-game watcher is cleaned up when last socket unsubscribes

### 8.3. Equality and update suppression

`jsonEquals(a, b)` is implemented as `JSON.stringify(a) === JSON.stringify(b)`.

This drives suppression of redundant lobby/game updates. Reimplementations
should preserve this semantic (including ordering sensitivity inherent in
stringification).

## 10. Error handling semantics

- many DB and server methods throw on invalid state (missing rows, duplicates,
  etc.)
- socket layer often catches and maps failures to `DisplayError`, if they could
  be resolved by the end user
