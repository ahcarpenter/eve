import type { ContentSerializer } from "#tracing/lib/core/model.js";

function json(value: unknown): string | undefined {
  try {
    const result = JSON.stringify(value);
    return result !== undefined && new TextEncoder().encode(result).length <= 32768
      ? result
      : undefined;
  } catch {
    return undefined;
  }
}

export const defaultContentSerializer: ContentSerializer = {
  json,
  text: (value) => (new TextEncoder().encode(value).length <= 32768 ? value : undefined),
  inputMessages: json,
  instructions: json,
  outputMessages: (value) => json(value),
  toolResults: json,
};
