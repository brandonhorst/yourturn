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

`hooks` contains a number of Preact hooks for use on a Preact frontend. The
hooks manage connections to Websockets (those configured in `server`), as well
as some internal state.

`types` contains definitions of types used by both sides.

## Architecture

### Core Exports

The framework exports three main modules as defined in `deno.json`:

- `server` - WebSocket configuration and message handling for server-side game
  logic
- `hooks` - Preact hooks for client-side WebSocket management and state
- `types` - Shared TypeScript type definitions

### Server Architecture

The server-side code is organized around a single WebSocket connection that can
subscribe to multiple channels:

- `server.ts` - Main initializer; creates `DB`, `SocketStore`, and `Server`
- `server/server.ts` - Public server API, token/user setup, and client message
  routing, including initial channel payload assembly
- `server/sockets.ts` - Subscription lifecycle and stream fan-out for
  UserProfile, UserMatchmaking, room, queue, global lists, and per-game updates
- `server/db/` - Deno KV persistence and matchmaking implementation (see
  `server/db/AGENTS.md` for module-internal architecture, keyspace, and
  invariants)
- `server/utils.ts` - Shared server-side data conversion helpers for canonical
  user profiles and player snapshots
- `server/gamestateservice.ts` - Game state projection and move processing,
  including outcome handling and ranked rating updates

### Client Architecture

Client-side hooks are organized by functionality:

- `client/channels.ts` - UserMatchmaking, room, and game channel subscription
  hooks, including active public games/users and available room list hooks
- `client/socket.ts` - Shared socket connection utilities

### Game Interface

Games must implement the
`Game<Config, GameState, Move, PlayerState, PublicState, Outcome, Rating, Loadout>`
interface defined in `types.ts`:

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

The database layer uses Deno KV and lives under `server/db/`. Module-internal
storage keys, indexes, watchers, and invariants are documented in
`server/db/AGENTS.md`.

### WebSocket Communication

A single socket supports these channel subscriptions:

1. **AccountUserProfile channel** - Canonical profile updates for the
   authenticated socket user
2. **UserProfile channel** - Canonical profile updates for any requested user ID
3. **UserMatchmaking channel** - Matchmaking actions and user matchmaking
   updates
4. **Room channel** - Per-room lifecycle updates and room-specific actions
5. **Game channel** - Moves and game state updates for players/observers
6. **Active public games channel** - Global list of active games
7. **Active public users channel** - Global list of currently active users
8. **Available public rooms channel** - Global list of joinable public rooms

Message protocol types are defined in `common/sockettypes.ts`.

`JoinQueue`, `CreateAndJoinRoom`, and `JoinRoom` requests can include
`assignmentSubscriptionId` so queue graduation and committed rooms can emit
targeted `GameAssignment` messages without a dedicated assignment KV key/watch
stream.

`UpdateAccountUserProfile` requests can include `description` only, and persist
that canonical profile change to `["users", userId]` for the authenticated
socket user.

UserMatchmaking channel payloads (`UserMatchmakingViewData`) contain matchmaking
data only: `userActiveGames`, `roomIds`, and `queueEntries`. Player profile and
ratings are not part of UserMatchmaking channel view data.

AccountUserProfile and UserProfile channel payloads
(`UserProfileViewData<Rating>`) contain canonical user profile data.
Display-facing game and room payloads use `PlayerSnapshot<Rating>` instead.

Active public users channel payloads (`ActiveUsersViewData<Rating>`) contain
only `PlayerSnapshot<Rating>[]` (`allActiveUsers`).

## Agent Instructions

- When making changes, ALWAYS run `deno task check` and fix errors.
- Keep this `AGENTS.md` file up to date. If behavior, architecture, module
  exports, protocols, or developer workflow changes, update this file in the
  same change set.
- Ensure all functions have good comments that explain their purpose.
- Do not use the `unknown` type unless instructed to do so.
- Right now, this system is unlaunched and in active development. Do not worry
  about backwards compatibility or breaking existing APIs.
