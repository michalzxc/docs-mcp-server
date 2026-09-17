import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../utils/config";
import {
  isWithinWindow,
  Scheduler,
  type SchedulerPipeline,
  type SchedulerStore,
} from "./Scheduler";

function at(hhmm: string): Date {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  const d = new Date(2026, 0, 1, h, m, 0, 0);
  return d;
}

function makeConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return {
    app: { readOnly: false },
    cleanup: { enabled: true },
    automation: {
      enabled: true,
      windowStart: "01:00",
      windowEnd: "05:00",
      tickIntervalMs: 60_000,
      cleanupEnabled: true,
      refreshEnabled: true,
      refreshMinIntervalHours: 168,
      ...overrides,
    },
  } as unknown as AppConfig;
}

function makePipeline(busy = 0): SchedulerPipeline {
  return {
    enqueueCleanupJob: vi.fn(async () => "cleanup-job"),
    enqueueRefreshJob: vi.fn(async () => "refresh-job"),
    busyCount: vi.fn(() => busy),
  };
}

function makeStore(
  cleanup: { library: string; version: string | null } | null,
  refresh: { library: string; version: string | null } | null = null,
): SchedulerStore {
  return {
    findVersionNeedingCleanup: vi.fn(async () => cleanup),
    findVersionNeedingRefresh: vi.fn(async () => refresh),
  };
}

describe("isWithinWindow", () => {
  it("matches inside a normal window", () => {
    expect(isWithinWindow(at("02:30"), "01:00", "05:00")).toBe(true);
  });

  it("excludes the end boundary and includes the start", () => {
    expect(isWithinWindow(at("01:00"), "01:00", "05:00")).toBe(true);
    expect(isWithinWindow(at("05:00"), "01:00", "05:00")).toBe(false);
  });

  it("rejects times outside the window", () => {
    expect(isWithinWindow(at("06:00"), "01:00", "05:00")).toBe(false);
    expect(isWithinWindow(at("00:59"), "01:00", "05:00")).toBe(false);
  });

  it("handles a window that wraps midnight", () => {
    expect(isWithinWindow(at("23:30"), "22:00", "02:00")).toBe(true);
    expect(isWithinWindow(at("01:30"), "22:00", "02:00")).toBe(true);
    expect(isWithinWindow(at("12:00"), "22:00", "02:00")).toBe(false);
  });

  it("treats a zero-length window as always open", () => {
    expect(isWithinWindow(at("13:00"), "03:00", "03:00")).toBe(true);
  });
});

describe("Scheduler.tick", () => {
  it("queues a cleanup job inside the window", async () => {
    const pipeline = makePipeline();
    const store = makeStore({ library: "cilium", version: null });
    const scheduler = new Scheduler(pipeline, store, makeConfig(), () => "fp");

    const jobId = await scheduler.tick(at("02:00"));

    expect(jobId).toBe("cleanup-job");
    expect(pipeline.enqueueCleanupJob).toHaveBeenCalledWith("cilium", null);
    expect(pipeline.enqueueRefreshJob).not.toHaveBeenCalled();
  });

  it("does nothing outside the window", async () => {
    const pipeline = makePipeline();
    const store = makeStore({ library: "cilium", version: null });
    const scheduler = new Scheduler(pipeline, store, makeConfig(), () => "fp");

    expect(await scheduler.tick(at("12:00"))).toBeNull();
    expect(pipeline.enqueueCleanupJob).not.toHaveBeenCalled();
  });

  it("never piles on while the pipeline is busy", async () => {
    const pipeline = makePipeline(1);
    const store = makeStore({ library: "cilium", version: null });
    const scheduler = new Scheduler(pipeline, store, makeConfig(), () => "fp");

    expect(await scheduler.tick(at("02:00"))).toBeNull();
    expect(pipeline.enqueueCleanupJob).not.toHaveBeenCalled();
  });

  it("falls through to refresh when nothing needs cleaning", async () => {
    const pipeline = makePipeline();
    const store = makeStore(null, { library: "pulumi", version: null });
    const scheduler = new Scheduler(pipeline, store, makeConfig(), () => "fp");

    const jobId = await scheduler.tick(at("02:00"));

    expect(jobId).toBe("refresh-job");
    expect(store.findVersionNeedingRefresh).toHaveBeenCalledWith(168);
  });

  it("prefers cleanup over refresh: it is cheaper and fetches nothing", async () => {
    const pipeline = makePipeline();
    const store = makeStore(
      { library: "cilium", version: null },
      { library: "pulumi", version: null },
    );
    const scheduler = new Scheduler(pipeline, store, makeConfig(), () => "fp");

    await scheduler.tick(at("02:00"));

    expect(pipeline.enqueueCleanupJob).toHaveBeenCalledOnce();
    expect(pipeline.enqueueRefreshJob).not.toHaveBeenCalled();
  });

  it("skips cleanup when the feature is off but still refreshes", async () => {
    const pipeline = makePipeline();
    const store = makeStore(
      { library: "cilium", version: null },
      { library: "pulumi", version: null },
    );
    const config = makeConfig();
    (config as unknown as { cleanup: { enabled: boolean } }).cleanup.enabled = false;
    const scheduler = new Scheduler(pipeline, store, config, () => "fp");

    const jobId = await scheduler.tick(at("02:00"));

    expect(jobId).toBe("refresh-job");
    expect(pipeline.enqueueCleanupJob).not.toHaveBeenCalled();
  });

  it("does nothing when automation is disabled", async () => {
    const pipeline = makePipeline();
    const store = makeStore({ library: "cilium", version: null });
    const scheduler = new Scheduler(
      pipeline,
      store,
      makeConfig({ enabled: false }),
      () => "fp",
    );

    expect(await scheduler.tick(at("02:00"))).toBeNull();
  });

  it("survives a failing store without throwing", async () => {
    const pipeline = makePipeline();
    const store: SchedulerStore = {
      findVersionNeedingCleanup: vi.fn(async () => {
        throw new Error("database is locked");
      }),
      findVersionNeedingRefresh: vi.fn(async () => null),
    };
    const scheduler = new Scheduler(pipeline, store, makeConfig(), () => "fp");

    await expect(scheduler.tick(at("02:00"))).resolves.toBeNull();
  });
});

describe("Scheduler.start", () => {
  it("does not start when the server is read-only", () => {
    const config = makeConfig();
    (config as unknown as { app: { readOnly: boolean } }).app.readOnly = true;
    const pipeline = makePipeline();
    const scheduler = new Scheduler(
      pipeline,
      makeStore({ library: "cilium", version: null }),
      config,
      () => "fp",
    );

    scheduler.start();
    scheduler.stop();

    expect(pipeline.enqueueCleanupJob).not.toHaveBeenCalled();
  });
});
