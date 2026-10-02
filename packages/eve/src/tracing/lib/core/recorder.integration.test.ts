import { describe, expect, it } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createTraceRecorder } from "#tracing/lib/core/recorder.js";
import { durableOtelBackend } from "#tracing/lib/adapters/otel.js";
import { aiSdkContentSerializer } from "#tracing/lib/adapters/serialization.js";
import { AgentSpanIdGenerator } from "#tracing/lib/adapters/otel-ids.js";
import { eveOutputMapping } from "#tracing/eve/profile.js";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

const identity = {
  conversationId: "conversation",
  runId: "run",
  turnId: "turn",
  framework: { name: "eve", version: "1" },
};
const capture = { emit: true, recordInputs: false, recordOutputs: false };

function setup() {
  const idGenerator = new AgentSpanIdGenerator();
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    idGenerator,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const output = durableOtelBackend({
    tracer: provider.getTracer("recorder"),
    idGenerator,
    samplesTrace: () => true,
    mapping: eveOutputMapping(),
  });
  return {
    provider,
    exporter,
    recorder: createTraceRecorder({ output, serializer: aiSdkContentSerializer, mode: "live" }),
  };
}

describe("trace recorder", () => {
  it("rejects corrupt checkpoint records without starting spans", async () => {
    const runtime = setup();
    try {
      const result = await runtime.recorder.resolve({ key: "invalid" } as Parameters<
        typeof runtime.recorder.resolve
      >[0]);
      expect(result).toBeUndefined();
      expect(runtime.exporter.getFinishedSpans()).toHaveLength(0);
    } finally {
      await runtime.provider.shutdown();
    }
  });

  it("retains pending tool enrichment and terminal state until its action parent attaches", async () => {
    const runtime = setup();
    const manager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(manager);
    try {
      const recorder = runtime.recorder;
      const parent = { traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 };
      const action = { ...parent, spanId: "3".repeat(16) };
      recorder.toolCall({
        identity,
        executionKey: "tool",
        actionKey: "action",
        group: "attempt",
        callId: "call",
        name: "lookup",
        fallback: parent,
        capture,
      });
      const operation = recorder.toolExecution("tool")!;
      operation.run(() =>
        recorder
          .active()
          ?.mcp?.update({ connectionName: "catalog", method: "tools/call", requestId: "7" }),
      );
      await recorder.completeTool("tool", { outcome: "completed", output: "secret" });
      expect(runtime.exporter.getFinishedSpans()).toHaveLength(0);
      await recorder.actionAvailable("action", action);
      const [span] = runtime.exporter.getFinishedSpans();
      expect(span?.parentSpanContext?.spanId).toBe(action.spanId);
      expect(span?.attributes["jsonrpc.request.id"]).toBe("7");
      expect(span?.spanContext().spanId).toBe(operation.reference.spanId);
      expect(JSON.stringify(span?.attributes)).not.toContain("secret");
      expect(recorder.toolExecution("tool")).toBeUndefined();
    } finally {
      context.disable();
      manager.disable();
      await runtime.provider.shutdown();
    }
  });

  it("inherits output attribution and tracestate from eve checkpoint records", async () => {
    const runtime = setup();
    try {
      const recorder = runtime.recorder;
      const reference = {
        traceId: "1".repeat(32),
        spanId: "2".repeat(16),
        traceFlags: 1,
        tracestate: "vendor=state",
      };
      const parent = { ...reference, spanId: "3".repeat(16), tracestate: "vendor=parent" };
      const attempt = await recorder.resolve({
        key: "attempt",
        identity,
        data: { type: "step", options: { index: 0 } },
        capture,
        reference,
        parent,
        startTimeMs: Date.now(),
        outputContext: { platform: "vercel", traceSessionId: "remote-session" },
      });
      const model = await attempt!.modelCall({ provider: "provider", modelId: "model" }, "model");
      await model.complete({ outcome: "completed", result: { finishReason: "stop", usage: {} } });
      await attempt!.complete({ outcome: "completed" });
      const spans = runtime.exporter.getFinishedSpans();
      expect(spans.every((span) => span.attributes["vercel.session_id"] === "remote-session")).toBe(
        true,
      );
      const modelSpan = spans.find((span) => span.name === "chat model")!;
      expect(modelSpan.parentSpanContext?.spanId).toBe(reference.spanId);
      expect(modelSpan.parentSpanContext?.traceState?.serialize()).toBe("vendor=state");
      const step = spans.find((span) => span.name === "agent.step")!;
      expect(step.parentSpanContext?.traceState?.serialize()).toBe("vendor=parent");
      expect(step.spanContext().spanId).toBe(reference.spanId);
    } finally {
      await runtime.provider.shutdown();
    }
  });
});
