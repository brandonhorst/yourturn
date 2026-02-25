# AGENTS.md

This file provides guidance to LLM agents when working with code in this
repository.

## Overview

This is a Deno module called `yourturn`, a framework for implementing
multiplayer, online, turn-based games.

It exports 3 files, as defined in `deno.json`. `server` (defined in
`server.ts`), `hooks` (defined in `hooks.ts`) and `types` (defined in
`types.ts`).

`server` is used for configuring WebSockets and handling their messages. While
it works with any sockets, it is intended for use within a Deno Fresh app.

`hooks` contains Preact hooks for use on a Preact frontend, plus a one-shot
`fetchUserProfile(socket, userId)` helper for fetching arbitrary user profiles.
The hooks manage connections to Websockets (those configured in `server`), as
well as some internal state.

`types` contains definitions of types used by both sides, including the public
`Server` interface returned by `initializeServer` and the `AuditLogEntry` audit
union used for DB mutation logging.

## Architecture

### Core Exports

The framework exports three main modules as defined in `deno.json`:

- `server` - WebSocket configuration and message handling for server-side game
  logic
- `hooks` - Preact hooks for client-side WebSocket management and state
- `types` - Shared TypeScript type definitions, including the public `Server`
  API shape returned by `initializeServer`

### Server Architecture

The server-side code is organized around a single WebSocket connection that can
subscribe to multiple channels:

- `server.ts` - Main initializer; creates `DB` and `SocketStore`, then returns a
  `types.Server` implementation
- `server/server.ts` - `ServerController` implementation for token/user setup
  and client message routing, including initial channel payload assembly
- `server/sockets.ts` - Subscription lifecycle and stream fan-out for
  AccountUserProfile, UserMatchmaking, room, queue, global lists, and per-match
  updates
- `server/db.ts` - Deno KV persistence for users, queues, rooms, user
  matchmakings, active matches, active users, tokens, mutation log entries, and
  indexed global list snapshots (`["activepublicmatches", matchId]`,
  `["availablepublicrooms", roomId]`, and `["activepublicusers", userId]`)
- `server/gamestateservice.ts` - Match state projection and move processing,
  including outcome handling and ranked rating updates

### Client Architecture

Client-side hooks are organized by functionality:

- `client/channels.ts` - UserMatchmaking, room, and match channel subscription
  hooks, including active public matches/users and available room list hooks
- `client/fetchers.ts` - One-shot socket request helpers, including
  `fetchUserProfile(socket, userId)`
- `client/socket.ts` - Shared socket connection utilities

### Game Interface

Games must implement the `GameDefinition<GameTypesBundle>` interface defined in
`types.ts`, where `GameTypesBundle` is an object type containing:

- `Config` - Configuration type (structured clone compatible)
- `GameState` - Game state type (structured clone compatible)
- `Move` - Move type (JSON serializable)
- `PlayerState` - Player state type (JSON serializable)
- `PublicState` - Observer state type (JSON serializable)
- `Outcome` - Outcome type (JSON serializable)
- `Rating` - Rating type for ranked queues (JSON serializable)
- `Loadout` - Queue/room join payload provided per player (JSON serializable)

Key methods:

- `queues` - Queue definitions (`numPlayers`, `config`, and queue type)
- `setup()` - Initialize game state
- `isValidMove()` - Validate player moves
- Optional: `isValidLoadout()` for queue/room join validation (if omitted, all
  loadouts are valid)
- Optional: `isValidRoom()` for room config validation (if omitted, all rooms
  are invalid)
- `processMove()` - Apply moves to game state
- `playerState()` - Generate player-specific views
- `publicState()` - Generate observer views
- `outcome()` - Check if game is finished and report the result
- `initialRating()` - Provide default rating for new players
- `processOutcome()` - Compute new ratings after ranked games

### Database Layer

Uses Deno KV for:

- Match state persistence at `["matches", matchId]`
- Queue matchmaking and room-based matchmaking
- Queue entries and room members that optionally persist assignment subscription
  IDs used for direct `MatchAssignment` socket delivery
- User records (`["users", userId]`) for canonical profile fields (`username`,
  `isGuest`, `description`) and per-queue `ratings`
- Completed-match profile history at
  `["completedmatchesbyuser", userId, completedMatchEntryId]` with
  `CompletedMatchSnapshot<Config, Outcome, Rating>` payloads (`matchId`,
  optional `queueId`, frozen `players`, frozen `config`, `outcome`, and
  `completed` timestamp)
- Per-user completed-match history root tickers at
  `["completedmatchesbyuser", userId]` stored as `Deno.KvU64` counters so
  account profile watchers can react to history writes
- User matchmaking records (`["usermatchmakings", userId]`) for `activeMatches`,
  `joinedRooms`, and `queueEntries`; match-state writes touch these keys so
  UserMatchmaking subscribers can re-project stateful match views, and completed
  matches are removed from `activeMatches`
- Auth tokens
- Mutation log entries at `["auditlogentries", id]` with `AuditLogEntry` records
  (`id` plus `payload`, where payload includes actor `userId`, event `type`, and
  compact event-specific IDs such as `queueId`, `roomId`, `entryId`, and
  `matchId`)
- Global list indexes store one entry per room/match and are read as snapshots
  via `kv.list` (single batch, `limit=500`, `batchSize=500`)
- Root invalidation keys (`["activepublicmatches"]` and
  `["availablepublicrooms"]`) are stored as `Deno.KvU64` counters and mutated
  with atomic `sum` operations (`+1` insert, `-1` delete, `0` update) so list
  watchers can track updates without scanning (`["activepublicmatches"]` uses
  `0` updates on in-progress match state writes to refresh projections)
- Active public users at `["activepublicusers", userId]` with
  `ActiveUserStorageData` (`playerSnapshot` and `connectionCount`) and a root
  ticker key at `["activepublicusers"]` that increments on presence writes
- Account profile updates only change `description`; they do not mutate active
  public user snapshots because snapshots only store player-facing fields
- Presence uses a 10-minute TTL with no heartbeat loop; TTL is pushed on socket
  setup plus subscribe/mutating requests
- `PlayerSnapshot<T>` values are frozen at queue/room join time and stored in
  queue entries, room members, games, active public matches, and available
  public rooms; they are intentionally not updated after join

### WebSocket Communication

A single socket supports these channel subscriptions:

1. **AccountUserProfile channel** - Canonical profile updates for the
   authenticated socket user
2. **UserMatchmaking channel** - Matchmaking actions and user matchmaking
   updates
3. **Room channel** - Per-room lifecycle updates and room-specific actions
4. **Match channel** - Moves and match state updates for players/observers
5. **Active public matches channel** - Global list of active matches
6. **Active public users channel** - Global list of currently active users
7. **Available public rooms channel** - Global list of joinable public rooms

Message protocol types are defined in `common/sockettypes.ts`.

`FetchUserProfile` is a one-shot request (not a subscription) that returns a
single canonical profile snapshot for any requested user ID.

`JoinQueue`, `CreateAndJoinRoom`, and `JoinRoom` requests can include
`assignmentSubscriptionId` so queue graduation and committed rooms can emit
targeted `MatchAssignment` messages without a dedicated assignment KV key/watch
stream.

`UpdateAccountUserProfile` requests can include `description` only, and persist
that canonical profile change to `["users", userId]` for the authenticated
socket user.

UserMatchmaking channel payloads (`UserMatchmakingViewData`) contain
`userActiveMatches`, `roomIds`, and `queueEntries`. Each `userActiveMatches`
entry contains stored match metadata plus serve-time `publicState` and
`privateState` projections computed from the latest stored `gameState` via the
game's `publicState()` and `playerState()` methods.

AccountUserProfile payloads and `FetchUserProfile` results
(`UserProfileViewData<GameTypesBundle>`) contain canonical user profile data
plus `completedMatches` history snapshots. Display-facing match and room
payloads use `PlayerSnapshot<T>` instead.

Active public users channel payloads (`ActiveUsersViewData<GameTypesBundle>`)
contain only `PlayerSnapshot<T>[]` (`allActiveUsers`).

Active public matches channel payloads (`ActivePublicMatchesViewData`) contain
stored match metadata plus serve-time per-match `publicState` projections
computed from the latest stored `gameState` via the game's `publicState()`
method.

## Agent Instructions

- When making changes, ALWAYS run `deno task check` and fix errors.
- Keep this `AGENTS.md` file up to date. If behavior, architecture, module
  exports, protocols, or developer workflow changes, update this file in the
  same change set.
- Ensure all functions have good comments that explain their purpose.
- Do not use the `unknown` type unless instructed to do so.
- Right now, this system is unlaunched and in active development. Do not worry
  about backwards compatibility or breaking existing APIs.
