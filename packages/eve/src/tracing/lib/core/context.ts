import type {
  ActiveOperation,
  CaptureDecision,
  ExecutionContext,
  TraceBackend,
  TraceReference,
} from "#tracing/lib/core/types.js";

export function runTraceContext<T>(
  backend: TraceBackend,
  reference: TraceReference,
  capture: CaptureDecision,
  execute: () => T,
  host?: ExecutionContext,
  operation?: ActiveOperation,
): T {
  let entered = false;
  try {
    return backend.run(
      reference,
      capture,
      () => {
        entered = true;
        return execute();
      },
      host,
      operation,
    );
  } catch (error) {
    if (entered) throw error;
    // Hosts must offer suppression when ordinary context installation fails.
    if (backend.suppressed !== undefined) return backend.suppressed(execute);
    return execute();
  }
}
