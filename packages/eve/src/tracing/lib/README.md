# Agent tracing

This internal library owns trace topology, attributes, context activation, and
completion. These modules are not public package exports.

## Application tracing

Install an OTel provider and context manager first. SDK setup selects its own
serializer and telemetry binding:

```ts
const tracing = createAiSdkTracing({
  agent: { name: "support" },
  output: liveOtelBackend(tracer),
  content: { inputs: false, outputs: false },
  integrations: existingTelemetry,
});

await tracing.turn(turnInput, async (turn) => {
  return generateText({ model, messages, tools, telemetry: tracing.telemetry(turn) });
});
```

The application object does not expose runtime recording or transport methods.
Consume streams and await child work inside the callback. The library does not
retry callbacks or consume streams on the application's behalf.

Manual tracing uses `turn.attempt`, `attempt.modelCall`, `attempt.action`,
`action.toolExecution`, and `action.approval`. Result descriptions are required
for domain outcomes. A resolved approval callback does not imply acceptance:

```ts
await action.approval({ requestId }, requestApproval, (accepted) => ({
  outcome: accepted ? "approved" : "denied",
}));
```

Callbacks retain their original return values. Description and completion errors
do not replace successful callback results. Thrown application errors retain
their original identity. API attempts still emit `agent.step` spans.

## Runtime recording

Create `createTraceRecorder` separately with an explicit `live` or `durable` mode.
Durable mode requires reserved-ID support at construction. Operation-specific
handles expose `complete` with discriminated outcomes. Model handles do not expose
approval or tool constructors.

The runtime calls `snapshot()` and persists the detached state in its existing
checkpoint transaction. `restore(snapshot, ceiling)` reconstructs that state
without replaying application callbacks. Tracing does not load, save, or remove
workflow records. A store does not determine span lifetime.

Snapshots have version 1 and omit denied payloads. Serialization is bounded;
oversized or malformed content is omitted. Capture permissions can decrease but
cannot increase. A later local decrease cannot remove already exported or
committed content. The runtime owns concurrent writes and export deduplication.

eve's internal codec retains its existing checkpoint formats. eve uses typed
recorder handles and explicit completion outcomes. Tool-call bindings accept
semantic inputs; the recorder owns reservation, correlation, late action
attachment, and fallback completion. Corrupt snapshots disable tracing for the
affected operation without stopping valid runtime work.

## Output and protocol bindings

SDK, request, and MCP bindings use the same operation implementation. MCP reuses
an active tool operation instead of adding a duplicate call span. Protocol data
passes through semantic methods, never attribute maps.

The library owns trace schema version 4 for both neutral and eve output. The
private eve profile retains existing link keys and Vercel session attribution. Profiles cannot
change span names or link references, or restore denied content. Portable
references preserve W3C tracestate.

Global registration, trusted policy, workflow ownership, destination filtering,
local storage, and Agent Runs request-context export stay outside the recorder.
