/**
 * Cleanup command - Repairs the Markdown of an indexed version with an LLM.
 */

import type { Argv } from "yargs";
import { EventType } from "../../events";
import { PipelineFactory, PipelineJobStatus, type PipelineOptions } from "../../pipeline";
import type { IPipeline } from "../../pipeline/trpc/interfaces";
import { createDocumentManagement, type DocumentManagementService } from "../../store";
import type { IDocumentManagement } from "../../store/trpc/interfaces";
import { TelemetryEvent, telemetry } from "../../telemetry";
import { CleanupTool } from "../../tools/CleanupTool";
import { loadConfig } from "../../utils/config";
import { logger } from "../../utils/logger";
import { renderTextOutput } from "../output";
import { type CliContext, getEventBus } from "../utils";

export function createCleanupCommand(cli: Argv) {
  cli.command(
    "cleanup <library>",
    "Repair the markdown of an indexed library version using an LLM",
    (yargs) => {
      return yargs
        .version(false)
        .positional("library", {
          type: "string",
          description: "Library name to clean up",
          demandOption: true,
        })
        .option("version", {
          type: "string",
          description: "Version of the library (optional)",
          alias: "v",
        })
        .option("full", {
          type: "boolean",
          description: "Clean every page, not only those carrying conversion artefacts",
          default: false,
        })
        .option("force", {
          type: "boolean",
          description: "Re-clean pages already cleaned with the current prompt and model",
          default: false,
        })
        .option("server-url", {
          type: "string",
          description:
            "URL of external pipeline worker RPC (e.g., http://localhost:8080/api)",
          alias: "serverUrl",
        })
        .usage(
          "$0 cleanup <library> [options]\n\n" +
            "Repairs conversion artefacts in already-indexed pages: leftover HTML,\n" +
            "needless backslash escapes and unbalanced code fences. Works from each\n" +
            "page's stored markdown, so the documentation site is never fetched.\n\n" +
            "Requires cleanup to be configured (model and endpoint). Pages whose\n" +
            "repair fails validation keep their original text.\n\n" +
            "Examples:\n" +
            "  cleanup cilium\n" +
            "  cleanup react --version 18.0.0 --full",
        );
    },
    async (argv) => {
      await telemetry.track(TelemetryEvent.CLI_COMMAND, {
        command: "cleanup",
        library: argv.library,
        version: argv.version,
        full: argv.full,
        useServerUrl: !!argv.serverUrl,
      });

      const library = argv.library as string;
      const version = argv.version as string | undefined;
      const serverUrl = argv.serverUrl as string | undefined;

      const appConfig = loadConfig(argv, {
        configPath: argv.config as string,
        searchDir: argv.storePath as string,
      });

      if (!appConfig.cleanup.enabled) {
        // Fail early rather than queue a job that cannot run: the message is
        // the only place a user learns which settings are missing.
        renderTextOutput(
          "Cleanup is disabled. Set DOCS_MCP_CLEANUP_ENABLED=true, " +
            "DOCS_MCP_CLEANUP_MODEL and an API key before running this command.",
        );
        return;
      }

      const eventBus = getEventBus(argv as CliContext);

      const docService: IDocumentManagement = await createDocumentManagement({
        serverUrl,
        eventBus,
        appConfig: appConfig,
      });
      let pipeline: IPipeline | null = null;

      logger.info("⏳ Initializing cleanup job...");

      let unsubscribeProgress: (() => void) | null = null;
      let unsubscribeStatus: (() => void) | null = null;

      if (!serverUrl) {
        unsubscribeProgress = eventBus.on(EventType.JOB_PROGRESS, (event) => {
          const { job, progress } = event;
          logger.info(
            `🧹 Cleaning ${job.library}${job.version ? ` v${job.version}` : ""}: ${progress.pagesScraped}/${progress.totalPages} pages`,
          );
        });

        unsubscribeStatus = eventBus.on(EventType.JOB_STATUS_CHANGE, (event) => {
          if (event.status === PipelineJobStatus.RUNNING) {
            logger.info(
              `🚀 Cleaning ${event.library}${event.version ? ` v${event.version}` : ""}...`,
            );
          }
        });
      }

      try {
        const pipelineOptions: PipelineOptions = {
          recoverJobs: false,
          serverUrl,
          appConfig: appConfig,
        };

        pipeline = serverUrl
          ? await PipelineFactory.createPipeline(undefined, eventBus, {
              serverUrl,
              ...pipelineOptions,
            })
          : await PipelineFactory.createPipeline(
              docService as DocumentManagementService,
              eventBus,
              pipelineOptions,
            );

        await pipeline.start();
        const cleanupTool = new CleanupTool(pipeline);

        const result = await cleanupTool.execute({
          library,
          version,
          full: argv.full as boolean | undefined,
          force: argv.force as boolean | undefined,
          waitForCompletion: true,
        });

        if ("pagesCleaned" in result) {
          renderTextOutput(`Cleanup finished for ${result.pagesCleaned} pages`);
        } else {
          renderTextOutput(`Cleanup job started with ID: ${result.jobId}`);
        }
      } finally {
        unsubscribeProgress?.();
        unsubscribeStatus?.();
        await pipeline?.stop();
        await docService.shutdown();
      }
    },
  );
}
