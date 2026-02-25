/**
 * Supported server log levels in ascending verbosity order.
 */
export type ServerLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

type LogSerializable =
  | boolean
  | number
  | object
  | string
  | null
  | undefined;

const SERVER_LOG_LEVEL_ENV_VAR = "YOURTURN_SERVER_LOG_LEVEL";
const SERVER_LOG_MODULE_ENV_VAR = "YOURTURN_SERVER_LOG_MODULE";

const LOG_LEVEL_PRIORITIES: Record<ServerLogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

/**
 * Reads one environment variable and returns undefined if env access is denied.
 */
function readEnvironmentVariable(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/**
 * Normalizes a configured log level to a supported value.
 */
function parseConfiguredLogLevel(value: string | undefined): ServerLogLevel {
  const normalized = value?.trim().toUpperCase();
  if (
    normalized === "DEBUG" || normalized === "INFO" || normalized === "WARN" ||
    normalized === "ERROR"
  ) {
    return normalized;
  }
  return "INFO";
}

/**
 * Escapes regex metacharacters in a literal string segment.
 */
function escapeRegexLiteralSegment(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Converts a wildcard module filter into an anchored regular expression.
 */
function buildModuleFilterRegex(moduleFilter: string): RegExp {
  const escapedPattern = moduleFilter
    .split("*")
    .map((segment) => escapeRegexLiteralSegment(segment))
    .join(".*");
  return new RegExp(`^${escapedPattern}$`);
}

/**
 * Returns true when a module name should be logged for the configured filter.
 */
function shouldLogModule(moduleName: string): boolean {
  const configuredModuleFilter = readEnvironmentVariable(
    SERVER_LOG_MODULE_ENV_VAR,
  )?.trim();
  const moduleFilter = configuredModuleFilter === "" ||
      configuredModuleFilter == null
    ? "*"
    : configuredModuleFilter;
  return buildModuleFilterRegex(moduleFilter).test(moduleName);
}

/**
 * Returns true when a message at the given level should be emitted.
 */
function shouldLogLevel(level: ServerLogLevel): boolean {
  const configuredLevel = parseConfiguredLogLevel(
    readEnvironmentVariable(SERVER_LOG_LEVEL_ENV_VAR),
  );
  return LOG_LEVEL_PRIORITIES[level] >= LOG_LEVEL_PRIORITIES[configuredLevel];
}

/**
 * Emits one timestamped server log entry when level and module filters allow it.
 */
export function logServer(
  moduleName: string,
  level: ServerLogLevel,
  message: string,
): void {
  if (!shouldLogLevel(level)) {
    return;
  }
  if (!shouldLogModule(moduleName)) {
    return;
  }

  const timestamp = new Date().toISOString();
  console.log(`${timestamp} [${level}] [${moduleName}] ${message}`);
}

/**
 * Serializes a value into a stable single-line representation for logging.
 */
export function serializeLogValue(value: LogSerializable): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  if (value == null) {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}
