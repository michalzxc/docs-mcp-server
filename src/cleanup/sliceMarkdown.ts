import { isOpenAt, nextSafeOffset } from "../splitter/splitters/fenceState";

/**
 * Splits a page's Markdown into pieces small enough to send to a model.
 *
 * Two properties matter more than even sizing:
 *
 * - A slice never starts or ends inside a fenced code block. The model is told
 *   to balance fences, so handing it half a code block would have it close a
 *   fence that the next slice re-opens, corrupting a sample that was fine.
 * - Slices prefer to break at a heading, so each one reads as a whole section
 *   and the model has the context to leave it alone.
 *
 * A single code block larger than `maxChars` is emitted as one oversized slice
 * rather than cut: sending it whole may exceed the model's comfort, but cutting
 * it guarantees corruption.
 */
export function sliceMarkdown(markdown: string, maxChars: number): string[] {
  const limit = Math.max(1, Math.floor(maxChars));
  if (markdown.length <= limit) {
    return markdown.trim().length > 0 ? [markdown] : [];
  }

  const slices: string[] = [];
  let start = 0;

  while (start < markdown.length) {
    if (markdown.length - start <= limit) {
      slices.push(markdown.slice(start));
      break;
    }

    const hardEnd = start + limit;
    let end = findBreak(markdown, start, hardEnd);

    // Never cut inside a fence: push the boundary past the fence's closer.
    if (isOpenAt(markdown, end)) {
      end = nextSafeOffset(markdown, end);
    }

    // No usable boundary (one huge block): take the whole safe span.
    if (end <= start) {
      end = nextSafeOffset(markdown, hardEnd);
      if (end <= start) {
        end = markdown.length;
      }
    }

    slices.push(markdown.slice(start, end));
    start = end;
  }

  return slices.filter((slice) => slice.trim().length > 0);
}

/**
 * Finds the best break between `start` and `hardEnd`: the last heading that
 * begins a line, else the last blank line, else the hard limit.
 */
function findBreak(markdown: string, start: number, hardEnd: number): number {
  const window = markdown.slice(start, hardEnd);

  const heading = window.lastIndexOf("\n#");
  if (heading > 0) {
    return start + heading + 1;
  }

  const blankLine = window.lastIndexOf("\n\n");
  if (blankLine > 0) {
    return start + blankLine + 2;
  }

  const newline = window.lastIndexOf("\n");
  if (newline > 0) {
    return start + newline + 1;
  }

  return hardEnd;
}
