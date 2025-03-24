import { assertEquals, assertExists } from "jsr:@std/assert";
import { assertSpyCalls, spy } from "jsr:@std/testing/mock";
import { FakeTime } from "jsr:@std/testing/time";
import { useSocket } from "../client/hookutils.ts";
import { renderHook } from "npm:@testing-library/preact";
import { DOMParser } from "npm:linkedom";

// Set up DOM globals for tests
const dom = new DOMParser().parseFromString(
  "<!DOCTYPE html><html><body></body></html>",
  "text/html",
);

// @ts-ignore Set up globals that Preact expects
globalThis.document = dom;

Deno.test("useSocket initializes properly", () => {
  // Mock objects and functions - create new ones for each test
  const mockSocket = {
    addEventListener: spy(),
    close: spy(),
    send: spy(),
  };

  const mockCreateSocket = spy(() => mockSocket);

  const onUpdate = spy();

  const { result } = renderHook(() =>
    useSocket(true, mockCreateSocket, null, onUpdate)
  );

  // Check that the WebSocket was created with the correct URL
  assertSpyCalls(mockCreateSocket, 1);

  // Check that the correct event listeners were added
  assertSpyCalls(mockSocket.addEventListener, 3);
  assertEquals(mockSocket.addEventListener.calls[0].args[0], "open");
  assertEquals(mockSocket.addEventListener.calls[1].args[0], "message");
  assertEquals(mockSocket.addEventListener.calls[2].args[0], "close");

  // Verify the ref was returned
  assertExists(result.current);
});

Deno.test("useSocket handles messages correctly", () => {
  // Mock objects and functions - create new ones for each test
  const mockSocket = {
    addEventListener: spy(),
    close: spy(),
    send() {},
  };

  const mockCreateSocket = spy(() => mockSocket);

  const onUpdate = spy();

  renderHook(() => useSocket(true, mockCreateSocket, null, onUpdate));

  // Get the message handler
  const messageHandler = mockSocket.addEventListener.calls[1].args[1];

  // Simulate receiving a message
  const testData = { test: "data" };
  messageHandler({ data: JSON.stringify(testData) });

  // Check that onUpdate was called with the parsed data
  assertSpyCalls(onUpdate, 1);
  assertEquals(onUpdate.calls[0].args[0], testData);
});

Deno.test("useSocket sends initializeMessage when socket opens", () => {
  // Mock objects and functions
  const mockSocket = {
    addEventListener: spy(),
    close: spy(),
    send: spy(),
  };

  const mockCreateSocket = spy(() => mockSocket);
  const onUpdate = spy();

  // Define an initialize message
  const initMessage = { action: "init", data: "test-init" };

  renderHook(() => useSocket(true, mockCreateSocket, initMessage, onUpdate));

  // Get the open handler
  const openHandler = mockSocket.addEventListener.calls[0].args[1];

  // Simulate socket open event
  openHandler();

  // Check that send was called with the correct message
  assertSpyCalls(mockSocket.send, 1);
  assertEquals(mockSocket.send.calls[0].args[0], JSON.stringify(initMessage));
});

Deno.test("useSocket cleans up on unmount", () => {
  // Mock objects and functions - create new ones for each test
  const mockSocket = {
    addEventListener: spy(),
    close: spy(),
    send() {},
  };

  const mockCreateSocket = spy(() => mockSocket);

  const onUpdate = spy();

  const { unmount } = renderHook(() =>
    useSocket(true, mockCreateSocket, null, onUpdate)
  );

  // Execute the cleanup function
  unmount();

  // Verify that close was called
  assertSpyCalls(mockSocket.close, 1);
});

// Test for onClose callback
Deno.test("useSocket calls onClose when socket closes", () => {
  // Mock implementations
  const mockSocket = {
    addEventListener: spy(),
    close: spy(),
    send: spy(),
  };

  const mockCreateSocket = spy(() => mockSocket);
  const onMessage = spy();
  const onClose = spy();

  // Create a partial mock of the useSocket hook to control closedIntentionally
  const { unmount } = renderHook(() => {
    // This is a real call to the hook
    return useSocket(true, mockCreateSocket, null, onMessage, onClose);
  });

  // Retrieve the close handler
  const closeHandlerCall = mockSocket.addEventListener.calls.find(
    (call) => call.args[0] === "close",
  );
  assertExists(closeHandlerCall);
  const closeHandler = closeHandlerCall.args[1];

  // First unmount to set closedIntentionally=true internally
  unmount();

  // Then call the close handler directly
  closeHandler(new MessageEvent("close"));

  // Verify onClose was called
  assertSpyCalls(onClose, 1);
});

Deno.test("useSocket implements exponential backoff on reconnection", () => {
  // Use FakeTime to control the clock
  using fakeTime = new FakeTime();

  const consoleLogSpy = spy(console, "log");

  // Create a storage for event handler callbacks
  const eventHandlers: Record<string, Array<(event: MessageEvent) => void>> = {
    open: [],
    message: [],
    close: [],
  };

  // Factory for mock sockets that also captures event handlers
  const mockCreateSocket = spy(() => {
    const addEventListener = spy(
      (event: string, handler: (event: MessageEvent) => void) => {
        eventHandlers[event].push(handler);
      },
    );

    const socket = {
      addEventListener,
      close: spy(),
      send() {},
    };

    return socket;
  });

  const onUpdate = spy();

  // Render the hook with our mock socket creator
  renderHook(() => useSocket(true, mockCreateSocket, null, onUpdate));

  // Initial socket should be created
  assertSpyCalls(mockCreateSocket, 1);

  // First close event - should trigger reconnect with 1000ms delay (2^0 * 1000)
  eventHandlers.close[0](new MessageEvent("close"));

  // Advance time by 1000ms (the first backoff delay)
  fakeTime.tick(1000);

  // Second socket should be created
  assertSpyCalls(mockCreateSocket, 2);

  // Second close event - should trigger reconnect with 2000ms delay (2^1 * 1000)
  eventHandlers.close[1](new MessageEvent("close"));

  // Advance time by 2000ms (the second backoff delay)
  fakeTime.tick(2000);

  // Third socket should be created
  assertSpyCalls(mockCreateSocket, 3);

  // Third close event - should trigger reconnect with 4000ms delay (2^2 * 1000)
  eventHandlers.close[2](new MessageEvent("close"));

  // Advance time by 4000ms (the third backoff delay)
  fakeTime.tick(4000);

  // Fourth socket should be created
  assertSpyCalls(mockCreateSocket, 4);

  // Verify the log messages showing exponential backoff
  const reconnectLogs = consoleLogSpy.calls
    .filter((call) => call.args[0]?.includes?.("Reconnecting in"))
    .map((call) => call.args[0]);

  assertEquals(reconnectLogs.length, 3);
  assertEquals(reconnectLogs[0].includes("0ms"), true);
  assertEquals(reconnectLogs[1].includes("1ms"), true);
  assertEquals(reconnectLogs[2].includes("3ms"), true);

  // Verify attempt counts in logs
  assertEquals(reconnectLogs[0].includes("attempt 1"), true);
  assertEquals(reconnectLogs[1].includes("attempt 2"), true);
  assertEquals(reconnectLogs[2].includes("attempt 3"), true);
});
