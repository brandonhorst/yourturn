import { useCallback, useEffect, useState } from "preact/hooks";
import type { ClientMessage, ServerMessage } from "@/protocol/mod.ts";
import type {
  AccountUserProfileProps,
  GameTypes,
  Socket,
  UserProfileUpdate,
  UserProfileViewData,
} from "@/types/mod.ts";

/**
 * Subscribes to the authenticated user's account profile channel.
 */
export function useAccountUserProfileChannel<T extends GameTypes>({
  socket,
  initialAccountUserProfileProps,
}: {
  socket: Socket;
  initialAccountUserProfileProps: UserProfileViewData<T>;
}): AccountUserProfileProps<T> {
  const [accountUserProfile, setAccountUserProfile] = useState(
    initialAccountUserProfileProps,
  );

  useEffect(() => {
    setAccountUserProfile(initialAccountUserProfileProps);
  }, [initialAccountUserProfileProps]);

  useEffect(() => {
    const subscriptionId = crypto.randomUUID();

    /**
     * Sends one account-user-profile subscribe request.
     */
    function sendSubscribe() {
      const request: ClientMessage<T> = {
        type: "SubscribeAccountUserProfile",
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
        case "UpdateAccountUserProfileProps":
          if (response.subscriptionId !== subscriptionId) {
            break;
          }
          setAccountUserProfile(response.accountUserProfileProps);
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

  const update = useCallback((changes: UserProfileUpdate) => {
    if (changes.description == null) {
      return;
    }

    const request: ClientMessage<T> = {
      type: "UpdateAccountUserProfile",
      description: changes.description,
    };
    socket.send(JSON.stringify(request));
  }, [socket]);

  return {
    ...accountUserProfile,
    update,
  };
}
