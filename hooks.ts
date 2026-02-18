import type {
  ActivePublicGamesProps,
  ActivePublicGamesViewData,
  AvailablePublicRoomsProps,
  AvailablePublicRoomsViewData,
  GameProps,
  GameViewData,
  RoomProps,
  RoomViewData,
  Socket,
  Ulid,
  UserMatchmakingProps,
  UserMatchmakingViewData,
} from "./types.ts";

import { useInternalSocket } from "./client/socket.ts";
import { useInternalGameChannel } from "./client/gamechannel.ts";
import { useInternalRoomChannel } from "./client/roomchannel.ts";
import { useInternalUserMatchmakingChannel } from "./client/usermatchmakingchannel.ts";
import { useInternalActivePublicGamesChannel } from "./client/activepublicgameschannel.ts";
import { useInternalAvailablePublicRoomsChannel } from "./client/availablepublicroomschannel.ts";

// Opens a WebSocket with exponential backoff to socketUrl, if shouldOpen is true.
export function useSocket(
  socketUrl: string,
  shouldOpen = true,
): Socket {
  return useInternalSocket(socketUrl, shouldOpen);
}

// Subscribes to user-specific matchmaking data and exposes matchmaking actions.
export function useUserMatchmakingChannel<Config, Loadout>(
  socket: Socket,
  initialViewData: UserMatchmakingViewData<Config, Loadout>,
): UserMatchmakingProps<Config, Loadout> {
  return useInternalUserMatchmakingChannel(socket, initialViewData);
}

// Subscribes to a specific room stream and keeps room view data in sync.
export function useRoomChannel<Config, Loadout>(
  socket: Socket,
  roomId: Ulid,
  initialViewData: RoomViewData<Config, Loadout>,
): RoomProps<Config, Loadout> {
  return useInternalRoomChannel(socket, roomId, initialViewData);
}

// Subscribes to the global active public game list.
export function useActivePublicGamesChannel<Config>(
  socket: Socket,
  initialViewData: ActivePublicGamesViewData<Config>,
): ActivePublicGamesProps<Config> {
  return useInternalActivePublicGamesChannel(socket, initialViewData);
}

// Subscribes to the global available public room list.
export function useAvailablePublicRoomsChannel<Config>(
  socket: Socket,
  initialViewData: AvailablePublicRoomsViewData<Config>,
): AvailablePublicRoomsProps<Config> {
  return useInternalAvailablePublicRoomsChannel(socket, initialViewData);
}

// Subscribes to a specific game stream and exposes move submission for players.
export function useGameChannel<Move, PlayerState, PublicState, Outcome>(
  socket: Socket,
  gameId: Ulid,
  initialViewData: GameViewData<PlayerState, PublicState, Outcome>,
): GameProps<Move, PlayerState, PublicState, Outcome> {
  return useInternalGameChannel(socket, gameId, initialViewData);
}
