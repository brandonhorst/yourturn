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
- `server/socket.ts`
- `server/socketstore.ts`

### Client Architecture

Client-side hooks are organized by functionality:

- `client/hooks.ts`

## Agent Instructions

- When making changes, ALWAYS run `deno task check` and fix errors.
- Ensure all functions have good comments that explain their purpose.
- Do not use the `unknown` type unless instructed to do so.
- Right now, this system is unlaunched and in active development. Do not worry
  about backwards compatibility or breaking existing APIs.
