import type { ContentSerializer } from "#tracing/core/model.js";

export function boundedSerializer(
  serializer: ContentSerializer,
  diagnostic?: (code: string) => void,
): ContentSerializer {
  function invoke(method: keyof ContentSerializer, args: unknown[]): string | undefined {
    try {
      const value = Reflect.apply(serializer[method], serializer, args) as string | undefined;
      return value === undefined || new TextEncoder().encode(value).length > 32768
        ? undefined
        : value;
    } catch {
      try {
        diagnostic?.("agent.tracing.serialization.failed");
      } catch {}
      return undefined;
    }
  }
  return {
    json: (value) => invoke("json", [value]),
    text: (value) => invoke("text", [value]),
    inputMessages: (value) => invoke("inputMessages", [value]),
    instructions: (value) => invoke("instructions", [value]),
    outputMessages: (value, reason) => invoke("outputMessages", [value, reason]),
    toolResults: (value) => invoke("toolResults", [value]),
  };
}
