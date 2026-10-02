# Agent tracing

Use this library to record agent execution as OpenTelemetry (OTel) spans.
The library supplies operation IDs, parent references, start times, sampling,
and content serialization.

## Set up tracing

Create tracing before the application accepts requests:

```ts
import { createAgentTracing } from "./agent-tracing.js";

const tracing = createAgentTracing({ agentName: "support" });
```

`agentName` identifies the agent and sets the OTel service name. On Vercel,
the default destination sends completed spans through the active request context.
In other environments, OTel selects its automatic destination.

To supply destinations, pass the complete OTel configuration:

```ts
import { batchSpanProcessor } from "./adapters/batch-span-processor.js";

const tracing = createAgentTracing({
  agentName: "support",
  otel: { spanProcessors: [batchSpanProcessor(exporter)] },
});
```

Here, `exporter` is your application's OTel span exporter. Configuration also
accepts resource attributes, sampling, propagators, instrumentations, and metric
readers. Instances share registration for the same agent name and configuration
object. Conflicting registration causes an error.

## Choose a calling style

Agent operations support two styles. Both record the same operation structure.

| Style             | Call                                            | Who ends the span?                |
| ----------------- | ----------------------------------------------- | --------------------------------- |
| Wrapped execution | `method(data, execute)`                         | The library, when execution ends. |
| Lifecycle handle  | `method(data)`, then `handle.complete(outcome)` | Your application.                 |

Use wrapped execution when you can supply the function that performs the work.
Use lifecycle handles when start and completion arrive as separate events.

Operation creation always returns a typed handle. If span setup fails, the handle
disables emission. Child methods remain available, and execution still runs once.

## Wrapped execution

The first argument describes the operation. The second argument performs it.
The library activates context, records the result or error, and ends the span.

```ts
const identity = {
  conversationId: "conversation-123",
  runId: "run-456",
  turnId: "turn-789",
};

const result = await tracing.turn({ identity, sequence: 0 }, (turn) =>
  turn.attempt({ stepIndex: 0, attempt: 0 }, (attempt) =>
    attempt.action({ callId: "lookup-1", name: "lookup" }, (action) =>
      action.toolExecution({}, () => lookup()),
    ),
  ),
);
```

Each call returns the execution result or rethrows the original error.
Completion is automatic. You do not call `complete()` in this style.

For wrapped model calls, return the application result and response metadata:

```ts
const result = await attempt.modelCall({ provider, modelId }, async () => {
  const response = await callModel();
  return {
    result: response,
    finishReason: response.finishReason,
    usage: response.usage,
    content: response.content,
  };
});
```

Tracing records the metadata and returns `result` unchanged. SDK adapters
convert usage and content to library-owned types. Response IDs are optional.

Other wrapped operations accept `describe` in their metadata to record a domain
outcome. For example, a resolved approval can mean approval or denial:

```ts
const accepted = await action.approval(
  {
    requestId: "approval-1",
    describe: (value) => ({ outcome: value ? "approved" : "denied" }),
  },
  () => requestApproval(),
);
```

## Lifecycle handles and explicit completion

Pass metadata only to create a handle. Keep it until its operation ends.
`run()` activates context during local execution. It does not end the span.
`complete()` records the outcome and ends the span.

```ts
const turn = await tracing.turn({ identity, sequence: 0 });
const attempt = await turn.attempt({ stepIndex: 0, attempt: 0 });
const model = await attempt.modelCall({ provider, modelId });

try {
  const response = await model.run(() => callModel());

  await model.complete({
    outcome: "completed",
    result: {
      finishReason: response.finishReason,
      usage: response.usage,
      content: response.content,
    },
  });
  await attempt.complete({ outcome: "completed" });
  await turn.complete({ outcome: "completed" });
} catch (error) {
  const failure = {
    outcome: "failed" as const,
    errorType: error instanceof Error ? error.name : "_OTHER",
    error,
  };
  await model.complete(failure);
  await attempt.complete(failure);
  await turn.complete(failure);
  throw error;
}
```

For event-driven execution, create the handle on the start event and call
`complete()` on the completion or failure event. Complete children before parents.
Use `{ outcome: "cancelled" }` for a cancelled turn or attempt.

Actions, tools, and approvals also support explicit completion:

```ts
const action = await attempt.action({ callId: "lookup-1", name: "lookup" });
const approval = await action.approval({ requestId: "approval-1" });
await approval.complete({ outcome: "approved" });

const tool = await action.toolExecution();
const output = await tool.run(() => lookup());
await tool.complete({ outcome: "completed", output });
await action.complete({ outcome: "completed", output });
```

For denial, use `approval.complete({ outcome: "denied" })` and
`action.complete({ outcome: "rejected" })`. For failures, use the failed outcome
shown above. A resolved error-valued tool result also needs a failed outcome.

## Operation structure

```text
turn
└── attempt
    ├── model call
    └── action
        ├── approval
        └── tool execution
```

Attempts emit `agent.step` spans. The step index identifies the logical step;
the attempt number identifies its retry. Each model operation represents one
physical invocation. Model usage is added to parent operations.

## Streams

`modelStream(data, execute)` returns the stream immediately. Supply a completion
promise that settles when the stream finishes, fails, or is cancelled:

```ts
const stream = await attempt.modelStream({ provider, modelId }, () => {
  const response = startModelStream();
  return { result: response.stream, completion: response.completion };
});
```

Your adapter resolves `completion` with `finishReason`, `usage`, and completed
`content`, or rejects it with the stream error. Tracing observes the promise
without consuming the stream. Parent spans wait for pending model completions.
Completed content supplies `gen_ai.output.messages` when output capture is enabled.

## Memory, requests, and MCP

These methods wrap execution and complete automatically:

```ts
await turn.run(() =>
  tracing.memory.search(
    {
      identity: { ...identity, framework: { name: "custom", version: "1" } },
      storeId: "customer-history",
      slot: "history",
      phase: "retrieve",
    },
    () => store.search(query),
  ),
);

await tracing.request({ method: "GET", route: "/customers" }, () => handleRequest());
await tracing.mcp.list({ connectionName: "catalog" }, () => client.listTools());
await tracing.mcp.call({ connectionName: "catalog", toolName: "lookup" }, () => client.callTool());
```

Use `tracing.memory.write(data, execute)` for memory writes. MCP calls inside an
active tool record data on that tool span. Other MCP calls create their own span.

## Capture and stored operations

Content capture is disabled by default. Set turn permissions through
`capture: { emit: true, recordInputs: true, recordOutputs: false }`.
Children inherit effective permissions. Sampling and nested execution can make
them more restrictive. Serialized content has size limits.

Runtime adapters reconstruct stored operations through `resolve(record, options)`.
Keep the identity, reference, parent, start time, and capture decision in runtime
state. Use `{ deferred: true }` for spans emitted at later-worker completion.
Recovered handles use the same `complete()` interface.

## Export and close

```ts
await tracing.forceFlush(); // Send pending spans at a runtime boundary.
await tracing.shutdown(); // Close tracing when the process ends.
```

On Vercel, complete spans while their request context is available.
Trace output uses schema version 4.
