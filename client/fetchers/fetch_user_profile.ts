import type { ClientMessage, ServerMessage } from "@/protocol/mod.ts";
import type { GameTypes, Socket, UserProfileViewData } from "@/types/mod.ts";

const fetchUserProfileTimeoutMs = 10000;

/**
 * Fetches one canonical user profile snapshot for a target user ID.
 * Returns `null` when the requested user does not exist.
 */
export function fetchUserProfile<T extends GameTypes>(
  socket: Socket,
  userId: string,
): Promise<UserProfileViewData<T> | null> {
  const requestId = crypto.randomUUID();
  const request: ClientMessage<T> = {
    type: "FetchUserProfile",
    requestId,
    userId,
  };

  return new Promise((resolve, reject) => {
    /**
     * Resolves only for this request ID and then detaches listeners.
     */
    const onMessage = (message: string) => {
      const response = JSON.parse(message) as ServerMessage<T>;
      if (
        response.type !== "FetchUserProfileResult" ||
        response.requestId !== requestId
      ) {
        return;
      }

      clearTimeout(timeoutId);
      socket.removeMessageListener(onMessage);
      socket.removeOpenListener(onOpen);
      resolve(response.userProfile);
    };

    /**
     * Retries the request after reconnects until a response arrives.
     */
    const onOpen = () => {
      socket.send(JSON.stringify(request));
    };

    /**
     * Cleans up listeners and timeout for this one-shot request.
     */
    const timeoutId = setTimeout(() => {
      socket.removeMessageListener(onMessage);
      socket.removeOpenListener(onOpen);
      reject(new Error("Timed out fetching user profile."));
    }, fetchUserProfileTimeoutMs);

    socket.addMessageListener(onMessage);
    socket.addOpenListener(onOpen);
    try {
      socket.send(JSON.stringify(request));
    } catch {
      // Request will be retried when the socket opens.
    }
  });
}
