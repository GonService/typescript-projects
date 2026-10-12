import type { Config } from "./config.js";
import type { Delivery, Store } from "./store.js";

export interface WorkerLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/** Exponential backoff with full jitter: random value up to base * 2^(attempt-1), capped at 1 hour. */
export function backoff(attempt: number, baseMs: number, random = Math.random): number {
  const ceiling = Math.min(baseMs * 2 ** Math.max(attempt - 1, 0), 60 * 60 * 1000);
  return Math.max(baseMs, Math.floor(random() * ceiling));
}

export class Worker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private store: Store,
    private config: Pick<Config, "maxAttempts" | "baseBackoffMs" | "deliveryTimeoutMs" | "pollIntervalMs">,
    private log: WorkerLogger,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Processes every delivery that is due. Safe to call concurrently: overlapping runs are skipped. */
  async tick(now = Date.now()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const due = this.store.due(now);
      for (const d of due) await this.deliver(d, now);
      return due.length;
    } finally {
      this.running = false;
    }
  }

  private async deliver(d: Delivery, now: number): Promise<void> {
    const attempt = d.attempts + 1;
    try {
      const res = await this.fetchImpl(d.target, {
        method: "POST",
        headers: {
          "content-type": d.contentType,
          "x-relay-source": d.source,
          "x-relay-event-id": d.eventId,
          "x-relay-attempt": String(attempt),
        },
        body: d.payload,
        signal: AbortSignal.timeout(this.config.deliveryTimeoutMs),
      });
      if (res.ok) {
        this.store.markDelivered(d.id, now);
        this.log.info({ id: d.id, source: d.source, attempt }, "delivered");
        return;
      }
      this.fail(d, attempt, `HTTP ${res.status}`, now);
    } catch (err) {
      this.fail(d, attempt, err instanceof Error ? err.message : String(err), now);
    }
  }

  private fail(d: Delivery, attempt: number, error: string, now: number): void {
    const giveUp = attempt >= this.config.maxAttempts;
    const next = giveUp ? null : now + backoff(attempt, this.config.baseBackoffMs);
    this.store.markFailedAttempt(d.id, error, next, now);
    this.log.warn({ id: d.id, source: d.source, attempt, error, giveUp }, giveUp ? "delivery failed permanently" : "delivery failed, will retry");
  }
}
