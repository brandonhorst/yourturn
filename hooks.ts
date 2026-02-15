import type { GameViewData, Socket } from "./types.ts";

import { useInternalSocket } from "./client/socket.ts";
import { useInternalGameChannel } from "./client/gamechannel.ts";
import { useInternalRoomChannel } from "./client/roomchannel.ts";
import { useInternalUserMatchmakingChannel } from "./client/usermatchmakingchannel.ts";
import { useInternalActivePublicGamesChannel } from "./client/activepublicgameschannel.ts";
import { useInternalAvailablePublicRoomsChannel } from "./client/availablepublicroomschannel.ts";

// Opens a WebSocket with exponential backoff to socketUrl, if shouldOpen is true
export function useSocket(
  socketUrl: string,
  shouldOpen = true,
): Socket {
  return userInternalSocket(socketUrl, shouldOpen);
}

export function useUserMatchmakingChannel(
  socket: Socket,
  initialViewData: UserMatchmakingViewData,
): UserMatchmakingProps {
  return useInternalUserMatchmakingChannel(socket, initialViewData);
}

export function useRoomChannel(
  socket: Socket,
  initialViewData: RoomViewData,
): RoomProps {
  return useInternalRoomChannel(socket, initialViewData);
}

export function useQueueChannel(
  socket: Socket,
  initialViewData: QueueViewData,
): QueueProps {
  return useInternalQueueChannel(socket, initialViewData);
}

export function useActivePublicGamesChannel(
  socket: Socket,
  initialViewData: ActivePublicGamesViewData,
): ActivePublicGamesProps {
  return useInternalActivePublicGamesChannel(socket, initialViewData);
}

export function useAvailablePublicRoomsChannel(
  socket: Socket,
  initialViewData: AvailablePublicRoomsViewData,
): AvailablePublicRoomsProps {
  return useInternalAvailablePublicRoomsChannel(socket, initialViewData);
}

export function useGameChannel<Move, PlayerState, PublicState, Outcome>(
  socket: Socket,
  initialViewData: GameViewData<PlayerState, PublicState, Outcome>,
): GameProps<Move, PlayerState, PublicState, Outcome> {
  return useInternalGameChannel(socket, initialViewData);
}
