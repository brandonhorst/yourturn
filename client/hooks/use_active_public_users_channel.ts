import { useEffect, useMemo, useState } from "preact/hooks";
import type { ClientMessage, ServerMessage } from "@/protocol/mod.ts";
import type { ActiveUsersViewData, GameTypes, Socket } from "@/types/mod.ts";

/**
 * Subscribes to the global active public users channel.
 */
export function useActivePublicUsersChannel<T extends GameTypes>({
  socket,
  initialActivePublicUsersProps,
  starredUserIds = [],
}: {
  socket: Socket;
  initialActivePublicUsersProps: ActiveUsersViewData<T>;
  starredUserIds?: string[];
}): ActiveUsersViewData<T> {
  const [allActiveUsers, setActiveUsers] = useState(
    initialActivePublicUsersProps.allActiveUsers,
  );

  useEffect(() => {
    const subscriptionId = crypto.randomUUID();

    /**
     * Sends one active-public-users subscribe request.
     */
    function sendSubscribe() {
      const request: ClientMessage<T> = {
        type: "SubscribeActivePublicUsers",
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
        case "UpdateActivePublicUsers":
          if (response.subscriptionId !== subscriptionId) {
            break;
          }

          setActiveUsers(response.activePublicUsersProps.allActiveUsers);
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

  /**
   * Prioritizes starred users locally without altering server subscription data.
   */
  const sortedActiveUsers = useMemo(() => {
    if (starredUserIds.length === 0 || allActiveUsers.length < 2) {
      return allActiveUsers;
    }

    const starredUserIdSet = new Set(starredUserIds);
    return allActiveUsers
      .map((activeUser, index) => ({
        activeUser,
        index,
        isStarred: starredUserIdSet.has(activeUser.userId),
      }))
      .sort((left, right) => {
        if (left.isStarred !== right.isStarred) {
          return left.isStarred ? -1 : 1;
        }

        return left.index - right.index;
      })
      .map(({ activeUser }) => activeUser);
  }, [allActiveUsers, starredUserIds]);

  return { allActiveUsers: sortedActiveUsers };
}
