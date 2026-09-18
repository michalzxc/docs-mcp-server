import { describe, expect, it } from "vitest";
import { validateCleanup } from "./validateCleanup";

const options = { maxLengthDrift: 0.35 };

describe("validateCleanup", () => {
  it("accepts a genuine repair", () => {
    const original = "<dd>Sets the stack.</dd>\n\nPULUMI\\_STACK is read first.";
    const cleaned = "Sets the stack.\n\nPULUMI_STACK is read first.";

    expect(validateCleanup(original, cleaned, options)).toEqual({ ok: true });
  });

  it("rejects empty output", () => {
    const result = validateCleanup("Some text", "   ", options);
    expect(result).toEqual({ ok: false, reason: "empty output" });
  });

  it("rejects output that lost too much text", () => {
    const original = "sentence. ".repeat(50);
    const cleaned = "sentence. ".repeat(20);

    const result = validateCleanup(original, cleaned, options);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/length changed/);
  });

  it("rejects output that changed fence balance", () => {
    const original = "Intro\n\n```bash\necho hi\n```\n";
    const cleaned = "Intro\n\n```bash\necho hi\n";

    const result = validateCleanup(original, cleaned, options);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("fence balance changed");
  });

  it("rejects a single altered character inside a code block", () => {
    const original = "Run it:\n\n```bash\nkubectl get pods -n prod\n```\n";
    const cleaned = "Run it:\n\n```bash\nkubectl get pods -n dev\n```\n";

    const result = validateCleanup(original, cleaned, options);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("code blocks altered");
  });

  it("tolerates trailing whitespace differences inside code", () => {
    const original = "```bash\necho hi   \n```\n";
    const cleaned = "```bash\necho hi\n```\n";

    expect(validateCleanup(original, cleaned, options)).toEqual({ ok: true });
  });

  it("accepts re-fencing code the scrape left stranded outside a block", () => {
    // A real page in the index: doubled fence markers parsed as 15 blocks, 13
    // of them empty, with the code sitting outside as prose. Repairing that is
    // what the prompt asks for, so the gate must not demand identical blocks.
    const original = '```python\n```\n\nimport pulumi\nvpc = Vpc("vpc")\n\n```\n```\n';
    const cleaned = '```python\nimport pulumi\nvpc = Vpc("vpc")\n```\n';

    expect(validateCleanup(original, cleaned, options)).toEqual({ ok: true });
  });

  it("rejects an answer that unfenced the code entirely", () => {
    // Containment alone would allow this: no text is lost, but the code/prose
    // distinction search depends on is gone.
    const original = "```bash\nkubectl get pods\nkubectl get nodes\n```\n";
    const cleaned = "kubectl get pods\nkubectl get nodes\n";

    const result = validateCleanup(original, cleaned, options);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("code blocks dropped");
  });

  it("rejects unescaping inside a fenced block, because escapes there are real", () => {
    // Counted over the live index: 35 of the 40 escapes inside fenced blocks are
    // `\.` inside regular expressions, where the backslash is load-bearing —
    // `/\.tsx?$/` and `/.tsx?$/` match different things. Unescaping is a repair
    // outside fences and a corruption inside one, so code keeps the strict rule.
    const original = "```js\nconst re = /\\.tsx?$/;\n```\n";
    const cleaned = "```js\nconst re = /.tsx?$/;\n```\n";

    const result = validateCleanup(original, cleaned, options);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("code blocks altered");
  });

  it("rejects a dropped inline code span", () => {
    const original = "Set `--max-pages` and `--scope` before running.";
    const cleaned = "Set `--max-pages` before running.";

    const result = validateCleanup(original, cleaned, options);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("inline code altered");
  });

  it("allows unescaping inside inline code, which is the point of the pass", () => {
    const original = "Use `PULUMI\\_STACK` to select it.";
    const cleaned = "Use `PULUMI_STACK` to select it.";

    expect(validateCleanup(original, cleaned, options)).toEqual({ ok: true });
  });

  it("rejects a rewritten link target", () => {
    const original = "See [the docs](https://example.com/a).";
    const cleaned = "See [the docs](https://example.com/b).";

    const result = validateCleanup(original, cleaned, options);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("link targets altered");
  });
});
