/** Unit test for cleanup command */

import { beforeEach, describe, expect, it, vi } from "vitest";
import yargs from "yargs";
import { CleanupTool } from "../../tools/CleanupTool";
import { createCleanupCommand } from "./cleanup";

const pipelineMock = {
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
};

const shutdownMock = vi.fn(async () => {});

vi.mock("../../store", () => ({
  createDocumentManagement: vi.fn(async () => ({ shutdown: shutdownMock })),
}));
vi.mock("../../tools/CleanupTool", () => ({
  CleanupTool: vi.fn().mockImplementation(function () {
    return { execute: vi.fn(async () => ({ pagesCleaned: 7 })) };
  }),
}));
vi.mock("../../pipeline", () => ({
  PipelineFactory: {
    createPipeline: vi.fn(async () => pipelineMock),
  },
  PipelineJobStatus: { RUNNING: "running" },
}));
vi.mock("../../events", () => ({
  EventType: {
    JOB_STATUS_CHANGE: "JOB_STATUS_CHANGE",
    JOB_PROGRESS: "JOB_PROGRESS",
    LIBRARY_CHANGE: "LIBRARY_CHANGE",
  },
}));
vi.mock("../utils", () => ({
  getEventBus: vi.fn(() => ({ on: vi.fn(() => vi.fn()), emit: vi.fn() })),
  CliContext: {},
}));
vi.mock("../../telemetry", () => ({
  telemetry: { track: vi.fn(async () => {}) },
  TelemetryEvent: { CLI_COMMAND: "cli_command" },
}));

const renderTextOutput = vi.fn();
vi.mock("../output", () => ({
  renderTextOutput: (...args: unknown[]) => renderTextOutput(...args),
}));

let cleanupEnabled = true;
vi.mock("../../utils/config", () => ({
  loadConfig: vi.fn(() => ({ cleanup: { enabled: cleanupEnabled } })),
}));

async function run(args: string) {
  const cli = yargs([]).exitProcess(false);
  createCleanupCommand(cli);
  await cli.parseAsync(args);
}

describe("cleanup command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupEnabled = true;
  });

  it("cleans a library and reports the page count", async () => {
    await run("cleanup cilium");

    expect(CleanupTool).toHaveBeenCalledWith(pipelineMock);
    expect(renderTextOutput).toHaveBeenCalledWith("Cleanup finished for 7 pages");
  });

  it("stops the pipeline and the store when it finishes", async () => {
    await run("cleanup cilium");

    expect(pipelineMock.stop).toHaveBeenCalledOnce();
    expect(shutdownMock).toHaveBeenCalledOnce();
  });

  it("refuses to run when cleanup is not configured", async () => {
    // Queuing a job that cannot run would report success and clean nothing;
    // the message is the only place the missing settings are named.
    cleanupEnabled = false;

    await run("cleanup cilium");

    expect(CleanupTool).not.toHaveBeenCalled();
    expect(renderTextOutput).toHaveBeenCalledWith(
      expect.stringContaining("Cleanup is disabled"),
    );
  });
});
