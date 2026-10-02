import { trace, type Tracer } from "#compiled/@opentelemetry/api/index.js";
import { liveOtelBackend } from "#tracing/lib/adapters/otel.js";
import { eveOutputMapping } from "#tracing/eve/profile.js";
import { createTransportLifecycle } from "#tracing/lib/core/transports.js";
import { aiSdkContentSerializer } from "#tracing/lib/adapters/serialization.js";
import { createMcpTracing } from "#tracing/lib/adapters/mcp.js";

const lifecycles = new WeakMap<Tracer, ReturnType<typeof createTransportLifecycle>>();
const mcpAdapters = new WeakMap<Tracer, ReturnType<typeof createMcpTracing>>();

export function eveMcpTracing() {
  const tracer = trace.getTracer("eve.mcp");
  let adapter = mcpAdapters.get(tracer);
  if (adapter === undefined) {
    adapter = createMcpTracing(eveTransportLifecycle("eve.mcp"));
    mcpAdapters.set(tracer, adapter);
  }
  return adapter;
}

export function eveTransportLifecycle(scope: string) {
  const tracer = trace.getTracer(scope);
  let lifecycle = lifecycles.get(tracer);
  if (lifecycle === undefined) {
    lifecycle = createTransportLifecycle(
      liveOtelBackend(tracer, eveOutputMapping()),
      aiSdkContentSerializer,
    );
    lifecycles.set(tracer, lifecycle);
  }
  return lifecycle;
}
