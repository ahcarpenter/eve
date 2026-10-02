import type { RuntimeScope, ScopeRecord, ScopeTerminal } from "#tracing/core/scopes.js";
import type {
  CaptureDecision,
  ExecutionContext,
  TraceBackend,
  TraceReference,
} from "#tracing/core/types.js";
import type { McpUpdate } from "#tracing/core/mcp.js";
import { intersectCapture } from "#tracing/core/activation.js";

export function pendingTool(input: {
  readonly record: ScopeRecord;
  readonly backend: TraceBackend;
  readonly resolve: (
    record: ScopeRecord,
    options: { executionContext?: ExecutionContext },
  ) => Promise<RuntimeScope>;
  readonly executionContext?: ExecutionContext;
}) {
  let scope: RuntimeScope | undefined;
  let attaching: Promise<RuntimeScope> | undefined;
  let terminal: ScopeTerminal | undefined;
  const updates: McpUpdate[] = [];
  let pendingError: { error?: unknown; type?: string } | undefined;
  let capture = input.record.capture;
  const mcp = {
    update(update: McpUpdate) {
      if (scope !== undefined) scope.mcp.update(update);
      else if (updates.length < 256) updates.push(update);
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
      if (scope !== undefined) return scope.run(execute, capture);
      return input.backend.run(input.record.reference, capture, execute, input.executionContext, {
        type: "tool",
        reference: input.record.reference,
        capture,
        mcp,
      });
    },
    async finish(result: ScopeTerminal) {
      terminal = result;
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
