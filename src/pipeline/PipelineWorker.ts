import { CleanupService } from "../cleanup/CleanupService";
import type { ScraperService } from "../scraper";
import type {
  ScrapeResult,
  ScraperProgressEvent as ScraperProgress,
  ScraperProgressEvent,
} from "../scraper/types";
import type { DocumentManagementService } from "../store";
import type { AppConfig } from "../utils/config";
import { logger } from "../utils/logger";
import { CancellationError } from "./errors";
import type { CleanupJobProgress, InternalPipelineJob } from "./types";
import { PipelineJobKind } from "./types";

/**
 * Internal callbacks used by PipelineWorker.
 * These work with InternalPipelineJob before conversion to public interface.
 */
interface WorkerCallbacks {
  onJobProgress?: (job: InternalPipelineJob, progress: ScraperProgress) => Promise<void>;
  onJobError?: (
    job: InternalPipelineJob,
    error: Error,
    page?: ScrapeResult,
  ) => Promise<void>;
  onJobStatusChange?: (job: InternalPipelineJob) => Promise<void>;
}

/**
 * Executes a single document processing job.
 * Handles scraping, storing documents, and reporting progress/errors via callbacks.
 */
export class PipelineWorker {
  // Dependencies are passed in, making the worker stateless regarding specific jobs
  private readonly store: DocumentManagementService;
  private readonly scraperService: ScraperService;
  private readonly appConfig?: AppConfig;

  // Constructor accepts dependencies needed for execution
  constructor(
    store: DocumentManagementService,
    scraperService: ScraperService,
    appConfig?: AppConfig,
  ) {
    this.store = store;
    this.scraperService = scraperService;
    this.appConfig = appConfig;
  }

  /**
   * Repairs the Markdown of an already-indexed version.
   *
   * Fetches nothing: it reads each page's stored text, sends slices to the
   * configured model, and replaces the page's chunks. A slice that fails keeps
   * its original text, so the worst outcome is a page left as it was.
   */
  private async executeCleanupJob(
    job: InternalPipelineJob,
    callbacks: WorkerCallbacks,
  ): Promise<void> {
    const { id: jobId, library, version, abortController } = job;

    if (!this.appConfig) {
      throw new Error("Cleanup job requires application configuration");
    }
    if (!job.versionId) {
      throw new Error(`Cleanup job ${jobId} has no version id`);
    }

    const service = new CleanupService(this.store, this.appConfig);
    logger.info(`🧹 Cleaning markdown for ${library}@${version || "latest"}`);

    // Live detail for the Jobs view, kept on the job itself rather than in the
    // scrape-shaped progress event. Capped and truncated: a pass repairs
    // thousands of slices and every event reaches every open browser.
    const RECENT_LIMIT = 5;
    const live: CleanupJobProgress = {
      slicesRepaired: 0,
      slicesKept: 0,
      slicesRejected: 0,
      recent: [],
      recentRejections: [],
    };
    job.cleanupProgress = live;

    let pagesDone = 0;
    let pagesTotal = 0;
    let currentUrl = "";

    // Reuse the scrape progress shape so the Jobs view, the event bus and the
    // database counters need no special case for cleanup.
    const emitProgress = () => {
      void callbacks.onJobProgress?.(job, {
        pagesScraped: pagesDone,
        totalPages: pagesTotal,
        totalDiscovered: pagesTotal,
        currentUrl,
        depth: 0,
        maxDepth: 0,
        result: null,
      } as unknown as ScraperProgressEvent);
    };

    const summary = await service.cleanVersion(
      job.versionId,
      {
        full: job.cleanupOptions?.full,
        force: job.cleanupOptions?.force,
        signal: abortController.signal,
      },
      (progress) => {
        pagesDone = progress.pagesDone;
        pagesTotal = progress.pagesTotal;
        currentUrl = progress.page.url;
        emitProgress();
      },
      (event) => {
        // Per slice, so a page that takes minutes still says what it is doing.
        currentUrl = event.url;
        if (event.rejected !== undefined) {
          if (event.rejected === "kept") {
            live.slicesKept++;
          } else {
            live.slicesRejected++;
            live.recentRejections = [event.rejected, ...live.recentRejections].slice(
              0,
              RECENT_LIMIT,
            );
          }
        } else if (event.before !== undefined && event.after !== undefined) {
          live.slicesRepaired++;
          live.recent = [
            { url: event.url, before: event.before, after: event.after },
            ...live.recent,
          ].slice(0, RECENT_LIMIT);
        }
        emitProgress();
      },
    );

    logger.info(
      `🧹 Cleanup finished for ${library}@${version || "latest"}: ` +
        `${summary.pagesCleaned} cleaned, ${summary.pagesSkipped} skipped, ` +
        `${summary.pagesFailed} failed`,
    );
  }

  /**
   * Executes the given pipeline job.
   * @param job - The job to execute.
   * @param callbacks - Internal callbacks provided by the manager for reporting.
   */
  async executeJob(job: InternalPipelineJob, callbacks: WorkerCallbacks): Promise<void> {
    const { id: jobId, library, version, scraperOptions, abortController } = job;
    const signal = abortController.signal;

    logger.debug(`[${jobId}] Worker starting job for ${library}@${version}`);

    // Cleanup fetches nothing, so it branches before any scraper option is
    // read: its job carries placeholders, and `clean`/`isRefresh` below would
    // otherwise decide to wipe the very documents it is meant to repair.
    if (job.kind === PipelineJobKind.CLEANUP) {
      await this.executeCleanupJob(job, callbacks);
      return;
    }

    try {
      // Clear existing documents for this library/version before scraping
      // Skip this step for refresh operations or if clean is explicitly false
      if (!scraperOptions.isRefresh && scraperOptions.clean !== false) {
        await this.store.removeAllDocuments(library, version);
        logger.info(
          `💾 Cleared store for ${library}@${version || "latest"} before scraping.`,
        );
      } else {
        const message = scraperOptions.isRefresh
          ? `🔄 Refresh operation - preserving existing data for ${library}@${version || "latest"}.`
          : `💾 Appending to store for ${library}@${version || "latest"} (clean=false).`;
        logger.info(message);
      }

      // --- Core Job Logic ---
      await this.scraperService.scrape(
        scraperOptions,
        async (progress: ScraperProgressEvent) => {
          // Check for cancellation signal before processing each document
          if (signal.aborted) {
            throw new CancellationError("Job cancelled during scraping progress");
          }

          // Update job object directly (manager holds the reference)
          // Report progress via manager's callback (single source of truth)
          await callbacks.onJobProgress?.(job, progress);

          // Handle deletion events (404 during refresh or broken links)
          if (progress.deleted && progress.pageId) {
            try {
              await this.store.deletePage(progress.pageId);
              logger.debug(
                `[${jobId}] Deleted page ${progress.pageId}: ${progress.currentUrl}`,
              );
            } catch (docError) {
              logger.error(
                `❌ [${jobId}] Failed to delete page ${progress.pageId}: ${docError}`,
              );

              // Report the error and fail the job to ensure data integrity
              const error =
                docError instanceof Error ? docError : new Error(String(docError));
              await callbacks.onJobError?.(job, error);
              // Re-throw to fail the job - deletion failures indicate serious database issues
              // and leaving orphaned documents would compromise index accuracy
              throw error;
            }
          }
          // Handle successful content processing
          else if (progress.result) {
            try {
              // For refresh operations, delete old documents before adding new ones
              if (progress.pageId) {
                await this.store.deletePage(progress.pageId);
                logger.debug(
                  `[${jobId}] Refreshing page ${progress.pageId}: ${progress.currentUrl}`,
                );
              }

              // Add the processed content to the store
              await this.store.addScrapeResult(
                library,
                version,
                progress.depth,
                progress.result,
              );
              logger.debug(`[${jobId}] Stored processed content: ${progress.currentUrl}`);
            } catch (docError) {
              logger.error(
                `❌ [${jobId}] Failed to process content ${progress.currentUrl}: ${docError}`,
              );
              // Report document-specific errors via manager's callback
              await callbacks.onJobError?.(
                job,
                docError instanceof Error ? docError : new Error(String(docError)),
                progress.result,
              );
              // Decide if a single document error should fail the whole job
              // For now, we log and continue. To fail, re-throw here.
            }
          }
        },
        signal, // Pass signal to scraper service
      );
      // --- End Core Job Logic ---

      // Check signal one last time after scrape finishes
      if (signal.aborted) {
        throw new CancellationError("Job cancelled");
      }

      // If successful and not cancelled, the manager will handle status update
      logger.debug(`[${jobId}] Worker finished job successfully.`);
    } catch (error) {
      // Re-throw error to be caught by the manager in _runJob
      logger.warn(`⚠️  [${jobId}] Worker encountered error: ${error}`);
      throw error;
    }
    // Note: The manager (_runJob) is responsible for updating final job status (COMPLETED/FAILED/CANCELLED)
    // and resolving/rejecting the completion promise based on the outcome here.
  }

  // --- Old methods removed ---
  // process()
  // stop()
  // setCallbacks()
  // handleScrapingProgress()
}
