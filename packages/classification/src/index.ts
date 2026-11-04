/**
 * Classification provider factory.
 *
 * Which provider runs is a settings decision, not a code decision. The default
 * is `heuristic`: free, offline, deterministic, and good enough to save a
 * reviewer keystrokes. `anthropic` is opt-in and needs a key. `none` disables
 * suggestions entirely, which is a legitimate choice — the pipeline works
 * without them, because humans are the source of truth either way (§27).
 */
import type { Logger } from "@uxd/shared";
import { createHeuristicProvider } from "./heuristic.js";
import type { ClassificationProvider } from "./types.js";
import { emptyResult } from "./types.js";

export * from "./heuristic.js";
export * from "./types.js";

export type ClassificationProviderName = "none" | "heuristic" | "anthropic";

export interface CreateProviderOptions {
  readonly provider: ClassificationProviderName;
  readonly apiKey?: string | undefined;
  readonly model?: string | undefined;
  readonly logger?: Logger;
}

/** A provider that returns nothing, for `CLASSIFICATION_PROVIDER=none`. */
export function createNullProvider(): ClassificationProvider {
  return {
    name: "none",
    usesModel: false,
    async classify() {
      return emptyResult("none");
    },
  };
}

/**
 * Build the configured provider.
 *
 * The Anthropic provider is imported dynamically so that `@anthropic-ai/sdk`
 * — an optional dependency — is only loaded when it is actually configured. A
 * deployment running heuristic-only does not need the package installed.
 */
export async function createClassificationProvider(
  options: CreateProviderOptions,
): Promise<ClassificationProvider> {
  switch (options.provider) {
    case "none":
      return createNullProvider();

    case "anthropic": {
      if (!options.apiKey) {
        options.logger?.warn(
          "CLASSIFICATION_PROVIDER=anthropic but no API key was supplied; falling back to heuristic.",
        );
        return createHeuristicProvider();
      }
      try {
        const { createAnthropicProvider } = await import("./anthropic.js");
        return createAnthropicProvider({
          apiKey: options.apiKey,
          model: options.model,
          logger: options.logger,
        });
      } catch (error) {
        options.logger?.error(
          "Could not load the Anthropic classification provider; falling back to heuristic.",
          { error },
        );
        return createHeuristicProvider();
      }
    }

    case "heuristic":
    default:
      return createHeuristicProvider();
  }
}
