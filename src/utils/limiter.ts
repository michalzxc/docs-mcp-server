/**
 * Bounded-concurrency runner with a minimum gap between task starts.
 *
 * Exists because the scraper's own concurrency is the wrong knob for LLM calls:
 * `scraper.maxConcurrency` is used both as the pipeline's job concurrency and
 * as the per-job page batch size, so pages can be in flight in numbers a remote
 * inference endpoint should not see. A limiter owned by the caller keeps LLM
 * traffic bounded no matter how many jobs are running.
 *
 * The delay is measured between task *starts*, not between a finish and the
 * next start, so it throttles request rate rather than adding dead time after
 * slow calls. At `maxConcurrency: 1` it degrades to a simple serial queue with
 * a fixed cadence.
 */

export interface LimiterOptions {
  /** Maximum tasks running at once. Values below 1 are treated as 1. */
  maxConcurrency: number;
  /** Minimum milliseconds between two task starts. 0 disables pacing. */
  minIntervalMs: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class Limiter {
  private readonly maxConcurrency: number;
  private readonly minIntervalMs: number;
  private active = 0;
  private lastStart = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(options: LimiterOptions) {
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency));
    this.minIntervalMs = Math.max(0, options.minIntervalMs);
  }

  /** Tasks currently running. Exposed for tests and progress reporting. */
  get activeCount(): number {
    return this.active;
  }

  /** Tasks waiting for a slot. Exposed for tests and progress reporting. */
  get pendingCount(): number {
    return this.waiting.length;
  }

  /**
   * Runs `fn` once a slot is free and the pacing interval has elapsed.
   *
   * The slot is released whether `fn` resolves or rejects, so a failing task
   * cannot starve the queue — which matters here because the caller's failure
   * policy is to keep going after a failed LLM call rather than abort.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      const wait = this.lastStart + this.minIntervalMs - Date.now();
      if (wait > 0) {
        await sleep(wait);
      }
      this.lastStart = Date.now();
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) {
      next();
    }
  }
}
