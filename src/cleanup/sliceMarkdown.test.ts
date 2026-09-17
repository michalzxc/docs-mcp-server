import { describe, expect, it } from "vitest";
import { hasOpenFenceAtEnd } from "../splitter/splitters/fenceState";
import { sliceMarkdown } from "./sliceMarkdown";

describe("sliceMarkdown", () => {
  it("returns short input as a single slice", () => {
    const markdown = "# Title\n\nA short paragraph.";
    expect(sliceMarkdown(markdown, 5000)).toEqual([markdown]);
  });

  it("drops input that is only whitespace", () => {
    expect(sliceMarkdown("   \n\n  ", 5000)).toEqual([]);
  });

  it("keeps every slice within the limit when the text allows it", () => {
    const paragraph = `${"word ".repeat(40).trim()}\n\n`;
    const markdown = paragraph.repeat(40);

    const slices = sliceMarkdown(markdown, 1000);

    expect(slices.length).toBeGreaterThan(1);
    for (const slice of slices) {
      expect(slice.length).toBeLessThanOrEqual(1000);
    }
  });

  it("loses no content when reassembled", () => {
    const markdown = Array.from(
      { length: 30 },
      (_, i) => `## Section ${i}\n\nBody text for section ${i}.\n`,
    ).join("\n");

    expect(sliceMarkdown(markdown, 400).join("")).toBe(markdown);
  });

  it("never splits inside a fenced code block", () => {
    const code = `\`\`\`bash\n${"echo hello\n".repeat(30)}\`\`\``;
    const markdown = `# Heading\n\nIntro paragraph.\n\n${code}\n\nTrailing text.\n`;

    const slices = sliceMarkdown(markdown, 200);

    for (const slice of slices) {
      expect(hasOpenFenceAtEnd(slice)).toBe(false);
    }
  });

  it("emits an oversized code block whole rather than cutting it", () => {
    const code = `\`\`\`text\n${"x".repeat(900)}\n\`\`\``;
    const markdown = `Intro.\n\n${code}\n`;

    const slices = sliceMarkdown(markdown, 200);

    const fenced = slices.find((slice) => slice.includes("```"));
    expect(fenced).toBeDefined();
    expect(fenced!.length).toBeGreaterThan(200);
    expect(hasOpenFenceAtEnd(fenced!)).toBe(false);
  });

  it("prefers to break at a heading", () => {
    const body = `${"filler ".repeat(30).trim()}\n\n`;
    const markdown = `## One\n\n${body}## Two\n\n${body}`;

    const slices = sliceMarkdown(markdown, 300);

    expect(slices.length).toBeGreaterThan(1);
    expect(slices[1]!.startsWith("## Two")).toBe(true);
  });
});
