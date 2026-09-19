/**
 * Before/after for one page: the stored pre-cleanup Markdown beside the text
 * that serves search now.
 *
 * Two deliberate choices:
 *
 * - It fetches only once opened. A version can list thousands of chunks, and a
 *   page's original is a whole document, so fetching eagerly would pull the
 *   library across the wire to render a row nobody expanded.
 * - It compares whole pages, not chunks. Cleanup repairs a page and then
 *   re-splits it, so chunk boundaries move; a chunk-to-chunk comparison would
 *   show differences that are only re-chunking, and hide real ones that
 *   straddle a boundary.
 */
import { useState } from "react";
import { usePageOriginal } from "../../api/hooks";
import { Button } from "../../components/Button";
import { Chip } from "../../components/Chip";
import { Pill } from "../../components/Pill";
import { Loading } from "../../components/Spinner";

export interface PageComparisonProps {
  library: string;
  /** The active version (empty string for unversioned). */
  version: string;
  /** URL of the page this chunk belongs to. */
  url: string;
}

/**
 * Counts over the whole text, never stripping code first.
 *
 * A metric that strips fenced code before counting is not comparable across a
 * re-split: chunk boundaries move, so different amounts of text get excluded on
 * each side and a repaired page can read as unchanged — or worse.
 */
function countEscapes(text: string): number {
  return (text.match(/\\[_*\-.+#]/g) ?? []).length;
}

function countHtmlTags(text: string): number {
  return (text.match(/<\/?[a-zA-Z][a-zA-Z0-9-]*(\s[^>]*)?>/g) ?? []).length;
}

const BLOCK_STYLE = {
  maxHeight: 260,
  overflow: "auto",
  whiteSpace: "pre-wrap" as const,
  // Documentation is full of long bare URLs, which carry no whitespace to wrap
  // at: pre-wrap alone leaves them running off the edge behind a horizontal
  // scrollbar, so both panes have to be scrolled sideways to be read.
  overflowWrap: "anywhere" as const,
  margin: 0,
  padding: "8px 10px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontSize: 11.5,
};

/** One labelled side of the comparison. */
function Side({ label, text }: { label: string; text: string }) {
  return (
    <div style={{ minWidth: 0, flex: "1 1 320px" }}>
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 4 }}>
        {label}
      </div>
      <pre className="mono" style={BLOCK_STYLE}>
        {text}
      </pre>
    </div>
  );
}

/**
 * @example <PageComparison library="cilium" version="" url="https://docs.cilium.io/" />
 */
export function PageComparison({ library, version, url }: PageComparisonProps) {
  const [open, setOpen] = useState(false);
  const query = usePageOriginal({ library, version, url }, open);

  if (!open) {
    return (
      <div style={{ marginTop: 12 }}>
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          Compare with stored original
        </Button>
      </div>
    );
  }

  if (query.isLoading) {
    return <Loading label="Loading stored original…" />;
  }

  if (query.isError) {
    return (
      <p className="muted" style={{ marginTop: 12, color: "var(--err)" }}>
        Failed to load the original: {query.error.message}
      </p>
    );
  }

  const page = query.data;

  if (!page) {
    return (
      <p className="muted" style={{ marginTop: 12 }}>
        This page is no longer stored.
      </p>
    );
  }

  if (!page.original) {
    // Honest rather than convenient: showing the current text on both sides
    // would look like a page that cleanup left untouched.
    return (
      <div style={{ marginTop: 12 }}>
        <Pill variant="idle">no stored original</Pill>
        <span className="muted" style={{ fontSize: 11.5, marginLeft: 8 }}>
          Indexed before cleanup was enabled. A cleanup pass rebuilds the original from
          the stored chunks, and records it as reconstructed.
        </span>
      </div>
    );
  }

  const beforeEscapes = countEscapes(page.original);
  const afterEscapes = countEscapes(page.current);
  const beforeTags = countHtmlTags(page.original);
  const afterTags = countHtmlTags(page.current);
  const unchanged = page.original === page.current;

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Pill variant={page.cleanupStatus === "clean" ? "ok" : "idle"}>
          {page.cleanupStatus ?? "not cleaned"}
        </Pill>
        <Chip>
          escapes {beforeEscapes} → {afterEscapes}
        </Chip>
        <Chip>
          html tags {beforeTags} → {afterTags}
        </Chip>
        <Chip>
          chars {page.original.length.toLocaleString()} →{" "}
          {page.current.length.toLocaleString()}
        </Chip>
        {unchanged ? <Chip>identical</Chip> : null}
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Hide
        </Button>
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
        <Side label="Before — stored original" text={page.original} />
        <Side label="After — serving search" text={page.current} />
      </div>
    </div>
  );
}
