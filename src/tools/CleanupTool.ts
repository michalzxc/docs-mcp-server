import * as semver from "semver";
import type { IPipeline } from "../pipeline/trpc/interfaces";
import { logger } from "../utils/logger";
import { ValidationError } from "./errors";

export interface CleanupToolOptions {
  library: string;
  version?: string | null;
  /** Clean every page, not only those carrying conversion artefacts. */
  full?: boolean;
  /** Re-clean pages already cleaned with the current prompt and model. */
  force?: boolean;
  /** If false, returns jobId immediately without waiting. Defaults to true. */
  waitForCompletion?: boolean;
}

export interface CleanupResult {
  /** Pages the pass considered. 0 when waitForCompletion was false. */
  pagesCleaned: number;
}

/** Return type for CleanupTool.execute */
export type CleanupExecuteResult = CleanupResult | { jobId: string };

/**
 * Repairs the Markdown of an already-indexed version with an LLM.
 *
 * Fetches nothing: it works from each page's stored text, so it can be re-run
 * with a different prompt or model without touching the documentation site.
 */
export class CleanupTool {
  private pipeline: IPipeline;

  constructor(pipeline: IPipeline) {
    this.pipeline = pipeline;
  }

  async execute(options: CleanupToolOptions): Promise<CleanupExecuteResult> {
    const { library, version, full, force, waitForCompletion = true } = options;

    let internalVersion: string;
    const partialVersionRegex = /^\d+(\.\d+)?$/; // Matches '1' or '1.2'

    if (version === null || version === undefined) {
      internalVersion = "";
    } else {
      const validFullVersion = semver.valid(version);
      if (validFullVersion) {
        internalVersion = validFullVersion;
      } else if (partialVersionRegex.test(version)) {
        const coercedVersion = semver.coerce(version);
        if (coercedVersion) {
          internalVersion = coercedVersion.version;
        } else {
          throw new ValidationError(
            `Invalid version format for cleanup: '${version}'. Use 'X.Y.Z', 'X.Y.Z-prerelease', 'X.Y', 'X', or omit.`,
            "CleanupTool",
          );
        }
      } else {
        throw new ValidationError(
          `Invalid version format for cleanup: '${version}'. Use 'X.Y.Z', 'X.Y.Z-prerelease', 'X.Y', 'X', or omit.`,
          "CleanupTool",
        );
      }
    }

    internalVersion = internalVersion.toLowerCase();
    const cleanupVersion: string | null = internalVersion === "" ? null : internalVersion;

    const jobId = await this.pipeline.enqueueCleanupJob(library, cleanupVersion, {
      full,
      force,
    });

    if (!waitForCompletion) {
      return { jobId };
    }

    try {
      await this.pipeline.waitForJobCompletion(jobId);
      const job = await this.pipeline.getJob(jobId);
      const pagesCleaned = job?.progress?.pagesScraped ?? 0;
      logger.debug(`Cleanup job ${jobId} finished: ${pagesCleaned} pages`);
      return { pagesCleaned };
    } catch (error) {
      logger.error(
        `❌ Cleanup job ${jobId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}
