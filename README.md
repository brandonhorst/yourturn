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
export type PlayerId
```

This represents the ID of a player. It must extend `number | string`.

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

### `PlayerState` and `ObserverState`

```ts
export type PlayerState

export type ObserverState
```

Two JSON-serializable objects. These are sent to users' browsers to be rendered
by the View. For games with hidden information, this should only contain
information that each player (and observers) should be privy to. In games with
no hidden information, `GameState`, `PlayerState`, and `ObserverState` can (but
do not need to be) the same type.

### `game`

```ts
export const game: {
  setup(c: Config, o: { timestamp: Date }): GameState;
  isValidMove(
    s: GameState,
    move: Move
    o: { timestamp: Date; playerId: PlayerId },
  ): boolean;
  processMove(
    s: GameState,
    o: { m: Move, timestamp: Date; playerId: PlayerId },
  ): void;
  refreshTimeout?(
    s: GameState,
    o: { config: Config; timestamp: Date },
  ): number | undefined;
  refresh?(
    s: GameState,
    o: { config: Config; timestamp: Date },
  ): GameState;
  playerState(s: GameState, o: { playerId: PlayerId; isComplete: boolean }): PlayerState;
  observerState(s: GameState, o: { isComplete: boolean }): ObserverState;
  isComplete(s: GameState): boolean;
};
```

An object with functions which determine the Game's behavior. These functions
are only executed on the server.

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
- `observerState` should create an `ObserverState` object to be sent to the
  client. This can be used to hide information from observers, and to provide a
  nicer interface for building the UI upon.
- `isComplete` should return true if the game is done and no further `Move`s
  should be permitted.
- `refreshTimeout` can be called to trigger a `refresh` call and an `isComplete`
  check after a certain number of milliseconds. This can be used to implement
  timers.
- `refreshTimeout` can be used to create a new `GameState` object in response to
  a `refreshTimeout` trigger. Note that it's OK to implement `refreshTimeout`
  without implementing `refresh` in cases where the only time-based effect is
  ending the game in a loss (such as a chess timer).

### `View`

```ts
export function PlayerView(props: {
  playerState: PlayerState;
  playerId: PlayerId;
  perform: (move: Move) => void;
});

export function ObserverView(props: { observerState: ObserverState });
```

Two Preact components to define your views.

- `PlayerView` takes a `PlayerState` for rendering the game for each player, as
  well as a `playerId`. In response to user action, it can call `perform` to
  pass a `Move` to the server and modify the gamestate.
- `ObserverView` takes an `ObserverState` for rendering the game for people
  watching. It cannot perform actions.

In both cases, game state modifications cause a new state to be generated and
the component to be re-rendered.
