import { describe, expect, it } from "vitest";
import {
  fencedBlocks,
  hasOpenFenceAtEnd,
  isOpenAt,
  nextSafeOffset,
  withoutFences,
} from "./fenceState";

const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;

describe("fenceState", () => {
  describe("isOpenAt", () => {
    it("returns false for content without any fence", () => {
      const text = "hello\nworld\n";
      expect(isOpenAt(text, 0)).toBe(false);
      expect(isOpenAt(text, 6)).toBe(false);
      expect(isOpenAt(text, text.length)).toBe(false);
    });

    it("returns true inside a backtick fence and false outside", () => {
      const text = `before\n${fence("ts", "const x = 1;")}\nafter`;
      const openerStart = text.indexOf("```");
      const closerEnd = text.lastIndexOf("```") + 3 + 1; // include the newline after the closer
      expect(isOpenAt(text, openerStart)).toBe(false);
      expect(isOpenAt(text, openerStart + 1)).toBe(true);
      expect(isOpenAt(text, openerStart + 5)).toBe(true);
      expect(isOpenAt(text, closerEnd)).toBe(false);
      expect(isOpenAt(text, text.length)).toBe(false);
    });

    it("recognises tilde fences", () => {
      const text = "before\n~~~\ncode here\n~~~\nafter";
      const openerStart = text.indexOf("~~~");
      expect(isOpenAt(text, openerStart + 1)).toBe(true);
      expect(isOpenAt(text, openerStart + 5)).toBe(true);
      expect(isOpenAt(text, text.length)).toBe(false);
    });

    it("does not pair backtick opener with tilde closer", () => {
      const text = "```ts\ncode\n~~~\nstill open\n";
      // Backtick opener has no closer — entire rest is "inside".
      expect(isOpenAt(text, text.length - 1)).toBe(true);
    });

    it("tolerates leading indentation on the fence (including >3 spaces from list nesting)", () => {
      const text = "prose\n   ```ts\n   code\n   ```\nafter";
      const openerLineStart = text.indexOf("   ```");
      expect(isOpenAt(text, openerLineStart + 5)).toBe(true);
      expect(isOpenAt(text, text.length)).toBe(false);

      // Turndown emits 4-space indented fences inside list-item bodies.
      const listy = "prose\n    ```ts\n    code\n    ```\nafter";
      const listyOpenerStart = listy.indexOf("    ```");
      expect(isOpenAt(listy, listyOpenerStart + 6)).toBe(true);
      expect(isOpenAt(listy, listy.length)).toBe(false);
    });

    it("requires the closer to have at least as many delimiters as the opener", () => {
      // 4-backtick opener cannot be closed by 3-backtick line.
      const text = "````ts\ninside ```not a closer\n````\nafter";
      const opener = text.indexOf("````");
      const closer = text.lastIndexOf("````");
      expect(isOpenAt(text, opener + 2)).toBe(true);
      // Right after the closer's line + newline: outside.
      expect(isOpenAt(text, closer + 5)).toBe(false);
    });

    it("treats an unclosed opener as open through end of input", () => {
      const text = "intro\n```ts\nno closer";
      expect(isOpenAt(text, text.length - 1)).toBe(true);
    });

    it("handles multiple non-overlapping fences", () => {
      const text = "a\n```\nA\n```\nb\n```\nB\n```\nc";
      const firstOpener = text.indexOf("```");
      const firstCloser = text.indexOf("```", firstOpener + 3);
      const secondOpener = text.indexOf("```", firstCloser + 3);
      const secondCloser = text.lastIndexOf("```");
      expect(isOpenAt(text, firstOpener + 1)).toBe(true);
      expect(isOpenAt(text, firstCloser + 4)).toBe(false);
      expect(isOpenAt(text, secondOpener + 1)).toBe(true);
      expect(isOpenAt(text, secondCloser + 4)).toBe(false);
    });
  });

  describe("nextSafeOffset", () => {
    it("returns the input offset unchanged when outside any fence", () => {
      const text = "no fences here";
      expect(nextSafeOffset(text, 5)).toBe(5);
    });

    it("advances past the closer when the candidate is inside a fence", () => {
      const text = `intro\n${fence("ts", "code")}\nafter`;
      const fenceStart = text.indexOf("```");
      const closerEnd = text.lastIndexOf("```") + 3 + 1; // +1 for newline after closer
      const candidate = fenceStart + 4; // inside the opener line, past the ```
      expect(nextSafeOffset(text, candidate)).toBe(closerEnd);
    });

    it("returns text.length when the fence is unclosed", () => {
      const text = "intro\n```ts\nstill open";
      const candidate = text.indexOf("```") + 4;
      expect(nextSafeOffset(text, candidate)).toBe(text.length);
    });
  });

  describe("fencedBlocks", () => {
    it("returns the body without the opener and closer lines", () => {
      expect(fencedBlocks("intro\n```ts\nconst x = 1;\n```\nafter")).toEqual([
        "const x = 1;\n",
      ]);
    });

    it("returns each block of a multi-fence document in order", () => {
      expect(fencedBlocks("a\n```\nA\n```\nb\n```\nB\n```\nc")).toEqual(["A\n", "B\n"]);
    });

    it("does not close a 4-backtick fence on an inner 3-backtick line", () => {
      // What a regular expression gets wrong. A page documenting Markdown puts
      // a fence inside a fence; pairing by pattern ends the outer block at the
      // inner line and reads the prose that follows as code.
      const text = "````md\n```sh\nboom\n```\n````\nafter\n";

      expect(fencedBlocks(text)).toEqual(["```sh\nboom\n```\n"]);
    });

    it("treats an unclosed opener as running to the end", () => {
      expect(fencedBlocks("intro\n```ts\nno closer")).toEqual(["no closer"]);
    });

    it("recognises tilde fences and does not pair them with backticks", () => {
      expect(fencedBlocks("~~~\ncode\n~~~\n")).toEqual(["code\n"]);
    });

    it("returns nothing for prose", () => {
      expect(fencedBlocks("just words, and an `inline span`")).toEqual([]);
    });
  });

  describe("withoutFences", () => {
    it("removes fenced blocks and keeps the prose around them", () => {
      expect(withoutFences("before\n```ts\ncode\n```\nafter\n")).toBe("before\nafter\n");
    });

    it("removes the whole of a fence that contains another fence", () => {
      expect(withoutFences("````md\n```sh\nboom\n```\n````\nafter\n")).toBe("after\n");
    });

    it("returns text with no fences unchanged", () => {
      const text = "plain prose with an `inline span`\n";
      expect(withoutFences(text)).toBe(text);
    });
  });

  describe("hasOpenFenceAtEnd", () => {
    it("returns false for balanced content", () => {
      expect(hasOpenFenceAtEnd(`text\n${fence("", "x")}\nmore`)).toBe(false);
    });

    it("returns true when content ends inside an unclosed fence", () => {
      expect(hasOpenFenceAtEnd("text\n```ts\nconst x")).toBe(true);
    });

    it("returns false for content with no fences at all", () => {
      expect(hasOpenFenceAtEnd("plain prose")).toBe(false);
    });
  });
});
