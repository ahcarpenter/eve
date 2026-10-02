export { TRACE_SCHEMA_VERSION } from "#tracing/lib/core/schema.js";
export type {
  ModelCompletion,
  ModelCallReturn,
  ModelStreamReturn,
} from "#tracing/lib/core/model.js";
export { createAgentTracing, type AgentTracing } from "#tracing/lib/agent-tracing.js";
export type { OtelConfiguration } from "#tracing/lib/adapters/otel-configuration.js";
export { createTraceRecorder } from "#tracing/lib/core/recorder.js";
export type {
  TurnOperation,
  AttemptOperation,
  ActionOperation,
  ModelOperation,
  ToolOperation,
  ApprovalOperation,
  RestoredOperation,
} from "#tracing/lib/core/operations.js";
export type { ScopeRecord as TraceSnapshot } from "#tracing/lib/core/scopes.js";
export type { McpLifecycle, McpUpdate } from "#tracing/lib/core/mcp.js";
export type {
  ActionKind,
  ActionOutcome,
  CaptureDecision,
  FrameworkIdentity,
  TraceReference,
  Usage,
  ContentPart,
} from "#tracing/lib/core/types.js";
