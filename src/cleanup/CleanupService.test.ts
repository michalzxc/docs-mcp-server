import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CleanupPage } from "../store/types";
import { PageCleanupStatus } from "../store/types";
import type { AppConfig } from "../utils/config";
import {
  CleanupService,
  type CleanupStore,
  changedRegion,
  reassembleSlices,
  stripFenceWrapper,
  summarise,
} from "./CleanupService";

const DIRTY = "## Title\n\n<dd>Sets the stack.</dd>\n\nUse PULUMI\\_STACK first.";
const CLEAN = "## Title\n\nSets the stack.\n\nUse PULUMI_STACK first.";

function makeConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return {
    splitter: { minChunkSize: 500, preferredChunkSize: 1500, maxChunkSize: 5000 },
    cleanup: {
      enabled: true,
      model: "test-model",
      baseUrl: "",
      sliceChars: 5000,
      maxConcurrency: 2,
      requestDelayMs: 0,
      requestTimeoutMs: 1000,
      maxLengthDrift: 0.35,
      filter: "dirty",
      storeRawContent: true,
      systemPrompt: "repair it",
      ...overrides,
    },
  } as unknown as AppConfig;
}

function makePage(overrides: Partial<CleanupPage> = {}): CleanupPage {
  return {
    id: 1,
    version_id: 7,
    url: "https://example.com/docs/config",
    title: "Config",
    raw_content: DIRTY,
    cleanup_status: null,
    cleanup_fingerprint: null,
    ...overrides,
  };
}

function makeStore(page: CleanupPage, chunks: string[] = []): CleanupStore {
  return {
    getPageForCleanup: vi.fn(async () => page),
    getPagesNeedingCleanup: vi.fn(async () => [page]),
    countPagesNeedingCleanup: vi.fn(async () => 1),
    getChunksByPageId: vi.fn(async () =>
      chunks.map((content, i) => ({ id: i + 1, content, sort_order: i })),
    ),
    setPageRawContent: vi.fn(async () => {}),
    markPageCleanup: vi.fn(async () => {}),
    replacePageChunks: vi.fn(async () => {}),
  };
}

/** A chat model that answers with whatever the test hands it. */
function makeModel(reply: string | (() => Promise<string>)): BaseChatModel {
  return {
    invoke: vi.fn(async () => ({
      content: typeof reply === "string" ? reply : await reply(),
    })),
  } as unknown as BaseChatModel;
}

describe("stripFenceWrapper", () => {
  it("unwraps a whole-answer code fence", () => {
    expect(stripFenceWrapper("```markdown\n# Title\n\nBody\n```")).toBe(
      "# Title\n\nBody",
    );
  });

  it("leaves a document that merely contains a fence alone", () => {
    const text = "Intro\n\n```bash\necho hi\n```\n\nOutro";
    expect(stripFenceWrapper(text)).toBe(text);
  });
});

describe("changedRegion", () => {
  it("centres the excerpt on a one-character change deep inside a slice", () => {
    // The defect this guards against shipped: the live view sent the head of
    // the slice, so a repair further down produced two identical-looking walls
    // of text and the reader could not see what had happened.
    const filler = "Engines configured by default in settings.yml. ".repeat(12);
    const before = `${filler}### without further subgrouping¶ |${filler}`;
    const after = `${filler}### without further subgrouping |${filler}`;

    const region = changedRegion(before, after);

    expect(region.before).not.toEqual(region.after);
    expect(region.before).toContain("subgrouping¶");
    expect(region.after).not.toContain("¶");
    // Readable: the slice is over a thousand characters, the excerpt is not.
    expect(region.before.length).toBeLessThan(250);
  });

  it("stays short when changes are scattered across a long slice", () => {
    // The first attempt only trimmed the common prefix and suffix, so a slice
    // repaired near both ends returned almost all of itself. Measured against
    // the live job: a 4,763-character "excerpt" — the wall of text this is
    // meant to prevent. The earlier test passed because it changed one spot.
    const filler = "Bot protection and IP rate limitation. ".repeat(60);
    const before = `# Limiter¶ ${filler} answer-captcha¶ tail`;
    const after = `# Limiter ${filler} answer-captcha tail`;

    const region = changedRegion(before, after);

    expect(region.before.length).toBeLessThan(350);
    expect(region.after.length).toBeLessThan(350);
    // Still shows the first repair rather than an arbitrary slice of prose.
    expect(region.before).toContain("Limiter¶");
  });

  it("marks only the change when later edits shift the text", () => {
    // The live failure this reproduces: a one-character repair was highlighted
    // across 229 characters. Removing a character shifts everything after it,
    // and with further edits beyond the span cap both windows were cut at the
    // same offset — which is different text on each side, so nothing lined up.
    //
    // The earlier tests passed against that broken code, because a single
    // isolated change needs no resynchronisation. This one needs it.
    const long = "collaborative software platforms and other prose. ".repeat(6);
    const before = `${"x".repeat(80)}# Engines¶${long} a\\_b trailing text`;
    const after = `${"x".repeat(80)}# Engines${long} a_b trailing text`;

    const region = changedRegion(before, after);

    // Exactly what the job card does to decide what to highlight.
    let p = 0;
    while (
      p < region.before.length &&
      p < region.after.length &&
      region.before[p] === region.after[p]
    ) {
      p++;
    }
    let endB = region.before.length;
    let endA = region.after.length;
    while (endB > p && endA > p && region.before[endB - 1] === region.after[endA - 1]) {
      endB--;
      endA--;
    }

    expect(endB - p).toBeLessThan(5);
    expect(region.before.slice(p, endB)).toContain("¶");
  });

  it("keeps the whole text when it is shorter than the context window", () => {
    const region = changedRegion("PULUMI\\_STACK", "PULUMI_STACK");

    expect(region.before).toBe("PULUMI\\_STACK");
    expect(region.after).toBe("PULUMI_STACK");
  });
});

describe("summarise", () => {
  it("names removed escapes", () => {
    expect(summarise("a\\_b and c\\_d", "a_b and c_d")).toContain("−2 escapes");
  });

  it("names removed html", () => {
    expect(summarise("<dd>x</dd>", "x")).toContain("html tags");
  });

  it("reports whitespace when nothing else changed", () => {
    // Same length and same counts, but not the same text: only layout moved,
    // which would otherwise be summarised as no change at all.
    expect(summarise("a b", "a\nb")).toBe("whitespace only");
  });
});

describe("CleanupService.cleanPage", () => {
  let page: CleanupPage;

  beforeEach(() => {
    page = makePage();
  });

  it("replaces the page's chunks and marks it clean", async () => {
    const store = makeStore(page);
    const service = new CleanupService(store, makeConfig(), makeModel(CLEAN));

    const result = await service.cleanPage(page);

    expect(result.status).toBe(PageCleanupStatus.CLEAN);
    expect(result.repaired).toBe(1);
    expect(result.kept).toBe(0);
    expect(store.replacePageChunks).toHaveBeenCalledOnce();
    expect(store.markPageCleanup).toHaveBeenCalledWith(
      page.id,
      PageCleanupStatus.CLEAN,
      expect.any(String),
    );
  });

  it("keeps the original text when the model's answer fails validation", async () => {
    // Drops the second half: exactly the silent damage the gates exist for.
    const store = makeStore(page);
    const service = new CleanupService(store, makeConfig(), makeModel("## Title"));

    const result = await service.cleanPage(page);

    expect(result.status).toBe(PageCleanupStatus.FAILED);
    expect(result.kept).toBe(1);
    expect(store.replacePageChunks).not.toHaveBeenCalled();
  });

  it("keeps the original text when the model call throws", async () => {
    const store = makeStore(page);
    const model = {
      invoke: vi.fn(async () => {
        throw new Error("endpoint down");
      }),
    } as unknown as BaseChatModel;
    const service = new CleanupService(store, makeConfig(), model);

    const result = await service.cleanPage(page);

    expect(result.status).toBe(PageCleanupStatus.FAILED);
    expect(store.replacePageChunks).not.toHaveBeenCalled();
  });

  it("skips a page with no artefacts without calling the model", async () => {
    const store = makeStore(makePage({ raw_content: CLEAN }));
    const model = makeModel(CLEAN);
    const service = new CleanupService(store, makeConfig(), model);

    const result = await service.cleanPage(makePage({ raw_content: CLEAN }));

    expect(result.status).toBe(PageCleanupStatus.SKIPPED);
    expect(model.invoke).not.toHaveBeenCalled();
    expect(store.markPageCleanup).toHaveBeenCalledWith(
      1,
      PageCleanupStatus.SKIPPED,
      expect.any(String),
    );
  });

  it("cleans a page with no artefacts when asked for a full pass", async () => {
    const store = makeStore(makePage({ raw_content: CLEAN }));
    const model = makeModel(CLEAN);
    const service = new CleanupService(store, makeConfig(), model);

    const result = await service.cleanPage(makePage({ raw_content: CLEAN }), {
      full: true,
    });

    expect(model.invoke).toHaveBeenCalledOnce();
    expect(result.status).toBe(PageCleanupStatus.CLEAN);
  });

  it("rebuilds and stores the original when the page has none", async () => {
    const withoutRaw = makePage({ raw_content: null });
    const store = makeStore(withoutRaw, [DIRTY]);
    const service = new CleanupService(store, makeConfig(), makeModel(CLEAN));

    const result = await service.cleanPage(withoutRaw);

    expect(store.getChunksByPageId).toHaveBeenCalledWith(withoutRaw.id);
    expect(store.setPageRawContent).toHaveBeenCalledWith(withoutRaw.id, DIRTY);
    expect(result.status).toBe(PageCleanupStatus.CLEAN);
  });

  it("skips a page that has neither stored text nor chunks", async () => {
    const empty = makePage({ raw_content: null });
    const store = makeStore(empty, []);
    const model = makeModel(CLEAN);
    const service = new CleanupService(store, makeConfig(), model);

    const result = await service.cleanPage(empty);

    expect(result.status).toBe(PageCleanupStatus.SKIPPED);
    expect(model.invoke).not.toHaveBeenCalled();
  });

  it("does not call the model once cancelled", async () => {
    const store = makeStore(page);
    const model = makeModel(CLEAN);
    const service = new CleanupService(store, makeConfig(), model);
    const controller = new AbortController();
    controller.abort();

    const result = await service.cleanPage(page, { signal: controller.signal });

    expect(model.invoke).not.toHaveBeenCalled();
    expect(result.kept).toBeGreaterThan(0);
  });
});

describe("CleanupService reconciliation", () => {
  // A closing fence with a heading welded to it: the fence never closes, so
  // everything after it is served as code.
  const DAMAGED = "```sh\necho hi\n```## Heading\n\nBody.\n";

  it("restores a page it skips when the stored text is damaged", async () => {
    // How 8 pages survived a full regeneration still broken. They were skipped
    // or wholly rejected, and both paths marked the fingerprint and returned
    // without ever looking at what was on disk.
    const page = makePage({ raw_content: CLEAN });
    const store = makeStore(page, [DAMAGED]);
    const service = new CleanupService(store, makeConfig(), makeModel(CLEAN));

    const result = await service.cleanPage(page);

    expect(result.status).toBe(PageCleanupStatus.SKIPPED);
    expect(store.replacePageChunks).toHaveBeenCalled();
  });

  it("leaves a page it skips alone when the stored text is sound", async () => {
    // The other half: a good repair from an earlier run must survive. Only a
    // page the guard refuses is rewritten.
    const page = makePage({ raw_content: CLEAN });
    const store = makeStore(page, [CLEAN]);
    const service = new CleanupService(store, makeConfig(), makeModel(CLEAN));

    await service.cleanPage(page);

    expect(store.replacePageChunks).not.toHaveBeenCalled();
  });
});

describe("reassembleSlices", () => {
  it("restores the line breaks the answer was trimmed of", () => {
    // The defect this exists for. Joining the trimmed answers with nothing in
    // between put a heading on a closing fence line, the fence never closed,
    // and the rest of the page was served as code.
    const originals = ["Intro\n\n```go\ncode\n```\n\n", "## Add the mocks\n"];
    const repaired = ["Intro\n\n```go\ncode\n```", "## Add the mocks"];

    expect(reassembleSlices(originals, repaired)).toBe(
      "Intro\n\n```go\ncode\n```\n\n## Add the mocks\n",
    );
  });

  it("produces no fence glued to a heading", () => {
    const joined = reassembleSlices(
      ["```sh\nkubeadm join\n```\n", "### Options\n"],
      ["```sh\nkubeadm join\n```", "### Options"],
    );

    expect(joined).not.toMatch(/`{3,}#/);
  });

  it("leaves an answer that kept its own line breaks alone", () => {
    expect(reassembleSlices(["a\n\n", "b"], ["a\n\n", "b"])).toBe("a\n\nb");
  });

  it("keeps line breaks the repair added rather than trimming back", () => {
    expect(reassembleSlices(["a\n"], ["a\n\n\n"])).toBe("a\n\n\n");
  });

  it("handles slices that never ended in a line break", () => {
    expect(reassembleSlices(["a", "b"], ["a", "b"])).toBe("ab");
  });
});

describe("CleanupService.cleanVersion", () => {
  it("reports what it did and marks every page", async () => {
    const page = makePage();
    const store = makeStore(page);
    // One page, then nothing: the second query returns the same row, so the
    // service must stop on a short batch rather than loop.
    (store.getPagesNeedingCleanup as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      page,
    ]);
    const service = new CleanupService(store, makeConfig(), makeModel(CLEAN));

    const summary = await service.cleanVersion(7);

    expect(summary.pagesConsidered).toBe(1);
    expect(summary.pagesCleaned).toBe(1);
    expect(summary.pagesFailed).toBe(0);
  });

  it("marks pages with the same fingerprint a forced run selects by", async () => {
    // These drifted apart: the query asked for pages lacking `<fp>-forced`
    // while the page was marked `<fp>`, so no page ever left the result set.
    const store = makeStore(makePage());
    const service = new CleanupService(store, makeConfig(), makeModel(CLEAN));

    await service.cleanVersion(7, { force: true });

    const selectBy = (store.getPagesNeedingCleanup as ReturnType<typeof vi.fn>).mock
      .calls[0][1];
    const markWith = (store.markPageCleanup as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(selectBy).toMatch(/-forced$/);
    expect(markWith).toBe(selectBy);
  });

  it("stops instead of looping when a full batch comes back unchanged", async () => {
    // The backstop for the same class of bug. A full batch (PAGE_BATCH rows)
    // of already-processed pages means the query cannot see the mark, and the
    // short-batch check never fires; a forced run spun for four hours on this.
    const pages = Array.from({ length: 50 }, (_, i) => makePage({ id: i + 1 }));
    const store = makeStore(pages[0]);
    (store.getPagesNeedingCleanup as ReturnType<typeof vi.fn>).mockResolvedValue(pages);
    (store.countPagesNeedingCleanup as ReturnType<typeof vi.fn>).mockResolvedValue(50);
    const service = new CleanupService(store, makeConfig(), makeModel(CLEAN));

    const summary = await service.cleanVersion(7);

    expect(summary.pagesConsidered).toBe(50);
    expect(store.getPagesNeedingCleanup).toHaveBeenCalledTimes(2);
  });

  it("stops when cancelled", async () => {
    const page = makePage();
    const store = makeStore(page);
    const service = new CleanupService(store, makeConfig(), makeModel(CLEAN));
    const controller = new AbortController();
    controller.abort();

    const summary = await service.cleanVersion(7, { signal: controller.signal });

    expect(summary.pagesConsidered).toBe(0);
    expect(store.replacePageChunks).not.toHaveBeenCalled();
  });
});
