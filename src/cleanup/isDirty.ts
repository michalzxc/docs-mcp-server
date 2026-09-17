import { hasOpenFenceAtEnd } from "../splitter/splitters/fenceState";

/**
 * Deterministic detection of conversion artefacts worth sending to a model.
 *
 * Most scraped pages convert cleanly, so cleaning everything spends tokens to
 * reformat text that was already correct. Measured on a real index, fewer than
 * one chunk in ten carried any of these signals, which is the difference
 * between a sweep of minutes and one of hours.
 *
 * Deliberately conservative: each signal is something a Markdown document has
 * no legitimate reason to contain outside a code block.
 */

/** Block-level HTML that survived conversion. */
const RESIDUAL_HTML =
  /<\/?(?:dl|dt|dd|div|span|table|tr|td|th|tbody|thead|p|pre|code|ul|ol|li|h[1-6]|a|img|br|hr|em|strong|b|i)\b[^>]*>/i;

/** An HTML attribute left inline, e.g. `class="text-xs"`. */
const RESIDUAL_ATTRIBUTE = /\b(?:class|style|id|data-[\w-]+)\s*=\s*["']/i;

/** Backslash escapes Turndown adds where Markdown needs none. */
const NEEDLESS_ESCAPE = /\\[_*\-.+#]/;

/** Strips fenced and inline code so signals inside samples don't count. */
function withoutCode(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\n]*`/g, "");
}

export type DirtSignal = "html" | "attribute" | "escape" | "fence";

/**
 * Returns the artefact signals present in `markdown`, ignoring code samples —
 * a shell snippet containing `<div>` is not a conversion artefact.
 */
export function dirtSignals(markdown: string): DirtSignal[] {
  const prose = withoutCode(markdown);
  const signals: DirtSignal[] = [];
  if (RESIDUAL_HTML.test(prose)) signals.push("html");
  if (RESIDUAL_ATTRIBUTE.test(prose)) signals.push("attribute");
  if (NEEDLESS_ESCAPE.test(prose)) signals.push("escape");
  if (hasOpenFenceAtEnd(markdown)) signals.push("fence");
  return signals;
}

/** True when `markdown` carries at least one conversion artefact. */
export function isDirty(markdown: string): boolean {
  return dirtSignals(markdown).length > 0;
}
