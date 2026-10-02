import { createTraceLifecycle, type TurnScope, type TurnMetadata } from "#tracing/core/scopes.js";
import type { ContentSerializer } from "#tracing/core/model.js";
import type {
  FrameworkIdentity,
  RunIdentity,
  TraceBackend,
  TraceLink,
  TraceReference,
} from "#tracing/core/types.js";
import { createTransportLifecycle } from "#tracing/core/transports.js";
import { disabledTurn } from "#tracing/core/disabled.js";
import { defaultContentSerializer } from "#tracing/core/default-serializer.js";

export interface TracingAdapter<TMcp = unknown> {
  readonly backend: TraceBackend;
  readonly serializer: ContentSerializer;
  readonly mcp?: (
    lifecycle: ReturnType<typeof createTraceLifecycle> &
      ReturnType<typeof createTransportLifecycle>,
  ) => TMcp;
}

export interface TurnInput extends RunIdentity {
  readonly sequence: number;
  readonly caller?: TraceReference;
  readonly request?: TraceReference;
  readonly signal?: AbortSignal;
  readonly activation?: TurnMetadata;
}
export type ActivationMetadata = TurnMetadata;
export type { TurnScope } from "#tracing/core/scopes.js";

export function createTracingRuntime<TMcp = unknown>(input: {
  readonly agentName?: string;
  readonly framework?: FrameworkIdentity;
  readonly adapter: TracingAdapter<TMcp>;
  readonly mode?: "live" | "durable";
  readonly content?: { readonly recordInputs: boolean; readonly recordOutputs: boolean };
  readonly diagnostic?: (code: string) => void;
}) {
  const runtime = createTraceLifecycle({
    ...input,
    ...input.adapter,
  });
  const transports = createTransportLifecycle(input.adapter.backend, input.adapter.serializer);
  const lifecycle = { ...runtime, ...transports };
  return {
    lifecycle,
    mcpAdapter: input.adapter.mcp?.(lifecycle),
    async request<T extends { status: number }>(
      options: Parameters<typeof transports.request>[0] & {
        channelName?: string;
        channelKind?: string;
      },
      execute: () => Promise<T>,
    ): Promise<T> {
      const operation = transports.request(options);
      operation.channel(options);
      try {
        const response = await operation.run(execute);
        operation.completed(response.status);
        return response;
      } catch (error) {
        operation.failed();
        throw error;
      }
    },
    async mcp<T>(
      options: Parameters<typeof transports.mcp>[0],
      execute: () => Promise<T>,
    ): Promise<T> {
      const operation = transports.mcp(options);
      try {
        const value = await operation.run(execute);
        operation.completed(value);
        return value;
      } catch (error) {
        operation.failed(error);
        throw error;
      }
    },
    async turn<T>(turn: TurnInput, execute: (scope: TurnScope) => Promise<T>): Promise<T> {
      const links: TraceLink[] = [];
      if (turn.sequence === 0 && turn.caller !== undefined)
        links.push({ context: turn.caller, relationship: "agent.dispatch" });
      if (turn.request !== undefined)
        links.push({ context: turn.request, relationship: "channel.request" });
      let scope;
      try {
        scope = await runtime.turn(
          {
            ...turn,
            agentName: input.agentName,
            framework: input.framework ?? { name: "custom", version: "" },
          },
          {
            ...turn.activation,
            sequence: turn.sequence,
            subagent: turn.caller !== undefined,
          },
          {
            emit: turn.caller === undefined || (turn.caller.traceFlags & 1) !== 0,
            recordInputs: input.content?.recordInputs ?? false,
            recordOutputs: input.content?.recordOutputs ?? false,
          },
          { key: JSON.stringify([turn.runId, turn.turnId]), links },
        );
      } catch {
        return input.adapter.backend.suppressed === undefined
          ? execute(disabledTurn())
          : input.adapter.backend.suppressed(() => execute(disabledTurn()));
      }
      try {
        await scope.started();
        const result = await scope.run(() => execute(scope.authoring as TurnScope));
        try {
          await scope.completed({ outcome: turn.signal?.aborted ? "cancelled" : "completed" });
        } catch {}
        return result;
      } catch (error) {
        try {
          await scope.finish({
            outcome: turn.signal?.aborted ? "cancelled" : "failed",
            failed: !turn.signal?.aborted,
            error,
          });
        } catch {}
        throw error;
      }
    },
  };
}

export function createAgentTracing(input: {
  readonly agentName?: string;
  readonly framework?: FrameworkIdentity;
  readonly output: TraceBackend;
  readonly content?: { readonly recordInputs: boolean; readonly recordOutputs: boolean };
  readonly diagnostic?: (code: string) => void;
}) {
  const recorder = createTracingRuntime({
    ...input,
    adapter: { backend: input.output, serializer: defaultContentSerializer },
  });
  return { turn: recorder.turn };
}

export type TracingRuntime = ReturnType<typeof createTracingRuntime>;
export type AgentTracing = ReturnType<typeof createAgentTracing>;
