import { trace, type Tracer } from "#compiled/@opentelemetry/api/index.js";
import { liveOtelBackend } from "#tracing/adapters/otel.js";
import { eveOutputMapping } from "#tracing/adapters/eve/compatibility.js";
import { createAgentTracing } from "#tracing/core/agent-tracing.js";
import { eveContentSerializer } from "#tracing/adapters/eve/serializer.js";
import { createMcpTracing } from "#tracing/adapters/mcp.js";

const lifecycles = new WeakMap<Tracer, ReturnType<typeof createAgentTracing>["lifecycle"]>();
const mcpAdapters = new WeakMap<Tracer, ReturnType<typeof createMcpTracing>>();

export function eveMcpTracing() {
  const tracer = trace.getTracer("eve.mcp");
  let adapter = mcpAdapters.get(tracer);
  if (adapter === undefined) {
    const tracing = createAgentTracing({
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
    lifecycle = createAgentTracing({
      adapter: {
        backend: liveOtelBackend(tracer, eveOutputMapping()),
        serializer: eveContentSerializer,
      },
    }).lifecycle;
    lifecycles.set(tracer, lifecycle);
  }
  return lifecycle;
}
