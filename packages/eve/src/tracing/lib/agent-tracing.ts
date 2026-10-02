import { trace } from "#compiled/@opentelemetry/api/index.js";
import { randomUUID } from "node:crypto";
import {
  registerOtelPipeline,
  type RegisteredOtelPipeline,
} from "#tracing/lib/adapters/otel-registration.js";
import type { OtelConfiguration } from "#tracing/lib/adapters/otel-configuration.js";
import { vercelRuntimeSpanProcessor } from "#tracing/lib/adapters/vercel-runtime-span-exporter.js";
import { durableOtelBackend } from "#tracing/lib/adapters/otel.js";
import { aiSdkContentSerializer } from "#tracing/lib/adapters/serialization.js";
import { createTraceRecorder } from "#tracing/lib/core/recorder.js";
import type { OutputMapping } from "#tracing/lib/core/types.js";

let installed:
  | { agentName: string; configuration?: OtelConfiguration; runtime: RegisteredOtelPipeline }
  | undefined;

/** Initialize once at application startup, before requests or instrumented work. */
export function createAgentTracing(input: {
  agentName: string;
  otel?: OtelConfiguration;
  mapping?: OutputMapping;
  diagnostic?: (code: string) => void;
}) {
  if (
    installed !== undefined &&
    (installed.agentName !== input.agentName || installed.configuration !== input.otel)
  )
    throw new Error(
      "Agent tracing already owns OpenTelemetry. Use the same agent name and configuration for all instances in this process.",
    );
  if (installed === undefined) {
    const otel = input.otel ?? {
      spanProcessors:
        process.env.VERCEL_ENV === undefined
          ? ["auto" as const]
          : [vercelRuntimeSpanProcessor(input.diagnostic)],
    };
    const registered = registerOtelPipeline({ serviceName: input.agentName, otel });
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
    installed = { agentName: input.agentName, configuration: input.otel, runtime };
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
  return {
    ...recorder,
    ...runtime,
    turn(
      turn:
        | {
            identity: import("#tracing/lib/core/types.js").RunIdentity;
            sequence: number;
            framework?: import("#tracing/lib/core/types.js").FrameworkIdentity;
            capture?: import("#tracing/lib/core/types.js").CaptureDecision;
          }
        | (import("#tracing/lib/core/recorder.js").RuntimeOperationInput & {
            metadata: import("#tracing/lib/core/scope-lifecycle.js").TurnMetadata;
          }),
    ) {
      if ("binding" in turn) return recorder.turn(turn);
      return recorder.beginTurn({
        identity: {
          ...turn.identity,
          agentName: input.agentName,
          framework: turn.framework ?? { name: "custom", version: "" },
        },
        metadata: { sequence: turn.sequence },
        capture: turn.capture ?? { emit: true, recordInputs: false, recordOutputs: false },
        key: randomUUID(),
      });
    },
  };
}

export type AgentTracing = ReturnType<typeof createAgentTracing>;
