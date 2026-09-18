import type {
  ScrapeResult,
  ScraperOptions,
  ScraperProgressEvent,
} from "../scraper/types";
import type { VersionStatus } from "../store/types";

/**
 * Represents the possible states of a pipeline job.
 */
export enum PipelineJobStatus {
  QUEUED = "queued",
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLING = "cancelling",
  CANCELLED = "cancelled",
}

/**
 * What a job does. Jobs share the queue, the concurrency budget and the status
 * bookkeeping; only the work differs.
 *
 * SCRAPE and REFRESH fetch pages. CLEANUP touches no network at all: it repairs
 * the Markdown of pages already stored, which is why it can run against a
 * library indexed months ago and why cancelling it loses nothing.
 */
export enum PipelineJobKind {
  SCRAPE = "scrape",
  REFRESH = "refresh",
  CLEANUP = "cleanup",
}

/** One slice the cleanup pass repaired, as shown live in the Jobs view. */
export interface CleanupRepairSample {
  /** Page the slice belongs to. */
  url: string;
  /** The region of the slice that changed, with a little context. */
  before: string;
  /** The same region after the accepted repair. */
  after: string;
  /** What changed, in words: "−2 escapes · −6 chars", or "whitespace only". */
  summary: string;
}

/**
 * Live detail of a cleanup job, carried beside the scrape-shaped progress.
 *
 * Deliberately not part of `ScraperProgressEvent`: that type describes
 * crawling, and every scrape consumer would otherwise carry fields that are
 * never set for it. Samples are capped and truncated because this rides a
 * progress event to every connected browser — streaming whole documents on
 * each repaired slice would cost far more than the feature is worth.
 */
export interface CleanupJobProgress {
  slicesRepaired: number;
  slicesKept: number;
  slicesRejected: number;
  /** Most recent accepted repairs, newest first. */
  recent: CleanupRepairSample[];
  /** Why the most recent answers were refused, newest first. */
  recentRejections: string[];
}

/**
 * Public interface for pipeline jobs exposed through API boundaries.
 * Contains only serializable fields suitable for JSON transport.
 */
export interface PipelineJob {
  /** Unique identifier for the job. */
  id: string;
  /** The library name associated with the job. */
  library: string;
  /** The library version associated with the job. */
  version: string | null;
  /** Current pipeline status of the job. */
  status: PipelineJobStatus;
  /** What the job does. Absent on jobs created before job kinds existed. */
  kind?: PipelineJobKind;
  /** Detailed progress information. */
  progress: ScraperProgressEvent | null;
  /** Error information if the job failed. */
  error: { message: string } | null;
  /** Timestamp when the job was created. */
  createdAt: Date;
  /** Timestamp when the job started running. */
  startedAt: Date | null;
  /** Timestamp when the job finished (completed, failed, or cancelled). */
  finishedAt: Date | null;
  /** Database version ID for direct updates. */
  versionId?: number;
  /** Database version status (authoritative). */
  versionStatus?: VersionStatus;
  /** Current number of pages processed. */
  progressPages?: number;
  /** Maximum number of pages to process. */
  progressMaxPages?: number;
  /** Database error message (more detailed than Error object). */
  errorMessage?: string | null;
  /** Last update timestamp from database. */
  updatedAt?: Date;
  /** Original scraping URL. */
  sourceUrl: string | null;
  /** Stored scraper options for reproducibility. */
  scraperOptions: ScraperOptions | null;
  /** Live cleanup detail. Absent on scrape and refresh jobs. */
  cleanupProgress?: CleanupJobProgress;
}

/**
 * Internal pipeline job representation used within PipelineManager.
 * Contains non-serializable fields for job management and control.
 *
 * Note: scraperOptions is required (non-nullable) for internal jobs as they
 * always have complete runtime configuration available.
 */
export interface InternalPipelineJob
  extends Omit<PipelineJob, "version" | "error" | "scraperOptions"> {
  /** The library version associated with the job (internal uses string). */
  version: string;
  /** Error object if the job failed. */
  error: Error | null;
  /** Complete scraper options with runtime configuration. */
  scraperOptions: ScraperOptions;
  /**
   * Options for a CLEANUP job. Absent on scrape and refresh jobs, which is
   * also why cleanup carries its settings here rather than in scraperOptions:
   * those are persisted per version and describe how to fetch a site.
   */
  cleanupOptions?: { full?: boolean; force?: boolean };
  /** AbortController to signal cancellation. */
  abortController: AbortController;
  /** Promise that resolves/rejects when the job finishes. */
  completionPromise: Promise<void>;
  /** Resolver function for the completion promise. */
  resolveCompletion: () => void;
  /** Rejector function for the completion promise. */
  rejectCompletion: (reason?: unknown) => void;
}

/**
 * Defines the structure for callback functions used with the PipelineManager.
 * Allows external components to hook into job lifecycle events.
 * All callbacks receive the public PipelineJob representation to maintain
 * clean separation between internal implementation and external API.
 */
export interface PipelineManagerCallbacks {
  /** Callback triggered when a job's status changes. */
  onJobStatusChange?: (job: PipelineJob) => Promise<void>;
  /** Callback triggered when a job makes progress. */
  onJobProgress?: (job: PipelineJob, progress: ScraperProgressEvent) => Promise<void>;
  /** Callback triggered when a job encounters an error during processing (e.g., storing a doc). */
  onJobError?: (job: PipelineJob, error: Error, page?: ScrapeResult) => Promise<void>;
}
