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
  it.each(["root", "child"])(
    "keeps typed access and executes once after %s span setup fails",
    async (failureAt) => {
      const idGenerator = new AgentSpanIdGenerator();
      const exporter = new InMemorySpanExporter();
      const provider = new BasicTracerProvider({
        idGenerator,
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      const backend = durableOtelBackend({
        tracer: provider.getTracer("failure"),
        idGenerator,
        samplesTrace: () => true,
      });
      const start = backend.start;
      let calls = 0;
      backend.start = (...args) => {
        if (++calls === (failureAt === "root" ? 1 : 2)) throw new Error("span setup");
        return start(...args);
      };
      const recorder = createTraceRecorder({
        output: backend,
        serializer: aiSdkContentSerializer,
        mode: "live",
      });
      try {
        const turn = await recorder.beginTurn({
          identity,
          metadata: { sequence: 0 },
          capture,
          key: "failure",
        });
        let executions = 0;
        const result = await turn.attempt({ stepIndex: 0, attempt: 0 }, (attempt) =>
          attempt.action({ callId: "call", name: "lookup" }, (action) =>
            action.toolExecution({}, async (tool) => {
              expect(tool.capture).toEqual({
                emit: false,
                recordInputs: false,
                recordOutputs: false,
              });
              executions++;
              return "original";
            }),
          ),
        );
        expect(result).toBe("original");
        expect(executions).toBe(1);
        const error = new TypeError("original failure");
        await expect(
          turn.attempt({ stepIndex: 1, attempt: 0 }, async () => {
            throw error;
          }),
        ).rejects.toBe(error);
        await turn.complete({ outcome: "completed" });
        expect(
          exporter.getFinishedSpans().some((span) => span.name === "execute_tool lookup"),
        ).toBe(false);
      } finally {
        await provider.shutdown();
      }
    },
  );
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
