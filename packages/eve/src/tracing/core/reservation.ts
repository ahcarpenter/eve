import type { ScopeRecord } from "#tracing/core/scope-lifecycle.js";
import type {
  TraceBackend,
  DurableTraceBackend,
  PreparedSpan,
  TraceReference,
} from "#tracing/core/types.js";

export function reservation(
  backend: TraceBackend | DurableTraceBackend,
  prepare: (record: ScopeRecord) => PreparedSpan,
) {
  return {
    reserve(options: { key: string; parent?: TraceReference; traceFlags: number }): TraceReference {
      if (!("reserveReference" in backend))
        throw new Error("Reference reservation requires a durable backend.");
      return backend.reserveReference(options);
    },
    sample(record: ScopeRecord): boolean {
      return "admits" in backend
        ? backend.admits(
            { ...prepare(record), outputContext: record.outputContext },
            record.reference,
          )
        : (record.reference.traceFlags & 1) !== 0;
    },
  };
}
