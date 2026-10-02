---
issue: TBD
status: proposed
last_updated: "2026-10-02"
---

# Agent tracing library

## Decision

Extract the tracing behavior used by eve into `tracing/lib/`. Keep eve event
translation, trusted policy, checkpoint codecs, and installation outside the
library in `tracing/eve/` and the existing instrumentation modules.

The library has no callback authoring DSL or standalone AI SDK tracing pipeline.
Those interfaces had no production consumer. eve's SDK event bridge uses shared
payload conversion without installing a second SDK instrumentation path.

## Runtime interface

Create `createAgentTracing({ serviceName, otel? })` at application startup. The
factory owns OTel registration, stable IDs, sampling, default serialization,
flush, and shutdown. On Vercel the default destination reports through request
context immediately. Explicit OTel configuration supplies the full destination
list. eve discovers and collects its declarations, then passes
`otel: collected.configuration`; the library does not discover files.

Instances share one registration for the same service name and configuration.
Conflicting configuration and unrelated global providers fail explicitly.
Operations are live by default. eve selects deferred emission per resolved
operation when its workflow lifetime requires it, not through factory-wide mode.

Pass semantic operation records to `resolve`.
eve's codec supplies existing IDs, parent references, start times, capture
permissions, and operation metadata. Invalid records return no handle.

Operation-specific handles expose context activation and discriminated
completion outcomes. Attempt handles also create model-call handles and accept
gateway costs. Model completion includes model results and usage. Approval
completion distinguishes approval, denial, cancellation, and failure.

The recorder does not run application work. It does not expose a parallel
checkpoint format or load, save, or remove workflow state. eve retains its
existing checkpoint formats, scheduler, transactions, and replay ownership.

Tool calls can start before action events arrive. `toolCall` supplies semantic
tool input, an execution key, an action key, an attempt group, and a fallback
reference. The recorder reserves the tool reference and retains MCP enrichment
and terminal state. `actionAvailable` attaches the action parent. `completeTool`
records the outcome. `endAttempt` drains unresolved tools using the fallback.
eve does not maintain separate tool-correlation maps.

`createTransportLifecycle` records channel requests and MCP operations.
`createMcpTracing` reuses active tool operations for MCP calls. It creates
standalone MCP spans only when no tool operation is active.

## Topology and output contract

```text
eve lifecycle events and checkpoint codec ──> trace recorder ──┐
eve SDK bridge ──> shared payload conversion ─────────────────┤
channel requests and MCP calls ──> transport lifecycle ────────┤
                                                             ↓
                                                       trace engine
                                                             ↓
                                                OTel + eve output profile
```

Preserve turn → attempt → model/action → approval/tool parentage. Attempts emit
`agent.step`. Memory spans use their runtime-selected parent. Channel requests
and dispatch links remain separate from agent parentage.

Preserve existing span names, GenAI attributes, terminal events, usage, error
classes, W3C tracestate, and Vercel session attribution. The library owns
`TRACE_SCHEMA_VERSION = 4`; eve's profile does not rewrite it. Extraction changes
ownership, not the ingestion schema.

The eve output profile translates attributes and link attributes only. It
retains legacy `eve.link.type`, connection keys, channel-request keys, and
Vercel attribution. It cannot change span names or link references.

Use explicit parent references to construct spans and the host context manager
to activate operations. The backend accepts opaque host context so unrelated
host context survives activation. Do not replace global OTel registration or
use raw-span bridges, fake tracers, or proxy instrumentation.

## Privacy, durability, and failures

Capture permissions can decrease but cannot increase. Unsampled operations must
not retain content. Bound and detach retained tool data; do not retain arbitrary
application payloads until delayed parent attachment. Denied capture excludes
exception details but preserves error classes.

Durable output uses eve's ID generator and sampler preparation. Preserve IDs,
parents, and timestamps from existing checkpoints. Do not add a second durable
driver or storage service. Workflow concurrency and export deduplication remain
runtime responsibilities.

Tracing failures must not replace application results or errors. Failed context
installation uses host suppression when available and never retries an entered
application callback. Invalid checkpoint records disable only the affected
trace operation.

## Delivery and validation

Keep design, library implementation, and eve integration in separate draft
stack layers. All `tracing/lib/` implementation changes belong in the library
layer. The integration layer must not change library implementation.

Keep tests at the production boundary: recorder correlation and checkpoint
resolution, OTel context/output, eve runtime instrumentation, and installed
pipeline topology. Do not retain production APIs solely for library tests.

Run focused unit and integration tests, typecheck, lint, invariants, and docs
checks. Installed-pipeline e2e and live Agent Runs export require CI/platform
validation.
