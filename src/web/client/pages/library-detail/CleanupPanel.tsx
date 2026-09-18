/**
 * Cleanup state of the active version, and the button that starts a pass.
 *
 * Sits in the left column beside the scrape configuration, because "how good is
 * the stored text" belongs next to "where the text came from". The counts are
 * per page rather than per chunk: cleanup repairs a page and re-splits it, so a
 * chunk count would move for reasons that have nothing to do with repair.
 */
import { useCleanupStats, useEnqueueCleanupJob, useSystemHealth } from "../../api/hooks";
import { trpc } from "../../api/trpc";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Chip } from "../../components/Chip";
import { Pill } from "../../components/Pill";
import { Loading } from "../../components/Spinner";
import { useToast } from "../../components/Toast";

export interface CleanupPanelProps {
  library: string;
  /** The active version (empty string for unversioned). */
  version: string;
}

/** Renders a stored timestamp as a short local string, or a dash when never run. */
function formatWhen(value: string | null): string {
  if (!value) return "never";
  // SQLite stores `CURRENT_TIMESTAMP` as "YYYY-MM-DD HH:MM:SS" in UTC with no
  // zone marker, so it has to be spelled out or the browser reads it as local.
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/**
 * @example <CleanupPanel library="cilium" version="" />
 */
export function CleanupPanel({ library, version }: CleanupPanelProps) {
  const { data: health } = useSystemHealth();
  const toast = useToast();
  const utils = trpc.useUtils();
  const enqueueCleanupJob = useEnqueueCleanupJob();

  const fingerprint = health?.cleanup.fingerprint ?? "";
  const stats = useCleanupStats(
    { library, version, fingerprint },
    Boolean(library) && fingerprint.length > 0,
  );

  async function startCleanup(full: boolean) {
    try {
      await enqueueCleanupJob.mutateAsync({
        library,
        version: version || undefined,
        options: { full },
      });
      await Promise.all([utils.getJobs.invalidate(), utils.getCleanupStats.invalidate()]);
      toast.success(
        `Cleaning ${library}${version ? ` ${version}` : ""}`,
        "Progress appears in Jobs & Queue.",
      );
    } catch (err) {
      toast.error(
        "Failed to start cleanup",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const cleanupEnabled = health?.cleanup.enabled ?? false;
  const data = stats.data;
  const repaired = data ? data.clean + data.partial : 0;

  return (
    <Card className="panel">
      <div className="section-head">
        <div>
          <h2 style={{ fontSize: 13.5 }}>Markdown cleanup</h2>
        </div>
      </div>

      {!cleanupEnabled ? (
        <div className="set-grid tight">
          <div className="k">
            <b>Status</b>
            <span>Repairs conversion artefacts with an LLM</span>
          </div>
          <div className="v">
            <Pill variant="idle">disabled</Pill>
            <span className="muted" style={{ fontSize: 11.5 }}>
              Set via configuration/environment
            </span>
          </div>
        </div>
      ) : stats.isLoading ? (
        <Loading label="Loading cleanup state…" />
      ) : stats.isError ? (
        <p className="muted" style={{ padding: "12px 16px", color: "var(--err)" }}>
          Failed to load cleanup state: {stats.error.message}
        </p>
      ) : data ? (
        <>
          <div className="set-grid tight">
            <div className="k">
              <b>Pages repaired</b>
              <span>Cleaned fully or in part</span>
            </div>
            <div className="v">
              <Pill variant={repaired > 0 ? "ok" : "idle"}>
                {repaired} / {data.totalPages}
              </Pill>
              {data.partial > 0 ? <Chip>{data.partial} partial</Chip> : null}
              {data.failed > 0 ? <Chip>{data.failed} failed</Chip> : null}
            </div>

            <div className="k">
              <b>Needs cleaning</b>
              <span>Never cleaned, or cleaned by an older prompt</span>
            </div>
            <div className="v">
              <Pill variant={data.needingCleanup > 0 ? "queued" : "ok"}>
                {data.needingCleanup} pages
              </Pill>
              {data.unprocessed !== data.needingCleanup ? (
                <Chip>{data.needingCleanup - data.unprocessed} stale</Chip>
              ) : null}
            </div>

            <div className="k">
              <b>Skipped</b>
              <span>Nothing a model would repair</span>
            </div>
            <div className="v">
              <Chip>{data.skipped} pages</Chip>
            </div>

            <div className="k">
              <b>Originals stored</b>
              <span>Pages a re-run can repair without re-scraping</span>
            </div>
            <div className="v">
              <Chip>
                {data.withOriginal} / {data.totalPages}
              </Chip>
              {data.reconstructed > 0 ? (
                <Chip>{data.reconstructed} rebuilt from chunks</Chip>
              ) : null}
            </div>

            <div className="k">
              <b>Last run</b>
              <span>Most recent repair on this version</span>
            </div>
            <div className="v">
              <Chip>{formatWhen(data.lastCleanupAt)}</Chip>
            </div>
          </div>

          <div className="cfg-actions">
            <Button
              size="sm"
              disabled={enqueueCleanupJob.isPending || data.needingCleanup === 0}
              onClick={() => startCleanup(false)}
            >
              Clean {data.needingCleanup} pages
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={enqueueCleanupJob.isPending || data.totalPages === 0}
              onClick={() => startCleanup(true)}
            >
              Clean every page
            </Button>
          </div>
        </>
      ) : null}
    </Card>
  );
}
