export type SocketMessageListener = (message: string) => void;
export type SocketOpenListener = () => void;

export interface Socket {
  /**
   * Registers a handler for incoming WebSocket message events.
   */
  addMessageListener: (handler: SocketMessageListener) => void;

  /**
   * Removes a previously registered message handler.
   */
  removeMessageListener: (handler: SocketMessageListener) => void;

  /**
   * Registers a handler for the WebSocket open event.
   */
  addOpenListener: (handler: SocketOpenListener) => void;

  /**
   * Removes a previously registered open handler.
   */
  removeOpenListener: (handler: SocketOpenListener) => void;

  /**
   * Sends one serialized payload over the websocket.
   */
  send: (data: string) => void;
}
