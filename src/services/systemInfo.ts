/**
 * Distilled, serializable snapshot of how the server process was started.
 *
 * `SystemInfo` is derived once from {@link AppServerConfig} (service
 * composition/runtime wiring) and {@link AppConfig} (resolved env/YAML/CLI
 * configuration) when the tRPC service is registered. It intentionally
 * contains no measured/live state — the goal is an honest reflection of the
 * running configuration, not a health probe. Live state (e.g. whether a
 * remote worker is currently connected) is threaded through the tRPC context
 * separately; see {@link ./appRouter}.
 */
import type { AppServerConfig } from "../app/AppServerConfig";
import { cleanupFingerprint, DEFAULT_CLEANUP_SYSTEM_PROMPT } from "../cleanup/prompt";
import type { AppConfig } from "../utils/config";

/** Which top-level services this process was started with. */
export interface SystemInfoServices {
  web: boolean;
  mcp: boolean;
  api: boolean;
  worker: boolean;
}

/**
 * How the pipeline worker is wired: embedded in this process, or delegated
 * to a remote worker reachable over HTTP/WebSocket.
 */
export type SystemInfoWorker =
  | { mode: "embedded"; maxConcurrency: number }
  | { mode: "remote"; url: string };

/** MCP protocol exposure, when enabled. */
export interface SystemInfoMcp {
  enabled: boolean;
  /** Relative endpoint paths the MCP server answers on (empty when disabled). */
  endpoints: string[];
}

/** OAuth2/OIDC authentication configuration. */
export interface SystemInfoAuth {
  enabled: boolean;
  /** The OIDC issuer URL, present only when auth is enabled and configured. */
  issuer?: string;
}

/** Scrape limits used when a job leaves these options unspecified. */
export interface SystemInfoScraper {
  maxPages: number;
  maxDepth: number;
}

/**
 * LLM Markdown cleanup, as the running process resolved it.
 *
 * The prompt is reported in full rather than as a flag, because it is the
 * setting that decides what the model may change: reading the dashboard is
 * otherwise no way to tell whether the built-in default or an override is in
 * force. No credential appears here — the API key is read from the environment
 * and never enters `AppConfig`.
 */
export interface SystemInfoCleanup {
  enabled: boolean;
  model: string;
  /** OpenAI-compatible endpoint the cleanup model is called on. */
  baseUrl: string;
  sliceChars: number;
  maxConcurrency: number;
  requestDelayMs: number;
  /** `dirty` repairs only pages carrying artefacts; `all` repairs every page. */
  filter: string;
  /** The prompt actually in force, default or overridden. */
  systemPrompt: string;
  /** False when `systemPrompt` is the built-in default. */
  promptOverridden: boolean;
  /**
   * Identifies model + prompt + slice size together. A page cleaned under a
   * different fingerprint is stale, which is how the library page counts what
   * still needs work without re-reading a single page.
   */
  fingerprint: string;
}

/** The maintenance window, and what it is allowed to queue inside it. */
export interface SystemInfoAutomation {
  enabled: boolean;
  windowStart: string;
  windowEnd: string;
  cleanupEnabled: boolean;
  refreshEnabled: boolean;
  refreshMinIntervalHours: number;
}

/**
 * Distilled, serializable snapshot of the server's startup configuration.
 * Safe to assemble a single time at service-registration and share across
 * every tRPC request (HTTP and WebSocket alike).
 */
export interface SystemInfo {
  version: string;
  readOnly: boolean;
  telemetryEnabled: boolean;
  services: SystemInfoServices;
  worker: SystemInfoWorker;
  mcp: SystemInfoMcp;
  auth: SystemInfoAuth;
  scraper: SystemInfoScraper;
  cleanup: SystemInfoCleanup;
  automation: SystemInfoAutomation;
}

/**
 * Assembles the {@link SystemInfo} snapshot from server + app configuration.
 * @param serverConfig - Service composition/runtime wiring for this process.
 * @param appConfig - Resolved application configuration (env/YAML/CLI merged).
 * @returns The distilled system info to thread through the tRPC context.
 */
export function buildSystemInfo(
  serverConfig: AppServerConfig,
  appConfig: AppConfig,
): SystemInfo {
  const mcpEnabled = Boolean(serverConfig.enableMcpServer);
  const authEnabled = Boolean(appConfig.auth.enabled);

  return {
    version: __APP_VERSION__,
    readOnly: Boolean(appConfig.app.readOnly),
    telemetryEnabled: Boolean(appConfig.app.telemetryEnabled),
    services: {
      web: Boolean(serverConfig.enableWebInterface),
      mcp: mcpEnabled,
      api: Boolean(serverConfig.enableApiServer),
      worker: Boolean(serverConfig.enableWorker),
    },
    worker: serverConfig.externalWorkerUrl
      ? { mode: "remote", url: serverConfig.externalWorkerUrl }
      : { mode: "embedded", maxConcurrency: appConfig.scraper.maxConcurrency },
    mcp: {
      enabled: mcpEnabled,
      endpoints: mcpEnabled ? ["/mcp", "/sse"] : [],
    },
    auth: {
      enabled: authEnabled,
      issuer:
        authEnabled && appConfig.auth.issuerUrl ? appConfig.auth.issuerUrl : undefined,
    },
    scraper: {
      maxPages: appConfig.scraper.maxPages,
      maxDepth: appConfig.scraper.maxDepth,
    },
    cleanup: {
      enabled: Boolean(appConfig.cleanup.enabled),
      model: appConfig.cleanup.model,
      baseUrl: appConfig.cleanup.baseUrl,
      sliceChars: appConfig.cleanup.sliceChars,
      maxConcurrency: appConfig.cleanup.maxConcurrency,
      requestDelayMs: appConfig.cleanup.requestDelayMs,
      filter: appConfig.cleanup.filter,
      // Resolved the same way the service resolves it, so the dashboard shows
      // the instruction actually in force rather than what is configured.
      systemPrompt: appConfig.cleanup.systemPrompt || DEFAULT_CLEANUP_SYSTEM_PROMPT,
      promptOverridden: Boolean(appConfig.cleanup.systemPrompt),
      fingerprint: cleanupFingerprint(
        appConfig.cleanup.model,
        appConfig.cleanup.systemPrompt || DEFAULT_CLEANUP_SYSTEM_PROMPT,
        appConfig.cleanup.sliceChars,
      ),
    },
    automation: {
      enabled: Boolean(appConfig.automation.enabled),
      windowStart: appConfig.automation.windowStart,
      windowEnd: appConfig.automation.windowEnd,
      cleanupEnabled: Boolean(appConfig.automation.cleanupEnabled),
      refreshEnabled: Boolean(appConfig.automation.refreshEnabled),
      refreshMinIntervalHours: appConfig.automation.refreshMinIntervalHours,
    },
  };
}
