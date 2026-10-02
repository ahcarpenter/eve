import type { Usage } from "#tracing/lib/core/types.js";

export function accumulateUsage(total: Usage | undefined, usage: Usage): Usage {
  return {
    inputTokens:
      usage.inputTokens === undefined
        ? total?.inputTokens
        : (total?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens:
      usage.outputTokens === undefined
        ? total?.outputTokens
        : (total?.outputTokens ?? 0) + usage.outputTokens,
  };
}
