import { describe, expect, it } from "vitest";
import { dirtSignals, isDirty } from "./isDirty";

describe("isDirty", () => {
  it("passes clean markdown", () => {
    const markdown = [
      "## Configuration",
      "",
      "Set the stack with `PULUMI_STACK`, then run:",
      "",
      "```bash",
      "pulumi up --stack homelab",
      "```",
      "",
      "See [the docs](https://example.com/docs).",
    ].join("\n");

    expect(isDirty(markdown)).toBe(false);
    expect(dirtSignals(markdown)).toEqual([]);
  });

  it("flags leftover block HTML", () => {
    expect(dirtSignals("<dd>Sets the stack.</dd>")).toContain("html");
  });

  it("flags a leftover HTML attribute", () => {
    expect(dirtSignals('<pre><code class="text-xs">x</code></pre>')).toContain(
      "attribute",
    );
  });

  it("flags needless backslash escapes", () => {
    expect(dirtSignals("Set PULUMI\\_STACK first.")).toContain("escape");
  });

  it("flags an unbalanced fence", () => {
    expect(dirtSignals("Intro\n\n```bash\necho hi\n")).toContain("fence");
  });

  it("ignores HTML and escapes inside code samples", () => {
    const markdown = [
      "Render it:",
      "",
      "```html",
      '<div class="wrapper">hello</div>',
      "```",
      "",
      "And inline: `<span>x</span>` stays as written.",
    ].join("\n");

    expect(isDirty(markdown)).toBe(false);
  });

  it("reports every signal it finds", () => {
    const markdown = '<dd class="x">Value</dd>\n\nUse FOO\\_BAR.';
    expect(dirtSignals(markdown).sort()).toEqual(["attribute", "escape", "html"]);
  });
});
