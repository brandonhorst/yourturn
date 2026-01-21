import type { JSONValue } from "../types.ts";

export interface Socket {
  send: (data: string) => void;
}

// Returns true if the two JSON-style objects are equal
export function jsonEquals<T extends JSONValue>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
