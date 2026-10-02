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

## Choose a calling style

Agent operations support two calling styles. Both create the same spans.

| Style             | Arguments                             | Who ends the span?                                 | Use when                                                                             |
| ----------------- | ------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Wrapped execution | Metadata, then an execution function. | The library, after the function returns or throws. | You can supply the function that performs the work.                                  |
| Lifecycle handle  | Metadata only.                        | You, through `handle.complete(result)`.            | Start and completion arrive as separate events, or work continues in another worker. |

### Wrapped execution

Use wrapped execution for ordinary calls:

```ts
const result = await attempt.modelCall(
  {
    provider: "example-provider",
    modelId: "example-model",
  },
  async () => {
    const response = await callModel();
    return {
      result: response,
      finishReason: response.finishReason,
      usage: response.usage,
      content: response.content,
      responseId: response.responseId,
      responseModelId: response.responseModelId,
    };
  },
);
```

The first argument describes the operation. The second argument performs it.
The library starts the span, activates its context, and calls the function once.
It records the result or error and ends the span in `finally`.
The call returns the original result or rethrows the original error.

Wrapped model execution returns an envelope with `result` and response metadata.
Tracing records the metadata and returns `result` unchanged. With wrapped
execution, you do not call `complete()`.

Other operation types use `describe` to convert an application result into
trace data. That function does not end the span.

### Lifecycle handle

Omit the execution function to receive a handle:

```ts
const model = await attempt.modelCall({
  provider: "example-provider",
  modelId: "example-model",
});

// When the separate completion event arrives:
await model.complete({
  outcome: "completed",
  result: { finishReason: "stop", usage: { inputTokens: 12, outputTokens: 8 } },
});
```

Keep the handle until the operation ends. Call `complete()` with its actual
outcome. If you execute work locally, `handle.run(execute)` activates context;
it does not end the span. Complete child handles before their parents.

The request, MCP, and `tracing.memory.search()`/`write()` methods wrap execution.
Their spans complete automatically.

## Create operation handles

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

const attempt = await turn.attempt({ stepIndex: 0, attempt: 0 });
const model = await attempt.modelCall({
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

Operation creation always returns a typed handle. If span setup fails, the
handle disables emission. Its child methods remain available, and execution
callbacks still execute exactly once.

## Wrap execution

Supply execution as the second argument to wrap the operation. The library
activates context and completes each span in `finally`:

```ts
const result = await tracing.turn({ identity, sequence: 0 }, (turn) =>
  turn.attempt({ stepIndex: 0, attempt: 0 }, (attempt) =>
    attempt.action({ callId: "lookup-1", name: "lookup" }, (action) =>
      action.toolExecution({}, () => lookup()),
    ),
  ),
);
```

Turns, attempts, actions, approvals, tools, model calls, and memory handles
accept wrapped execution. Supply a `describe` function in metadata to record
domain results for actions and approvals. Wrapped model calls return response
metadata with the application result. Approval descriptions select approved or denied outcomes.

```ts
await attempt.modelCall(
  {
    provider: "example-provider",
    modelId: "example-model",
  },
  async () => {
    const response = await callModel();
    return {
      result: response,
      finishReason: response.finishReason,
      usage: response.usage,
      content: response.content,
      responseId: response.responseId,
      responseModelId: response.responseModelId,
    };
  },
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

Wrapped execution returns the original result and rethrows the original error.
Result-description and completion failures preserve application results.
MCP calls inside an active tool attach their data to that tool span.
Complete streaming work inside the execution function before it returns.

For work completed by another worker, create a handle with one argument and
complete that handle when the terminal event arrives.

Wrapped execution completes the model automatically:

```ts
const result = await attempt.modelCall(
  {
    provider: "example-provider",
    modelId: "example-model",
  },
  async () => {
    const response = await callModel();
    return {
      result: response,
      finishReason: response.finishReason,
      usage: response.usage,
      content: response.content,
      responseId: response.responseId,
      responseModelId: response.responseModelId,
    };
  },
);
```

Here, `callModel()` supplies the actual finish reason and usage. Model usage is
added to parent operations. Consume streams inside the execution function.
The library records thrown errors and completes the model in `finally`.

An attempt also accepts gateway costs through `cost()`.

## Stream model output

`modelStream(data, execute)` returns the stream result immediately. Its execution
function returns the result and a separate completion promise:

```ts
interface ModelCompletion {
  finishReason: string;
  usage: Usage;
  content: readonly ContentPart[];
  responseId?: string;
  responseModelId?: string;
}
interface ModelCallReturn<T> extends ModelCompletion {
  result: T;
}
interface ModelStreamReturn<T> {
  result: T;
  completion: PromiseLike<ModelCompletion>;
}
```

`Usage` and `ContentPart` are library-owned types. SDK adapters convert provider
types to these shapes.
`content` contains completed text, reasoning, and tool content. The serializer
uses that content for `gen_ai.output.messages` when output capture is permitted.

```ts
const stream = await attempt.modelStream({ provider, modelId, messages }, () => {
  const response = startModelStream();
  return {
    result: response.stream,
    completion: response.completion,
  };
});

for await (const part of stream) {
  sendToClient(part);
}
```

Here, your adapter's `startModelStream()` observes natural completion, errors,
and cancellation. It resolves `completion` with the completed response or
rejects it with the stream error. Tracing observes that promise without reading
the stream. Parent spans wait for pending model completions before export.

AI SDK completion getters can consume streams automatically. An adapter must
observe lifecycle completion rather than eagerly read those getters before
returning the stream. For a callback that consumes the entire stream itself,
use `modelCall()` and return completed metadata afterward.

Each model operation describes one physical invocation. Multi-step generation
needs a separate model operation for each invocation, not aggregate content or
usage copied onto every model span.

## Record actions, approvals, and tools

An attempt creates actions. Each action creates its approval and tool operations:

```ts
const result = await attempt.action({ callId: "lookup-1", name: "lookup" }, async (action) => {
  const accepted = await action.approval(
    {
      requestId: "approval-1",
      describe: (value) => ({ outcome: value ? "approved" : "denied" }),
    },
    () => requestApproval(),
  );

  if (!accepted) return "Approval declined";
  return action.toolExecution({}, () => lookup());
});
```

Each wrapped call completes its span automatically. Supply a `describe` function
on the action or tool metadata when a resolved value represents failure,
rejection, or cancellation.

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

Wrap a memory operation. Supply metadata first and
execution second:

```ts
const result = await turn.run(() =>
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

Turns, attempts, and actions can create memory operations. Use wrapped execution
with a result description to capture the record count:

```ts
const records = await attempt.memory(
  {
    operation: "search_memory",
    phase: "retrieve",
    slot: "history",
    storeId: "customer-history",
    describe: (values) => ({ outcome: "completed", recordCount: values.length }),
  },
  () => store.search(query),
);
```

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

| Runtime event         | Tracing method                             |
| --------------------- | ------------------------------------------ |
| Turn starts           | `tracing.turn()`                           |
| Attempt starts        | `turn.attempt()`                           |
| Model call starts     | `attempt.modelCall()`                      |
| Action starts         | `attempt.action()`                         |
| Approval starts       | `action.approval()`                        |
| Tool execution starts | `action.toolExecution()`                   |
| Operation ends        | `handle.complete()` for lifecycle handles. |

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
