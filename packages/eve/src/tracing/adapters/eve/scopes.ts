import { createTracingRuntime } from "#tracing/core/agent-tracing.js";
import { durableOtelBackend } from "#tracing/adapters/otel.js";
import { eveOutputMapping } from "#tracing/adapters/eve/compatibility.js";
import { eveContentSerializer } from "#tracing/adapters/eve/serializer.js";
import type { AgentSpanIdGenerator } from "#tracing/adapters/otel-ids.js";
import type { Tracer } from "#compiled/@opentelemetry/api/index.js";
import type { AgentSamplingOperation } from "#tracing/agent-span-contract.js";

export function createEveTraceLifecycle(input: {
  readonly tracer: Tracer;
  readonly idGenerator: AgentSpanIdGenerator;
  readonly samplesTrace?: (traceId: string, operation?: AgentSamplingOperation) => boolean;
}) {
  return createTracingRuntime({
    adapter: {
      serializer: eveContentSerializer,
      backend: durableOtelBackend({
        ...input,
        samplesTrace: (traceId, operation) =>
          input.samplesTrace?.(traceId, operation as AgentSamplingOperation) ?? true,
        mapping: eveOutputMapping(),
      }),
    },
  }).lifecycle;
}
