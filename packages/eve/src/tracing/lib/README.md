# Agent tracing

Use this library to record agent execution as OpenTelemetry (OTel) spans.
Each span describes one operation, its parent, its result, and its duration.
The library records turns, attempts, model calls, actions, approvals, tools,
memory operations, channel requests, and MCP calls.

## Set up tracing

Create tracing once, before the application accepts requests:

```ts
import { createAgentTracing } from "./agent-tracing.js";

const tracing = createAgentTracing({ serviceName: "support" });
```

`serviceName` identifies the application in OTel. The factory registers the
provider and sets up trace IDs, sampling, content serialization, and export.
On Vercel, the default destination sends completed spans through the active
request context. In other environments, OTel selects its automatic destination.

To configure destinations, supply `otel`. For example, send spans to an exporter:

```ts
import { batchSpanProcessor } from "./adapters/batch-span-processor.js";

const tracing = createAgentTracing({
  serviceName: "support",
  otel: {
    resource: { "service.version": "1.0" },
    sampler: "always_on",
    spanProcessors: [batchSpanProcessor(exporter)],
  },
});
```

Here, `exporter` is an OTel span exporter supplied by your application.
The `otel` configuration supplies the complete destination list. It also accepts
propagators, instrumentations, and metric readers.

Multiple tracing instances share registration when they use the same service
name and configuration object. A different configuration causes an error.
An existing provider registered by another component also causes an error.

## Define operation identity

A conversation can contain multiple runs. Each run can contain multiple turns.
A turn contains attempts. An attempt contains model calls and actions.

```text
turn
└── attempt
    ├── model call
    └── action
        ├── approval
        └── tool execution
```

Use application IDs for the conversation, run, and turn:

```ts
const identity = {
  conversationId: "conversation-123",
  runId: "run-456",
  turnId: "turn-789",
  agentName: "support",
  framework: { name: "my-agent-runtime", version: "1.0" },
};

const capture = {
  emit: true,
  recordInputs: false,
  recordOutputs: false,
};
```

`emit` permits span recording. `recordInputs` and `recordOutputs` permit content
capture in each direction. Use the same capture decision for related operations.
Nested execution can make these permissions more restrictive.

Operation keys identify physical executions. Include the run ID, turn ID,
operation type, and attempt number. Use a different key for each retry.
Use the original key when reconstructing the same execution from stored state.

## Record a turn and attempt

First, reserve the turn reference. Then, resolve the turn record into a handle:

```ts
const turnKey = JSON.stringify([identity.runId, identity.turnId, "turn"]);
const turnRecord = {
  key: turnKey,
  identity,
  data: { type: "activation" as const, options: { sequence: 0 } },
  capture,
  reference: tracing.reserve({ key: turnKey, traceFlags: 1 }),
  startTimeMs: Date.now(),
};

if (!tracing.sample(turnRecord)) {
  turnRecord.capture = {
    emit: false,
    recordInputs: false,
    recordOutputs: false,
  };
  turnRecord.reference = { ...turnRecord.reference, traceFlags: 0 };
}

const turn = await tracing.resolve(turnRecord);
```

`sample()` applies the configured sampler to the turn name and attributes.
`resolve()` returns `undefined` if recording setup fails or the record is invalid.
Use an optional handle so application execution can continue.

Next, record an attempt under the turn:

```ts
const attemptKey = JSON.stringify([
  identity.runId,
  identity.turnId,
  "attempt",
  0, // Step index.
  0, // Retry number.
]);

const attempt = await tracing.resolve({
  key: attemptKey,
  identity,
  data: { type: "step", options: { index: 0, attempt: 0 } },
  capture: turnRecord.capture,
  reference: tracing.reserve({
    key: attemptKey,
    parent: turnRecord.reference,
    traceFlags: turnRecord.reference.traceFlags,
  }),
  parent: turnRecord.reference,
  startTimeMs: Date.now(),
});
```

The emitted attempt span has the name `agent.step`. The turn span has the name
`invoke_agent support`.

## Record a model call

An attempt handle creates a model-call handle. Call `run()` to make its context
active while the model executes. HTTP and database spans can then use that parent.

```ts
const model = await attempt?.modelCall(
  { provider: "example-provider", modelId: "example-model" },
  JSON.stringify([attemptKey, "model", 0]),
);

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
  await turn?.complete({
    outcome: "completed",
    usage: { inputTokens: 12, outputTokens: 8 },
  });

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
reason and usage to `complete()`. Shared SDK conversion functions can prepare
model content and usage from SDK events.

Complete child operations before their parents. For a cancelled turn, use
`{ outcome: "cancelled" }`.

## Record an action and tool execution

Create an action record under the attempt. Its `callId` identifies the logical
tool call. Its key identifies the action execution:

```ts
const actionKey = JSON.stringify([attemptKey, "action", "lookup-1"]);
const actionReference = tracing.reserve({
  key: actionKey,
  parent: attempt!.reference,
  traceFlags: attempt!.reference.traceFlags,
});

const action = await tracing.resolve({
  key: actionKey,
  identity,
  data: { type: "action", options: { callId: "lookup-1", name: "lookup" } },
  capture: turnRecord.capture,
  reference: actionReference,
  parent: attempt!.reference,
  startTimeMs: Date.now(),
});

const executionKey = JSON.stringify([actionKey, "execution", 0]);
tracing.toolCall({
  identity,
  executionKey,
  actionKey,
  group: attemptKey,
  callId: "lookup-1",
  name: "lookup",
  capture: turnRecord.capture,
  fallback: attempt!.reference,
});
await tracing.actionAvailable(actionKey, actionReference);
```

This example assumes the attempt handle exists. In an application adapter, skip
child tracing when parent setup fails and continue the application operation.

Run and complete the tool:

```ts
const execution = tracing.toolExecution(executionKey);
try {
  const result = execution === undefined ? await lookup() : await execution.run(() => lookup());

  await tracing.completeTool(executionKey, { outcome: "completed", output: result });
  await action?.complete({ outcome: "completed", output: result });
} catch (error) {
  const failure = {
    outcome: "failed" as const,
    errorType: error instanceof Error ? error.name : "_OTHER",
    error,
  };
  await tracing.completeTool(executionKey, failure);
  await action?.complete(failure);
  throw error;
} finally {
  await tracing.endAttempt(attemptKey);
}
```

Here, `lookup()` is your application's tool implementation. A tool call can
arrive before its action record. The recorder keeps the tool result until
`actionAvailable()` supplies the parent. `endAttempt()` completes pending tools
with their fallback parent.

## Record approvals and memory operations

Resolve an approval record under its action. Include `requestId`, `callId`, and
`actionName` in the record options. Complete the handle with the actual decision:

```ts
await approval?.complete({ outcome: "denied", response: "Approval declined" });
await action?.complete({ outcome: "rejected" });
```

For memory records, set the operation to `search_memory` or `upsert_memory`.
Supply `phase`, `slot`, and `storeId`. Complete a memory handle with its result:

```ts
await memory?.complete({ outcome: "completed", recordCount: 3 });
```

## Connect runtime events

Translate your runtime's events into tracing operations:

| Runtime event         | Tracing operation                                     |
| --------------------- | ----------------------------------------------------- |
| Turn starts           | Resolve an activation record.                         |
| Attempt starts        | Resolve a step record.                                |
| Model call starts     | Call `attempt.modelCall()`.                           |
| Model call ends       | Complete the model handle with usage and result data. |
| Tool execution starts | Resolve an action and call `toolCall()`.              |
| Tool execution ends   | Call `completeTool()` and complete the action.        |
| Attempt ends          | Call `endAttempt()` and complete the attempt.         |
| Turn ends             | Complete the turn with its outcome and total usage.   |

Keep handles in your adapter until their completion events arrive. Scope adapter
state to one run, or use run and turn IDs as map keys for concurrent execution.

For streaming calls, complete the model after the stream ends. Complete the turn
after all child work ends. For operations reported after execution, use the
original start time in the record.

## Continue across processes

Store operation keys, identity, references, parent references, start times, and
capture decisions with your runtime state. Pass those values to `resolve()` in
the process that continues execution.

Use `resolve(record, { deferred: true })` when the operation ends in a later
worker. The library emits that span when you call `complete()`.
The stored reference lets child spans use the same parent across workers.

Trace references preserve W3C tracestate. Use the original capture decision when
you continue execution, and apply any stricter local permissions.

## Export and close

Flush at a runtime boundary where completed spans must be sent:

```ts
await tracing.forceFlush();
```

Close tracing when the application process ends:

```ts
await tracing.shutdown();
```

On Vercel, complete spans while their request context is available.
Trace output uses `TRACE_SCHEMA_VERSION = 4`.
