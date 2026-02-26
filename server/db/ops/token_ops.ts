import {
  logServer,
  serializeLogValue,
  type ServerLogLevel,
} from "@/server/logging.ts";
import type { GameTypes, TokenData } from "@/types/mod.ts";
import type { DbContext } from "../context.ts";
import type { TokenOps } from "../contracts.ts";
import { getTokenKey } from "../keys.ts";

const TOKEN_OPS_LOG_MODULE = "server.db.token";

/**
 * Deno KV implementation of auth token storage operations.
 */
export class KvTokenOps<T extends GameTypes> implements TokenOps {
  constructor(
    private readonly context: DbContext<T>,
  ) {}

  /**
   * Emits one log entry for token DB operations.
   */
  private log(level: ServerLogLevel, message: string): void {
    logServer(TOKEN_OPS_LOG_MODULE, level, message);
  }

  /**
   * Stores one token payload.
   */
  async storeToken(token: string, tokenData: TokenData): Promise<void> {
    this.log(
      "INFO",
      `storeToken request=${serializeLogValue({ token, tokenData })}`,
    );
    const res = await this.context.kv.atomic()
      .set(getTokenKey(token), tokenData)
      .commit();
    if (!res.ok) {
      throw new Error("Failed to store token");
    }
    this.log(
      "INFO",
      `storeToken completed=${serializeLogValue({ token, tokenData })}`,
    );
  }

  /**
   * Fetches one token payload.
   */
  async getToken(token: string): Promise<TokenData | null> {
    this.log(
      "INFO",
      `getToken request=${serializeLogValue({ token })}`,
    );
    const entry = await this.context.kv.get<TokenData>(getTokenKey(token));
    const tokenData = entry.value ?? null;
    this.log(
      "INFO",
      `getToken response=${serializeLogValue({ token, tokenData })}`,
    );
    return tokenData;
  }
}
