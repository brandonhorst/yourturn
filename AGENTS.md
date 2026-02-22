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
  routing
- `server/sockets.ts` - Subscription lifecycle and stream fan-out for lobby,
  room, queue, global lists, and per-game updates
- `server/db.ts` - Deno KV persistence for users, queues, rooms, assignments,
  active games, and tokens
- `server/gamestateservice.ts` - Game state projection and move processing,
  including outcome handling and ranked rating updates

### Client Architecture

Client-side hooks are organized by functionality:

- `client/channels.ts` - Lobby, room, and game channel subscription hooks
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

Uses Deno KV for:

- Game state persistence
- Queue matchmaking and room-based matchmaking
- Queue/room-to-game assignments
- User records, auth tokens, and per-queue ratings
- Real-time state synchronization via watch streams

### WebSocket Communication

A single socket supports these channel subscriptions:

1. **Lobby channel** - Matchmaking actions and user lobby updates
2. **Room channel** - Per-room lifecycle updates and room-specific actions
3. **Game channel** - Moves and game state updates for players/observers
4. **Active public games channel** - Global list of active games
5. **Available public rooms channel** - Global list of joinable public rooms

Message protocol types are defined in `common/sockettypes.ts`.

## Agent Instructions

- When making changes, ALWAYS run `deno task check` and fix errors.
- Keep this `AGENTS.md` file up to date. If behavior, architecture, module
  exports, protocols, or developer workflow changes, update this file in the
  same change set.
- Ensure all functions have good comments that explain their purpose.
- Do not use the `unknown` type unless instructed to do so.
- Right now, this system is unlaunched and in active development. Do not worry
  about backwards compatibility or breaking existing APIs.
