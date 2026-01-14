import type { JSONValue } from "../types.ts";

export interface Socket {
  send: (data: string) => void;
}

// Returns true if the two JSON-style objects are equal
export function jsonEquals(
  a: JSONValue | undefined,
  b: JSONValue | undefined,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
