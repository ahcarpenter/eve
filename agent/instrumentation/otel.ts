import { DiagConsoleLogger, DiagLogLevel, diag } from "@opentelemetry/api";
import { otel } from "eve/instrumentation/otel";

// Makes OpenTelemetry's own errors visible. A second end() on a span is
// reported through diag and is silent without a diag logger.
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

export default otel({
  // The condition for the fault. Build with
  // REPRO_TRACE_CHANNEL_REQUESTS=false to compare.
  traceChannelRequests: process.env.REPRO_TRACE_CHANNEL_REQUESTS !== "false",
});
