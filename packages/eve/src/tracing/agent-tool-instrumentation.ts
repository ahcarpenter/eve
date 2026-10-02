import { type Context, type SpanContext } from "#compiled/@opentelemetry/api/index.js";
import type {
  InstrumentationActionStartedEvent,
  InstrumentationToolCallStartedEvent,
  InstrumentationToolCallTerminalEvent,
} from "#instrumentation/lifecycle.js";
import { actionIdempotencyKey } from "#instrumentation/lifecycle.js";
import type { AgentActionContext } from "#tracing/agent-action-instrumentation.js";
import { eveScopeRecord } from "#tracing/adapters/eve/checkpointer.js";
import type { AgentTracing } from "#tracing/core/agent-tracing.js";

type PendingTool = ReturnType<AgentTracing["lifecycle"]["pendingTool"]>;
interface ToolState {
  readonly actionKey: string;
  readonly event: InstrumentationToolCallStartedEvent;
  readonly operation: PendingTool;
}

export function createAgentToolInstrumentation(input: {
  readonly lifecycle: AgentTracing["lifecycle"];
  readonly actionContextFor: (
    sessionId: string,
    turnId: string,
    callId: string,
  ) => Promise<AgentActionContext | undefined>;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
  readonly resolveFallback: (
    event: InstrumentationToolCallStartedEvent,
  ) => { readonly context: Context; readonly spanContext: SpanContext } | undefined;
}) {
  const byAction = new Map<string, ToolState>();
  const byAttempt = new Map<string, Map<string, ToolState>>();
  async function attach(state: ToolState) {
    const event = state.event;
    const parent = await input.actionContextFor(
      event.scope.sessionId,
      event.scope.turnId,
      event.callId,
    );
    if (parent !== undefined) await state.operation.attach(parent.spanContext, parent.context);
  }
  function forget(state: ToolState) {
    byAction.delete(state.actionKey);
    const states = byAttempt.get(state.event.scope.attemptId);
    states?.delete(state.event.idempotencyKey);
    if (states?.size === 0) byAttempt.delete(state.event.scope.attemptId);
  }
  async function onStarted(event: InstrumentationToolCallStartedEvent) {
    const fallback =
      input.resolveFallback(event) ??
      (await input.actionContextFor(event.scope.sessionId, event.scope.turnId, event.callId));
    if (fallback === undefined) return;
    const record = eveScopeRecord(
      {
        ...event.scope,
        frameworkVersion: "",
        parent: fallback.spanContext,
        reference: input.lifecycle.reserve({
          key: `tool:${event.idempotencyKey}`,
          parent: fallback.spanContext,
          traceFlags: fallback.spanContext.traceFlags,
        }),
      },
      event.idempotencyKey,
      {
        type: "tool",
        options: {
          callId: event.callId,
          name: event.toolName,
          arguments: input.recordInputs ? event.input : undefined,
        },
      },
    );
    const state: ToolState = {
      actionKey: actionIdempotencyKey(event.scope.sessionId, event.scope.turnId, event.callId),
      event,
      operation: input.lifecycle.pendingTool(
        {
          ...record,
          capture: {
            ...record.capture,
            recordInputs: input.recordInputs,
            recordOutputs: input.recordOutputs,
          },
        },
        { executionContext: fallback.context },
      ),
    };
    const states = byAttempt.get(event.scope.attemptId) ?? new Map<string, ToolState>();
    states.set(event.idempotencyKey, state);
    byAttempt.set(event.scope.attemptId, states);
    byAction.set(state.actionKey, state);
    await attach(state);
  }
  async function onTerminal(event: InstrumentationToolCallTerminalEvent) {
    const state = byAttempt.get(event.scope.attemptId)?.get(event.idempotencyKey);
    if (state === undefined) return;
    await attach(state);
    await state.operation.finish({
      failed: event.type === "tool.call.failed" || event.output.type === "error",
      error:
        event.type === "tool.call.failed"
          ? event.error
          : event.output.type === "error"
            ? event.output.error
            : undefined,
      output:
        input.recordOutputs &&
        event.type === "tool.call.completed" &&
        event.output.type === "result"
          ? event.output.output
          : undefined,
    });
    if (state.operation.finished) forget(state);
  }
  return {
    async actionStarted(event: InstrumentationActionStartedEvent) {
      const state = byAction.get(event.idempotencyKey);
      if (state !== undefined) {
        await attach(state);
        if (state.operation.finished) forget(state);
      }
    },
    operationFor: (attemptId: string, key: string) => byAttempt.get(attemptId)?.get(key)?.operation,
    async drain(attemptId: string, failure?: { readonly error: unknown }) {
      for (const state of byAttempt.get(attemptId)?.values() ?? []) {
        await state.operation.drain({ failed: failure !== undefined, error: failure?.error });
        forget(state);
      }
    },
    events: {
      "tool.call.started": onStarted,
      "tool.call.completed": onTerminal,
      "tool.call.failed": onTerminal,
    },
  };
}
