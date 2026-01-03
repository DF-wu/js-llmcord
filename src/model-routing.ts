import { createOpenAI } from "@ai-sdk/openai";
import { getConfig } from "./config-parser";
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGroq } from "@ai-sdk/groq";
import { createGateway } from "ai";
// Note: @ai-sdk/google is no longer imported
// Google provider is now created as OpenAI-compatible to support tool call patching
import {
  createOpenAICompatible,
  type OpenAICompatibleProvider,
} from "@ai-sdk/openai-compatible";
import type { Providers } from "./type";
import { createToolCallIndexPatchedFetch } from "./tool-call-index-patch";

export async function getProvidersFromConfig() {
  const config = await getConfig();
  // Note: "google" is intentionally NOT in this list so it can use the patch
  // Google provider needs the tool call index patch for Gemini compatibility
  const preConfigurable = [
    "openai",
    "x-ai",
    "anthropic",
    "openrouter",
    "groq",
    "ai-gateway",
  ];
  const openaiCompatibleProviders = Object.keys(config.providers).filter(
    (p) => !preConfigurable.includes(p),
  );
  const providers = {
    openai: config.providers.openai
      ? createOpenAI({
          baseURL: config.providers.openai.base_url,
          apiKey: config.providers.openai.api_key,
          headers: config.providers.openai.extra_headers,
        })
      : null,
    "x-ai": config.providers["x-ai"]
      ? createXai({
          baseURL: config.providers["x-ai"].base_url,
          apiKey: config.providers["x-ai"].api_key,
          headers: config.providers["x-ai"].extra_headers,
        })
      : null,
    anthropic: config.providers.anthropic
      ? createAnthropic({
          baseURL: config.providers.anthropic.base_url,
          apiKey: config.providers.anthropic.api_key,
          headers: config.providers.anthropic.extra_headers,
        })
      : null,
    openrouter: config.providers.openrouter
      ? createOpenRouter({
          baseURL: config.providers.openrouter.base_url,
          apiKey: config.providers.openrouter.api_key,
          headers: config.providers.openrouter.extra_headers,
          extraBody: config.providers.openrouter.extra_body,
        })
      : null,
    groq: config.providers.groq
      ? createGroq({
          baseURL: config.providers.groq.base_url,
          apiKey: config.providers.groq.api_key,
          headers: config.providers.groq.extra_headers,
        })
      : null,
    "ai-gateway": config.providers["ai-gateway"]
      ? createGateway({
          baseURL: config.providers["ai-gateway"].base_url,
          apiKey: config.providers["ai-gateway"].api_key,
        })
      : null,
    // Google is now handled as OpenAI-compatible provider below
    // This allows the tool call index patch to be applied when configured
    // We set it to null here to satisfy the Providers type constraint
    // It will be overridden by the spread below if configured
    google: null,
    ...Object.fromEntries(
      openaiCompatibleProviders.map((p) => {
        const providerConfig = config.providers[p]!;
        const needsToolPatch = Boolean(
          providerConfig.compatibility?.patch_tool_call_index,
        );
        const fetchImpl = needsToolPatch
          ? createToolCallIndexPatchedFetch(globalThis.fetch, {
              patchToolCallIndex: true,
              transformConstToEnum: true,
              handleThoughtSignature: true,
            })
          : undefined;

        return [
          p,
          createOpenAICompatible({
            name: p,
            baseURL: providerConfig.base_url,
            apiKey: providerConfig.api_key,
            headers: providerConfig.extra_headers,
            queryParams: providerConfig.extra_query,
            fetch: fetchImpl,
            includeUsage: Boolean(config.stats_for_nerds),
          }),
        ];
      }),
    ),
  } satisfies Record<Providers, unknown>;
  return providers as typeof providers &
    Record<string, OpenAICompatibleProvider>;
}

export function parseProviderModelString(providerModel: string) {
  providerModel = providerModel.replace(/:vision$/i, "");
  const firstSlash = providerModel.indexOf("/");
  const provider = providerModel.slice(0, firstSlash) as Providers;
  const model = providerModel.slice(firstSlash + 1);

  if (provider !== "ai-gateway") return { provider, model };
  const gatewayAdapter = model.slice(0, model.indexOf("/"));
  return { provider, model, gatewayAdapter };
}
