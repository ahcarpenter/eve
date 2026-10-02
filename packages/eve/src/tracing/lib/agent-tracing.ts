import { trace } from "#compiled/@opentelemetry/api/index.js";
import {
  registerOtelPipeline,
  type RegisteredOtelPipeline,
} from "#tracing/lib/adapters/otel-registration.js";
import type { OtelConfiguration } from "#tracing/lib/adapters/otel-configuration.js";
import { vercelRuntimeSpanProcessor } from "#tracing/lib/adapters/vercel-runtime-span-exporter.js";
import { durableOtelBackend } from "#tracing/lib/adapters/otel.js";
import { aiSdkContentSerializer } from "#tracing/lib/adapters/serializer.js";
import { createTraceRecorder } from "#tracing/lib/core/recorder.js";
import type { OutputMapping } from "#tracing/lib/core/types.js";

let installed:
  | { serviceName: string; configuration?: OtelConfiguration; runtime: RegisteredOtelPipeline }
  | undefined;

/** Initialize once at application startup, before requests or instrumented work. */
export function createAgentTracing(input: {
  serviceName: string;
  otel?: OtelConfiguration;
  mapping?: OutputMapping;
  diagnostic?: (code: string) => void;
}) {
  if (
    installed !== undefined &&
    (installed.serviceName !== input.serviceName || installed.configuration !== input.otel)
  )
    throw new Error(
      "Agent tracing already owns OpenTelemetry. Use the same service name and configuration for all agents in this process.",
    );
  if (installed === undefined) {
    const otel = input.otel ?? {
      spanProcessors:
        process.env.VERCEL_ENV === undefined
          ? ["auto" as const]
          : [vercelRuntimeSpanProcessor(input.diagnostic)],
    };
    const registered = registerOtelPipeline({ serviceName: input.serviceName, otel });
    let shutdown: Promise<void> | undefined;
    const runtime = {
      ...registered,
      shutdown() {
        shutdown ??= registered.shutdown().finally(() => {
          if (installed?.runtime === runtime) installed = undefined;
        });
        return shutdown;
      },
    };
    installed = { serviceName: input.serviceName, configuration: input.otel, runtime };
  }
  const runtime = installed.runtime;
  const recorder = createTraceRecorder({
    output: durableOtelBackend({
      tracer: trace.getTracer("agent.tracing"),
      idGenerator: runtime.idGenerator,
      samplesTrace: runtime.samplesTrace,
      mapping: input.mapping,
    }),
    serializer: aiSdkContentSerializer,
    mode: "live",
    diagnostic: input.diagnostic,
  });
  return { ...recorder, ...runtime };
}

export type AgentTracing = ReturnType<typeof createAgentTracing>;
