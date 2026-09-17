import type { AppConfig } from "../utils/config";
import { logger } from "../utils/logger";

/**
 * Runs background maintenance inside a time window.
 *
 * Deliberately the smallest thing that works: one timer, and at most one job
 * queued per tick. The pipeline already handles concurrency, cancellation and
 * recovery, so a scheduler that enqueues more than one job per tick would only
 * be racing machinery that is already there.
 *
 * It drives both halves of keeping an index current — re-scraping what changed
 * upstream, and repairing the Markdown of what is stored — because they compete
 * for the same workers and want the same quiet hours.
 */

/** What the scheduler is allowed to ask the pipeline to do. */
export interface SchedulerPipeline {
  enqueueCleanupJob(
    library: string,
    version: string | undefined | null,
    options?: { full?: boolean; force?: boolean },
  ): Promise<string>;
  enqueueRefreshJob(library: string, version: string | undefined | null): Promise<string>;
  /** Jobs currently queued or running; the scheduler never piles on. */
  busyCount(): number;
}

export interface SchedulerCandidate {
  library: string;
  version: string | null;
}

/** The store questions the scheduler asks, kept narrow for testing. */
export interface SchedulerStore {
  /** Version with the most pages missing or stale for this fingerprint. */
  findVersionNeedingCleanup(fingerprint: string): Promise<SchedulerCandidate | null>;
  /** Completed version whose last index is older than `olderThanHours`. */
  findVersionNeedingRefresh(olderThanHours: number): Promise<SchedulerCandidate | null>;
}

/**
 * True when `now` falls inside [start, end), both "HH:MM" local times.
 *
 * Windows that wrap midnight are the normal case for overnight maintenance,
 * so "22:00"–"02:00" means what it looks like rather than never matching.
 */
export function isWithinWindow(now: Date, start: string, end: string): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const [startH = 0, startM = 0] = start.split(":").map(Number);
  const [endH = 0, endM = 0] = end.split(":").map(Number);
  const from = startH * 60 + startM;
  const to = endH * 60 + endM;

  if (from === to) return true; // A zero-length window means "always".
  if (from < to) return minutes >= from && minutes < to;
  return minutes >= from || minutes < to; // wraps midnight
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(
    private readonly pipeline: SchedulerPipeline,
    private readonly store: SchedulerStore,
    private readonly config: AppConfig,
    private readonly fingerprint: () => string,
  ) {}

  start(): void {
    if (this.timer) return;
    if (!this.config.automation.enabled) {
      logger.debug("Scheduler disabled by configuration");
      return;
    }
    if (this.config.app.readOnly) {
      // A read-only deployment must not queue work that writes to the index.
      logger.debug("Scheduler not started: server is read-only");
      return;
    }

    const { windowStart, windowEnd, tickIntervalMs } = this.config.automation;
    this.timer = setInterval(() => {
      void this.tick();
    }, tickIntervalMs);
    // Do not hold the process open for a maintenance timer.
    this.timer.unref?.();
    logger.debug(`Scheduler started for ${windowStart}-${windowEnd}`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * One pass: queue at most one job, and only when the pipeline is idle.
   *
   * Cleanup is considered before refresh because it is the cheaper of the two
   * and costs no upstream traffic, so a backlog of unrepaired pages clears
   * before the crawler starts fetching again.
   */
  async tick(now: Date = new Date()): Promise<string | null> {
    if (this.ticking) return null;
    this.ticking = true;

    try {
      const { automation } = this.config;
      if (!automation.enabled) return null;
      if (!isWithinWindow(now, automation.windowStart, automation.windowEnd)) return null;
      if (this.pipeline.busyCount() > 0) return null;

      if (automation.cleanupEnabled && this.config.cleanup.enabled) {
        const candidate = await this.store.findVersionNeedingCleanup(this.fingerprint());
        if (candidate) {
          const jobId = await this.pipeline.enqueueCleanupJob(
            candidate.library,
            candidate.version,
          );
          logger.info(
            `🧹 Scheduled cleanup for ${candidate.library}@${candidate.version || "latest"}`,
          );
          return jobId;
        }
      }

      if (automation.refreshEnabled) {
        const candidate = await this.store.findVersionNeedingRefresh(
          automation.refreshMinIntervalHours,
        );
        if (candidate) {
          const jobId = await this.pipeline.enqueueRefreshJob(
            candidate.library,
            candidate.version,
          );
          logger.info(
            `🔄 Scheduled refresh for ${candidate.library}@${candidate.version || "latest"}`,
          );
          return jobId;
        }
      }

      return null;
    } catch (error) {
      // A failing tick must never take the manager down with it.
      logger.warn(
        `⚠️  Scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    } finally {
      this.ticking = false;
    }
  }
}
