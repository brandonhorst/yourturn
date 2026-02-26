# AGENTS.md

This file provides guidance to LLM agents when working with code in this
repository.

## Overview

This is a Deno module called `yourturn`, a framework for implementing
multiplayer, online, turn-based games.

It exports 3 public entrypoints in `deno.json`:

- `./server` - Server initialization and runtime orchestration.
- `./client` - Preact hooks, socket client utilities, and one-shot fetchers.
  `ServerMessage`).
- `./types` - Shared type system for game definitions, views, server API, and
  socket interfaces.

## Architecture

### Core Exports

- `server/mod.ts` re-exports `initializeServer` from `server/initialize.ts`.
- `client/mod.ts` re-exports all client hooks plus `useSocket` and
  `fetchUserProfile`.
- `protocol/mod.ts` re-exports protocol unions from
  `protocol/client_messages.ts` and `protocol/server_messages.ts`.
- `types/mod.ts` re-exports game contracts, domain models, view models, and core
  interfaces from `types/*`.

### Server Architecture

The server-side code is organized around a single WebSocket connection that can
subscribe to multiple channels.

- `server/initialize.ts` - Main initializer. Creates `DB` + `SocketStore` and
  returns `ServerController`.
- `server/controller/server_controller.ts` - Public `Server<T>` API
  implementation (`resolveToken`, initial payload reads, `configureSocket`).
- `server/controller/socket_router.ts` - Inbound socket message routing,
  validation, and delegation to `SocketStore`/`DB`/`GameStateService`.
- `server/sockets/socket_store.ts` - Subscription lifecycle, stream fan-out,
  room/queue actions, and match assignment dispatch.
- `server/sockets/state.ts` - Socket connection state types.
- `server/sockets/wire.ts` - Shared socket send/reader/match-payload helpers.
- `server/db/db.ts` - Deno KV persistence implementation.
- `server/db/models.ts` - DB storage/view model types + user/profile mappers.
- `server/db/keys.ts` - KV key builders.
- `server/db/constants.ts` - DB constants (list limits, TTLs, u64 helpers).
- `server/services/game_state_service.ts` - Game state projection + move
  application + ranked rating updates.
- `server/services/match_projection_service.ts` - Shared match projection logic
  for active/public/user match views.
- `server/logging.ts` - Shared server-side logger.

### Client Architecture

Client-side hooks are split by channel:

- `client/hooks/use_match_channel.ts`
- `client/hooks/use_user_matchmaking_channel.ts`
- `client/hooks/use_room_channel.ts`
- `client/hooks/use_account_user_profile_channel.ts`
- `client/hooks/use_active_public_matches_channel.ts`
- `client/hooks/use_active_public_users_channel.ts`
- `client/hooks/use_available_public_rooms_channel.ts`

Supporting modules:

- `client/socket/use_socket.ts` - reconnecting socket hook.
- `client/fetchers/fetch_user_profile.ts` - one-shot profile fetch helper.

### Protocol Architecture

Socket protocol types are in:

- `protocol/client_messages.ts`
- `protocol/server_messages.ts`

Every socket payload should be typed via `ClientMessage<T>` and
`ServerMessage<T>`.

### Type Architecture

Shared types are split by concern:

- `types/game.ts` - `GameTypes`, `GameDefinition`, and game lifecycle types.
- `types/domain.ts` - snapshots, profile data, queue/room/match domain models,
  and audit/token types.
- `types/views.ts` - channel payloads and hook prop types.
- `types/server.ts` - public `Server<T>` interface.
- `types/socket.ts` - client socket interface + listener types.

### Game Interface

Games must implement `GameDefinition<GameTypesBundle>` from `types/game.ts`,
where `GameTypesBundle` includes:

- `Config`
- `GameState`
- `Move`
- `PlayerState`
- `PublicState`
- `Outcome`
- `Rating`
- `Loadout`

Key methods:

- `queues`
- `setup()`
- `isValidMove()`
- Optional `isValidLoadout()`
- Optional `isValidRoom()`
- `processMove()`
- `playerState()`
- `publicState()`
- `outcome()`
- `initialRating()`
- `processOutcome()`

### Database Layer

Uses Deno KV for:

- Match state persistence at `["matches", matchId]`
- Queue matchmaking and room-based matchmaking
- Queue entries and room members with optional assignment subscription IDs
- User records at `["users", userId]` (username, guest flag, description,
  ratings)
- Completed-match history at
  `["completedmatchesbyuser", userId, completedMatchEntryId]`
- User matchmaking records at `["usermatchmakings", userId]`
- Auth tokens at `["tokens", token ]`
- Audit log entries at `["auditlogentries", id]`
- Indexed global list snapshots at `["activepublicmatches", matchId]`,
  `["availablepublicrooms", roomId]`, and `["activepublicusers", userId]`
- Root invalidation counters at `["activepublicmatches"]`,
  `["availablepublicrooms"]`, and `["activepublicusers"]`

### WebSocket Communication

One socket supports these subscriptions:

1. AccountUserProfile
2. UserMatchmaking
3. Room
4. Match
5. Active public matches
6. Active public users
7. Available public rooms

`FetchUserProfile` is one-shot (not a subscription).

`JoinQueue`, `CreateAndJoinRoom`, and `JoinRoom` may include
`assignmentSubscriptionId` for direct `MatchAssignment` delivery.

`UpdateAccountUserProfile` currently supports `description` updates.

### Server Logging

Server components use `server/logging.ts`.

- `YOURTURN_SERVER_LOG_LEVEL`: `DEBUG`/`INFO`/`WARN`/`ERROR` (default `INFO`)
- `YOURTURN_SERVER_LOG_MODULE`: module filter with `*` wildcard (default `*`)

Current module names include:

- `server.initialize`
- `server.controller`
- `server.socket_router`
- `server.socket`
- `server.sockets`
- `server.db`
- `server.gamestate`

## Agent Instructions

- When making changes, ALWAYS run `deno task check` and fix errors.
- Keep this `AGENTS.md` file up to date. If behavior, architecture, module
  exports, protocols, or developer workflow changes, update this file in the
  same change set.
- Ensure all functions have good comments that explain their purpose.
- Do not use the `unknown` type unless instructed to do so.
- Right now, this system is unlaunched and in active development. Do not worry
  about backwards compatibility or breaking existing APIs.
