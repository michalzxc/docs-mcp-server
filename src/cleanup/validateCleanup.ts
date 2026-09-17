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
  return blocks.sort();
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

function sameMultiset(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Checks a cleaned slice against the original it replaces.
 *
 * Escaped identifiers are unescaped by design, so inline spans and link targets
 * are compared after removing the backslashes the conversion added — otherwise
 * every genuine repair would read as a violation.
 */
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

  if (!sameMultiset(fencedCode(original), fencedCode(cleaned))) {
    return { ok: false, reason: "code blocks altered" };
  }

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
