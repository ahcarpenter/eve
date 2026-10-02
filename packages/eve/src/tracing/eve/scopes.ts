import { createTraceRecorder } from "#tracing/lib/core/recorder.js";
import { durableOtelBackend } from "#tracing/lib/adapters/otel.js";
import { eveOutputMapping } from "#tracing/eve/profile.js";
import { eveContentSerializer } from "#tracing/eve/serializer.js";
import type { AgentSpanIdGenerator } from "#tracing/lib/adapters/otel-ids.js";
import type { Tracer } from "#compiled/@opentelemetry/api/index.js";
import type { AgentSamplingOperation } from "#tracing/agent-span-contract.js";

export function createEveTraceLifecycle(input: {
  readonly tracer: Tracer;
  readonly idGenerator: AgentSpanIdGenerator;
  readonly samplesTrace?: (traceId: string, operation?: AgentSamplingOperation) => boolean;
}) {
  return createTraceRecorder({
    mode: "live",
    serializer: eveContentSerializer,
    output: durableOtelBackend({
      ...input,
      samplesTrace: (traceId, operation) =>
        input.samplesTrace?.(traceId, operation as AgentSamplingOperation) ?? true,
      mapping: eveOutputMapping(),
    }),
  });
}
