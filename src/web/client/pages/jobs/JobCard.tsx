/**
 * A single row in the "Active & queued" live section: a running, cancelling,
 * or queued job. Matches the mockup's `.jobc` job card, reusing `Pill`,
 * `LibIcon`, `Chip`, `ProgressBar`, and `Icon` from the shared component
 * library — see `components/README.md`.
 */
import { PipelineJobKind, PipelineJobStatus } from "../../../../pipeline/types";
import { Button } from "../../components/Button";
import { Chip } from "../../components/Chip";
import { Icon } from "../../components/Icon";
import { LibIcon } from "../../components/LibIcon";
import { Pill } from "../../components/Pill";
import { ProgressBar } from "../../components/ProgressBar";
import { displayUrl, formatElapsed, jobPageCounts, progressPercent } from "./format";
import type { Job } from "./types";

export interface JobCardProps {
  job: Job;
  /** 1-based position in the FIFO queue. Only meaningful for queued jobs. */
  position?: number;
  now: number;
  onCancel: (id: string) => void;
  /** True while this specific job's cancel request is in flight. */
  cancelPending?: boolean;
}

/**
 * Live detail of a cleanup job: what it has repaired, and what it just changed.
 *
 * Shown because a cleanup pass was previously silent between page completions —
 * a page with dozens of slices reported nothing for minutes, so a slow job and
 * a hung one were indistinguishable, and every rejection went only to the log.
 */
function CleanupDetail({ job }: { job: Job }) {
  const live = job.cleanupProgress;
  if (!live) return null;

  return (
    <>
      <div className="jobc__stats">
        <span>
          <b>{live.slicesRepaired.toLocaleString()}</b> repaired
        </span>
        <span>
          <b>{live.slicesKept.toLocaleString()}</b> kept
        </span>
        <span>
          <b>{live.slicesRejected.toLocaleString()}</b> rejected
        </span>
      </div>

      {live.recent.length > 0 || live.recentRejections.length > 0 ? (
        <details className="adv">
          <summary>Recent changes</summary>
          {live.recent.map((sample) => (
            <div key={`${sample.url}-${sample.before}`} style={{ marginBottom: 8 }}>
              <div className="muted" style={{ fontSize: 11 }}>
                {sample.url}
              </div>
              <pre
                className="mono"
                style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11 }}
              >
                − {sample.before}
                {"\n"}+ {sample.after}
              </pre>
            </div>
          ))}
          {live.recentRejections.length > 0 ? (
            <div className="muted" style={{ fontSize: 11 }}>
              refused: {live.recentRejections.join(" · ")}
            </div>
          ) : null}
        </details>
      ) : null}
    </>
  );
}

/** Renders the mockup's per-status meta line (URL for running, or the collapse note for cancelling). */
function StatsLine({ job }: { job: Job }) {
  const { pages, maxPages } = jobPageCounts(job);

  // A cleanup job fetches nothing, so "discovered" and "depth" would be zeroes
  // dressed up as information.
  if (job.kind === PipelineJobKind.CLEANUP) {
    return (
      <div className="jobc__stats">
        <span>
          <b>{pages.toLocaleString()}</b> / {maxPages.toLocaleString()} pages
        </span>
        <span>repairs stored Markdown — no site is fetched</span>
      </div>
    );
  }

  if (job.status === PipelineJobStatus.CANCELLING) {
    return (
      <div className="jobc__stats">
        <span>
          <b>{pages.toLocaleString()}</b> / {maxPages.toLocaleString()} pages
        </span>
        <span>stops once the in-flight page finishes</span>
      </div>
    );
  }

  if (job.status === PipelineJobStatus.RUNNING) {
    return (
      <div className="jobc__stats">
        <span>
          <b>{pages.toLocaleString()}</b> / {maxPages.toLocaleString()} pages
        </span>
        {job.progress ? (
          <span>
            <b>{job.progress.totalDiscovered.toLocaleString()}</b> discovered
          </span>
        ) : null}
        {job.progress ? (
          <span>
            depth <b>{job.progress.depth}</b> / {job.progress.maxDepth}
          </span>
        ) : null}
      </div>
    );
  }

  // Queued
  return (
    <div className="jobc__stats">
      {job.sourceUrl ? <span>{displayUrl(job.sourceUrl)}</span> : null}
      {job.scraperOptions?.maxPages ? (
        <span>max {job.scraperOptions.maxPages.toLocaleString()} pages</span>
      ) : null}
    </div>
  );
}

/**
 * @example <JobCard job={job} now={Date.now()} onCancel={(id) => cancelJob.mutate({ id })} />
 */
export function JobCard({
  job,
  position,
  now,
  onCancel,
  cancelPending = false,
}: JobCardProps) {
  const isRunning = job.status === PipelineJobStatus.RUNNING;
  const isCancelling = job.status === PipelineJobStatus.CANCELLING;
  const isQueued = job.status === PipelineJobStatus.QUEUED;

  const { pages, maxPages } = jobPageCounts(job);
  const pct = progressPercent(pages, maxPages);

  const modifierClass = isRunning
    ? "jobc--running"
    : isCancelling
      ? "jobc--cancelling"
      : "jobc--queued";

  return (
    <div className={`jobc ${modifierClass}`}>
      <div className="jobc__head">
        {isRunning ? (
          <Pill variant="run" pulse>
            running
          </Pill>
        ) : isCancelling ? (
          <Pill variant="idle">cancelling</Pill>
        ) : (
          <Pill variant="queued">queued</Pill>
        )}
        {isQueued && position != null ? <span className="qpos">#{position}</span> : null}
        <LibIcon name={job.library} url={job.sourceUrl} />
        <span className="jobc__title">{job.library}</span>
        <Chip>{job.version || "unversioned"}</Chip>
        {job.kind && job.kind !== PipelineJobKind.SCRAPE ? <Chip>{job.kind}</Chip> : null}
        <div className="jobc__right">
          {isRunning ? (
            <span className="jobc__elapsed">
              <Icon name="i-clock" size="xs" style={{ color: "var(--text-faint)" }} />
              {job.startedAt ? formatElapsed(now - job.startedAt.getTime()) : "—"}
            </span>
          ) : isCancelling ? (
            <span className="jobc__elapsed">finishing current page…</span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            disabled={isCancelling || cancelPending}
            onClick={() => onCancel(job.id)}
          >
            Cancel
          </Button>
        </div>
      </div>

      {isRunning && job.progress?.currentUrl ? (
        <div className="jobc__url">
          <Icon name="i-globe" size="xs" style={{ color: "var(--text-faint)" }} />
          Processing <span className="u">{job.progress.currentUrl}</span>
        </div>
      ) : null}

      {isRunning || isCancelling ? (
        <div className="jobc__prog">
          <ProgressBar value={pct} />
          <span className="pct">{pct}%</span>
        </div>
      ) : null}

      <StatsLine job={job} />
      <CleanupDetail job={job} />
    </div>
  );
}
