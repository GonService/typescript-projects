export interface Config {
  port: number;
  host: string;
  /** Messages kept per room and sent to whoever joins. */
  historySize: number;
  /** Flood protection: burst size and refill rate of each connection's token bucket. */
  burst: number;
  refillPerSecond: number;
  /** Rate-limit violations tolerated before the connection is closed. */
  maxViolations: number;
  maxMessageLength: number;
  /** Interval of WebSocket pings; connections that miss one are dropped. */
  heartbeatMs: number;
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: num(env.PORT, 8080),
    host: env.HOST ?? "0.0.0.0",
    historySize: Math.min(num(env.HISTORY_SIZE, 50), 500),
    burst: num(env.FLOOD_BURST, 5),
    refillPerSecond: num(env.FLOOD_REFILL_PER_SECOND, 1),
    maxViolations: num(env.FLOOD_MAX_VIOLATIONS, 10),
    maxMessageLength: num(env.MAX_MESSAGE_LENGTH, 1000),
    heartbeatMs: num(env.HEARTBEAT_MS, 30_000),
  };
}
