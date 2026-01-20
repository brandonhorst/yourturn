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
deno test server/db.test.ts
```

Tests are co-located with the code they cover and use the `.test.ts` suffix.

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
  - `server/gamesockets.ts` - Player and observer WebSocket handling

### Client Architecture

Client-side hooks are organized by functionality:

- `client/lobbyhooks.ts` - Lobby and matchmaking state management
- `client/gamehooks.ts` - Game play and observation state management
- `client/hookutils.ts` - Shared utilities for WebSocket management

### Game Interface

Games must implement the
`Game<Config, GameState, Move, PlayerState, PublicState, Outcome>` interface
defined in `types.ts`:

- `Config` - Configuration type (structured clone compatible)
- `GameState` - Game state type (structured clone compatible)
- `Move` - Move type (JSON serializable)
- `PlayerState` - Player state type (JSON serializable)
- `PublicState` - Observer state type (JSON serializable)
- `Outcome` - Outcome type (JSON serializable)

Key methods:

- `setup()` - Initialize game state
- `isValidMove()` - Validate player moves
- `processMove()` - Apply moves to game state
- `playerState()` - Generate player-specific views
- `publicState()` - Generate observer views
- `outcome()` - Check if game is finished and report the result
- Optional: `refreshTimeout()` for future time-based mechanics

### Database Layer

Uses Deno KV for:

- Game state persistence
- Player queues and matchmaking
- Real-time state synchronization via watch streams

### WebSocket Communication

1. **Lobby sockets** - Handle matchmaking, queue joining/leaving
2. **Game sockets** - Handle moves and game state updates for both players and
   observers

Each socket type has its own message protocol defined in
`common/sockettypes.ts`.

## Agent Instructions

- When making changes, ALWAYS run `deno task check` and `deno task test` and fix
  errors.
