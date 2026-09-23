import {
  fencedBlocks,
  hasOpenFenceAtEnd,
  withoutFences,
} from "../splitter/splitters/fenceState";

/**
 * Gates a model's output before it is allowed to replace indexed content.
 *
 * The cleanup pass rewrites text that users will search and models will quote,
 * so the interesting failure is not an error — it is a plausible-looking answer
 * that quietly drops a paragraph or edits a command. Each gate below is a
 * property the repair must preserve; failing any one means the original slice
 * is kept instead.
 */

export interface ValidationOptions {
  /** Permitted relative change in length, e.g. 0.35 for ±35%. */
  maxLengthDrift: number;
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/**
 * Fenced blocks, normalised so trailing whitespace differences don't count.
 *
 * Uses the splitter's fence scanner rather than a regular expression of its
 * own: see fencedBlocks for why pairing fences by pattern silently misreads
 * pages that document Markdown.
 */
function fencedCode(markdown: string): string[] {
  return fencedBlocks(markdown).map(normaliseCode);
}

/** Inline spans, which carry flags, paths and identifiers worth protecting. */
function inlineCode(markdown: string): string[] {
  const spans = withoutFences(markdown).match(/`[^`\n]+`/g) ?? [];
  return spans.map((span) => span.slice(1, -1).trim()).sort();
}

/** Link and image targets. */
function linkTargets(markdown: string): string[] {
  const targets: string[] = [];
  const pattern = /\]\(([^)\s]+)/g;
  let match = pattern.exec(markdown);
  while (match !== null) {
    targets.push(match[1] ?? "");
    match = pattern.exec(markdown);
  }
  return targets.sort();
}

function normaliseCode(code: string): string {
  return code
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .trim();
}

/** Whitespace-insensitive form, so re-indentation is not read as an edit. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Fence markers with a heading welded onto the same line. */
function gluedFences(text: string): number {
  return (text.match(/`{3,}#/g) ?? []).length;
}

/**
 * Headings welded onto whatever preceded them, so they no longer start a line.
 *
 * The general form of the same defect: a heading marker only opens a heading at
 * the start of a line, so text running straight into one leaves the marker as
 * literal characters and loses the heading altogether. Seen on seven pages,
 * where "provided by Cilium." and "## Validate the Installation" arrived on one
 * line because the blank line between them was dropped.
 *
 * Counted rather than forbidden, because a legitimate page can contain the
 * sequence; only an increase over the original is the repair's doing.
 */
function weldedHeadings(text: string): number {
  // The character before the marker must not itself be a hash, or a perfectly
  // ordinary heading counts as welded: in "\n## Validate" the first hash is
  // non-whitespace, so \S matches it and the second satisfies the run. Both
  // sides of the comparison then tie and the gate passes everything.
  return (text.match(/[^\s#]#{1,6}[ \t]/g) ?? []).length;
}

/** Characters of actual code, ignoring layout. */
function codeVolume(blocks: string[]): number {
  return blocks.reduce((total, block) => total + block.replace(/\s+/g, "").length, 0);
}

/**
 * Below this, a fenced block is too short to be worth tracing to the original:
 * a one-word block like `nginx` occurs in the prose anyway, so requiring a
 * match would reject pages without evidence of a real edit.
 */
const MIN_TRACEABLE_CODE_CHARS = 20;

/**
 * Gates a whole page once its slices are reassembled.
 *
 * The per-slice gates cannot see a fenced block that a slice boundary cut in
 * half. Each half reaches the model as prose, and prose is guarded only by
 * length drift, so a two-character edit inside a command passes: this is how
 * `sed -e 's/^kube_owner:.*$/...'` became `sed -e 's/^kube_owner:._$/...'` in a
 * live index while every slice validated cleanly. Reassembly is the first point
 * where the block is whole again and can be compared as a block.
 *
 * The test is provenance, not equality: every fenced block in the result must
 * appear verbatim somewhere in the original, ignoring whitespace. That allows
 * the reflow cleanup is for — re-indenting, merging, moving a block — and
 * refuses any block whose content the model invented or altered.
 *
 * @param original The page's Markdown before cleanup.
 * @param cleaned The reassembled Markdown the slices produced.
 * @returns ok, or the first block that cannot be traced to the original.
 */
export function validatePage(original: string, cleaned: string): ValidationResult {
  // A fence marker with a heading welded to it never closes, so everything
  // after it is served as code. Reassembly caused this by joining trimmed
  // answers with no separator, and the provenance check below only caught it
  // by accident, when the runaway block happened to stop tracing. Comparing
  // the counts catches it directly and cannot fire on an honest page: across
  // 3,298 stored originals, not one contained the sequence.
  if (gluedFences(cleaned) > gluedFences(original)) {
    const line = /[^\n]*`{3,}#[^\n]*/.exec(cleaned)?.[0] ?? "";
    return { ok: false, reason: `fence glued to a heading: ${line.slice(0, 60)}` };
  }

  // The same loss of a boundary, one step more general: a heading that no
  // longer starts its line is not a heading at all, just literal hashes in the
  // middle of a sentence.
  if (weldedHeadings(cleaned) > weldedHeadings(original)) {
    const line = /[^\n]*[^\s#]#{1,6}[ \t][^\n]*/.exec(cleaned)?.[0] ?? "";
    return { ok: false, reason: `heading welded to text: ${line.slice(0, 60)}` };
  }

  const haystack = flatten(original);
  for (const block of fencedCode(cleaned)) {
    const needle = flatten(block);
    if (needle.length < MIN_TRACEABLE_CODE_CHARS) continue;
    if (!haystack.includes(needle)) {
      return { ok: false, reason: `code altered: ${needle.slice(0, 60)}` };
    }
  }
  return { ok: true };
}

function sameMultiset(a: string[], b: string[]): boolean {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((value, index) => value === y[index]);
}

export function validateCleanup(
  original: string,
  cleaned: string,
  options: ValidationOptions,
): ValidationResult {
  if (cleaned.trim().length === 0) {
    return { ok: false, reason: "empty output" };
  }

  const drift = Math.abs(cleaned.length - original.length) / original.length;
  if (original.length > 0 && drift > options.maxLengthDrift) {
    const percent = Math.round(drift * 100);
    return { ok: false, reason: `length changed by ${percent}%` };
  }

  if (hasOpenFenceAtEnd(cleaned) !== hasOpenFenceAtEnd(original)) {
    return { ok: false, reason: "fence balance changed" };
  }

  // Removing needless escapes is the point of the pass, so an answer carrying
  // more of them than its input is moving backwards. Measured in production
  // before this gate existed: on one page the model escaped 24 identifiers that
  // were already plain (`source_pod` became `source\_pod`), and every other gate
  // accepted it — inline spans and link targets are compared with escapes
  // stripped, and prose escapes were not checked at all.
  const escapeCount = (text: string): number => (text.match(/\\[_*\-.+#]/g) ?? []).length;
  if (escapeCount(cleaned) > escapeCount(original)) {
    return { ok: false, reason: "escapes added" };
  }

  // Code is guarded by provenance, not by shape: every fenced block in the
  // answer must already appear in the slice it came from. Demanding an
  // identical set of blocks looked stricter but was wrong — scraped pages
  // arrive with doubled fence markers (one page here parsed as 15 blocks, 13 of
  // them empty, with the real code stranded outside as prose), and the prompt
  // asks the model to repair exactly that. Containment still refuses invented
  // or edited code, including unescaping inside a fence: of the 40 escapes
  // inside fenced blocks in this index, 35 are `\.` in real regular
  // expressions, where `/\.tsx?$/` and `/.tsx?$/` match different things.
  const originalBlocks = fencedCode(original);
  const cleanedBlocks = fencedCode(cleaned);
  const haystack = flatten(original);

  for (const block of cleanedBlocks) {
    const needle = flatten(block);
    if (needle.length === 0) continue;
    if (!haystack.includes(needle)) {
      return { ok: false, reason: "code blocks altered" };
    }
  }

  // Containment alone would accept an answer that simply deleted every fence,
  // which loses no text but destroys the code/prose distinction that search
  // depends on. Growth is allowed: re-fencing stranded code is the repair.
  if (codeVolume(cleanedBlocks) * 2 < codeVolume(originalBlocks)) {
    return { ok: false, reason: "code blocks dropped" };
  }

  // Inline spans and link targets are compared after removing the escapes the
  // HTML conversion added, because removing them is the repair: `PULUMI\_STACK`
  // becoming `PULUMI_STACK` must read as unchanged.
  const stripEscapes = (values: string[]): string[] =>
    values.map((value) => value.replace(/\\([_*\-.+#])/g, "$1")).sort();

  const originalInline = stripEscapes(inlineCode(original));
  const cleanedInline = stripEscapes(inlineCode(cleaned));
  if (!sameMultiset(originalInline, cleanedInline)) {
    return { ok: false, reason: "inline code altered" };
  }

  const originalLinks = stripEscapes(linkTargets(original));
  const cleanedLinks = stripEscapes(linkTargets(cleaned));
  if (!sameMultiset(originalLinks, cleanedLinks)) {
    return { ok: false, reason: "link targets altered" };
  }

  return { ok: true };
}
