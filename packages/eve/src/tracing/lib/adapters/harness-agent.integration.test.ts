import { HarnessAgent } from "@ai-sdk/harness/agent";
import type { HarnessV1, HarnessV1PromptControl, HarnessV1StreamPart } from "@ai-sdk/harness";
import type { Experimental_SandboxSession as SandboxSession } from "@ai-sdk/provider-utils";
import { z } from "zod";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";
import { createAgentTracing } from "#tracing/lib/agent-tracing.js";
import type {
  ActionOperation,
  AttemptOperation,
  ModelOperation,
  TurnOperation,
} from "#tracing/lib/core/operations.js";
import { context, trace, propagation } from "@opentelemetry/api";
import { modelUsage } from "#tracing/lib/adapters/ai-sdk-payload.js";

// Consumer-side translation: HarnessAgent owns execution; the recorder owns spans.
type HarnessTelemetry = Exclude<
  NonNullable<
    NonNullable<ConstructorParameters<typeof HarnessAgent>[0]["telemetry"]>["integrations"]
  >,
  readonly unknown[]
>;

function harnessTelemetry(
  recorder: ReturnType<typeof createAgentTracing>,
  runId: string,
): HarnessTelemetry {
  const identity = {
    conversationId: "conversation",
    runId,
    turnId: "turn",
    agentName: "support",
    framework: { name: "ai-sdk-harness", version: "1" },
  };
  let turn: TurnOperation | undefined;
  let attempt: AttemptOperation | undefined;
  let model: ModelOperation | undefined;
  const actions = new Map<
    string,
    { action: ActionOperation; tool: import("#tracing/lib/core/operations.js").ToolOperation }
  >();
  return {
    executeTool({ toolCallId, execute }) {
      const operation = actions.get(toolCallId)?.tool;
      return operation === undefined ? execute() : operation.run(execute);
    },
    async onStart() {
      turn = await recorder.turn({ identity, sequence: 0, framework: identity.framework });
    },
    async onStepStart(event) {
      attempt = await turn?.attempt({ stepIndex: event.stepNumber, attempt: 0 });
    },
    async onLanguageModelCallStart(event) {
      model = await attempt?.modelCall({ provider: event.provider, modelId: event.modelId });
    },
    async onLanguageModelCallEnd(event) {
      await model?.complete({
        outcome: "completed",
        result: { finishReason: event.finishReason, usage: modelUsage(event.usage) },
      });
      model = undefined;
    },
    async onToolExecutionStart(event) {
      const action = await attempt?.action({
        callId: event.toolCall.toolCallId,
        name: event.toolCall.toolName,
      });
      if (action !== undefined)
        actions.set(event.toolCall.toolCallId, { action, tool: await action.toolExecution() });
    },
    async onToolExecutionEnd(event) {
      const output = event.toolOutput;
      const completion =
        output.type === "tool-error"
          ? {
              outcome: "failed" as const,
              errorType: output.error instanceof Error ? output.error.name : "tool_error",
              error: output.error,
            }
          : { outcome: "completed" as const };
      const handles = actions.get(event.toolCall.toolCallId);
      await handles?.tool.complete(completion);
      await handles?.action.complete(completion);
      actions.delete(event.toolCall.toolCallId);
    },
    async onStepEnd() {
      await attempt?.complete({ outcome: "completed" });
      attempt = undefined;
    },
    async onEnd(event) {
      if (!("totalUsage" in event)) return;
      await turn?.complete({ outcome: "completed", usage: modelUsage(event.totalUsage) });
      turn = undefined;
    },
    async onError(error) {
      const completion = {
        outcome: "failed" as const,
        errorType: error instanceof Error ? error.name : "_OTHER",
        error,
      };
      await model?.complete(completion);
      for (const handles of actions.values()) {
        await handles.tool.complete(completion);
        await handles.action.complete(completion);
      }
      await attempt?.complete(completion);
      await turn?.complete(completion);
    },
  };
}

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};
const finishReason = { unified: "stop" as const, raw: undefined };

function scriptedHarness(toolFails: boolean): HarnessV1 {
  function prompt({
    emit,
  }: {
    emit: (event: HarnessV1StreamPart) => void;
  }): Promise<HarnessV1PromptControl> {
    const done = Promise.resolve().then(() => {
      emit({ type: "stream-start", modelId: "test-model" });
      emit({
        type: "tool-call",
        toolCallId: "lookup-1",
        toolName: "lookup",
        input: "{}",
        providerExecuted: true,
      });
      emit({
        type: "tool-result",
        toolCallId: "lookup-1",
        toolName: "lookup",
        result: toolFails ? "Private tool error" : "Private tool result",
        isError: toolFails,
      });
      emit({ type: "finish-step", finishReason: { unified: "tool-calls", raw: undefined }, usage });
      emit({ type: "text-start", id: "answer" });
      emit({ type: "text-delta", id: "answer", delta: "Alice's answer" });
      emit({ type: "text-end", id: "answer" });
      emit({ type: "finish-step", finishReason, usage });
      emit({
        type: "finish",
        finishReason,
        totalUsage: {
          ...usage,
          inputTokens: { ...usage.inputTokens, total: 6 },
          outputTokens: { ...usage.outputTokens, total: 4 },
        },
      });
    });
    return Promise.resolve({ done, async submitToolResult() {} });
  }
  const unsupported = async (): Promise<never> => {
    throw new Error("Not used by this harness turn");
  };
  return {
    specificationVersion: "harness-v1",
    harnessId: "scripted",
    builtinTools: { lookup: { inputSchema: z.object({}) } },
    async doStart({ sessionId }) {
      return {
        sessionId,
        isResume: false,
        doPromptTurn: prompt,
        doContinueTurn: prompt,
        doCompact: unsupported,
        doSuspendTurn: unsupported,
        doDetach: unsupported,
        doStop: unsupported,
        async doDestroy() {},
      };
    },
  };
}

const sandbox: SandboxSession = {
  description: "In-memory harness test sandbox",
  async run() {
    return { exitCode: 0, stdout: "/workspace\n", stderr: "" };
  },
  async readFile() {
    return null;
  },
  async readBinaryFile() {
    return null;
  },
  async readTextFile() {
    return null;
  },
  async writeFile() {},
  async writeBinaryFile() {},
  async writeTextFile() {},
  async spawn() {
    throw new Error("The scripted harness does not spawn processes");
  },
};

describe("HarnessAgent consumer instrumentation", () => {
  it("finalizes every around operation without explicit completion", async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = createAgentTracing({
      agentName: "around-agent",
      otel: { spanProcessors: [new SimpleSpanProcessor(exporter)] },
    });
    try {
      const value = await tracing.turn(
        { identity: { conversationId: "around", runId: "around", turnId: "turn" }, sequence: 0 },
        (turn) =>
          turn.attempt({ stepIndex: 0, attempt: 0 }, async (attempt) => {
            await attempt.modelCall(
              {
                provider: "provider",
                modelId: "model",
                describe: () => ({
                  outcome: "completed" as const,
                  result: { finishReason: "stop", usage: { inputTokens: 3 } },
                }),
              },
              async () => "answer",
            );
            return attempt.action({ callId: "lookup", name: "lookup" }, async (action) => {
              await action.approval(
                {
                  requestId: "approval",
                  describe: (accepted) => ({ outcome: accepted ? "approved" : "denied" }),
                },
                async () => true,
              );
              return action.toolExecution({}, async () =>
                tracing.mcp.call(
                  { connectionName: "catalog", toolName: "lookup" },
                  async () => "original",
                ),
              );
            });
          }),
      );
      expect(value).toBe("original");
      await tracing.request({ method: "GET", route: "/test" }, async () => ({ status: 200 }));
      await tracing.mcp.list({ connectionName: "catalog" }, async () => []);
      const spans = exporter.getFinishedSpans();
      expect(spans.map((span) => span.name).sort()).toEqual(
        [
          "agent.action",
          "agent.approval",
          "agent.channel.request",
          "agent.step",
          "chat model",
          "execute_tool lookup",
          "invoke_agent around-agent",
          "tools/list",
        ].sort(),
      );
      expect(
        spans.find((span) => span.name === "agent.approval")?.attributes["agent.approval.outcome"],
      ).toBe("approved");
      const failure = new TypeError("original");
      await expect(
        tracing.turn(
          {
            identity: { conversationId: "around", runId: "failed", turnId: "failed" },
            sequence: 0,
          },
          (turn) =>
            turn.attempt({ stepIndex: 0, attempt: 0 }, async () => {
              throw failure;
            }),
        ),
      ).rejects.toBe(failure);
      expect(exporter.getFinishedSpans().filter((span) => span.status.code === 2)).toHaveLength(2);
    } finally {
      await tracing.shutdown();
      trace.disable();
      propagation.disable();
      context.disable();
    }
  });
  it("finalizes memory pointcuts and preserves application values and errors", async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = createAgentTracing({
      agentName: "memory-agent",
      otel: { spanProcessors: [new SimpleSpanProcessor(exporter)] },
    });
    try {
      const turn = (await tracing.turn({
        identity: { conversationId: "memory", runId: "memory", turnId: "turn" },
        sequence: 0,
      }))!;
      const data = {
        identity: {
          conversationId: "memory",
          runId: "memory",
          turnId: "turn",
          framework: { name: "test", version: "1" },
        },
        storeId: "store",
        slot: "history",
        phase: "retrieve",
      };
      const value = { records: ["Alice's preference"] };
      let executions = 0;
      expect(
        await turn.run(() =>
          tracing.memory.search(
            {
              ...data,
              describe: () => {
                throw new Error("description failure");
              },
            },
            async () => {
              executions++;
              return value;
            },
          ),
        ),
      ).toBe(value);
      const failure = new TypeError("write failed");
      await expect(
        turn.run(() =>
          tracing.memory.write(data, async () => {
            executions++;
            throw failure;
          }),
        ),
      ).rejects.toBe(failure);
      await turn.complete({ outcome: "completed" });
      expect(executions).toBe(2);
      const search = exporter.getFinishedSpans().find((span) => span.name === "search_memory")!;
      const write = exporter.getFinishedSpans().find((span) => span.name === "upsert_memory")!;
      expect(search.parentSpanContext?.spanId).toBe(turn.reference.spanId);
      expect(write.status.code).toBe(2);
      expect(write.attributes["error.type"]).toBe("TypeError");
      expect(write.events.some((event) => event.name === "exception")).toBe(false);
    } finally {
      await tracing.shutdown();
      trace.disable();
      propagation.disable();
      context.disable();
    }
  });
  it("constructs typed approval and memory children and applies root sampling", async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = createAgentTracing({
      agentName: "typed-agent",
      otel: { sampler: "always_on", spanProcessors: [new SimpleSpanProcessor(exporter)] },
    });
    try {
      const turn = (await tracing.turn({
        identity: { conversationId: "typed", runId: "typed", turnId: "typed" },
        sequence: 0,
      }))!;
      const attempt = await turn.attempt({ stepIndex: 0, attempt: 0 });
      const action = await attempt.action({ callId: "lookup", name: "lookup" });
      const approval = await action.approval({ requestId: "approval" });
      await approval.complete({ outcome: "denied" });
      const memory = await action.memory({
        operation: "search_memory",
        phase: "retrieve",
        slot: "history",
        storeId: "store",
      });
      await memory.complete({ outcome: "completed", recordCount: 3 });
      await action.complete({ outcome: "rejected" });
      await attempt.complete({ outcome: "completed" });
      await turn.complete({ outcome: "completed" });
      const spans = exporter.getFinishedSpans();
      expect(
        spans.find((span) => span.name === "agent.approval")?.attributes["agent.approval.outcome"],
      ).toBe("denied");
      expect(
        spans
          .filter((span) => span.name === "agent.approval" || span.name === "search_memory")
          .every((span) => span.parentSpanContext?.spanId === action.reference.spanId),
      ).toBe(true);
    } finally {
      await tracing.shutdown();
      trace.disable();
      propagation.disable();
      context.disable();
    }
    const declined = new InMemorySpanExporter();
    const unsampled = createAgentTracing({
      agentName: "unsampled",
      otel: { sampler: "always_off", spanProcessors: [new SimpleSpanProcessor(declined)] },
    });
    try {
      const turn = (await unsampled.turn({
        identity: { conversationId: "private", runId: "private", turnId: "private" },
        sequence: 0,
        capture: { emit: true, recordInputs: true, recordOutputs: true },
      }))!;
      expect(turn.capture).toEqual({ emit: false, recordInputs: false, recordOutputs: false });
      const model = await (
        await turn.attempt({ stepIndex: 0, attempt: 0 })
      ).modelCall({
        provider: "provider",
        modelId: "model",
        messages: [{ role: "user", content: "secret" }],
      });
      await model.complete({ outcome: "completed", result: { finishReason: "stop", usage: {} } });
      await turn.complete({ outcome: "completed" });
      expect(declined.getFinishedSpans()).toHaveLength(0);
    } finally {
      await unsampled.shutdown();
      trace.disable();
      propagation.disable();
      context.disable();
    }
  });
  it("reports through Vercel request context without explicit OTel setup", async () => {
    const reportSpans = vi.fn();
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubGlobal(Symbol.for("@vercel/request-context"), {
      get: () => ({ headers: {}, waitUntil() {}, telemetry: { reportSpans } }),
    });
    const tracing = createAgentTracing({ agentName: "vercel-harness" });
    try {
      const turn = await tracing.turn({
        identity: { conversationId: "vercel-conversation", runId: "vercel-run", turnId: "turn" },
        sequence: 0,
      });
      await turn.complete({ outcome: "completed" });
      expect(reportSpans).toHaveBeenCalledOnce();
      expect(JSON.stringify(reportSpans.mock.calls[0])).toContain("invoke_agent vercel-harness");
      expect(() => createAgentTracing({ agentName: "different-service" })).toThrow(
        /already owns OpenTelemetry/,
      );
      const another = createAgentTracing({ agentName: "vercel-harness" });
      expect(another.idGenerator).toBe(tracing.idGenerator);
      await Promise.all([tracing.shutdown(), another.shutdown()]);
    } finally {
      await tracing.shutdown();
      trace.disable();
      propagation.disable();
      context.disable();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
  it.each(["generate", "stream"] as const)(
    "records a real HarnessAgent %s lifecycle without eve integration",
    async (method) => {
      const exporter = new InMemorySpanExporter();
      const recorder = createAgentTracing({
        agentName: "support",
        otel: { spanProcessors: [new SimpleSpanProcessor(exporter)] },
      });
      const agent = new HarnessAgent({
        harness: scriptedHarness(method === "stream"),
        telemetry: { integrations: [harnessTelemetry(recorder, method)] },
      });
      const session = await agent.createSession({ sandboxSession: sandbox });
      try {
        let text = "";
        if (method === "generate")
          text = (await agent.generate({ session, prompt: "Help Alice inspect her project." }))
            .text;
        else {
          const result = await agent.stream({ session, prompt: "Help Alice inspect her project." });
          for await (const chunk of result.textStream) {
            text += chunk;
            expect(
              exporter.getFinishedSpans().some((span) => span.name === "invoke_agent support"),
            ).toBe(false);
          }
        }
        expect(text).toBe("Alice's answer");
        const spans = exporter.getFinishedSpans();
        const turn = spans.find((span) => span.name === "invoke_agent support")!;
        const attempts = spans.filter((span) => span.name === "agent.step");
        const models = spans.filter((span) => span.name === "chat test-model");
        const action = spans.find((span) => span.name === "agent.action")!;
        const toolSpan = spans.find((span) => span.name === "execute_tool lookup")!;
        expect(spans).toHaveLength(7);
        expect(attempts).toHaveLength(2);
        expect(models).toHaveLength(2);
        expect(
          attempts.every((span) => span.parentSpanContext?.spanId === turn.spanContext().spanId),
        ).toBe(true);
        expect(
          models.every((span) =>
            attempts.some(
              (attempt) => span.parentSpanContext?.spanId === attempt.spanContext().spanId,
            ),
          ),
        ).toBe(true);
        expect(action.parentSpanContext?.spanId).toBe(attempts[0]!.spanContext().spanId);
        expect(toolSpan.parentSpanContext?.spanId).toBe(action.spanContext().spanId);
        expect(toolSpan.status.code).toBe(method === "stream" ? 2 : 0);
        expect(turn.attributes).toMatchObject({
          "agent.trace.schema.version": 4,
          "agent.framework.name": "ai-sdk-harness",
          "gen_ai.usage.input_tokens": 6,
          "gen_ai.usage.output_tokens": 4,
        });
        expect(JSON.stringify(spans.map((span) => span.attributes))).not.toMatch(/Private|Alice/);
        expect(
          spans.every((span) =>
            Object.keys(span.attributes).every((key) => !key.startsWith("eve.")),
          ),
        ).toBe(true);
      } finally {
        await session.destroy();
        await recorder.shutdown();
        trace.disable();
        propagation.disable();
        context.disable();
      }
    },
  );
});
