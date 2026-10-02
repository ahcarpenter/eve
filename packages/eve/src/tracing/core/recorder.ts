import { createTraceLifecycle } from "#tracing/core/scopes.js";
import type {
  ScopeRecord,
  ScopeIdentity,
  TurnMetadata,
  RuntimeBinding,
} from "#tracing/core/scopes.js";
import type { CaptureDecision, TraceBackend, DurableTraceBackend } from "#tracing/core/types.js";
import type { ContentSerializer } from "#tracing/core/model.js";
import type { ExecutionContext, TraceReference } from "#tracing/core/types.js";
import type { ToolCallInput } from "#tracing/core/pending-tool.js";
import { validSnapshot } from "#tracing/core/snapshot.js";
import {
  operationHandle,
  type TurnOperation,
  type RestoredOperation,
} from "#tracing/core/operations.js";

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
    async completeTool(key: string, result: import("#tracing/core/scopes.js").ToolResult) {
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
    async beginTurn(input: {
      identity: ScopeIdentity;
      metadata: TurnMetadata;
      capture: CaptureDecision;
      binding: RuntimeBinding;
    }): Promise<TurnOperation | undefined> {
      try {
        return operationHandle(
          await runtime.turn(input.identity, input.metadata, input.capture, input.binding),
        ) as TurnOperation;
      } catch {
        report();
        return undefined;
      }
    },
    async restore(
      snapshot: unknown,
      ceiling: CaptureDecision,
    ): Promise<RestoredOperation | undefined> {
      try {
        if (!validSnapshot(snapshot)) {
          report();
          return undefined;
        }
        return operationHandle(await runtime.restore(snapshot, ceiling));
      } catch {
        report();
        return undefined;
      }
    },
  };
}
