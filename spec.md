# `yourturn` Reimplementation Spec (Approximate)

## Scope and goals

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

### Generic Explantions

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

### Authentication Concepts

- A "User" represents a user account.
- A "token" is a string that can point to a "TokenData" object stored in the DB
  to represent a User's authentication status. It is intended that developers
  will store it to a cookie.

### Matchmaking Concepts

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

### Data Concepts

- "ViewData" objects are JSON-serializable data required to render the various
  UIs. They are used for initial page rendering with the `getInitial*ViewData`
  methods, and can be subscribed to with sockets to process changes.
- "Props" objects are provided to the actual Preact components, and include
  ViewData objects as well as additional convenience accessors, and functions
  for communicating over a socket.

## WebSocket protocol

All socket payloads are JSON and discriminated by `type`. These are not part of
the public API, but are already defined in `./common/sockettypes.ts`.

`SocketClientMessage` are messages sent from the client to the server, and
`SocketServerMessage` are messages sent from the server to the client.

### Subscription model

- `Subscribe*` messages kick off watching the db for changes
- client sends current snapshot on subscribe; server uses this as baseline to
  avoid redundant initial updates
- `Unsubscribe*` messages detaches from current stream group

## Server runtime behavior

`InternalServer` class (in `server/gameserver.ts`) is the main orchestrator.

- opens Deno KV with `Deno.openKv()`
- creates `DB` instance, injecting KV
- creates two KV-backed global streams:
  - active public game list changes
  - available public room list changes
- creates `SocketStore`
- returns `Server` wrapper that exposes high-level server methods for auth,
  socket setup, and SSR

### `getUser(token)`

- Looks up the token in the database. If it exists and is valid, returns the
  associated user.
- Otherwise:
  - creates guest user (`guest-0000` style, random 4-digit suffix, retries up to
    10k)
  - generates new token (`crypto.randomUUID()`)
- Write the token (the old valid one, or the newly-created guest one) to the db
  with a fresh 30-day TTL (`expiration` timestamp only; cleanup done separately)

### `configureSocket

### `getInitialActivePublicGames()` and `getInitialAvailablePublicRooms()`

- Fetched directly from DB

### `configureSocket(user, socket)`

- registers `message` and `close` listeners
- `close` always unsubscribes current subscriptions
- handles all `./common/sockettypes.ts` messages appropriately
  - join/create room/loadout validation delegates to
    `game.isValidRoom`/`game.isValidLoadout`
  - queue existence validated against `game.queues`
  - room privacy enforced via invitation checks
  - ProcessMove requires player membership in the game
- errors are generally surfaced via `{ type: "DisplayError", message }`

### `acceptInvitation(user, invitationId)`

- Adds the given invitation to the user matchmaking's `invitations` array

### `getInitial*ViewData`

- Loads the current view data from the database. Used for SSR.

## Client hook behavior

### `useSocket`

Behavior:

- opens `WebSocket(socketUrl)` when mounted and `shouldOpen` is true
- reconnects on unexpected close with exponential backoff:
  - delay `min(30000, 2^attempt - 1)` milliseconds
  - attempts reset to 0 on successful open
- exposes the `Socket` interface

### `use*Channel`

- attaches to an already-open socket
- sends `Subscribe*` once per effect lifecycle (immediately if the socket is
  open, or on open)
- tracks the `*ViewData` within Preact state (useState hook)
- handles viewData updates from the server
- returns full `*Props`, with wrappers that send corresponding client messages
- sends `Unsubscribe*` on unmount

#### `useRoomChannel`

- `createInvitation` generates `invitationId` locally using ULID and returns it
- closes socket if room is deleted or committed

#### `useGameChannel`

- closes socket when `outcome` becomes defined
- `perform` is available only for player sessions (`playerId != null`)

## Persistence model (Deno KV keyspace)

This repo uses key prefixes as table-like partitions.

### Keyspaces and values

- `['tokens', token]` -> `TokenData`
- `['users', userId]` -> `UserStorageData<Config, Loadout, Rating>`
- `['activepublicgames']` -> `ActiveGame<Config>[]`
- `['availablepublicrooms']` -> `AvailableRoom<Config>[]`
- `['queueentry', queueId, entryId]` -> `QueueEntryValue<Loadout>`
- `['rooms', roomId]` -> `RoomStorageData<Config, Loadout>`
- `['roominvitations', invitationId]` -> `RoomInvitation<Config>`
- `['assignments', entryId]` -> `AssignmentStorageData`
- `['games', gameId]` -> `GameStorageData<Config, GameState, Outcome>`

### Transactional pattern

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

## Matchmaking, rooms, and game lifecycle

### Queue flow

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

### Room flow

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

### Invitation flow

- direct user invitations (`inviteUserToRoom`) create a new invitation ID,
  replace prior invite for same room in invitee list, and store invitation key
- URL invitations (`createRoomInvitation`) use caller-provided `invitationId`
- `getRoomInvitation` returns `null` if invitation missing or room missing
- invitation consumption during join removes both user invitation(s) for room
  and corresponding `roominvitations/*` records

### Game state and ratings

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

## Stream/watch infrastructure

### DB watchers

- `watchForAssignments(entryId)` -> emits assignment when present
- `watchForRoomChanges(roomId)`-> emits`{type:'updated', room}` or
  `{type:'deleted'}`
- `watchForGameChanges(gameId)` -> emits non-null game data updates
- `watchForUserMatchmakingChanges(userId)` -> emits hydrated
  `UserMatchmakingData`
- `watchForActiveGameListChanges()` -> emits `ActiveGame[]` (defaults to `[]`)
- `watchForAvailableRoomListChanges()` -> watches room trigger and emits full
  recomputed room list

### Socket store

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

### Equality and update suppression

`jsonEquals(a, b)` is implemented as `JSON.stringify(a) === JSON.stringify(b)`.

This drives suppression of redundant lobby/game updates. Reimplementations
should preserve this semantic (including ordering sensitivity inherent in
stringification).

## Error handling semantics

- many DB and server methods throw on invalid state (missing rows, duplicates,
  etc.)
