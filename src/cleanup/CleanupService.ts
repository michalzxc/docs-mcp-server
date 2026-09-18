import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createCleanupChatModel } from "../llm/LlmClientFactory";
import { GreedySplitter } from "../splitter/GreedySplitter";
import { SemanticMarkdownSplitter } from "../splitter/SemanticMarkdownSplitter";
import type { Chunk } from "../splitter/types";
import type { CleanupPage } from "../store/types";
import { PageCleanupStatus } from "../store/types";
import type { AppConfig } from "../utils/config";
import { Limiter } from "../utils/limiter";
import { logger } from "../utils/logger";
import { isDirty } from "./isDirty";
import { cleanupFingerprint, DEFAULT_CLEANUP_SYSTEM_PROMPT } from "./prompt";
import { sliceMarkdown } from "./sliceMarkdown";
import { validateCleanup } from "./validateCleanup";

/**
 * The slice of the store the cleanup pass needs.
 *
 * Narrower than DocumentStore on purpose: it keeps the service testable with a
 * plain object and makes the blast radius of a cleanup bug obvious — it can
 * replace a page's chunks and set its cleanup columns, and nothing else.
 */
export interface CleanupStore {
  getPageForCleanup(pageId: number): Promise<CleanupPage | null>;
  getPagesNeedingCleanup(
    versionId: number,
    fingerprint: string,
    limit: number,
  ): Promise<CleanupPage[]>;
  countPagesNeedingCleanup(versionId: number, fingerprint: string): Promise<number>;
  getChunksByPageId(
    pageId: number,
  ): Promise<Array<{ id: number; content: string; sort_order: number }>>;
  setPageRawContent(pageId: number, markdown: string): Promise<void>;
  markPageCleanup(
    pageId: number,
    status: PageCleanupStatus,
    fingerprint: string,
  ): Promise<void>;
  replacePageChunks(
    pageId: number,
    chunks: Chunk[],
    title: string,
    url: string,
  ): Promise<void>;
}

export interface PageCleanupResult {
  pageId: number;
  url: string;
  status: PageCleanupStatus;
  slices: number;
  repaired: number;
  kept: number;
}

export interface CleanupProgress {
  pagesTotal: number;
  pagesDone: number;
  page: PageCleanupResult;
}

/**
 * One slice's outcome, reported as it happens.
 *
 * Page-level progress drives a progress bar but cannot answer the question
 * anyone actually asks while a pass runs: what is it changing? A page can hold
 * dozens of slices and take minutes, and nothing was reported in between, so a
 * slow page and a hung one looked identical from outside. Rejections were
 * written to the log and then discarded.
 *
 * Excerpts are truncated here rather than at the transport, so the cap holds
 * however this is consumed.
 */
export interface CleanupSliceEvent {
  url: string;
  /** 1-based, for "slice 3 of 14". */
  sliceIndex: number;
  sliceTotal: number;
  /** Set when the answer passed validation. */
  before?: string;
  after?: string;
  /** Set when the answer was refused, naming the gate that refused it. */
  rejected?: string;
}

/** Enough of a slice to see what changed, not enough to ship the page. */
const EXCERPT_CHARS = 240;

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat;
}

export interface CleanVersionOptions {
  /** Clean every page, not only those carrying artefacts. */
  full?: boolean;
  /** Re-clean pages already cleaned with the current fingerprint. */
  force?: boolean;
  signal?: AbortSignal;
}

export interface CleanupSummary {
  pagesConsidered: number;
  pagesCleaned: number;
  pagesSkipped: number;
  pagesFailed: number;
}

/** Pages pulled from the database per round trip. */
const PAGE_BATCH = 50;

/**
 * One limiter per process, not one per job.
 *
 * Cleanup jobs run under the pipeline's own concurrency, so a limiter owned by
 * a job would let three jobs put three times the configured load on the
 * endpoint. Keyed by the settings that matter so a config change takes effect
 * without a restart.
 */
let sharedLimiter: { key: string; limiter: Limiter } | undefined;

function getLimiter(config: AppConfig): Limiter {
  const key = `${config.cleanup.maxConcurrency}:${config.cleanup.requestDelayMs}`;
  if (!sharedLimiter || sharedLimiter.key !== key) {
    sharedLimiter = {
      key,
      limiter: new Limiter({
        maxConcurrency: config.cleanup.maxConcurrency,
        minIntervalMs: config.cleanup.requestDelayMs,
      }),
    };
  }
  return sharedLimiter.limiter;
}

/**
 * Models like to answer with the whole document inside a ```markdown fence
 * even when told not to. Unwrapping is cheap; leaving it in corrupts fence
 * balance for the chunk that follows.
 */
export function stripFenceWrapper(text: string): string {
  const trimmed = text.trim();
  const match = /^```[a-zA-Z]*\n([\s\S]*)\n```$/.exec(trimmed);
  return match ? match[1] : text;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : "",
      )
      .join("");
  }
  return "";
}

/**
 * Repairs the Markdown of already-scraped pages with an LLM.
 *
 * Runs over stored page text rather than inside the scrape pipeline, which is
 * what lets one code path serve both a freshly scraped page and a library
 * indexed months ago, and lets the work be cancelled and resumed without
 * re-fetching anything.
 */
export class CleanupService {
  private readonly splitter: GreedySplitter;
  private model: BaseChatModel | undefined;

  constructor(
    private readonly store: CleanupStore,
    private readonly config: AppConfig,
    model?: BaseChatModel,
  ) {
    this.model = model;
    this.splitter = new GreedySplitter(
      new SemanticMarkdownSplitter(
        config.splitter.preferredChunkSize,
        config.splitter.maxChunkSize,
      ),
      config.splitter.minChunkSize,
      config.splitter.preferredChunkSize,
      config.splitter.maxChunkSize,
    );
  }

  /** The prompt in force, and the fingerprint identifying it. */
  get systemPrompt(): string {
    return this.config.cleanup.systemPrompt || DEFAULT_CLEANUP_SYSTEM_PROMPT;
  }

  get fingerprint(): string {
    return cleanupFingerprint(
      this.config.cleanup.model,
      this.systemPrompt,
      this.config.cleanup.sliceChars,
    );
  }

  /** Cleans every page of a version that needs it. */
  async cleanVersion(
    versionId: number,
    options: CleanVersionOptions = {},
    onProgress?: (progress: CleanupProgress) => void,
    onSlice?: (event: CleanupSliceEvent) => void,
  ): Promise<CleanupSummary> {
    const fingerprint = options.force ? `${this.fingerprint}-forced` : this.fingerprint;
    const summary: CleanupSummary = {
      pagesConsidered: 0,
      pagesCleaned: 0,
      pagesSkipped: 0,
      pagesFailed: 0,
    };

    const pagesTotal = await this.store.countPagesNeedingCleanup(versionId, fingerprint);
    let pagesDone = 0;

    // Paged rather than loaded at once: a library can hold thousands of pages,
    // and each iteration re-queries so pages cleaned by this run drop out.
    for (;;) {
      if (options.signal?.aborted) break;

      const pages = await this.store.getPagesNeedingCleanup(
        versionId,
        fingerprint,
        PAGE_BATCH,
      );
      if (pages.length === 0) break;

      for (const page of pages) {
        if (options.signal?.aborted) break;

        const result = await this.cleanPage(
          page,
          {
            full: options.full ?? this.config.cleanup.filter === "all",
            signal: options.signal,
          },
          onSlice,
        );

        summary.pagesConsidered++;
        pagesDone++;
        if (result.status === PageCleanupStatus.FAILED) summary.pagesFailed++;
        else if (result.status === PageCleanupStatus.SKIPPED) summary.pagesSkipped++;
        else summary.pagesCleaned++;

        onProgress?.({ pagesTotal, pagesDone, page: result });
      }

      // Every page in the batch was marked, so the next query returns new rows.
      // A page that somehow kept its old fingerprint would loop forever, so
      // stop when a full batch produced no progress.
      if (pages.length < PAGE_BATCH) break;
    }

    return summary;
  }

  /**
   * Repairs one page and replaces its chunks.
   *
   * Never throws for model or validation failures: a slice that cannot be
   * repaired keeps its original text, and the page is marked `partial` so a
   * later sweep can try again.
   */
  async cleanPage(
    page: CleanupPage,
    options: { full?: boolean; signal?: AbortSignal } = {},
    onSlice?: (event: CleanupSliceEvent) => void,
  ): Promise<PageCleanupResult> {
    const fingerprint = this.fingerprint;
    const source = await this.resolveSource(page);

    if (!source) {
      await this.store.markPageCleanup(page.id, PageCleanupStatus.SKIPPED, fingerprint);
      return this.result(page, PageCleanupStatus.SKIPPED, 0, 0, 0);
    }

    if (!options.full && !isDirty(source)) {
      // Nothing a model would fix: record the fingerprint so the sweep stops
      // reconsidering this page, and spend no tokens on it.
      await this.store.markPageCleanup(page.id, PageCleanupStatus.SKIPPED, fingerprint);
      return this.result(page, PageCleanupStatus.SKIPPED, 0, 0, 0);
    }

    const slices = sliceMarkdown(source, this.config.cleanup.sliceChars);
    const repairedSlices: string[] = [];
    let repaired = 0;
    let kept = 0;

    for (const [index, slice] of slices.entries()) {
      if (options.signal?.aborted) {
        repairedSlices.push(slice);
        kept++;
        continue;
      }

      let rejection: string | undefined;
      const cleaned = await this.repairSlice(
        slice,
        page.url,
        options.signal,
        (reason) => {
          rejection = reason;
        },
      );

      if (cleaned === null) {
        repairedSlices.push(slice);
        kept++;
        onSlice?.({
          url: page.url,
          sliceIndex: index + 1,
          sliceTotal: slices.length,
          rejected: rejection ?? "kept",
        });
      } else {
        repairedSlices.push(cleaned);
        repaired++;
        onSlice?.({
          url: page.url,
          sliceIndex: index + 1,
          sliceTotal: slices.length,
          before: excerpt(slice),
          after: excerpt(cleaned),
        });
      }
    }

    if (repaired === 0) {
      const status = kept > 0 ? PageCleanupStatus.FAILED : PageCleanupStatus.SKIPPED;
      await this.store.markPageCleanup(page.id, status, fingerprint);
      return this.result(page, status, slices.length, repaired, kept);
    }

    const cleanedMarkdown = repairedSlices.join("");
    const chunks = await this.splitter.splitText(cleanedMarkdown, "text/markdown");
    await this.store.replacePageChunks(page.id, chunks, page.title ?? "", page.url);

    const status = kept > 0 ? PageCleanupStatus.PARTIAL : PageCleanupStatus.CLEAN;
    await this.store.markPageCleanup(page.id, status, fingerprint);
    return this.result(page, status, slices.length, repaired, kept);
  }

  /**
   * The page's pre-cleanup Markdown.
   *
   * Pages indexed before cleanup existed have no stored original, so it is
   * rebuilt by concatenating their chunks. That reconstruction is close to the
   * page but not identical — the splitter merged and re-joined blocks — so it
   * is recorded as `reconstructed` rather than passed off as pristine.
   */
  private async resolveSource(page: CleanupPage): Promise<string | null> {
    if (page.raw_content && page.raw_content.trim().length > 0) {
      return page.raw_content;
    }

    const chunks = await this.store.getChunksByPageId(page.id);
    if (chunks.length === 0) return null;

    const rebuilt = chunks.map((chunk) => chunk.content).join("\n\n");
    await this.store.setPageRawContent(page.id, rebuilt);
    return rebuilt;
  }

  /** Returns the repaired slice, or null when the original must be kept. */
  private async repairSlice(
    slice: string,
    url: string,
    signal?: AbortSignal,
    onReject?: (reason: string) => void,
  ): Promise<string | null> {
    const limiter = getLimiter(this.config);

    try {
      const answer = await limiter.run(async () => {
        const model = this.getModel();
        const response = await model.invoke(
          [new SystemMessage(this.systemPrompt), new HumanMessage(slice)],
          signal ? { signal } : undefined,
        );
        return stripFenceWrapper(messageText(response.content));
      });

      const verdict = validateCleanup(slice, answer, {
        maxLengthDrift: this.config.cleanup.maxLengthDrift,
      });
      if (!verdict.ok) {
        logger.warn(`⚠️  Cleanup rejected for ${url}: ${verdict.reason}`);
        onReject?.(verdict.reason);
        return null;
      }
      return answer;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.warn(`⚠️  Cleanup call failed for ${url}: ${detail}`);
      onReject?.(detail);
      return null;
    }
  }

  private getModel(): BaseChatModel {
    if (!this.model) {
      this.model = createCleanupChatModel(this.config);
    }
    return this.model;
  }

  private result(
    page: CleanupPage,
    status: PageCleanupStatus,
    slices: number,
    repaired: number,
    kept: number,
  ): PageCleanupResult {
    return { pageId: page.id, url: page.url, status, slices, repaired, kept };
  }
}
