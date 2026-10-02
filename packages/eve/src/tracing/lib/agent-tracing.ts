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
import { aroundOperation } from "#tracing/lib/core/pointcut.js";
import type { TurnOperation } from "#tracing/lib/core/operations.js";
import { createTransportLifecycle } from "#tracing/lib/core/transports.js";

type TurnInput =
  | {
      identity: import("#tracing/lib/core/types.js").RunIdentity;
      sequence: number;
      framework?: import("#tracing/lib/core/types.js").FrameworkIdentity;
      capture?: import("#tracing/lib/core/types.js").CaptureDecision;
    }
  | (import("#tracing/lib/core/recorder.js").RuntimeOperationInput & {
      metadata: import("#tracing/lib/core/scope-lifecycle.js").TurnMetadata;
    });

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
  const output = durableOtelBackend({
    tracer: trace.getTracer("agent.tracing"),
    idGenerator: runtime.idGenerator,
    samplesTrace: runtime.samplesTrace,
    mapping: input.mapping,
  });
  const recorder = createTraceRecorder({
    output,
    serializer: aiSdkContentSerializer,
    mode: "live",
    diagnostic: input.diagnostic,
  });
  const transports = createTransportLifecycle(output, aiSdkContentSerializer);
  const begin = (turn: TurnInput) => {
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
  };
  function turn(data: TurnInput): Promise<TurnOperation>;
  function turn<T>(
    data: TurnInput & { describe?: (value: T) => Parameters<TurnOperation["complete"]>[0] },
    execute: (turn: TurnOperation) => T | PromiseLike<T>,
  ): Promise<T>;
  function turn<T>(
    data: TurnInput & { describe?: (value: T) => Parameters<TurnOperation["complete"]>[0] },
    execute?: (turn: TurnOperation) => T | PromiseLike<T>,
  ): Promise<T> | Promise<TurnOperation> {
    if (execute === undefined) return begin(data);
    let handle: TurnOperation;
    return aroundOperation({
      start: async () => {
        handle = await begin(data);
        return handle;
      },
      execute: () => execute(handle),
      completed: (value) => data.describe?.(value) ?? { outcome: "completed" },
      failed: (error) => ({
        outcome: "failed",
        errorType: error instanceof Error ? error.name : "_OTHER",
        error,
      }),
      fallback: { outcome: "completed" },
      diagnostic: input.diagnostic,
    });
  }
  return {
    ...recorder,
    ...runtime,
    turn,
    request<T extends { status: number }>(
      data: Parameters<typeof transports.request>[0] & {
        channelName?: string;
        channelKind?: string;
      },
      execute: () => T | PromiseLike<T>,
    ) {
      return aroundOperation<T, { outcome: "completed"; status: number } | { outcome: "failed" }>({
        start: () => {
          const operation = transports.request(data);
          operation.channel(data);
          return {
            run: operation.run,
            complete: async (result) => {
              if (result.outcome === "failed") operation.failed();
              else operation.completed(result.status);
            },
          };
        },
        execute,
        completed: (result) => ({ outcome: "completed", status: result.status }),
        failed: () => ({ outcome: "failed" }),
        fallback: { outcome: "failed" },
        diagnostic: input.diagnostic,
      });
    },
    mcp: {
      list<T>(
        data: { connectionName: string; protocolVersion?: string },
        execute: () => T | PromiseLike<T>,
      ) {
        return mcp("tools/list", data, execute);
      },
      call<T>(
        data: { connectionName: string; toolName: string; protocolVersion?: string },
        execute: () => T | PromiseLike<T>,
      ) {
        return mcp("tools/call", data, execute);
      },
    },
  };
  function mcp<T>(
    method: "tools/list" | "tools/call",
    data: { connectionName: string; toolName?: string; protocolVersion?: string },
    execute: () => T | PromiseLike<T>,
  ) {
    return aroundOperation<
      T,
      { outcome: "completed"; value?: T } | { outcome: "failed"; error?: unknown }
    >({
      start: () => {
        const active = recorder.active();
        if (method === "tools/call" && active?.type === "tool" && active.mcp !== undefined) {
          active.mcp.update({ ...data, method });
          return {
            run: (callback) => recorder.run(active.reference, active.capture, callback),
            complete: async (result) => {
              if (result.outcome === "failed") active.mcp?.error(result.error);
              else active.mcp?.result(result.value);
            },
          };
        }
        const operation = transports.mcp({
          ...data,
          method,
          capture: active?.capture ?? { emit: true, recordInputs: false, recordOutputs: false },
        });
        return {
          run: operation.run,
          complete: async (result) => {
            if (result.outcome === "failed") operation.failed(result.error);
            else operation.completed(result.value);
          },
        };
      },
      execute,
      completed: (value) => ({ outcome: "completed", value }),
      failed: (error) => ({ outcome: "failed", error }),
      fallback: { outcome: "completed" },
      diagnostic: input.diagnostic,
    });
  }
}

export type AgentTracing = ReturnType<typeof createAgentTracing>;
