# Agent tracing

This internal library records eve runtime operations and request/MCP transports.
These modules are not public package exports. There is no callback authoring API
or standalone AI SDK instrumentation pipeline.

Create tracing at application startup:

```ts
const tracing = createAgentTracing({ serviceName: "support" });
```

The factory owns process-wide OTel registration, stable IDs, sampling, default
serialization, and flush/shutdown. On Vercel the default destination reports
immediately through request context. An explicit `otel` configuration supplies
the complete destination list; it does not add another automatic destination.
Instances share registration when service name and configuration are identical.
Conflicting configuration or an unrelated global provider fails explicitly.
Initialize before requests and shut down once when the process ends.

eve discovers its own declarations and passes `otel: collected.configuration`.
The library does not load instrumentation files or infer trusted capture policy.

Tracing resolves semantic records supplied by eve's checkpoint
codec. Operation-specific handles activate context and complete operations with
explicit outcomes. Attempts create model-call handles. Other operations resolve
from runtime events; the library does not run agent work or manage checkpoints.

Tool-call inputs reserve references inside the recorder. The recorder retains
MCP enrichment and terminal state until the action parent is available, then
attaches and completes the tool span. Attempt completion drains remaining tools.
Retained tool payloads are detached and bounded. Capture permissions can decrease
but cannot increase.

`createTransportLifecycle` records channel requests and MCP operations.
`createMcpTracing` reuses an active tool operation rather than adding a duplicate
call span. eve's SDK event bridge uses the shared payload conversions, not a
separate SDK tracing adapter.

The library owns trace schema version 4. eve's output profile retains existing
link keys and Vercel attribution without rewriting the schema version. Portable
references preserve W3C tracestate.

`tracing/eve/` owns trusted policy, workflow/checkpoint integration, declaration
discovery, and audience-aware destination filtering. `tracing/local/` owns trace
storage and viewer queries. The library owns OTel registration, batching, and
Vercel request-context export; it does not import eve or local tracing modules.
