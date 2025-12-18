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

## Development Commands

### Testing

```sh
deno task test
```

### Running Specific Tests

To run a specific test file:

```sh
deno test test/db_test.ts
```

## Architecture

### Core Exports

The framework exports three main modules as defined in `deno.jsonc`:

- `server` - WebSocket configuration and message handling for server-side game
  logic
- `hooks` - Preact hooks for client-side WebSocket management and state
- `types` - Shared TypeScript type definitions

### Server Architecture

The server-side code is organized around WebSocket handling:

- `server.ts` - Main server initialization and WebSocket configuration
- `server/db.ts` - Database layer using Deno KV for persistence
- `server/gamedata.ts` - Core game state management and move processing
- Socket handlers:
  - `server/lobbysockets.ts` - Matchmaking and lobby functionality
  - `server/playsockets.ts` - Active game play WebSocket handling
  - `server/observesockets.ts` - Observer WebSocket handling

### Client Architecture

Client-side hooks are organized by functionality:

- `client/lobbyhooks.ts` - Lobby and matchmaking state management
- `client/playhooks.ts` - Active game play state management
- `client/observehooks.ts` - Game observation state management
- `client/hookutils.ts` - Shared utilities for WebSocket management

### Game Interface

Games must implement the `Game<C, S, M, P, O>` interface defined in `types.ts`:

- `C` - Configuration type (structured clone compatible)
- `S` - Game state type (structured clone compatible)
- `M` - Move type (JSON serializable)
- `P` - Player state type (JSON serializable)
- `O` - Observer state type (JSON serializable)

Key methods:

- `setup()` - Initialize game state
- `isValidMove()` - Validate player moves
- `processMove()` - Apply moves to game state
- `playerState()` - Generate player-specific views
- `observerState()` - Generate observer views
- `isComplete()` - Check if game is finished
- Optional: `refreshTimeout()` and `refresh()` for time-based mechanics

### Database Layer

Uses Deno KV for:

- Game state persistence
- Player queues and matchmaking
- Real-time state synchronization via watch streams
- Automatic game state refresh scheduling

### WebSocket Communication

Three types of WebSocket connections:

1. **Lobby sockets** - Handle matchmaking, queue joining/leaving
2. **Play sockets** - Handle moves and game state updates for active players
3. **Observe sockets** - Handle read-only game observation

Each socket type has its own message protocol defined in `common/types.ts`.
