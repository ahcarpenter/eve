import {
  ROOT_CONTEXT,
  type Context,
  type SpanContext,
  trace,
} from "#compiled/@opentelemetry/api/index.js";

import type {
  InstrumentationActionStartedEvent,
  InstrumentationActionTerminalEvent,
  InstrumentationAttemptScope,
  InstrumentationProviderDefinition,
} from "#instrumentation/lifecycle.js";
import { actionIdempotencyKey, attemptIdempotencyKey } from "#instrumentation/lifecycle.js";
import { traceSessionIdOf } from "#tracing/eve/checkpoint-codec.js";
import { contentAttribute } from "#tracing/lib/adapters/serialization.js";
import type {
  AgentActionTraceState,
  AgentTraceStateStore,
} from "#tracing/eve/agent-trace-state.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import { isSampledTrace } from "#shared/trace-policy.js";
import { withChannelAudience } from "#tracing/eve/channel-audience-context.js";
import { eveScopeRecord, checkpointContent } from "#tracing/eve/checkpoint-codec.js";
import type { ActionOperation } from "#tracing/lib/core/operations.js";
import type { createTraceRecorder } from "#tracing/lib/core/recorder.js";

interface AgentActionInstrumentation {
  readonly events: Pick<
    NonNullable<InstrumentationProviderDefinition["events"]>,
    "action.completed" | "action.failed" | "action.started"
  >;
  deleteForSession(sessionId: string): void | PromiseLike<void>;
  failForAttempt(scope: InstrumentationAttemptScope, error: unknown): Promise<void>;
  contextFor(
    sessionId: string,
    turnId: string,
    callId: string,
  ): Promise<AgentActionContext | undefined>;
}

export interface AgentActionContext {
  readonly context: Context;
  readonly spanContext: SpanContext;
}

/** Builds durable `agent.action` spans around eve's runtime dispatch boundary. */
export function createAgentActionInstrumentation(input: {
  readonly lifecycle: ReturnType<typeof createTraceRecorder>;
  readonly frameworkVersion: string;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
  readonly resolveTraceContext: (
    event: InstrumentationActionStartedEvent,
  ) => SpanContext | undefined | PromiseLike<SpanContext | undefined>;
  readonly stateStore: AgentTraceStateStore;
}): AgentActionInstrumentation {
  const byAttempt = new Map<string, Set<string>>();

  const onStarted = async (event: InstrumentationActionStartedEvent): Promise<void> => {
    const traceContext = await input.resolveTraceContext(event);
    if (traceContext === undefined || !isSampledTrace(traceContext)) return;

    const existing = await input.stateStore.getAction(event.idempotencyKey);
    const state: AgentActionTraceState = existing ?? {
      attemptIndex: event.scope.attemptIndex,
      callId: event.callId,
      channelAudience: normalizeChannelAudience(event.scope.channelAudience),
      inputAttribute: input.recordInputs ? contentAttribute(event.input) : undefined,
      kind: event.kind,
      name: event.name,
      parent: {
        ...input.lifecycle.reserve({
          key: attemptIdempotencyKey(event.scope),
          parent: traceContext,
          traceFlags: traceContext.traceFlags,
        }),
      },
      rootSessionId: event.scope.rootSessionId ?? event.scope.sessionId,
      traceSessionId: traceSessionIdOf(event.scope),
      sessionId: event.scope.sessionId,
      spanId: input.lifecycle.reserve({
        key: `action:${event.idempotencyKey}`,
        parent: traceContext,
        traceFlags: traceContext.traceFlags,
      }).spanId,
      startTimeMs: Date.now(),
      stepIndex: event.scope.stepIndex,
      turnId: event.scope.turnId,
    };
    await input.stateStore.setAction(event.idempotencyKey, state);
    if (event.isWorkflowTool === true) {
      await input.stateStore.setActionAnchor(event.idempotencyKey, state);
    }
    const keys = byAttempt.get(event.scope.attemptId) ?? new Set<string>();
    keys.add(event.idempotencyKey);
    byAttempt.set(event.scope.attemptId, keys);
  };

  const onTerminal = async (event: InstrumentationActionTerminalEvent): Promise<void> => {
    const state = await input.stateStore.getAction(event.idempotencyKey);
    if (state === undefined) return;
    try {
      await finishActionSpan(state, event);
    } finally {
      await input.stateStore.deleteAction(event.idempotencyKey);
      forget(event.idempotencyKey);
    }
  };

  const startScope = (state: AgentActionTraceState): Promise<ActionOperation | undefined> =>
    input.lifecycle.resolve(
      eveScopeRecord(
        {
          ...state,
          frameworkVersion: input.frameworkVersion,
          reference: { ...state.parent, spanId: state.spanId },
          startTimeMs: state.startTimeMs,
        },
        `${state.sessionId}:${state.callId}`,
        {
          type: "action",
          options: {
            callId: state.callId,
            kind: state.kind,
            name: state.name,
            arguments: checkpointContent(state.inputAttribute),
          },
        },
      ),
      { deferred: true, executionContext: contextFromActionState(state) },
    );

  return {
    async contextFor(sessionId, turnId, callId) {
      const directKey = actionIdempotencyKey(sessionId, turnId, callId);
      const direct = await input.stateStore.getAction(directKey);
      if (direct !== undefined) return actionContext(direct);
      const state = await input.stateStore.findAction(sessionId, callId);
      return state === undefined ? undefined : actionContext(state);
    },
    async deleteForSession(sessionId) {
      await input.stateStore.deleteActions(sessionId);
      await input.stateStore.deleteActionAnchors(sessionId);
    },
    async failForAttempt(scope, error) {
      const keys = byAttempt.get(scope.attemptId);
      if (keys === undefined) return;
      byAttempt.delete(scope.attemptId);
      for (const key of keys) {
        const state = await input.stateStore.getAction(key);
        if (state === undefined) continue;
        const scope = await startScope(state);
        await scope?.complete({
          outcome: "failed",
          errorType: error instanceof Error ? error.name : "_OTHER",
          error,
        });
        await input.stateStore.deleteAction(key);
      }
    },
    events: {
      "action.completed": onTerminal,
      "action.failed": onTerminal,
      "action.started": onStarted,
    },
  };

  function forget(idempotencyKey: string): void {
    for (const [attemptId, keys] of byAttempt) {
      keys.delete(idempotencyKey);
      if (keys.size === 0) byAttempt.delete(attemptId);
    }
  }

  async function finishActionSpan(
    state: AgentActionTraceState,
    event: InstrumentationActionTerminalEvent,
  ): Promise<void> {
    const scope = await startScope(state);
    const error =
      event.type === "action.failed"
        ? event.error
        : event.output.type === "error"
          ? event.output.error
          : undefined;
    const failed = event.type === "action.failed" || event.output.type === "error";
    await scope?.complete({
      ...(failed
        ? {
            outcome: "failed" as const,
            errorType: event.type === "action.failed" ? (event.errorCode ?? "Error") : "Error",
            error,
          }
        : {
            outcome: "completed" as const,
            output:
              input.recordOutputs &&
              event.type === "action.completed" &&
              event.output.type === "result"
                ? event.output.output
                : undefined,
          }),
      usage: event.usage,
      endTimeMs: event.acceptedAtMs,
    });
  }
}

function actionContext(state: AgentActionTraceState): AgentActionContext {
  const spanContext = {
    isRemote: false,
    spanId: state.spanId,
    traceFlags: state.parent.traceFlags,
    traceId: state.parent.traceId,
  };
  return {
    context: withChannelAudience(
      trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(spanContext)),
      state.channelAudience,
    ),
    spanContext,
  };
}

function contextFromActionState(state: AgentActionTraceState): Context {
  return withChannelAudience(
    trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext({ ...state.parent, isRemote: false })),
    state.channelAudience,
  );
}
