import { ChatOpenAI } from "@langchain/openai";
import { MissingCredentialsError } from "../store/errors";
import type { AppConfig } from "../utils/config";

/**
 * Builds the chat model used by the documentation cleanup pass.
 *
 * Mirrors the embeddings factory: the model string may carry a provider prefix,
 * credentials come from the environment rather than the config file, and an
 * OpenAI-compatible base URL is passed through `configuration.baseURL` so
 * self-hosted gateways work without a provider of their own.
 */

/** Credentials are read from the environment, never from the config schema. */
function resolveApiKey(): string | undefined {
  return process.env.DOCS_MCP_LLM_API_KEY || process.env.OPENAI_API_KEY || undefined;
}

/**
 * Splits `provider:model` on the first colon only, so model names containing
 * colons survive. A bare name is treated as OpenAI-compatible.
 */
export function parseCleanupModel(spec: string): { provider: string; model: string } {
  const separator = spec.indexOf(":");
  if (separator < 1) {
    return { provider: "openai", model: spec };
  }
  return {
    provider: spec.slice(0, separator),
    model: spec.slice(separator + 1),
  };
}

export function createCleanupChatModel(config: AppConfig): ChatOpenAI {
  const { provider, model } = parseCleanupModel(config.cleanup.model);
  if (!model) {
    throw new Error("cleanup.model is not set; cleanup cannot run without a model name");
  }
  if (provider !== "openai") {
    throw new Error(
      `Unsupported cleanup provider '${provider}'. ` +
        "Only OpenAI-compatible endpoints are supported.",
    );
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    // Same error the embeddings factory raises, so a missing key reads the same
    // way wherever it happens.
    throw new MissingCredentialsError("cleanup", [
      "DOCS_MCP_LLM_API_KEY or OPENAI_API_KEY",
    ]);
  }

  const baseURL = config.cleanup.baseUrl || process.env.OPENAI_API_BASE || undefined;
  const timeout = config.cleanup.requestTimeoutMs;

  return new ChatOpenAI({
    model,
    apiKey,
    // Pinned: the task is a near-copy transcription, and any sampling turns
    // "repair this markup" into "rewrite this prose".
    temperature: 0,
    // Retries belong to the caller, not the SDK. LangChain's own backoff would
    // issue extra requests from inside a limiter slot, quietly multiplying the
    // concurrency the endpoint actually sees.
    maxRetries: 0,
    timeout,
    ...(baseURL ? { configuration: { baseURL, timeout } } : {}),
  });
}
