/**
 * tRPC client implementation of the Pipeline interface.
 * Delegates all pipeline operations to an external worker via tRPC router.
 * Uses WebSocket link for subscriptions and HTTP for queries/mutations.
 */

import {
  createTRPCProxyClient,
  createWSClient,
  httpBatchLink,
  splitLink,
  wsLink,
} from "@trpc/client";
import superjson from "superjson";
import type { EventBusService } from "../events/EventBusService";
import { EventType } from "../events/types";
import type { ScraperOptions } from "../scraper/types";
import { logger } from "../utils/logger";
import { PipelineStateError } from "./errors";
import type { IPipeline } from "./trpc/interfaces";
import type { PipelineRouter } from "./trpc/router";
import {
  type PipelineJob,
  PipelineJobStatus,
  type PipelineManagerCallbacks,
} from "./types";

/** How often the worker is asked about a job while waiting for it. */
const JOB_POLL_INTERVAL_MS = 2000;

/**
 * Whether a job has finished, and with what.
 *
 * CANCELLING is deliberately not terminal: the job is still winding down, and
 * a caller that stops waiting there would race the work it asked to stop.
 *
 * @param job The job record as the worker reports it.
 * @returns undefined while the job is still in flight.
 */
function terminalOutcome(job: PipelineJob): { error?: Error } | undefined {
  switch (job.status) {
    case PipelineJobStatus.COMPLETED:
      return {};
    // Cancellation is not an error to whoever asked for it, which is how
    // PipelineManager.waitForJobCompletion already behaves.
    case PipelineJobStatus.CANCELLED:
      return {};
    case PipelineJobStatus.FAILED:
      return { error: new Error(job.error?.message ?? `Job ${job.id} failed`) };
    default:
      return undefined;
  }
}

/**
 * HTTP client that implements the IPipeline interface by delegating to external worker.
 */
export class PipelineClient implements IPipeline {
  private readonly baseUrl: string;
  private readonly wsUrl: string;
  private readonly client: ReturnType<typeof createTRPCProxyClient<PipelineRouter>>;
  private readonly wsClient: ReturnType<typeof createWSClient>;
  private readonly eventBus: EventBusService;
  private readonly pollIntervalMs: number;

  constructor(
    serverUrl: string,
    eventBus: EventBusService,
    pollIntervalMs: number = JOB_POLL_INTERVAL_MS,
  ) {
    this.baseUrl = serverUrl.replace(/\/$/, "");
    this.eventBus = eventBus;
    this.pollIntervalMs = pollIntervalMs;

    // Extract base URL without the /api path for WebSocket connection
    // The tRPC WebSocket adapter handles the /api routing internally
    const url = new URL(this.baseUrl);
    const baseWsUrl = `${url.protocol}//${url.host}`;
    this.wsUrl = baseWsUrl.replace(/^http/, "ws");

    // Create WebSocket client for subscriptions
    this.wsClient = createWSClient({
      url: this.wsUrl,
    });

    // Create tRPC client with split link:
    // - Subscriptions use WebSocket
    // - Queries and mutations use HTTP
    this.client = createTRPCProxyClient<PipelineRouter>({
      links: [
        splitLink({
          condition: (op) => op.type === "subscription",
          true: wsLink({ client: this.wsClient, transformer: superjson }),
          false: httpBatchLink({ url: this.baseUrl, transformer: superjson }),
        }),
      ],
    });

    logger.debug(
      `PipelineClient (tRPC) created for: ${this.baseUrl} (ws: ${this.wsUrl})`,
    );
  }

  async start(): Promise<void> {
    // Check connectivity via ping procedure
    try {
      await this.client.ping.query();
      logger.debug("PipelineClient connected to external worker via tRPC");
    } catch (error) {
      throw new Error(
        `Failed to connect to external worker at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async stop(): Promise<void> {
    // Close WebSocket connection
    this.wsClient.close();

    logger.debug("PipelineClient stopped");
  }

  async enqueueScrapeJob(
    library: string,
    version: string | undefined | null,
    options: ScraperOptions,
  ): Promise<string> {
    try {
      const normalizedVersion =
        typeof version === "string" && version.trim().length === 0
          ? null
          : (version ?? null);
      const result = await this.client.enqueueScrapeJob.mutate({
        library,
        version: normalizedVersion,
        options,
      });
      logger.debug(`Job ${result.jobId} enqueued successfully`);
      return result.jobId;
    } catch (error) {
      throw new Error(
        `Failed to enqueue job: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async enqueueRefreshJob(
    library: string,
    version: string | undefined | null,
    options?: { preserveHashes?: boolean },
  ): Promise<string> {
    try {
      const normalizedVersion =
        typeof version === "string" && version.trim().length === 0
          ? null
          : (version ?? null);
      const result = await this.client.enqueueRefreshJob.mutate({
        library,
        version: normalizedVersion,
        options,
      });
      logger.debug(`Refresh job ${result.jobId} enqueued successfully`);
      return result.jobId;
    } catch (error) {
      throw new Error(
        `Failed to enqueue refresh job: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Queues a Markdown cleanup pass on the remote worker.
   *
   * The work happens where the store is, so only the request crosses the wire.
   */
  async enqueueCleanupJob(
    library: string,
    version: string | undefined | null,
    options?: { full?: boolean; force?: boolean },
  ): Promise<string> {
    try {
      const normalizedVersion =
        typeof version === "string" && version.trim().length === 0
          ? null
          : (version ?? null);
      const result = await this.client.enqueueCleanupJob.mutate({
        library,
        version: normalizedVersion,
        options,
      });
      logger.debug(`Cleanup job ${result.jobId} enqueued successfully`);
      return result.jobId;
    } catch (error) {
      throw new Error(
        `Failed to enqueue cleanup job: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getJob(jobId: string): Promise<PipelineJob | undefined> {
    try {
      // superjson automatically deserializes Date objects
      return await this.client.getJob.query({ id: jobId });
    } catch (error) {
      throw new Error(
        `Failed to get job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getJobs(status?: PipelineJobStatus): Promise<PipelineJob[]> {
    try {
      // superjson automatically deserializes Date objects
      const result = await this.client.getJobs.query({ status });
      return result.jobs || [];
    } catch (error) {
      logger.error(`❌ Failed to get jobs from external worker: ${error}`);
      throw error;
    }
  }

  async cancelJob(jobId: string): Promise<void> {
    try {
      await this.client.cancelJob.mutate({ id: jobId });
      logger.debug(`Job cancelled via external worker: ${jobId}`);
    } catch (error) {
      logger.error(`❌ Failed to cancel job ${jobId} via external worker: ${error}`);
      throw error;
    }
  }

  async clearCompletedJobs(): Promise<number> {
    try {
      const result = await this.client.clearCompletedJobs.mutate();
      logger.debug(`Cleared ${result.count} completed jobs via external worker`);
      return result.count || 0;
    } catch (error) {
      logger.error(`❌ Failed to clear completed jobs via external worker: ${error}`);
      throw error;
    }
  }

  /**
   * Waits for a job to finish, asking the worker rather than trusting events.
   *
   * This used to resolve only when a JOB_STATUS_CHANGE event arrived on the
   * local event bus. Nothing publishes remote job events onto that bus outside
   * the server process — RemoteEventProxy is built by AppServer, and the
   * pipeline router exposes no subscription at all — so a CLI run against
   * --server-url waited forever no matter what the job did. One cleanup pass
   * finished all 999 of its pages server-side and the caller sat on it for a
   * further 150 minutes, blocking every library queued behind it. Every tool
   * that waits was affected: scrape, refresh, remove and cleanup alike.
   *
   * The worker's own record is the authority, so it is polled. The event bus
   * stays as a fast path for in-process callers and costs nothing when it
   * never fires.
   *
   * @param jobId The job to wait for.
   * @throws PipelineStateError when no such job exists, or the job's own error
   *   when it failed.
   */
  async waitForJobCompletion(jobId: string): Promise<void> {
    const initial = await this.getJob(jobId);
    if (!initial) {
      throw new PipelineStateError(`Job not found: ${jobId}`);
    }
    const alreadySettled = terminalOutcome(initial);
    if (alreadySettled) {
      if (alreadySettled.error) throw alreadySettled.error;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      let finished = false;
      let unsubscribe: (() => void) | undefined;
      let timer: ReturnType<typeof setInterval> | undefined;

      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        unsubscribe?.();
        if (timer) clearInterval(timer);
        if (error) reject(error);
        else resolve();
      };

      unsubscribe = this.eventBus.on(EventType.JOB_STATUS_CHANGE, (job: PipelineJob) => {
        if (job.id !== jobId) return;
        const outcome = terminalOutcome(job);
        if (outcome) finish(outcome.error);
      });

      timer = setInterval(() => {
        void this.getJob(jobId)
          .then((job) => {
            // A job that has been cleared cannot be waited on any longer, and
            // reporting it as finished beats hanging on a record that is gone.
            if (!job) {
              finish();
              return;
            }
            const outcome = terminalOutcome(job);
            if (outcome) finish(outcome.error);
          })
          .catch(() => {
            // A transient transport failure is not an answer: keep polling.
          });
      }, this.pollIntervalMs);
      timer.unref?.();
    });
  }

  setCallbacks(_callbacks: PipelineManagerCallbacks): void {
    // For external pipeline, callbacks are not used since all updates come via event bus
    logger.debug("PipelineClient.setCallbacks called - no-op for external worker");
  }
}
