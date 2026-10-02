import { SpanStatusCode, type Span } from "#compiled/@opentelemetry/api/index.js";
import { boundedTraceError } from "#tracing/bounded-error.js";
import { truncateTelemetryText } from "#tracing/telemetry-budget.js";
import { contentAttribute, textContentAttribute } from "#tracing/lib/adapters/serialization.js";

/** Call with policy-projected errors; undefined retains failure status without content. */
export function recordAgentSpanError(span: Span, error: unknown, errorType?: string): void {
  span.setAttribute(
    "error.type",
    truncateTelemetryText(
      errorType ?? (error instanceof Error ? error.name || "Error" : "_OTHER"),
      128,
    ),
  );
  if (error !== undefined && !(error instanceof Error)) {
    const serialized = contentAttribute(error);
    const message =
      typeof error === "object" && error !== null ? Reflect.get(error, "message") : undefined;
    const detail =
      typeof error === "string"
        ? textContentAttribute(error)
        : typeof message === "string"
          ? textContentAttribute(serialized === undefined ? message : `${message}\n${serialized}`)
          : serialized;
    if (detail !== undefined) error = new Error(detail);
  }
  if (error instanceof Error) {
    const bounded = boundedTraceError(error);
    if (errorType !== undefined) bounded.name = truncateTelemetryText(errorType, 128);
    span.recordException(bounded);
    span.setStatus({ code: SpanStatusCode.ERROR, message: bounded.message });
  } else {
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
}
