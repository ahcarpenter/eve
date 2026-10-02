import { randomBytes } from "node:crypto";
import type { RuntimeScope, ScopeData, RuntimeBinding } from "#tracing/lib/core/scope-lifecycle.js";
import type { TraceBackend } from "#tracing/lib/core/types.js";
import { mcpLifecycle } from "#tracing/lib/core/mcp.js";
import type { ContentSerializer } from "#tracing/lib/core/model.js";
import { capturedScopeData } from "#tracing/lib/core/scope-completion.js";

/** A failed trace operation keeps the same lifecycle with emission disabled. */
export function disabledOperation(
  data: ScopeData,
  backend: TraceBackend,
  serializer: ContentSerializer,
  binding?: RuntimeBinding,
): RuntimeScope {
  let finished = false;
  const capture = { emit: false, recordInputs: false, recordOutputs: false };
  const reference = {
    traceId:
      binding?.reference?.traceId ?? binding?.parent?.traceId ?? randomBytes(16).toString("hex"),
    spanId: binding?.reference?.spanId ?? randomBytes(8).toString("hex"),
    traceFlags: 0,
  };
  return {
    waitUntil() {},
    type: data.type,
    description: capturedScopeData(data, capture),
    reference,
    parent: binding?.parent,
    startTimeMs: binding?.startTimeMs ?? Date.now(),
    capture,
    get finished() {
      return finished;
    },
    child: async (child) =>
      disabledOperation(child, backend, serializer, { key: "disabled", parent: reference }),
    run<T>(execute: () => T): T {
      if (backend.suppressed === undefined) return execute();
      let entered = false;
      try {
        return backend.suppressed(() => {
          entered = true;
          return execute();
        });
      } catch (error) {
        if (entered) throw error;
        return execute();
      }
    },
    async finish() {
      finished = true;
    },
    async started() {},
    async usage() {},
    modelSelected() {},
    error() {},
    cost() {},
    mcp: mcpLifecycle({ serializer, ...capture, write() {}, error() {} }),
  };
}
