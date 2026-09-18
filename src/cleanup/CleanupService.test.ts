import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CleanupPage } from "../store/types";
import { PageCleanupStatus } from "../store/types";
import type { AppConfig } from "../utils/config";
import {
  CleanupService,
  type CleanupStore,
  changedRegion,
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
