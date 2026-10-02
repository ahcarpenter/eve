import type { RuntimeScope, ScopeRecord, ScopeTerminal } from "#tracing/core/scopes.js";
import type {
  CaptureDecision,
  ExecutionContext,
  TraceBackend,
  TraceReference,
} from "#tracing/core/types.js";
import type { McpUpdate } from "#tracing/core/mcp.js";
import { intersectCapture } from "#tracing/core/activation.js";
import { snapshotRecord } from "#tracing/core/snapshot.js";
import type { ContentSerializer } from "#tracing/core/model.js";
import type { ScopeIdentity } from "#tracing/core/scope-lifecycle.js";
import type { DurableTraceBackend } from "#tracing/core/types.js";
import { runTraceContext } from "#tracing/core/context.js";
import { capturedScopeData } from "#tracing/core/scope-completion.js";

export interface ToolCallInput {
  identity: ScopeIdentity;
  executionKey: string;
  referenceKey?: string;
  actionKey: string;
  name: string;
  callId: string;
  arguments?: unknown;
  fallback: TraceReference;
  capture: CaptureDecision;
  executionContext?: ExecutionContext;
  outputContext?: Readonly<Record<string, string>>;
}

export function toolCallRecord(
  input: ToolCallInput,
  backend: TraceBackend | DurableTraceBackend,
): ScopeRecord {
  if (!("reserveReference" in backend))
    throw new Error("Tool binding requires reserved-ID support.");
  return {
    key: input.executionKey,
    identity: input.identity,
    reference: backend.reserveReference({
      key: input.referenceKey ?? input.executionKey,
      parent: input.fallback,
      traceFlags: input.fallback.traceFlags,
    }),
    parent: input.fallback,
    data: {
      type: "tool",
      options: { callId: input.callId, name: input.name, arguments: input.arguments },
    },
    capture: input.capture,
    startTimeMs: Date.now(),
    outputContext: input.outputContext,
  };
}

export function pendingTool(input: {
  readonly record: ScopeRecord;
  readonly serializer: ContentSerializer;
  readonly backend: TraceBackend;
  readonly resolve: (
    record: ScopeRecord,
    options: { executionContext?: ExecutionContext },
  ) => Promise<RuntimeScope>;
  readonly executionContext?: ExecutionContext;
}) {
  input = { ...input, record: snapshotRecord(input.record, input.serializer) };
  let scope: RuntimeScope | undefined;
  let attaching: Promise<RuntimeScope> | undefined;
  let terminal: ScopeTerminal | undefined;
  const updates: McpUpdate[] = [];
  let pendingError: { error?: unknown; type?: string } | undefined;
  let capture = input.record.capture;
  function bounded(value: unknown) {
    const text = input.serializer.json(value);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }
  const mcp = {
    update(update: McpUpdate) {
      if (scope !== undefined) scope.mcp.update(update);
      else if (updates.length < 256) {
        const encoded = JSON.stringify(update);
        if (encoded.length <= 8192) updates.push(JSON.parse(encoded) as McpUpdate);
      }
    },
    error(error?: unknown, type?: string) {
      pendingError = {
        error: capture.recordOutputs ? error : undefined,
        type: type ?? (error instanceof Error ? error.name : undefined),
      };
      scope?.mcp.error(pendingError.error, pendingError.type);
    },
    arguments() {},
    result() {},
  };
  async function attach(parent: TraceReference, executionContext?: ExecutionContext) {
    attaching ??= input
      .resolve({ ...input.record, parent, capture }, { executionContext })
      .then(async (next) => {
        scope = next;
        for (const update of updates) next.mcp.update(update);
        updates.length = 0;
        if (pendingError !== undefined) next.error(pendingError.error, pendingError.type);
        if (terminal !== undefined) await next.finish(terminal);
        return next;
      });
    return attaching;
  }
  return {
    type: "tool" as const,
    reference: input.record.reference,
    get capture() {
      return capture;
    },
    mcp,
    get attached() {
      return attaching !== undefined;
    },
    get finished() {
      return scope?.finished ?? false;
    },
    attach,
    run<T>(execute: () => T, ceiling?: CaptureDecision): T {
      capture = intersectCapture(
        intersectCapture(capture, ceiling),
        input.backend.active?.()?.capture,
      );
      input = {
        ...input,
        record: { ...input.record, capture, data: capturedScopeData(input.record.data, capture) },
      };
      if (!capture.recordOutputs) {
        if (pendingError !== undefined) pendingError.error = undefined;
        if (terminal !== undefined) terminal = { ...terminal, output: undefined, error: undefined };
      }
      if (scope !== undefined) return scope.run(execute, capture);
      return runTraceContext(
        input.backend,
        input.record.reference,
        capture,
        execute,
        input.executionContext,
        {
          type: "tool",
          reference: input.record.reference,
          capture,
          mcp,
        },
      );
    },
    async finish(result: ScopeTerminal) {
      terminal = {
        ...result,
        output: capture.recordOutputs ? bounded(result.output) : undefined,
        error: capture.recordOutputs
          ? result.error instanceof Error
            ? new Error(input.serializer.text(result.error.message) ?? "")
            : bounded(result.error)
          : undefined,
      };
      if (scope !== undefined) await scope.finish(result);
    },
    async drain(result: ScopeTerminal = {}) {
      terminal ??= result;
      if (input.record.parent === undefined)
        throw new Error("A pending tool requires a fallback parent.");
      const next = await attach(input.record.parent, input.executionContext);
      await next.finish(terminal);
    },
  };
}
