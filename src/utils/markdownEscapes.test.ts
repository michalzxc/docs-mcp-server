import { describe, expect, it } from "vitest";
import { unescapeInert } from "./markdownEscapes";

describe("unescapeInert", () => {
  it("removes an escape from an underscore inside a word", () => {
    // 9,580 of 13,827 escapes in a real index were these. An underscore inside
    // a word cannot open emphasis, so the backslash only obscured the text.
    expect(unescapeInert("source\\_pod and PULUMI\\_STACK")).toBe(
      "source_pod and PULUMI_STACK",
    );
  });

  it("removes an escape from a long command-line flag", () => {
    // A cleanup pass produced 266 of these on one library: `\--namespace ...`.
    expect(unescapeInert("\\--namespace kube-system")).toBe("--namespace kube-system");
    expect(unescapeInert("\\--set kubeProxyReplacement=true")).toBe(
      "--set kubeProxyReplacement=true",
    );
  });

  it("removes an escape from a short command-line flag", () => {
    // What the first, double-dash-only version of this rule missed: `sed \-e`
    // is a flag too, and a single dash followed by a letter cannot open a list
    // any more than a double dash can.
    expect(unescapeInert("sed \\-e 's/^kube_owner:.*$/root/'")).toBe(
      "sed -e 's/^kube_owner:.*$/root/'",
    );
    expect(unescapeInert("kubectl get pods \\-n kube-system")).toBe(
      "kubectl get pods -n kube-system",
    );
  });

  it("keeps the escape on a dash that would open a list", () => {
    // The other half of the rule. Without this, literal text becomes structure.
    expect(unescapeInert("\\- not a bullet")).toBe("\\- not a bullet");
  });

  it("keeps the escape on an asterisk that would open a list", () => {
    expect(unescapeInert("\\* not a bullet")).toBe("\\* not a bullet");
  });

  it("removes an escape from punctuation inside a word", () => {
    expect(unescapeInert("file\\-name and a\\*b")).toBe("file-name and a*b");
  });

  it("leaves text with no escapes untouched", () => {
    const text = "# Heading\n\n- item one\n- item two\n";
    expect(unescapeInert(text)).toBe(text);
  });
});
