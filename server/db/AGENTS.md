# server/db AGENTS

This file provides module-specific guidance for `server/db/*`. Repo-wide
guidance in `/Users/brandon/Developer/yourturn/AGENTS.md` still applies.

## Module Overview

The DB layer is implemented as a composed class hierarchy:

- `db.ts` - Top-level `DB` facade exported to the rest of the server
- `utils.ts` - KV key builders, shared constants, and base transaction helpers
- `types.ts` - DB storage and watcher payload types
- `users.ts` - Canonical user profile storage, username index, and auth tokens
- `presence.ts` - Active public user presence counters, TTL updates, and
  watchers
- `matchmaking.ts` - Queue, room, game, user-matchmaking, and public list
  indexes

`DB` inherits behavior in this order:
`DB -> MatchmakingDB -> PresenceDB -> UsersDB -> DBBase`.

## Storage Keys

The module persists data in Deno KV using these key families:

- `[`"users"`, userId]` for canonical user profile and queue ratings
- `[`"usersByUsername"`, username]` for unique username lookup
- `[`"usermatchmakings"`, userId]` for `activeGames`, `joinedRooms`, and
  `queueEntries`
- `[`"tokens"`, token]` for reconnect/auth token data
- `[`"queueentry"`, queueId, entryId]` for queue entries
- `[`"rooms"`, roomId]` for room records
- `[`"games"`, gameId]` for game records
- `[`"activepublicgames"`, gameId]` for indexed active public games
- `[`"availablepublicrooms"`, roomId]` for indexed available public rooms
- `[`"activepublicusers"`, userId]` for active user presence snapshots

Root index invalidation/ticker keys:

- `[`"activepublicgames"]`
- `[`"availablepublicrooms"]`
- `[`"activepublicusers"]`

## Index and Watcher Behavior

- Public list watchers observe only root keys, then reload full snapshots with
  `kv.list` (`limit=500`, `batchSize=500`) filtered to direct children.
- Root keys are mutated with `Deno.KvU64` atomic `sum` operations: `+1` for
  insert, `-1` for delete, `0` for in-place updates.
- Active users use a TTL (`10 minutes`) with no heartbeat loop; TTL is refreshed
  during socket setup and mutating/subscribe requests.

## Data Invariants

- `PlayerSnapshot<Rating>` is frozen at queue/room join time and reused in queue
  entries, room members, games, active public games, and available public rooms.
- Account profile updates only mutate canonical user data (`description` etc.)
  and do not retroactively rewrite stored snapshots.
- Queue/room join requests may include `assignmentSubscriptionId` so graduation
  and room commit can emit targeted `GameAssignment` notifications.

## Cross-Module Boundary

Profile/snapshot conversion helpers are intentionally outside this module in
`/Users/brandon/Developer/yourturn/server/utils.ts`:

- `userStorageDataToUserProfileViewData`
- `userProfileViewDataToPlayerSnapshot`

Keep this separation when changing DB internals.

## Maintenance Rule

When changing DB keyspace, index semantics, storage/watcher payloads, or module
layout under `server/db/`, update this file in the same change set.
