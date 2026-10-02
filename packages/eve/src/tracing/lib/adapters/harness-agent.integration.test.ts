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
import type { ScopeData, ScopeRecord } from "#tracing/lib/core/scope-lifecycle.js";
import type { TraceReference } from "#tracing/lib/core/types.js";
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
  const capture = { emit: true, recordInputs: false, recordOutputs: false };
  let turn: TurnOperation | undefined;
  let attempt: AttemptOperation | undefined;
  let model: ModelOperation | undefined;
  let stepKey = "";
  const actions = new Map<string, ActionOperation>();
  const key = (...parts: unknown[]) => JSON.stringify([identity.runId, identity.turnId, ...parts]);
  function resolve<K extends ScopeData["type"]>(
    operationKey: string,
    data: Extract<ScopeData, { type: K }>,
    parent?: TraceReference,
  ) {
    const reference = recorder.reserve({ key: operationKey, parent, traceFlags: 1 });
    const record: ScopeRecord & { data: Extract<ScopeData, { type: K }> } = {
      key: operationKey,
      identity,
      data,
      capture,
      reference,
      parent,
      startTimeMs: Date.now(),
    };
    return recorder.resolve<K>(record);
  }
  return {
    executeTool({ toolCallId, execute }) {
      const operation = recorder.toolExecution(key("execution", toolCallId));
      return operation === undefined ? execute() : operation.run(execute);
    },
    async onStart() {
      turn = await resolve(key("turn"), { type: "activation", options: { sequence: 0 } });
    },
    async onStepStart(event) {
      if (turn === undefined) return;
      stepKey = key("attempt", event.stepNumber);
      attempt = await resolve(
        stepKey,
        { type: "step", options: { index: event.stepNumber, attempt: 0 } },
        turn.reference,
      );
    },
    async onLanguageModelCallStart(event) {
      model = await attempt?.modelCall(
        { provider: event.provider, modelId: event.modelId },
        key("model", stepKey),
      );
    },
    async onLanguageModelCallEnd(event) {
      await model?.complete({
        outcome: "completed",
        result: { finishReason: event.finishReason, usage: modelUsage(event.usage) },
      });
      model = undefined;
    },
    async onToolExecutionStart(event) {
      if (attempt === undefined) return;
      const call = event.toolCall;
      const actionKey = key("action", call.toolCallId);
      const action = await resolve(
        actionKey,
        { type: "action", options: { callId: call.toolCallId, name: call.toolName } },
        attempt.reference,
      );
      if (action === undefined) return;
      actions.set(call.toolCallId, action);
      recorder.toolCall({
        identity,
        executionKey: key("execution", call.toolCallId),
        actionKey,
        group: stepKey,
        callId: call.toolCallId,
        name: call.toolName,
        fallback: attempt.reference,
        capture,
      });
      await recorder.actionAvailable(actionKey, action.reference);
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
      await recorder.completeTool(key("execution", event.toolCall.toolCallId), completion);
      await actions.get(event.toolCall.toolCallId)?.complete(completion);
      actions.delete(event.toolCall.toolCallId);
    },
    async onStepEnd() {
      await recorder.endAttempt(stepKey);
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
      await recorder.endAttempt(stepKey, { error });
      for (const action of actions.values()) await action.complete(completion);
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
  it("reports through Vercel request context without explicit OTel setup", async () => {
    const reportSpans = vi.fn();
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubGlobal(Symbol.for("@vercel/request-context"), {
      get: () => ({ headers: {}, waitUntil() {}, telemetry: { reportSpans } }),
    });
    const tracing = createAgentTracing({ serviceName: "vercel-harness" });
    try {
      const reference = tracing.reserve({ key: "vercel-root", traceFlags: 1 });
      const turn = await tracing.resolve({
        key: "vercel-root",
        identity: {
          conversationId: "vercel-conversation",
          runId: "vercel-run",
          turnId: "turn",
          agentName: "support",
          framework: { name: "harness", version: "1" },
        },
        data: { type: "activation", options: { sequence: 0 } },
        capture: { emit: true, recordInputs: false, recordOutputs: false },
        reference,
        startTimeMs: Date.now(),
      });
      await turn!.complete({ outcome: "completed" });
      expect(reportSpans).toHaveBeenCalledOnce();
      expect(JSON.stringify(reportSpans.mock.calls[0])).toContain("invoke_agent support");
      expect(() => createAgentTracing({ serviceName: "different-service" })).toThrow(
        /already owns OpenTelemetry/,
      );
      const another = createAgentTracing({ serviceName: "vercel-harness" });
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
        serviceName: "harness",
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
