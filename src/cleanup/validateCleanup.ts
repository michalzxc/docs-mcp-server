import { hasOpenFenceAtEnd } from "../splitter/splitters/fenceState";

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

/** Fenced blocks, normalised so trailing whitespace differences don't count. */
function fencedCode(markdown: string): string[] {
  const blocks: string[] = [];
  const pattern = /(?:```|~~~)[^\n]*\n([\s\S]*?)(?:```|~~~)/g;
  let match = pattern.exec(markdown);
  while (match !== null) {
    blocks.push(normaliseCode(match[1] ?? ""));
    match = pattern.exec(markdown);
  }
  return blocks;
}

/** Inline spans, which carry flags, paths and identifiers worth protecting. */
function inlineCode(markdown: string): string[] {
  const withoutFences = markdown.replace(/(?:```|~~~)[\s\S]*?(?:```|~~~)/g, "");
  const spans = withoutFences.match(/`[^`\n]+`/g) ?? [];
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

/** Characters of actual code, ignoring layout. */
function codeVolume(blocks: string[]): number {
  return blocks.reduce((total, block) => total + block.replace(/\s+/g, "").length, 0);
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
