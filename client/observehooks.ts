import { useState } from "preact/hooks";
import { useSocket } from "../client/hookutils.ts";
import type {
  ObserveSocketRequest,
  ObserveSocketResponse,
} from "../common/types.ts";
import type { ObserverProps, ObserveViewProps } from "../types.ts";

// Opens an auto-reconnecting WebSocket to a given Observe URL.
// Returns an always up-to-date ObserverState. Closes the socket if the game completes.
export function useObserveSocket<ObserverState>(
  socketUrl: string,
  initialObserverProps: ObserverProps<ObserverState>,
): ObserveViewProps<ObserverState> {
  const [observerState, setObserverState] = useState<ObserverState>(
    initialObserverProps.observerState,
  );
  const [isComplete, setIsComplete] = useState<boolean>(
    initialObserverProps.isComplete,
  );
  const players = initialObserverProps.players;

  // Handler for socket messages
  function onMessage(response: ObserveSocketResponse<ObserverState>, close: () => void) {
    switch (response.type) {
      case "MarkComplete":
        setIsComplete(true);
        close();
        break;
      case "UpdateObserveState":
        setObserverState(response.observerState);
        break;
    }
  }

  // Open the socket
  useSocket<
    ObserveSocketRequest<ObserverState>,
    ObserveSocketResponse<ObserverState>
  >(
    !initialObserverProps.isComplete,
    () => new WebSocket(socketUrl),
    { type: "Initialize", currentObserverState: observerState },
    onMessage,
  );

  return { observerState, isComplete, players };
}
