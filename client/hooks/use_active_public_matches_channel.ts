import { useEffect, useState } from "preact/hooks";
import type { ClientMessage, ServerMessage } from "@/protocol/mod.ts";
import type {
  ActivePublicMatchesViewData,
  GameTypes,
  Socket,
} from "@/types/mod.ts";

/**
 * Subscribes to the global active public matches channel.
 */
export function useActivePublicMatchesChannel<T extends GameTypes>({
  socket,
  initialActivePublicMatchesProps,
}: {
  socket: Socket;
  initialActivePublicMatchesProps: ActivePublicMatchesViewData<T>;
}): ActivePublicMatchesViewData<T> {
  const [allActiveMatches, setActiveMatches] = useState(
    initialActivePublicMatchesProps.allActiveMatches,
  );

  useEffect(() => {
    const subscriptionId = crypto.randomUUID();

    /**
     * Sends one active-public-matches subscribe request.
     */
    function sendSubscribe() {
      const request: ClientMessage<T> = {
        type: "SubscribeActivePublicMatches",
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
        case "UpdateActivePublicMatches":
          if (response.subscriptionId !== subscriptionId) {
            break;
          }

          setActiveMatches(response.activePublicMatchesProps.allActiveMatches);
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

  return { allActiveMatches };
}
