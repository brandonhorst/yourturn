import { useEffect, useState } from "preact/hooks";
import type { ClientMessage, ServerMessage } from "../../protocol/mod.ts";
import type {
  AvailablePublicRoomsViewData,
  GameTypes,
  Socket,
} from "../../types/mod.ts";

/**
 * Subscribes to the global available public rooms channel.
 */
export function useAvailablePublicRoomsChannel<T extends GameTypes>({
  socket,
  initialAvailablePublicRoomsProps,
}: {
  socket: Socket;
  initialAvailablePublicRoomsProps: AvailablePublicRoomsViewData<T>;
}): AvailablePublicRoomsViewData<T> {
  const [allAvailableRooms, setAvailableRooms] = useState(
    initialAvailablePublicRoomsProps.allAvailableRooms,
  );

  useEffect(() => {
    const subscriptionId = crypto.randomUUID();

    /**
     * Sends one available-public-rooms subscribe request.
     */
    function sendSubscribe() {
      const request: ClientMessage<T> = {
        type: "SubscribeAvailablePublicRooms",
        subscriptionId,
      };
      socket.send(JSON.stringify(request));
    }

    function onOpen() {
      sendSubscribe();
    }

    function onMessage(message: string) {
      const response = JSON.parse(message) as ServerMessage<T>;
      switch (response.type) {
        case "UpdateAvailablePublicRooms":
          if (response.subscriptionId !== subscriptionId) {
            break;
          }

          setAvailableRooms(
            response.availablePublicRoomsProps.allAvailableRooms,
          );
          break;
      }
    }

    socket.addMessageListener(onMessage);
    socket.addOpenListener(onOpen);
    try {
      sendSubscribe();
    } catch {
      // The socket may still be connecting; subscription will be sent on open.
    }

    return () => {
      const request: ClientMessage<T> = {
        type: "Unsubscribe",
        subscriptionId,
      };
      try {
        socket.send(JSON.stringify(request));
      } catch {
        // Ignore socket state errors during teardown.
      }
      socket.removeMessageListener(onMessage);
      socket.removeOpenListener(onOpen);
    };
  }, [socket]);

  return { allAvailableRooms };
}
