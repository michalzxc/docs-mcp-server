import { describe, expect, it } from "vitest";
import { cleanupFingerprint, DEFAULT_CLEANUP_SYSTEM_PROMPT } from "./prompt";

describe("cleanupFingerprint", () => {
  it("is stable for the same inputs", () => {
    const a = cleanupFingerprint("deepseek-v4-fast", "prompt", 5000);
    const b = cleanupFingerprint("deepseek-v4-fast", "prompt", 5000);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes when the model changes", () => {
    expect(cleanupFingerprint("model-a", "prompt", 5000)).not.toBe(
      cleanupFingerprint("model-b", "prompt", 5000),
    );
  });

  it("changes when the prompt changes", () => {
    expect(cleanupFingerprint("model", "prompt one", 5000)).not.toBe(
      cleanupFingerprint("model", "prompt two", 5000),
    );
  });

  it("changes when the slice size changes", () => {
    expect(cleanupFingerprint("model", "prompt", 5000)).not.toBe(
      cleanupFingerprint("model", "prompt", 4000),
    );
  });
});

describe("DEFAULT_CLEANUP_SYSTEM_PROMPT", () => {
  // Each of these lines was added after watching a model misbehave on real
  // scraped pages; losing one silently degrades every cleaned page.
  it("forbids wrapping the answer in a code fence", () => {
    expect(DEFAULT_CLEANUP_SYSTEM_PROMPT).toMatch(
      /Do not wrap your answer in a code fence/,
    );
  });

  it("forbids changing punctuation or Unicode", () => {
    expect(DEFAULT_CLEANUP_SYSTEM_PROMPT).toMatch(/Never change punctuation or Unicode/);
  });

  it("protects code samples", () => {
    expect(DEFAULT_CLEANUP_SYSTEM_PROMPT).toMatch(
      /Never change anything inside a code block/,
    );
  });

  it("allows an unchanged fragment", () => {
    expect(DEFAULT_CLEANUP_SYSTEM_PROMPT).toMatch(/return it unchanged/);
  });
});
