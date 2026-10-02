import type { ScopeData, ScopeRecord } from "#tracing/lib/core/scopes.js";
import type { TraceLink, TraceReference } from "#tracing/lib/core/types.js";
import { resolveConversationId } from "#shared/conversation-identity.js";
import type { RuntimeOperationInput } from "#tracing/lib/core/recorder.js";
export function traceSessionIdOf(scope: {
  readonly traceSessionId?: string;
  readonly rootSessionId?: string;
  readonly sessionId: string;
}): string {
  return scope.traceSessionId ?? scope.rootSessionId ?? scope.sessionId;
}

export function checkpointContent(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  // Historical checkpoints contain truncated JSON; omit payloads, not the operation.
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Converts existing workflow checkpoint records; does not create another state owner. */
export function eveScopeRecord<K extends ScopeData["type"]>(
  input: {
    readonly sessionId: string;
    readonly rootSessionId?: string;
    readonly traceSessionId?: string;
    readonly turnId: string;
    readonly frameworkVersion: string;
    readonly agentName?: string;
    readonly functionId?: string;
    readonly reference: TraceReference;
    readonly parent?: TraceReference;
    readonly startTimeMs?: number;
    readonly stepIndex?: number;
    readonly attemptIndex?: number;
    readonly links?: readonly TraceLink[];
    readonly content?: { readonly recordInputs: boolean; readonly recordOutputs: boolean };
  },
  key: string,
  data: Extract<ScopeData, { type: K }>,
): ScopeRecord & { data: Extract<ScopeData, { type: K }> } {
  const operation = eveOperationInput(input, key);
  return {
    key,
    data,
    identity: operation.identity,
    capture: operation.capture,
    reference: input.reference,
    parent: input.parent,
    startTimeMs: input.startTimeMs ?? Date.now(),
    attempt: operation.attempt,
    links: input.links,
    content: input.content,
    outputContext: operation.binding.outputContext,
  };
}

export function eveOperationInput(
  input: Parameters<typeof eveScopeRecord>[0],
  key: string,
  deferred = false,
  executionContext?: import("#tracing/lib/core/types.js").ExecutionContext,
): RuntimeOperationInput {
  return {
    identity: {
      conversationId: resolveConversationId(input.rootSessionId ?? input.sessionId),
      runId: input.sessionId,
      turnId: input.turnId,
      agentName: input.agentName ?? input.functionId,
      framework: { name: "eve", version: input.frameworkVersion },
    },
    capture: {
      emit: (input.reference.traceFlags & 1) !== 0,
      recordInputs: true,
      recordOutputs: true,
    },
    attempt: { index: input.stepIndex ?? 0, attempt: input.attemptIndex ?? 0 },
    binding: {
      key,
      reference: input.reference,
      parent: input.parent,
      startTimeMs: input.startTimeMs,
      links: input.links,
      content: input.content,
      deferred,
      executionContext,
      outputContext: {
        traceSessionId: traceSessionIdOf(input),
        platform: process.env.VERCEL_ENV === undefined ? "other" : "vercel",
      },
    },
  };
}
