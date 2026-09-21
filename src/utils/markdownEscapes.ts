/**
 * Removes backslash escapes that cannot change how Markdown renders.
 *
 * Both converters in this project round-trip text through Turndown — the
 * scraper, which writes the Markdown we store as a page's original, and the
 * chunk splitter, which rebuilds chunks from it. Turndown escapes punctuation
 * in text nodes conservatively, which is correct in general and wrong for a
 * documentation site, where the punctuation is usually part of an identifier
 * or a command rather than markup.
 *
 * Measured on a real index built with this project:
 *
 * - `\_` inside words accounted for 9,580 of 13,827 escapes. An underscore
 *   inside a word cannot open emphasis in CommonMark, so the backslash changed
 *   nothing except making the text harder to read, search and quote.
 * - `\-` appeared 266 times on one library after a cleanup pass, all of them
 *   command-line flags at the start of a line: `\--namespace kube-system`.
 *   A leading `-` can open a list, so Turndown escapes it; `--namespace`
 *   cannot, because a list marker is a single dash followed by a space.
 *
 * What is deliberately left escaped is the other half of the same rule: `- `
 * and `* ` at the start of a line really do open a list, and unescaping those
 * would turn literal text into structure. That is why this narrows rather than
 * disabling escaping, which would be the easy and wrong fix.
 */

/** Markdown punctuation that is inert when it sits inside a word. */
const INTRA_WORD = /(?<=[A-Za-z0-9])\\([_*-])(?=[A-Za-z0-9])/g;

/**
 * A dash only opens a list when a space follows it, so any other dash is inert.
 *
 * This started as a double-dash rule, which handled `--namespace` and missed
 * `sed \-e` on the very next page: a single dash and a letter is just as much
 * a flag, and just as incapable of starting a list. Matching "not followed by
 * a space" covers both and stays narrow, because `- item` is untouched.
 */
const INERT_DASH = /\\-(?=\S)/g;

/**
 * Strips escapes that cannot affect rendering, leaving every load-bearing one.
 * @param text Markdown as Turndown escaped it.
 * @returns The same Markdown with inert escapes removed.
 */
export function unescapeInert(text: string): string {
  return text.replace(INTRA_WORD, "$1").replace(INERT_DASH, "-");
}
