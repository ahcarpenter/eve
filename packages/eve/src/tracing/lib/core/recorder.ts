import { createTraceLifecycle } from "#tracing/lib/core/scopes.js";
import type { ScopeRecord } from "#tracing/lib/core/scopes.js";
import type { TraceBackend, DurableTraceBackend } from "#tracing/lib/core/types.js";
import type { ContentSerializer } from "#tracing/lib/core/model.js";
import type { ExecutionContext, TraceReference } from "#tracing/lib/core/types.js";
import type { ToolCallInput } from "#tracing/lib/core/pending-tool.js";
import { validSnapshot } from "#tracing/lib/core/snapshot.js";
import { operationHandle, type RestoredOperation } from "#tracing/lib/core/operations.js";

export function createTraceRecorder(input: {
  output: TraceBackend | DurableTraceBackend;
  serializer: ContentSerializer;
  mode: "live" | "durable";
  diagnostic?: (code: string) => void;
}) {
  const runtime = createTraceLifecycle({
    backend: input.output,
    serializer: input.serializer,
    mode: input.mode,
    diagnostic: input.diagnostic,
  });
  const tools = new Map<
    string,
    { actionKey: string; group: string; operation: ReturnType<typeof runtime.toolCall> }
  >();
  const report = () => {
    try {
      input.diagnostic?.("agent.tracing.operation.failed");
    } catch {}
  };
  return {
    async beginTurn(input: {
      identity: import("#tracing/lib/core/scope-lifecycle.js").ScopeIdentity;
      metadata: import("#tracing/lib/core/scope-lifecycle.js").TurnMetadata;
      capture: import("#tracing/lib/core/types.js").CaptureDecision;
      key: string;
    }) {
      try {
        return operationHandle(
          await runtime.begin(input.identity, input.metadata, input.capture, input.key),
        ) as import("#tracing/lib/core/operations.js").TurnOperation;
      } catch {
        report();
        return undefined;
      }
    },
    active: runtime.active,
    run: runtime.run,
    reserve: runtime.reserve,
    sample: runtime.sample,
    async resolve<K extends ScopeRecord["data"]["type"]>(
      record: ScopeRecord & { data: { type: K } },
      options: { deferred?: boolean; executionContext?: ExecutionContext } = {},
    ): Promise<Extract<RestoredOperation, { type: K }> | undefined> {
      try {
        if (!validSnapshot(record, false)) {
          report();
          return undefined;
        }
        return operationHandle(await runtime.resolve(record, options)) as Extract<
          RestoredOperation,
          { type: K }
        >;
      } catch {
        report();
        return undefined;
      }
    },
    toolCall(input: ToolCallInput & { group: string }) {
      const previous = tools.get(input.executionKey);
      if (previous !== undefined) return;
      let operation;
      try {
        operation = runtime.toolCall(input);
      } catch {
        report();
        return undefined;
      }
      tools.set(input.executionKey, { actionKey: input.actionKey, group: input.group, operation });
    },
    toolExecution(key: string) {
      const operation = tools.get(key)?.operation;
      return operation === undefined
        ? undefined
        : { run: operation.run, reference: operation.reference };
    },
    async actionAvailable(
      key: string,
      parent: TraceReference,
      executionContext?: ExecutionContext,
    ) {
      for (const [keyId, tool] of tools)
        if (tool.actionKey === key) {
          try {
            await tool.operation.attach(parent, executionContext);
          } catch {
            report();
            tools.delete(keyId);
          }
          if (tool.operation.finished) tools.delete(keyId);
        }
    },
    async completeTool(key: string, result: import("#tracing/lib/core/scopes.js").ToolResult) {
      const tool = tools.get(key);
      if (tool === undefined) return;
      try {
        await tool.operation.finish({
          ...result,
          failed: result.outcome === "failed",
          errorCode: "errorType" in result ? result.errorType : undefined,
        });
      } catch {
        report();
        tools.delete(key);
      }
      if (tool.operation.finished) tools.delete(key);
    },
    async endAttempt(group: string, failure?: { error: unknown }) {
      for (const [key, tool] of tools)
        if (tool.group === group) {
          try {
            await tool.operation.drain({ failed: failure !== undefined, error: failure?.error });
          } catch {
            report();
          } finally {
            tools.delete(key);
          }
        }
    },
  };
}
