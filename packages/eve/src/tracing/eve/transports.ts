import { trace, type Tracer } from "#compiled/@opentelemetry/api/index.js";
import { liveOtelBackend } from "#tracing/lib/adapters/otel.js";
import { eveOutputMapping } from "#tracing/eve/profile.js";
import { createTracingRuntime } from "#tracing/lib/core/agent-tracing.js";
import { eveContentSerializer } from "#tracing/eve/serializer.js";
import { createMcpTracing } from "#tracing/lib/adapters/mcp.js";

const lifecycles = new WeakMap<Tracer, ReturnType<typeof createTracingRuntime>["lifecycle"]>();
const mcpAdapters = new WeakMap<Tracer, ReturnType<typeof createMcpTracing>>();

export function eveMcpTracing() {
  const tracer = trace.getTracer("eve.mcp");
  let adapter = mcpAdapters.get(tracer);
  if (adapter === undefined) {
    const tracing = createTracingRuntime({
      adapter: {
        backend: liveOtelBackend(tracer, eveOutputMapping()),
        serializer: eveContentSerializer,
        mcp: createMcpTracing,
      },
    });
    adapter = tracing.mcpAdapter!;
    mcpAdapters.set(tracer, adapter);
  }
  return adapter;
}

export function eveTransportLifecycle(scope: string) {
  const tracer = trace.getTracer(scope);
  let lifecycle = lifecycles.get(tracer);
  if (lifecycle === undefined) {
    lifecycle = createTracingRuntime({
      adapter: {
        backend: liveOtelBackend(tracer, eveOutputMapping()),
        serializer: eveContentSerializer,
      },
    }).lifecycle;
    lifecycles.set(tracer, lifecycle);
  }
  return lifecycle;
}
