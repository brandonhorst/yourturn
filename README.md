# `yourturn`

`yourturn` is an opinionated framework for building turn-based multiplayer
browser games using Typescript.

You design the game logic as a state machine, design your UI as a function of
that state, and `yourturn` handles the rest.

Games built with `yourturn` get automatic support for:

- Networking
- Persistence
- Matchmaking
- Observation

`yourturn` includes support for games that require:

- Hidden Information
- Simultaneous or Out-of-turn Play
- Randomness
- Timers

`yourturn` is built to run on Deno and uses Deno KV as its database. Games
render their UI with Preact components.

## Usage

To get started, it's recommended to start with
[yourturn-template](https://github.com/brandonhorst/yourturn-template).

If you want to use the library directly, it's available at
[jsr:@brandonhorst/yourturn](https://jsr.io/@brandonhorst/yourturn).

## Fetching User Profiles

Use `fetchUserProfile(socket, userId)` from `@brandonhorst/yourturn/hooks` to
fetch a single canonical profile snapshot for any user. This is a one-shot
request, not a subscription.

```ts
import { fetchUserProfile, useSocket } from "@brandonhorst/yourturn/hooks";

const socket = useSocket("/api/socket");
const profile = await fetchUserProfile(socket, "some-user-id");
```

`profile` is `UserProfileViewData<MyGameTypes> | null`, including canonical user
fields plus a reverse-chronological `completedMatches` snapshot list.

All exported framework types now take a single bundled generic. Define your
game's bundle once and reuse it across `GameDefinition`, server APIs, and hook
props.

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

## Designing Game and UI Logic

These are the things you need to define to build your game.

### `Config`

```ts
export type Config
```

This represents the necessary setup information for the game, such as number of
players, decks, etc.

### `GameState`

```ts
export type GameState
```

This represents complete state of the game at any given point in time, including
information hidden from all players. This must be a datatype compatible with the
[the structured clone algorithm](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm).

### `Move`

```ts
export type Move
```

Any JSON-serializable object. This represents any action that any player takes.
This can be thought of as the edges of the game's state machine's graph. Often,
typescript "Union Types" are a good way to implement this.

### `PlayerState` and `PublicState`

```ts
export type PlayerState

export type PublicState
```

Two JSON-serializable objects. These are sent to users' browsers to be rendered
by the View. For games with hidden information, this should only contain
information that each player (and observers) should be privy to. In games with
no hidden information, `GameState`, `PlayerState`, and `PublicState` can (but do
not need to be) the same type.

### `game`

This object should satisfy `GameDefinition<MyGameTypes>`.

```ts
export const game: {
  queues: { [id: string]: {numPlayers: number, config: Config} };
  setup(c: Config, o: { timestamp: Date }): GameState;
  isValidMove(
    s: GameState,
    move: Move
    o: { timestamp: Date; playerId: number },
  ): boolean;
  processMove(
    s: GameState,
    o: { m: Move, timestamp: Date; playerId: number },
  ): void;
  refreshTimeout?(
    s: GameState,
    o: { config: Config; timestamp: Date },
  ): number | undefined;
  playerState(
    s: GameState,
    o: { playerId: number },
  ): PlayerState;
  publicState(
    s: GameState,
  ): PublicState;
  outcome(s: GameState): Outcome | undefined;
};
```

A `GameDefinition` object with functions which determine the game's behavior.
These functions are only executed on the server.

- `setup` is used to create the initial `GameState` object.
- `isValidMove` is used to determine if a `Move` sent from the client is
  legimate. Ideally, the UI should prevent sending invalid moves, but this
  serves as a server-side failsafe.
- `processMove` should return a modified version of the provided `GameState`
  according to the provided `Move`. This will only be called if `isValidMove`
  returned true. It is recommended to use a library like `npm:immer` to make
  returning a mutated version of `GameState` easier. This will potentially be
  called many times, and must efficient. It should be determistic and cannot
  access the network or the file system.
- `playerState` should create a `PlayerState` object to be sent to the client.
  This can be used to hide information from players, and to provide a nicer
  interface for building the UI upon.
- `publicState` should create an `PublicState` object to be sent to the client.
  This can be used to hide information from observers, and to provide a nicer
  interface for building the UI upon.
- `outcome` should return a non-undefined value when the game is done and no
  further `Move`s should be permitted.
- `refreshTimeout` is reserved for future time-based mechanics.

### `View`

```ts
export function PlayerView(props: {
  playerState: PlayerState;
  publicState: PublicState;
  playerId: number;
  perform: (move: Move) => void;
});

export function ObserverView(props: { publicState: PublicState });
```

Two Preact components to define your views.

- `PlayerView` takes a `PlayerState` and `PublicState` for rendering the game
  for each player, as well as a `playerId`. In response to user action, it can
  call `perform` to pass a `Move` to the server and modify the gamestate.
- `ObserverView` takes an `PublicState` for rendering the game for people
  watching. It cannot perform actions.

In both cases, game state modifications cause a new state to be generated and
the component to be re-rendered.

## Active Public User Presence

`yourturn` maintains a TTL-backed public presence list at
`["activepublicusers", userId]` with:

- `playerSnapshot`: a `PlayerSnapshot`
- `connectionCount`: number of currently tracked open sockets for that user

Presence entries are created/incremented when a socket is configured, refreshed
when the user subscribes to channels or performs mutating operations, and
decremented when the socket closes. All presence writes also increment the root
ticker at `["activepublicusers"]`, which drives presence list watchers.

The current design has known tradeoffs:

- TTL expiration does not trigger an application-side presence write, so
  expiration-only removals do not increment `["activepublicusers"]`. Watchers
  notice those removals on the next ticker bump, not immediately at expiry.
- There are no heartbeats. A connected but idle socket can age out after the
  10-minute TTL window and temporarily disappear from the active users list
  until a subsequent socket reconnect increments presence again.
- Active public user snapshots are read with one `kv.list` batch (`limit=500`,
  `batchSize=500`), so lists over 500 users are truncated.
