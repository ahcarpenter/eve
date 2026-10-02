import { describe, expect, it } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createTracingRuntime as createAgentTracing } from "#tracing/core/agent-tracing.js";
import { createTraceLifecycle, type ScopeRecord } from "#tracing/core/scopes.js";
import { durableOtelBackend, liveOtelBackend } from "#tracing/adapters/otel.js";
import { aiSdkContentSerializer } from "#tracing/adapters/serializer.js";
import { AgentSpanIdGenerator } from "#tracing/adapters/otel-ids.js";
import { eveOutputMapping } from "#tracing/core/profiles/eve.js";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { createMcpTracing } from "#tracing/adapters/mcp.js";
import { createAiSdkTracing } from "#tracing/adapters/ai-sdk.js";
import { createTraceRecorder } from "#tracing/core/recorder.js";

describe("constructed agent trace scopes", () => {
  it("rejects corrupt snapshots and detaches bounded content before restore", async () => {
    const idGenerator = new AgentSpanIdGenerator();
    const provider = new BasicTracerProvider({ idGenerator });
    try {
      const output = durableOtelBackend({
        tracer: provider.getTracer("snapshots"),
        idGenerator,
        samplesTrace: () => true,
      });
      const recorder = createTraceRecorder({
        output,
        serializer: aiSdkContentSerializer,
        mode: "durable",
      });
      expect(
        await recorder.restore(
          { version: 99 },
          { emit: true, recordInputs: true, recordOutputs: true },
        ),
      ).toBeUndefined();
      const turn = await recorder.beginTurn({
        identity: {
          conversationId: "conversation",
          runId: "run",
          turnId: "turn",
          framework: { name: "custom", version: "1" },
        },
        metadata: { sequence: 0 },
        capture: { emit: true, recordInputs: true, recordOutputs: true },
        binding: { key: "turn" },
      });
      const payload = { value: "before" };
      const action = await (
        await turn!.attempt({ index: 0 }, "attempt")
      ).action({ callId: "call", name: "lookup", arguments: payload }, "action");
      const snapshot = action.snapshot();
      payload.value = "after";
      expect(JSON.stringify(snapshot)).toContain("before");
      expect(JSON.stringify(snapshot)).not.toContain("after");
      const restored = await recorder.restore(snapshot, {
        emit: true,
        recordInputs: false,
        recordOutputs: false,
      });
      expect(JSON.stringify(restored?.snapshot())).not.toContain("before");
      expect(restored?.reference).toEqual(action.reference);
      expect(restored?.snapshot().startTimeMs).toBe(snapshot.startTimeMs);
      const oversized = await (
        await turn!.attempt({ index: 1 }, "large-attempt")
      ).action(
        { callId: "large", name: "lookup", arguments: { text: "x".repeat(100000) } },
        "large-action",
      );
      expect(
        new TextEncoder().encode(JSON.stringify(oversized.snapshot())).length,
      ).toBeLessThanOrEqual(65536);
      expect(JSON.stringify(oversized.snapshot())).not.toContain("x".repeat(100));
      await action.run(async () => undefined, {
        emit: true,
        recordInputs: false,
        recordOutputs: false,
      });
      expect(JSON.stringify(action.snapshot())).not.toContain("after");
    } finally {
      await provider.shutdown();
    }
  });

  it("preserves results and errors when serializers and result descriptions fail", async () => {
    const provider = new BasicTracerProvider();
    try {
      const serializer = {
        ...aiSdkContentSerializer,
        json() {
          throw new Error("serializer");
        },
      };
      const tracing = createAgentTracing({
        adapter: { backend: liveOtelBackend(provider.getTracer("failures")), serializer },
        content: { recordInputs: true, recordOutputs: true },
      });
      const result = await tracing.turn(
        { conversationId: "c", runId: "r", turnId: "t", sequence: 0 },
        (turn) =>
          turn.attempt({ stepIndex: 0, attempt: 0 }, (attempt) =>
            attempt.action(
              { callId: "call", name: "lookup", arguments: { value: "secret" } },
              async () => "original",
              () => {
                throw new Error("description");
              },
            ),
          ),
      );
      expect(result).toBe("original");
      const error = new TypeError("original error");
      await expect(
        tracing.turn(
          { conversationId: "c", runId: "r", turnId: "failed", sequence: 0 },
          async () => {
            throw error;
          },
        ),
      ).rejects.toBe(error);
    } finally {
      await provider.shutdown();
    }
  });
  it("separates application tracing from typed runtime operations and records denial explicitly", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    try {
      const output = liveOtelBackend(provider.getTracer("interfaces"));
      const tracing = createAiSdkTracing({ agent: { name: "support" }, output });
      expect("lifecycle" in tracing || "reserve" in tracing || "integrations" in tracing).toBe(
        false,
      );
      await tracing.turn(
        { conversationId: "conversation", runId: "run", turnId: "turn", sequence: 0 },
        (turn) =>
          turn.attempt({ stepIndex: 0, attempt: 0 }, (attempt) =>
            attempt.action(
              { callId: "call", name: "lookup" },
              (action) =>
                action.approval(
                  { requestId: "request" },
                  async () => false,
                  (approved) => ({ outcome: approved ? "approved" : "denied" }),
                ),
              () => ({ outcome: "rejected" }),
            ),
          ),
      );
      expect(
        exporter.getFinishedSpans().find((span) => span.name === "agent.approval")?.attributes[
          "agent.approval.outcome"
        ],
      ).toBe("denied");
      const recorder = createTraceRecorder({
        output,
        serializer: aiSdkContentSerializer,
        mode: "live",
      });
      const turn = await recorder.beginTurn({
        identity: {
          conversationId: "conversation",
          runId: "run",
          turnId: "typed",
          framework: { name: "custom", version: "1" },
        },
        metadata: { sequence: 0 },
        capture: { emit: true, recordInputs: false, recordOutputs: false },
        binding: { key: "typed" },
      });
      const model = await (
        await turn!.attempt({ index: 0 }, "attempt")
      ).modelCall({ provider: "provider", modelId: "model" }, "model");
      expect("approval" in model || "toolExecution" in model).toBe(false);
      await model.complete({ outcome: "completed", result: { finishReason: "stop", usage: {} } });
      await turn!.complete({ outcome: "completed" });
    } finally {
      await provider.shutdown();
    }
  });
  it("runs callbacks exactly once under suppression when context installation fails", async () => {
    const provider = new BasicTracerProvider();
    try {
      const output = liveOtelBackend(provider.getTracer("context-failure"));
      let executions = 0;
      let suppressions = 0;
      output.run = () => {
        throw new Error("context installation");
      };
      output.suppressed = (execute) => {
        suppressions++;
        return execute();
      };
      const tracing = createAiSdkTracing({ output });
      expect(
        await tracing.turn(
          { conversationId: "c", runId: "r", turnId: "t", sequence: 0 },
          async () => {
            executions++;
            return "original";
          },
        ),
      ).toBe("original");
      expect(executions).toBe(1);
      expect(suppressions).toBe(1);
    } finally {
      await provider.shutdown();
    }
  });
  it("retains pending tool enrichment and terminal state until its action parent attaches", async () => {
    const idGenerator = new AgentSpanIdGenerator();
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      idGenerator,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    try {
      const tracing = createAgentTracing({
        adapter: {
          backend: durableOtelBackend({
            tracer: provider.getTracer("pending"),
            idGenerator,
            samplesTrace: () => true,
          }),
          serializer: aiSdkContentSerializer,
        },
      });
      const parent = { traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 };
      const action = { ...parent, spanId: "3".repeat(16) };
      const operation = tracing.lifecycle.toolCall({
        executionKey: "tool",
        actionKey: "action",
        callId: "call",
        name: "lookup",
        identity: {
          conversationId: "conversation",
          runId: "run",
          turnId: "turn",
          framework: { name: "custom", version: "1" },
        },
        fallback: parent,
        capture: { emit: true, recordInputs: false, recordOutputs: false },
      });
      operation.mcp.update({ connectionName: "catalog", method: "tools/call", requestId: "7" });
      await operation.finish({ output: "secret" });
      expect(exporter.getFinishedSpans()).toHaveLength(0);
      await operation.attach(action);
      const [span] = exporter.getFinishedSpans();
      expect(span?.parentSpanContext?.spanId).toBe(action.spanId);
      expect(span?.attributes["jsonrpc.request.id"]).toBe("7");
      expect(span?.spanContext().spanId).toBe(operation.reference.spanId);
      expect(JSON.stringify(span?.attributes)).not.toContain("secret");
    } finally {
      await provider.shutdown();
    }
  });
  it("activates callback tools across awaits and narrows nested MCP capture without duplicate spans", async () => {
    const manager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(manager);
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    try {
      const tracing = createAgentTracing({
        adapter: {
          backend: liveOtelBackend(provider.getTracer("active")),
          serializer: aiSdkContentSerializer,
          mcp: createMcpTracing,
        },
        content: { recordInputs: true, recordOutputs: true },
      });
      await tracing.turn(
        { conversationId: "conversation", runId: "run", turnId: "turn", sequence: 0 },
        (turn) =>
          turn.attempt({ stepIndex: 0, attempt: 0 }, (step) =>
            step.action(
              { callId: "call", name: "lookup" },
              (action) =>
                action.toolExecution(
                  { executionId: "execution" },
                  async () => {
                    await Promise.resolve();
                    expect(tracing.lifecycle.active()?.type).toBe("tool");
                    await tracing.lifecycle.run(
                      tracing.lifecycle.active()!.reference,
                      { emit: true, recordInputs: false, recordOutputs: false },
                      async () => {
                        await Promise.resolve();
                        tracing.lifecycle.active()?.mcp?.arguments("secret");
                        await tracing.lifecycle.run(
                          tracing.lifecycle.active()!.reference,
                          { emit: true, recordInputs: true, recordOutputs: true },
                          async () => {
                            await Promise.resolve();
                            expect(tracing.lifecycle.active()?.capture.recordOutputs).toBe(false);
                            tracing.lifecycle.active()?.mcp?.result("secret");
                          },
                        );
                        await tracing.mcpAdapter!.call({
                          connectionName: "catalog",
                          toolName: "lookup",
                          arguments: "secret",
                          execute: async () => "secret",
                        });
                      },
                    );
                    return "result";
                  },
                  (value) => ({ outcome: "completed", output: value }),
                ),
              () => ({ outcome: "completed" }),
            ),
          ),
      );
      expect(tracing.lifecycle.active()).toBeUndefined();
      const spans = exporter.getFinishedSpans();
      expect(spans.filter((span) => span.name === "execute_tool lookup")).toHaveLength(1);
      expect(spans.filter((span) => span.name.startsWith("tools/call"))).toHaveLength(0);
      expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("secret");
    } finally {
      context.disable();
      manager.disable();
      await provider.shutdown();
    }
  });

  it("preserves callback results and application errors without library-owned checkpoint IO", async () => {
    const idGenerator = new AgentSpanIdGenerator();
    const provider = new BasicTracerProvider({ idGenerator });
    try {
      const tracing = createAgentTracing({
        adapter: {
          backend: durableOtelBackend({
            tracer: provider.getTracer("checkpoint"),
            idGenerator,
            samplesTrace: () => true,
          }),
          serializer: aiSdkContentSerializer,
        },
      });
      const input = { conversationId: "conversation", runId: "run", turnId: "turn", sequence: 0 };
      expect(await tracing.turn(input, async () => "result")).toBe("result");
      const error = new TypeError("application");
      await expect(
        tracing.turn({ ...input, turnId: "failed" }, async () => {
          throw error;
        }),
      ).rejects.toBe(error);
    } finally {
      await provider.shutdown();
    }
  });
  it("omits checkpoint content when the root sampler declines emission", async () => {
    const provider = new BasicTracerProvider({ idGenerator: new AgentSpanIdGenerator() });
    const records = new Map<string, ScopeRecord>();
    const idGenerator = new AgentSpanIdGenerator();
    try {
      const tracing = createAgentTracing({
        adapter: {
          backend: durableOtelBackend({
            tracer: provider.getTracer("unsampled"),
            idGenerator,
            samplesTrace: () => false,
          }),
          serializer: aiSdkContentSerializer,
        },
        mode: "durable",
      });
      const turn = await tracing.lifecycle.turn(
        {
          conversationId: "conversation",
          runId: "run",
          turnId: "turn",
          framework: { name: "custom", version: "1" },
        },
        { sequence: 0, title: "secret title" },
        { emit: true, recordInputs: true, recordOutputs: true },
        { key: "turn" },
      );
      const step = await turn.step({ index: 0 });
      const action = await step.action({
        callId: "call",
        name: "lookup",
        arguments: "secret input",
      });
      for (const operation of [turn, step, action])
        records.set(operation.snapshot().key, operation.snapshot());
      expect(JSON.stringify([...records.values()])).not.toContain("secret");
      expect(
        [...records.values()].every(
          (record) =>
            !record.capture.emit && !record.capture.recordInputs && !record.capture.recordOutputs,
        ),
      ).toBe(true);
    } finally {
      await provider.shutdown();
    }
  });

  it("keeps error classes without exception details through callback and MCP lifecycles", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    try {
      const tracing = createAgentTracing({
        adapter: {
          backend: liveOtelBackend(provider.getTracer("errors")),
          serializer: aiSdkContentSerializer,
        },
      });
      await expect(
        tracing.turn(
          { conversationId: "conversation", runId: "run", turnId: "turn", sequence: 0 },
          async (turn) => {
            await turn.attempt({ stepIndex: 0, attempt: 0 }, async (step) => {
              await step.modelCall(
                { provider: "provider", modelId: "model" },
                async () => {
                  throw new TypeError("secret");
                },
                () => ({ finishReason: "stop", usage: {} }),
              );
            });
          },
        ),
      ).rejects.toThrow("secret");
      const mcp = tracing.lifecycle.mcp({
        method: "tools/list",
        connectionName: "catalog",
        capture: { emit: true, recordInputs: false, recordOutputs: false },
      });
      mcp.failed(new RangeError("secret"));
      const spans = exporter.getFinishedSpans();
      expect(spans.find((span) => span.name === "chat model")?.attributes["error.type"]).toBe(
        "TypeError",
      );
      expect(spans.find((span) => span.name === "tools/list")?.attributes["error.type"]).toBe(
        "RangeError",
      );
      expect(spans.every((span) => span.events.every((event) => event.name !== "exception"))).toBe(
        true,
      );
      expect(
        JSON.stringify(spans.map((span) => ({ attributes: span.attributes, status: span.status }))),
      ).not.toContain("secret");
    } finally {
      await provider.shutdown();
    }
  });
  it("constructs a complete callback topology without exposing spans or persistence", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    try {
      const tracing = createAgentTracing({
        adapter: {
          backend: liveOtelBackend(provider.getTracer("dsl")),
          serializer: aiSdkContentSerializer,
        },
        agentName: "support",
        framework: { name: "custom", version: "1" },
      });
      const value = await tracing.turn(
        { conversationId: "conversation", runId: "run", turnId: "turn", sequence: 0 },
        (turn) =>
          turn.attempt({ stepIndex: 0, attempt: 0 }, async (step) => {
            await step.modelCall(
              { provider: "provider", modelId: "model" },
              async () => "answer",
              () => ({ finishReason: "stop", usage: { inputTokens: 3, outputTokens: 2 } }),
            );
            return step.action(
              { callId: "lookup", name: "lookup" },
              async (action) => {
                expect(
                  "checkpoint" in action ||
                    "resume" in action ||
                    "setAttribute" in action ||
                    "step" in action ||
                    "action" in action,
                ).toBe(false);
                await action.approval(
                  { requestId: "request" },
                  async () => true,
                  () => ({ outcome: "approved" }),
                );
                return action.toolExecution(
                  { executionId: "execution" },
                  async () => "result",
                  (value) => ({ outcome: "completed", output: value }),
                );
              },
              () => ({ outcome: "completed" }),
            );
          }),
      );
      expect(value).toBe("result");
      const spans = exporter.getFinishedSpans();
      const root = spans.find((span) => span.name === "invoke_agent support")!;
      const step = spans.find((span) => span.name === "agent.step")!;
      const action = spans.find((span) => span.name === "agent.action")!;
      expect(step.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
      expect(action.parentSpanContext?.spanId).toBe(step.spanContext().spanId);
      expect(spans.find((span) => span.name === "chat model")!.parentSpanContext?.spanId).toBe(
        step.spanContext().spanId,
      );
      expect(
        spans
          .filter((span) => span.name === "agent.approval" || span.name === "execute_tool lookup")
          .every((span) => span.parentSpanContext?.spanId === action.spanContext().spanId),
      ).toBe(true);
      expect(root.attributes["gen_ai.usage.input_tokens"]).toBe(3);
    } finally {
      await provider.shutdown();
    }
  });

  it("exposes lifecycle beneath the DSL and starts and settles operations once", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    try {
      const tracing = createAgentTracing({
        adapter: {
          backend: liveOtelBackend(provider.getTracer("lifecycle")),
          serializer: aiSdkContentSerializer,
        },
        agentName: "support",
        framework: { name: "custom", version: "1" },
      });
      const turn = await tracing.lifecycle.turn(
        {
          conversationId: "conversation",
          runId: "run",
          turnId: "turn",
          agentName: "support",
          framework: { name: "custom", version: "1" },
        },
        { sequence: 0 },
        { emit: true, recordInputs: false, recordOutputs: false },
      );
      const step = await turn.step({ index: 0 });
      await step.started();
      await step.started();
      const action = await step.action({ callId: "call", name: "lookup" });
      const tool = await action.tool();
      await tool.completed({ output: "private" });
      await tool.completed({ output: "duplicate" });
      await action.completed();
      await step.completed();
      await turn.completed();
      const spans = exporter.getFinishedSpans();
      expect(spans.filter((span) => span.name === "execute_tool lookup")).toHaveLength(1);
      expect(
        spans.find((span) => span.name === "agent.step")!.events.map((event) => event.name),
      ).toEqual(["step.started", "step.completed"]);
      expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("private");
    } finally {
      await provider.shutdown();
    }
  });

  it("restores a suspended action in a new runtime without replaying callbacks or broadening capture", async () => {
    const exporter = new InMemorySpanExporter();
    const idGenerator = new AgentSpanIdGenerator();
    const provider = new BasicTracerProvider({
      idGenerator,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const records = new Map<string, ScopeRecord>();
    try {
      const backend = durableOtelBackend({
        tracer: provider.getTracer("durable-dsl"),
        idGenerator,
        samplesTrace: () => true,
      });
      const options = { backend, serializer: aiSdkContentSerializer, mode: "durable" as const };
      const before = createTraceLifecycle(options);
      const capture = { emit: true, recordInputs: false, recordOutputs: false };
      const turn = await before.turn(
        {
          conversationId: "conversation",
          runId: "run",
          turnId: "turn",
          agentName: "support",
          framework: { name: "custom", version: "1" },
        },
        { sequence: 0 },
        capture,
        { key: "turn" },
      );
      const step = await turn.step({ index: 0 }, { key: "step" });
      const action = await step.action(
        { callId: "call", name: "lookup", arguments: "secret input" },
        { key: "action" },
      );
      const approval = await action.approval(
        { requestId: "request", request: "secret request" },
        { key: "approval" },
      );
      for (const operation of [turn, step, action, approval])
        records.set(operation.snapshot().key, operation.snapshot());
      const original = action.reference;
      expect(exporter.getFinishedSpans()).toHaveLength(0);
      expect(JSON.stringify([...records.values()])).not.toContain("secret input");
      const after = createTraceLifecycle(options);
      const restored = await after.restore(records.get("action")!, {
        emit: true,
        recordInputs: true,
        recordOutputs: true,
      });
      await (
        await after.restore(records.get("approval")!, capture)
      ).finish({ outcome: "approved" });
      expect(restored!.reference).toEqual(original);
      let executions = 0;
      await (restored!.authoring as import("#tracing/core/scopes.js").ActionScope).toolExecution(
        { executionId: "execution" },
        async () => {
          executions++;
          return "secret output";
        },
        (value) => ({ outcome: "completed", output: value }),
      );
      await restored!.finish({ output: "secret output" });
      await (await after.restore(records.get("step")!, capture)).finish();
      await (await after.restore(records.get("turn")!, capture)).finish();
      expect(executions).toBe(1);
      expect(records.size).toBe(4);
      const spans = exporter.getFinishedSpans();
      expect(
        spans.find((span) => span.name === "execute_tool lookup")!.parentSpanContext?.spanId,
      ).toBe(original.spanId);
      expect(spans.find((span) => span.name === "agent.action")!.spanContext().spanId).toBe(
        original.spanId,
      );
      expect(spans.find((span) => span.name === "agent.approval")!.parentSpanContext?.spanId).toBe(
        original.spanId,
      );
      expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("secret");
    } finally {
      await provider.shutdown();
    }
  });

  it("resolves an external checkpoint record and inherits output attribution through construction", async () => {
    const exporter = new InMemorySpanExporter();
    const idGenerator = new AgentSpanIdGenerator();
    const provider = new BasicTracerProvider({
      idGenerator,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    try {
      const lifecycle = createTraceLifecycle({
        serializer: aiSdkContentSerializer,
        backend: durableOtelBackend({
          tracer: provider.getTracer("records"),
          idGenerator,
          samplesTrace: () => true,
          mapping: eveOutputMapping(),
        }),
      });
      const record: ScopeRecord = {
        key: "step",
        identity: {
          conversationId: "conversation",
          runId: "run",
          turnId: "turn",
          agentName: "support",
          framework: { name: "custom", version: "1" },
        },
        data: { type: "step", options: { index: 0 } },
        capture: { emit: true, recordInputs: false, recordOutputs: false },
        reference: {
          traceId: "1".repeat(32),
          spanId: "2".repeat(16),
          traceFlags: 1,
          tracestate: "vendor=state",
        },
        parent: {
          traceId: "1".repeat(32),
          spanId: "3".repeat(16),
          traceFlags: 1,
          tracestate: "vendor=parent",
        },
        startTimeMs: Date.now(),
        outputContext: { platform: "vercel", traceSessionId: "remote-session" },
      };
      const step = await lifecycle.resolve(record);
      const model = await step.model({ provider: "provider", modelId: "model" });
      await model.completed({ model: { finishReason: "stop", usage: {} } });
      await step.completed();
      const spans = exporter.getFinishedSpans();
      expect(spans.every((span) => span.attributes["vercel.session_id"] === "remote-session")).toBe(
        true,
      );
      expect(spans.find((span) => span.name === "chat model")!.parentSpanContext?.spanId).toBe(
        record.reference.spanId,
      );
      expect(
        spans
          .find((span) => span.name === "chat model")!
          .parentSpanContext?.traceState?.serialize(),
      ).toBe("vendor=state");
      expect(
        spans
          .find((span) => span.name === "agent.step")!
          .parentSpanContext?.traceState?.serialize(),
      ).toBe("vendor=parent");
      expect(spans.find((span) => span.name === "agent.step")!.spanContext().spanId).toBe(
        record.reference.spanId,
      );
    } finally {
      await provider.shutdown();
    }
  });
});
