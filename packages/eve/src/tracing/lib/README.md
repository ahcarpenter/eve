# Agent tracing

This library records agent operations, channel requests, and MCP calls.
It uses OpenTelemetry (OTel) to export trace spans.

## Start tracing

Create tracing before the application accepts requests:

```ts
import { createAgentTracing } from "#tracing/lib/agent-tracing.js";

const tracing = createAgentTracing({ serviceName: "support" });
```

The factory registers OTel and sets up trace IDs, sampling, and content
serialization. On Vercel, the default destination sends completed spans through
the active request context.

Use `otel` to supply the complete OTel configuration:

```ts
const tracing = createAgentTracing({
  serviceName: agentName,
  otel: collected.configuration,
});
```

The configuration selects destinations, resource attributes, sampling, and
propagation. Tracing instances share one registration when they use the same
service name and configuration object. A configuration conflict causes an error.

Call `forceFlush()` to send pending spans. Call `shutdown()` when the process ends.

## Record agent operations

Pass an operation record to `resolve()`. The record supplies the operation type,
identity, parent reference, start time, and capture permissions.

The returned handle provides these methods:

- `run()`: make the operation context active during execution.
- `complete()`: record the operation result and end the span.

An attempt handle also provides `modelCall()` and `cost()`.
Completion results specify outcomes such as completed, failed, approved, or denied.

Spans use this parent structure:

```text
turn
└── attempt
    ├── model call
    └── action
        ├── approval
        └── tool execution
```

Attempts use the span name `agent.step`. Trace output uses schema version 4.
Trace references preserve W3C tracestate.

## Record tool executions

Use `toolCall()` to register a tool execution. Supply its execution key, action
key, attempt group, and fallback parent reference.

The recorder keeps MCP data and the completion result until the action parent
is available. Call `actionAvailable()` to attach that parent. Call `completeTool()`
to record the result. Call `endAttempt()` to complete remaining tool spans.

The recorder copies retained tool data and limits its size. Capture permissions
can only become more restrictive.

## Record requests and MCP calls

`createTransportLifecycle()` records channel requests and MCP operations.
`createMcpTracing()` records MCP data on the active tool operation. For calls
outside a tool execution, it creates an MCP span.

Shared SDK conversion functions prepare model content and usage for recording.
The batching processor sends completed spans to configured exporters.

## Module responsibilities

| Directory        | Responsibility                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `tracing/lib/`   | Operation recording, context activation, OTel setup, batching, and Vercel export.                |
| `tracing/eve/`   | eve event translation, checkpoint conversion, declaration collection, and capture/export policy. |
| `tracing/local/` | Trace storage, retention, queries, and viewer support.                                           |
