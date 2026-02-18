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

### Generic Explanations

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
- Outcome: Representation of the game outcome (e.g. winner). Must be non-null;
  `GameViewData.outcome = null` represents an in-progress game.
- Rating: Representation of player rating, which is client-implementable (e.g.
  Elo, Glicko, etc)
- Loadout: Representation of a players pre-game choices (e.g. deck, starting
  position)

### Authentication Concepts

- A "User" represents a user account.
- A "token" is a string that can point to a "TokenData" object stored in the DB
  to represent a User's authentication status. It is intended that developers
  will store it to a cookie.
- all server-generated identifiers used in KV keys are ULIDs generated with
  `jsr:@std/ulid` (`userId`, `token`, `entryId`, `roomId`, `gameId`)

### Matchmaking Concepts

- A "Game" represents an instance of a Game that has already started (and may
  already have completed).
- A "Queue" is defined statically by the developer, with a set Config. It is
  used for automatic matchmaking, and can be used to support ranked play.
- A "QueueEntry" represents a user's entry into a Queue.
- Queue invariant: a user can have at most one active QueueEntry per `queueId`.
- A user may be in queues and rooms at the same time.
- A "Room" is used for player-driven matchmaking, either by users joining public
  rooms, or being invited to rooms. This also supports 1-to-1 challenges. Once
  full, a Room can be "committed" to create a Game.
- An "Invitation" represents user access to a private Room, keyed by `roomId`
  rather than by a separate invitation ID.
- An "ActivePublicGame" represents a game that is currently in progress and
  visible in the global public game list.
- A "UserActiveGame" represents an active game attached to a specific user's
  matchmaking view. It must include exactly one origin source:
  `queueEntryId` or `roomId`.
- An "AvailableRoom" represents a room that is currently available for joining.

### Data Concepts

- "*ViewData" objects are JSON-serializable data required to render the various
  UIs. They are used for initial page rendering with the `getInitial*ViewData`
  methods, and can be subscribed to with sockets to process changes.
- view timestamps exposed to clients are JSON-safe strings (ISO 8601), not
  `Date` instances.
- queue state is not exposed as a standalone channel; it is part of
  `UserMatchmakingViewData`.
- `UserMatchmakingViewData` contains incoming room invitations.
- incoming invitation view data is keyed by `roomId` and does not include
  inviter identity.
- private room links use `roomId` as the secret token.
- room loadouts are private. Room-facing view data includes only the requesting
  user's loadout (`yourLoadout`) and never exposes other room members' loadouts.
- `GameViewData` uses `null` (not `undefined`) for observer-only fields and
  missing outcome values to remain JSON-safe.
- runtime game logic may still use `undefined` for incomplete outcome; server
  serialization maps that state to `GameViewData.outcome = null`.
- "\*Props" objects are provided to the actual Preact components, and include
  ViewData objects as well as additional convenience accessors, and functions
  for communicating over a socket.

## WebSocket protocol

All socket payloads are JSON and discriminated by `type`. These are not part of
the public API, but are already defined in `./common/sockettypes.ts`.

`SocketClientMessage` are messages sent from the client to the server, and
`SocketServerMessage` are messages sent from the server to the client.

Server-originated runtime errors are delivered with a typed `ServerError`
message (`code`, `message`). Clients treat these as global UI errors (for
example toast notifications), without channel-specific targeting metadata.

`ServerError.code` uses a closed union exported from `./types`:
`AUTH_INVALID`, `AUTH_REQUIRED`, `USER_NOT_FOUND`,
`ACTIVE_PUBLIC_GAMES_NOT_FOUND`, `AVAILABLE_PUBLIC_ROOMS_NOT_FOUND`,
`QUEUE_NOT_FOUND`, `QUEUE_ALREADY_JOINED`, `QUEUE_ENTRY_NOT_FOUND`,
`ROOM_NOT_FOUND`, `ROOM_ALREADY_JOINED`, `ROOM_FULL`, `ROOM_CONFIG_INVALID`,
`ROOM_NOT_READY`, `GAME_NOT_FOUND`, `GAME_ALREADY_COMPLETE`, `MOVE_INVALID`,
`LOADOUT_INVALID`, `INTERNAL_ERROR`.

### Subscription model

- `Subscribe*` messages kick off watching the db for changes
- client sends current snapshot on subscribe; server uses this as baseline to
  avoid redundant initial updates
- server `Update*` messages always send full snapshot replacement viewData (not
  partial patches)
- target-scoped channels are explicit:
  - `SubscribeGame` and `UnsubscribeGame` include `gameId`
  - `SubscribeRoom` and `UnsubscribeRoom` include `roomId`
- target-scoped updates/actions are explicit:
  - `UpdateGame` includes `gameId`
  - `UpdateRoom` includes `roomId`
  - `PerformMove` includes `gameId`
- unauthorized room/game access is masked as not found (`ROOM_NOT_FOUND` /
  `GAME_NOT_FOUND`) to avoid leaking resource existence
- `Unsubscribe*` messages detach from the specific subscribed stream target

## Server runtime behavior

`server.ts` exports a function `initializeServer` that:

- opens Deno KV with `Deno.openKv()`
- creates `DB` instance, injecting KV
- creates two KV-backed global streams:
  - active public game list changes
  - available public room list changes
- creates `SocketStore`
- returns `Server` wrapper that exposes high-level server methods for auth,
  socket setup, and SSR

### `Server`

#### `getUser(token)`

- Looks up the token in the database. If it exists and is valid, returns the
  associated user.
- Otherwise:
  - creates guest user (`guest-0000` style, random 4-digit suffix, retries up to
    10k)
  - generates new token ULID (`ulid()` from `jsr:@std/ulid`)
- Write the token (the old valid one, or the newly-created guest one) to the db
  with a fresh 30-day TTL (`expiration` timestamp only; cleanup done separately)

#### `configureSocket(user, socket)`

- registers `message` and `close` listeners
- `close` always unsubscribes current subscriptions
- handles all `./common/sockettypes.ts` messages appropriately
  - join/create room/loadout validation delegates to
    `game.isValidRoom`/`game.isValidLoadout`
  - if `game.isValidRoom` is undefined, room creation/join is disabled
  - if `game.isValidLoadout` is undefined, all loadouts are accepted
  - queue existence validated against `game.queues`
  - room privacy enforced via invitation checks
  - PerformMove requires player membership in the game

#### `acceptInvitation(user, roomId)`

- Adds/ensures room access for `roomId` in the user's incoming room invitations
  in `UserMatchmakingViewData`
- kept as public server API for non-socket flows, primarily URL-scheme
  invitation links
- idempotent if already accepted
- idempotent no-op if the user is already in the room
- idempotent no-op for public rooms
- throws `ROOM_NOT_FOUND` if the room is missing or inaccessible

#### `getInitial*ViewData`

- Loads the current view data from the database. Used for SSR.
- All `getInitial*ViewData` methods throw when the requested data is missing.
- `getInitialActivePublicGamesViewData` throws
  `ACTIVE_PUBLIC_GAMES_NOT_FOUND` when missing.
- `getInitialAvailablePublicRoomsViewData` throws
  `AVAILABLE_PUBLIC_ROOMS_NOT_FOUND` when missing.
- `getInitialUserMatchmakingViewData` throws `USER_NOT_FOUND` when missing.
- `getInitialRoomViewData` throws `ROOM_NOT_FOUND` when the room is missing or
  inaccessible.
- `getInitialGameViewData` throws `GAME_NOT_FOUND` when the game is missing or
  inaccessible.

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
- room-scoped actions (`leaveRoom`, `commitRoom`, `inviteUser`) are exposed by
  `RoomProps`, not `UserMatchmakingProps`
- `UserMatchmakingProps` includes `acceptInvitation` for invitation-acceptance
  socket flows
- sends `Unsubscribe*` on unmount

## Persistence model (Deno KV keyspace)

This repo uses Deno KV for persistence for both user data and authentication. It
makes heavy use of `.watch` for updating sockets in response to changes. See
Deno KV docs if anything is unclear.

Storage rows are ID-based and normalized. They reference related entities by ID
(for example `userId`, `roomId`, `gameId`) instead of embedding full `User`
objects. Server read paths hydrate these IDs into full `*ViewData` snapshots.
All server-generated key identifiers use ULIDs from `jsr:@std/ulid`.

### Keyspaces and values

- `['tokens', token]` -> `TokenStorageData`
- `['users', userId]` -> `UserStorageData<Config, Loadout, Rating>`
- `['activepublicgames']` -> `ActivePublicGameStorageData<Config>[]`
- `['availablepublicrooms']` -> `AvailableRoomStorageData<Config>[]`
- `['usermatchmaking', userId]` -> `UserMatchmakingStorageData`
- incoming invitation references are embedded in `UserMatchmakingStorageData`
  (keyed by `roomId`)
- `['queueentry', queueId, entryId]` -> `QueueEntryStorageData<Loadout>`
- `['rooms', roomId]` -> `RoomStorageData<Config, Loadout>`
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
  - asserts user does not already have an active entry in that `queueId`
  - inserts queue entry
  - appends queue record to user `queueEntries`
  - then calls `maybeGraduateFromQueue`
- `leaveQueue(queueId)` is idempotent: if no active entry exists, it is a no-op
  success
- `acceptInvitation(roomId)` is idempotent: if already accepted, it is a
  no-op success
- `acceptInvitation(roomId)` is a no-op success if the user is already in the
  room
- `acceptInvitation(roomId)` is a no-op success for public rooms
- idempotent no-op paths are silent (no errors)
- `maybeGraduateFromQueue`:
  - reads first `numPlayers` queue entries using FIFO by `createdAt`
    (deterministic tiebreak such as `entryId` may be used when timestamps match)
  - if enough entrants:
    - creates game via shared helper with randomized player order
    - deletes consumed queue entries
    - removes queue from each user's `queueEntries`
    - appends a `UserActiveGame` with `queueEntryId` to each assigned user's
      `userActiveGames`

### Room flow

- `createRoom` creates room with empty members and toggles room list trigger.
  It also records an immutable `createdByUserId` for audit/record-keeping only
  (no special room privileges).
- `addToRoom` validates existence/capacity/non-membership, appends member,
  updates user joined rooms, optionally consumes invitations
- joining public rooms does not require invitations
- joining private rooms requires invitation and is masked as `ROOM_NOT_FOUND`
  when unavailable/invalid
- `joinRoom` throws `ROOM_FULL` when room is full
- `joinRoom` is idempotent no-op when user is already in the room
- successful `joinRoom` clears matching `incomingRoomInvitations` for that room
- `inviteUser` is allowed for any current room member
- `inviteUser` is allowed for both private and public rooms
- `inviteUser` throws `ROOM_ALREADY_JOINED` when the invitee is already in the
  room
- `inviteUser` throws `ROOM_FULL` when the room is full
- `inviteUser` throws `USER_NOT_FOUND` when the invitee does not exist
- `inviteUser` is idempotent when the same direct invitation already exists
- `leaveRoom(roomId)` is idempotent: if the user is not currently in the room,
  it is a no-op success
- `removeFromRoom` removes member by `entryId`; deletes room when last member
  leaves; toggles room list trigger
- `commitRoom` requires exactly `numPlayers` members and:
  - any current room member may commit the room
  - creates game from room members with randomized player order
  - removes room membership from each user's `joinedRooms`
  - appends a `UserActiveGame` with `roomId` to each assigned user's
    `userActiveGames`
  - deletes room and toggles room list trigger

### Game completion flow

- when a game transitions from in-progress to complete (`outcome` becomes
  defined):
  - remove it from each involved user's `userActiveGames`
  - remove it from global `activePublicGames`
  - keep the `games` record for completed-game reads/history
- completion-triggered removals produce normal `UpdateUserMatchmaking` and
  `UpdateActivePublicGames` snapshots to subscribed clients

### Invitation flow

- direct user invitations (`inviteUser`) add room access to the invitee's
  `incomingRoomInvitations`
- invitation records are room-scoped (`roomId`) rather than inviter-scoped
- direct user invitations throw `ROOM_ALREADY_JOINED` when invitee is already a
  current room member
- direct user invitations throw `ROOM_FULL` when the room is full
- direct user invitations throw `USER_NOT_FOUND` when invitee does not exist
- direct user invitations are idempotent for existing room/user access
- invitations to public rooms are valid and retained
- URL/share flows use the room link directly (`roomId` as secret); no separate
  invitation creation endpoint exists in v1
- invitations have no expiration in v1
- `acceptInvitation(roomId)` throws `ROOM_NOT_FOUND` for missing/invalid room
  targets
- `acceptInvitation(roomId)` is a silent no-op for public rooms
- `acceptInvitation(roomId)` is a silent no-op when the user is already in the
  room
- `acceptInvitation` only adds/ensures incoming invitation state and never
  auto-joins the room
- socket flow supports `AcceptInvitation` in addition to server-route
  `acceptInvitation(...)`
- invitation consumption during join removes matching incoming invitation
  references as needed
- invitation view data is hydrated from current room state at read time

## Game Logic Processor

`server/gamelogicprocessor` outputs a class which is constructed with a `Game`
object, and provides pure utility methods for calling the provided Game
functions. This includes accepting moves, validating them, creating new Game
states, computing outcomes, computing ratings, and similar things. It does not
know anything about matchmaking.

## Stream/watch infrastructure

### DB watchers

- `watchForRoomChanges(roomId)`-> emits`{type:'updated', room}` or
  `{type:'deleted'}`
- `watchForGameChanges(gameId)` -> emits non-null game data updates
- `watchForUserMatchmakingChanges(userId)` -> emits hydrated
  `UserMatchmakingData`
- `watchForActiveGameListChanges()` -> emits `ActivePublicGame[]` (defaults to
  `[]`)
- `watchForAvailableRoomListChanges()` -> watches room trigger and emits full
  recomputed room list

### `ServerSocket` class

Wraps a WebSocket and provides caching for `*ViewData` objects.

### Socket store

`SocketStore` stores `ServerSocket` instances.

### Equality and update suppression

`jsonEquals(a, b)` is implemented as `JSON.stringify(a) === JSON.stringify(b)`.

This drives suppression of redundant lobby/game updates. Reimplementations
should preserve this semantic (including ordering sensitivity inherent in
stringification).

## Error handling semantics

- many DB and server methods throw on invalid state (missing rows, duplicates,
  etc.)

## Future work

- define background cleanup strategy for expired tokens and stale invitations
- define reconciliation/repair flows for orphaned references in matchmaking data
- evaluate optional secondary indexes (for example room-scoped invitation
  indexes) only if profiling shows they are needed
- improve queue matchmaking policy beyond strict FIFO
