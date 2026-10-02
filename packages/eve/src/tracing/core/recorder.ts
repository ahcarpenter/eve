import { createTraceLifecycle } from "#tracing/core/scopes.js";
import type {
  ScopeRecord,
  ScopeIdentity,
  TurnMetadata,
  RuntimeBinding,
} from "#tracing/core/scopes.js";
import type { CaptureDecision, TraceBackend, DurableTraceBackend } from "#tracing/core/types.js";
import type { ContentSerializer } from "#tracing/core/model.js";
import {
  operationHandle,
  type TurnOperation,
  type RestoredOperation,
} from "#tracing/core/operations.js";

export function createTraceRecorder(input: {
  output: TraceBackend | DurableTraceBackend;
  serializer: ContentSerializer;
  mode: "live" | "durable";
}) {
  const runtime = createTraceLifecycle({
    backend: input.output,
    serializer: input.serializer,
    mode: input.mode,
  });
  return {
    async beginTurn(input: {
      identity: ScopeIdentity;
      metadata: TurnMetadata;
      capture: CaptureDecision;
      binding: RuntimeBinding;
    }): Promise<TurnOperation> {
      return operationHandle(
        await runtime.turn(input.identity, input.metadata, input.capture, input.binding),
      ) as TurnOperation;
    },
    async restore(snapshot: ScopeRecord, ceiling: CaptureDecision): Promise<RestoredOperation> {
      return operationHandle(await runtime.restore(snapshot, ceiling));
    },
  };
}
