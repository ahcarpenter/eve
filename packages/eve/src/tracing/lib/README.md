# Agent tracing

Use this library to record agent execution as OpenTelemetry (OTel) spans.
Each operation has a typed handle. The library supplies IDs, parent references,
start times, sampling, and content serialization.

## Set up tracing

Create tracing before the application accepts requests:

```ts
import { createAgentTracing } from "./agent-tracing.js";

const tracing = createAgentTracing({ agentName: "support" });
```

`agentName` identifies the agent on spans and sets the OTel service name.
On Vercel, the default destination sends completed spans through the active
request context. In other environments, OTel selects its automatic destination.

To supply an exporter, configure `otel`:

```ts
import { batchSpanProcessor } from "./adapters/batch-span-processor.js";

const configuration = {
  sampler: "always_on" as const,
  spanProcessors: [batchSpanProcessor(exporter)],
};
const tracing = createAgentTracing({
  agentName: "support",
  otel: configuration,
});
```

Here, `exporter` is your application's OTel span exporter. The configuration
supplies the complete destination list. It also accepts resource attributes,
propagators, instrumentations, and metric readers.

Tracing instances share registration for the same agent name and configuration
object. A conflicting configuration or an existing external provider causes an
error. Register tracing once at application startup.

## Record a turn

Supply your application identity and turn sequence:

```ts
const turn = await tracing.turn({
  identity: {
    conversationId: "conversation-123",
    runId: "run-456",
    turnId: "turn-789",
  },
  sequence: 0,
  framework: { name: "my-agent-runtime", version: "1.0" },
});

const attempt = await turn?.attempt({ stepIndex: 0, attempt: 0 });
const model = await attempt?.modelCall({
  provider: "example-provider",
  modelId: "example-model",
});
```

The library creates this structure:

```text
invoke_agent support
└── agent.step
    └── chat example-model
```

The step index identifies the logical step. The attempt number identifies its
retry. Each constructor call creates a separate physical operation.
Keep each handle until its operation ends.

`turn()` returns `undefined` if trace setup for that operation fails.
Optional handles let the application continue execution.

## Run and complete operations

Supply execution as the second argument to use an around pointcut. The library
activates context and completes each span in `finally`:

```ts
const result = await tracing.turn({ identity, sequence: 0 }, (turn) =>
  turn!.attempt({ stepIndex: 0, attempt: 0 }, (attempt) =>
    attempt.action({ callId: "lookup-1", name: "lookup" }, (action) =>
      action.toolExecution({}, () => lookup()),
    ),
  ),
);
```

Turns, attempts, actions, approvals, tools, model calls, and memory handles
accept around execution. Supply a `describe` function in metadata to record
domain results. Model-call pointcuts require a description with the finish
reason and usage. Approval descriptions select approved or denied outcomes.

```ts
await attempt.modelCall(
  {
    provider: "example-provider",
    modelId: "example-model",
    describe: (result) => ({ outcome: "completed" as const, result }),
  },
  () => callModel(),
);

await action.approval(
  {
    requestId: "approval-1",
    describe: (accepted) => ({ outcome: accepted ? "approved" : "denied" }),
  },
  () => requestApproval(),
);

await tracing.request({ method: "GET", route: "/customers" }, () => handleRequest());
await tracing.mcp.list({ connectionName: "catalog" }, () => client.listTools());
await tracing.mcp.call({ connectionName: "catalog", toolName: "lookup" }, () => client.callTool());
```

Around pointcuts return the original result and rethrow the original error.
Result-description and completion failures preserve application results.
MCP calls inside an active tool attach their data to that tool span.
Complete streaming work inside the execution function before it returns.

For work completed by another worker, create a handle with one argument and
complete that handle when the terminal event arrives.

Call `run()` to make an operation's context active. HTTP and database spans
created during execution can use that operation as their parent.

```ts
try {
  const result = model === undefined ? await callModel() : await model.run(() => callModel());

  await model?.complete({
    outcome: "completed",
    result: {
      finishReason: "stop",
      usage: { inputTokens: 12, outputTokens: 8 },
    },
  });
  await attempt?.complete({ outcome: "completed" });
  await turn?.complete({ outcome: "completed" });
  return result;
} catch (error) {
  const failure = {
    outcome: "failed" as const,
    errorType: error instanceof Error ? error.name : "_OTHER",
    error,
  };
  await model?.complete(failure);
  await attempt?.complete(failure);
  await turn?.complete(failure);
  throw error;
}
```

Here, `callModel()` is your application's model call. Supply its actual finish
reason and usage. Model usage is added to the parent operations.
Complete children before their parents. For streaming calls, complete the model
after the stream ends.

Use `{ outcome: "cancelled" }` for a cancelled turn or attempt.
An attempt also accepts gateway costs through `cost()`.

## Record actions, approvals, and tools

An attempt creates actions. Each action creates its approval and tool operations:

```ts
const action = await attempt?.action({
  callId: "lookup-1",
  name: "lookup",
  arguments: { customerId: "customer-123" },
});
const approval = await action?.approval({ requestId: "approval-1" });
await approval?.complete({ outcome: "approved" });

const tool = await action?.toolExecution();
try {
  const result = tool === undefined ? await lookup() : await tool.run(() => lookup());

  await tool?.complete({ outcome: "completed", output: result });
  await action?.complete({ outcome: "completed", output: result });
} catch (error) {
  const failure = {
    outcome: "failed" as const,
    errorType: error instanceof Error ? error.name : "_OTHER",
    error,
  };
  await tool?.complete(failure);
  await action?.complete(failure);
  throw error;
}
```

Here, `lookup()` is your tool implementation. The action supplies the tool name,
call ID, and arguments. An error-valued result must use the failed outcome even
when the tool promise resolves.

For a denied approval, complete the approval and reject the action:

```ts
await approval?.complete({ outcome: "denied", response: "Approval declined" });
await action?.complete({ outcome: "rejected" });
```

The parent structure is:

```text
turn
└── attempt
    ├── model call
    └── action
        ├── approval
        └── tool execution
```

## Record memory operations

Wrap a memory operation with an around pointcut. Supply metadata first and
execution second:

```ts
const result = await turn!.run(() =>
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
```

Use `tracing.memory.write(data, execute)` for writes. Each method returns the
original result, records thrown errors, and completes its span automatically.
The active operation supplies the parent context. Add `describe` to metadata
when the result contains a record count or records to capture.

Turns, attempts, and actions can create memory operations:

```ts
const memory = await attempt?.memory({
  operation: "search_memory",
  phase: "retrieve",
  slot: "history",
  storeId: "customer-history",
});
await memory?.complete({ outcome: "completed", recordCount: 3 });
```

Use `upsert_memory` to record a write. Supply the actual record count and any
permitted records when the operation ends.

## Select content capture

Content capture is disabled by default. Set permissions when you create the turn:

```ts
const turn = await tracing.turn({
  identity,
  sequence: 0,
  capture: { emit: true, recordInputs: true, recordOutputs: false },
});
```

`emit` permits recording. `recordInputs` and `recordOutputs` select content in
each direction. Children inherit the parent's effective permissions. The sampler
can decline the trace. Nested execution can make permissions more restrictive.
The library limits serialized content and retained tool data.

## Connect runtime events

Translate lifecycle events into typed methods:

| Runtime event         | Tracing method           |
| --------------------- | ------------------------ |
| Turn starts           | `tracing.turn()`         |
| Attempt starts        | `turn.attempt()`         |
| Model call starts     | `attempt.modelCall()`    |
| Action starts         | `attempt.action()`       |
| Approval starts       | `action.approval()`      |
| Tool execution starts | `action.toolExecution()` |
| Operation ends        | `handle.complete()`      |

Keep handles in adapter state until completion events arrive. Scope that state
to one run, or key maps by run and turn IDs for concurrent execution.
The HarnessAgent integration test demonstrates this event translation.

## Continue stored operations

Runtime adapters can reconstruct operations through `resolve(record, options)`.
Supply the stored identity, operation description, reference, parent, start time,
and capture decision. This uses the same private construction path as typed
methods.

Use `{ deferred: true }` when a later worker completes the operation. The library
emits that span at completion. Keep the original reference and start time across
workers. Trace references preserve W3C tracestate.

For tool events that arrive before their action parent, runtime adapters use
`toolCall()`, `actionAvailable()`, `completeTool()`, and `endAttempt()`.
These methods retain the tool result until its parent arrives, then attach and
complete the tool span.

## Export and close

Flush completed spans at a runtime boundary:

```ts
await tracing.forceFlush();
```

Close tracing when the process ends:

```ts
await tracing.shutdown();
```

On Vercel, complete spans while their request context is available.
Trace output uses `TRACE_SCHEMA_VERSION = 4`.
