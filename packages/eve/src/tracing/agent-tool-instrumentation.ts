import type { Context, SpanContext } from "#compiled/@opentelemetry/api/index.js";
import type {
  InstrumentationActionStartedEvent,
  InstrumentationToolCallStartedEvent,
  InstrumentationToolCallTerminalEvent,
} from "#instrumentation/lifecycle.js";
import { actionIdempotencyKey } from "#instrumentation/lifecycle.js";
import type { AgentActionContext } from "#tracing/agent-action-instrumentation.js";
import { resolveConversationId } from "#shared/conversation-identity.js";
import { traceSessionIdOf } from "#tracing/eve/checkpoint-codec.js";
import type { createTraceRecorder } from "#tracing/lib/core/recorder.js";

export function createAgentToolInstrumentation(input: {
  readonly lifecycle: ReturnType<typeof createTraceRecorder>;
  readonly actionContextFor: (
    sessionId: string,
    turnId: string,
    callId: string,
  ) => Promise<AgentActionContext | undefined>;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
  readonly resolveFallback: (
    event: InstrumentationToolCallStartedEvent,
  ) => { context: Context; spanContext: SpanContext } | undefined;
}) {
  async function actionAvailable(event: {
    scope: InstrumentationToolCallStartedEvent["scope"];
    callId: string;
  }) {
    const parent = await input.actionContextFor(
      event.scope.sessionId,
      event.scope.turnId,
      event.callId,
    );
    if (parent !== undefined)
      await input.lifecycle.actionAvailable(
        actionIdempotencyKey(event.scope.sessionId, event.scope.turnId, event.callId),
        parent.spanContext,
        parent.context,
      );
  }
  async function onStarted(event: InstrumentationToolCallStartedEvent) {
    const fallback =
      input.resolveFallback(event) ??
      (await input.actionContextFor(event.scope.sessionId, event.scope.turnId, event.callId));
    if (fallback === undefined) return;
    input.lifecycle.toolCall({
      identity: {
        conversationId: resolveConversationId(event.scope.rootSessionId ?? event.scope.sessionId),
        runId: event.scope.sessionId,
        turnId: event.scope.turnId,
        agentName: event.scope.functionId,
        framework: { name: "eve", version: "" },
      },
      executionKey: event.idempotencyKey,
      referenceKey: `tool:${event.idempotencyKey}`,
      group: event.scope.attemptId,
      actionKey: actionIdempotencyKey(event.scope.sessionId, event.scope.turnId, event.callId),
      callId: event.callId,
      name: event.toolName,
      arguments: input.recordInputs ? event.input : undefined,
      fallback: fallback.spanContext,
      capture: {
        emit: (fallback.spanContext.traceFlags & 1) !== 0,
        recordInputs: input.recordInputs,
        recordOutputs: input.recordOutputs,
      },
      executionContext: fallback.context,
      outputContext: {
        traceSessionId: traceSessionIdOf(event.scope),
        platform: process.env.VERCEL_ENV === undefined ? "other" : "vercel",
      },
    });
    await actionAvailable(event);
  }
  async function onTerminal(event: InstrumentationToolCallTerminalEvent) {
    await input.lifecycle.completeTool(
      event.idempotencyKey,
      event.type === "tool.call.failed" || event.output.type === "error"
        ? {
            outcome: "failed",
            errorType: "Error",
            error:
              event.type === "tool.call.failed"
                ? event.error
                : event.output.type === "error"
                  ? event.output.error
                  : undefined,
          }
        : { outcome: "completed", output: input.recordOutputs ? event.output.output : undefined },
    );
  }
  return {
    actionStarted: (event: InstrumentationActionStartedEvent) => actionAvailable(event),
    operationFor: (_attemptId: string, key: string) => input.lifecycle.toolExecution(key),
    drain: (attemptId: string, failure?: { error: unknown }) =>
      input.lifecycle.endAttempt(attemptId, failure),
    events: {
      "tool.call.started": onStarted,
      "tool.call.completed": onTerminal,
      "tool.call.failed": onTerminal,
    },
  };
}
