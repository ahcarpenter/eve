export { createAgentTracing } from "#tracing/lib/core/agent-tracing.js";
export { TRACE_SCHEMA_VERSION } from "#tracing/lib/core/schema.js";
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
export type {
  AgentTracing,
  ActivationMetadata,
  TurnInput,
  TurnScope,
} from "#tracing/lib/core/agent-tracing.js";
export type {
  StepScope as AttemptTrace,
  ActionScope as ActionTrace,
  ScopeRecord as TraceSnapshot,
} from "#tracing/lib/core/scopes.js";
export type { McpLifecycle, McpUpdate } from "#tracing/lib/core/mcp.js";
export type {
  ActionKind,
  ActionOutcome,
  CaptureDecision,
  FrameworkIdentity,
  TraceReference,
  Usage,
} from "#tracing/lib/core/types.js";
