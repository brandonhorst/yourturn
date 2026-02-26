# `yourturn`

`yourturn` is an opinionated framework for building turn-based multiplayer
browser games with TypeScript.

You model game logic as a state machine, render UI as a function of state, and
`yourturn` handles:

- WebSocket networking
- Persistence (Deno KV)
- Matchmaking (queues + rooms)
- Observer/player state projection

`yourturn` is designed for Deno backends and Preact frontends.

## Installation

The package is published as
[jsr:@brandonhorst/yourturn](https://jsr.io/@brandonhorst/yourturn).

A starter project is available at
[yourturn-template](https://github.com/brandonhorst/yourturn-template).

## Public Exports

`yourturn` exposes 4 entrypoints:

- `@brandonhorst/yourturn/server`
- `@brandonhorst/yourturn/client`
- `@brandonhorst/yourturn/protocol`
- `@brandonhorst/yourturn/types`

### `server`

Contains `initializeServer(game)`, which returns a `Server<T>` implementation
for token resolution, initial channel payload reads, and websocket
configuration.

### `client`

Contains:

- `useSocket(socketUrl)`
- Channel hooks (`useMatchChannel`, `useRoomChannel`,
  `useUserMatchmakingChannel`, `useAccountUserProfileChannel`,
  `useActivePublicMatchesChannel`, `useActivePublicUsersChannel`,
  `useAvailablePublicRoomsChannel`)
- `fetchUserProfile(socket, userId)` (one-shot profile fetch)

### `protocol`

Contains socket wire contracts:

- `ClientMessage<T>`
- `ServerMessage<T>`

### `types`

Contains shared game, domain, view, server, and socket interfaces.

## Quick Usage

```ts
import { initializeServer } from "@brandonhorst/yourturn/server";
import type { GameDefinition } from "@brandonhorst/yourturn/types";

const server = await initializeServer(
  gameDefinition satisfies GameDefinition<MyGameTypes>,
);
```

```ts
import { fetchUserProfile, useSocket } from "@brandonhorst/yourturn/client";

const socket = useSocket("/api/socket");
const profile = await fetchUserProfile(socket, "some-user-id");
```

## Game Type Bundle

All framework generics are keyed off one bundle type:

```ts
type MyGameTypes = {
  Config: Config;
  GameState: GameState;
  Move: Move;
  PlayerState: PlayerState;
  PublicState: PublicState;
  Outcome: Outcome;
  Rating: Rating;
  Loadout: Loadout;
};
```

Games implement `GameDefinition<MyGameTypes>`.

## Game Definition Summary

Required members:

- `queues`
- `setup`
- `isValidMove`
- `processMove`
- `playerState`
- `publicState`
- `outcome`
- `initialRating`
- `processOutcome`

Optional members:

- `isValidLoadout`
- `isValidRoom`
- `refreshTimeout`

## Socket Channel Model

One websocket can subscribe to multiple channels simultaneously:

1. AccountUserProfile
2. UserMatchmaking
3. Room
4. Match
5. Active public matches
6. Active public users
7. Available public rooms

`FetchUserProfile` is a request/response message, not a subscription.

## Server Logging

Server logs are centralized in `server/logging.ts`.

- `YOURTURN_SERVER_LOG_LEVEL` controls minimum level (`DEBUG`, `INFO`, `WARN`,
  `ERROR`; default `INFO`).
- `YOURTURN_SERVER_LOG_MODULE` filters by module name with `*` wildcard support.

Example:

```sh
YOURTURN_SERVER_LOG_LEVEL=DEBUG YOURTURN_SERVER_LOG_MODULE="server.socket*"
```

## Active Public Presence

Presence entries are stored at `[
  "activepublicusers", userId
]` with:

- `playerSnapshot`
- `connectionCount`

Presence TTL is 10 minutes and is refreshed on socket setup and inbound
subscribe/mutating activity.
