import { useState } from "preact/hooks";
import { useSocket } from "../client/hookutils.ts";
import type {
  ObserveSocketRequest,
  ObserveSocketResponse,
} from "../common/types.ts";
import type { ObserverProps } from "../types.ts";

// Opens an auto-reconnecting WebSocket to a given Observe URL.
// Returns an always up-to-date ObserverState. Closes the socket if the game completes.
export function useObserveSocket<O>(
  socketUrl: string,
  initialObserverProps: ObserverProps<O>,
): O {
  const [observerState, setObserverState] = useState<O>(
    initialObserverProps.observerState,
  );

  // Handler for socket messages
  function onMessage(response: ObserveSocketResponse<O>, close: () => void) {
    switch (response.type) {
      case "MarkComplete":
        close();
        break;
      case "UpdateObserveState":
        setObserverState(response.observerState);
        break;
    }
  }

  // Open the socket
  useSocket<
    ObserveSocketRequest<O>,
    ObserveSocketResponse<O>
  >(
    !initialObserverProps.isComplete,
    () => new WebSocket(socketUrl),
    { type: "Initialize", currentObserverState: observerState },
    onMessage,
  );

  return observerState;
}
