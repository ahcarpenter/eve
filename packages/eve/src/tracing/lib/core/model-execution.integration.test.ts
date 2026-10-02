import { describe, expect, it } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createTraceRecorder } from "#tracing/lib/core/recorder.js";
import { durableOtelBackend } from "#tracing/lib/adapters/otel.js";
import { AgentSpanIdGenerator } from "#tracing/lib/adapters/otel-ids.js";
import { aiSdkContentSerializer } from "#tracing/lib/adapters/serialization.js";
import type { ModelCompletion } from "#tracing/lib/core/model.js";

function setup(recordOutputs = true) {
  const exporter = new InMemorySpanExporter();
  const idGenerator = new AgentSpanIdGenerator();
  const provider = new BasicTracerProvider({
    idGenerator,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracing = createTraceRecorder({
    output: durableOtelBackend({
      tracer: provider.getTracer("model-execution"),
      idGenerator,
      samplesTrace: () => true,
    }),
    serializer: aiSdkContentSerializer,
    mode: "live",
  });
  return {
    exporter,
    provider,
    turn: () =>
      tracing.beginTurn({
        identity: {
          conversationId: "conversation",
          runId: "run",
          turnId: "turn",
          framework: { name: "test", version: "1" },
        },
        metadata: { sequence: 0 },
        capture: { emit: true, recordInputs: false, recordOutputs },
        key: "turn",
      }),
  };
}

const response: ModelCompletion = {
  finishReason: "stop",
  usage: { inputTokens: 3, outputTokens: 2 },
  content: [
    { type: "reasoning", text: "Consider the request" },
    { type: "text", text: "Alice's answer" },
  ],
  responseId: "response-id",
  responseModelId: "resolved-model",
};

describe("model execution results", () => {
  it.each([true, false])(
    "unwraps model results and applies output capture %s",
    async (recordOutputs) => {
      const runtime = setup(recordOutputs);
      try {
        const turn = await runtime.turn();
        const result = { text: "Alice's answer" };
        expect(
          await turn.attempt({ stepIndex: 0, attempt: 0 }, (attempt) =>
            attempt.modelCall({ provider: "provider", modelId: "model" }, async () => ({
              result,
              ...response,
            })),
          ),
        ).toBe(result);
        await turn.complete({ outcome: "completed" });
        const spans = runtime.exporter.getFinishedSpans();
        const model = spans.find((span) => span.name === "chat model")!;
        expect(model.attributes).toMatchObject({
          "gen_ai.response.id": "response-id",
          "gen_ai.response.model": "resolved-model",
          "gen_ai.usage.input_tokens": 3,
        });
        if (recordOutputs)
          expect(JSON.parse(model.attributes["gen_ai.output.messages"] as string)).toEqual([
            {
              role: "assistant",
              finish_reason: "stop",
              parts: [
                { type: "reasoning", content: "Consider the request" },
                { type: "text", content: "Alice's answer" },
              ],
            },
          ]);
        else expect(model.attributes["gen_ai.output.messages"]).toBeUndefined();
        expect(
          spans.find((span) => span.name.startsWith("invoke_agent"))?.attributes[
            "gen_ai.usage.output_tokens"
          ],
        ).toBe(2);
        const failedTurn = await runtime.turn();
        const failedAttempt = await failedTurn.attempt({ stepIndex: 1, attempt: 0 });
        const error = new TypeError("original model error");
        await expect(
          failedAttempt.modelCall({ provider: "provider", modelId: "failed-model" }, async () => {
            throw error;
          }),
        ).rejects.toBe(error);
        await failedAttempt.complete({ outcome: "failed", errorType: "TypeError", error });
        await failedTurn.complete({ outcome: "failed", errorType: "TypeError", error });
        expect(
          runtime.exporter.getFinishedSpans().find((span) => span.name === "chat failed-model")
            ?.attributes["error.type"],
        ).toBe("TypeError");
      } finally {
        await runtime.provider.shutdown();
      }
    },
  );

  it.each(["completed", "failed", "cancelled"] as const)(
    "returns streams before consumption and finalizes on %s",
    async (outcome) => {
      const runtime = setup();
      try {
        const turn = await runtime.turn();
        const attempt = await turn.attempt({ stepIndex: 0, attempt: 0 });
        const completion = Promise.withResolvers<ModelCompletion>();
        const failure = new TypeError("stream failed");
        let pulls = 0;
        const source = new ReadableStream<string>(
          {
            pull(controller) {
              pulls++;
              if (outcome === "failed") {
                controller.error(failure);
                completion.reject(failure);
              } else {
                controller.enqueue("Alice's answer");
                controller.close();
                completion.resolve(response);
              }
            },
            cancel() {
              completion.reject(new DOMException("Cancelled", "AbortError"));
            },
          },
          { highWaterMark: 0 },
        );
        const stream = await attempt.modelStream(
          { provider: "provider", modelId: "model" },
          () => ({ result: source, completion: completion.promise }),
        );
        expect(stream).toBe(source);
        expect(pulls).toBe(0);
        expect(runtime.exporter.getFinishedSpans()).toHaveLength(0);
        let ended = false;
        const parentCompletion = turn.complete({ outcome: "completed" }).then(() => {
          ended = true;
        });
        await Promise.resolve();
        expect(ended).toBe(false);
        if (outcome === "cancelled") await stream.cancel();
        else if (outcome === "failed")
          await expect(stream.getReader().read()).rejects.toBe(failure);
        else expect(await stream.getReader().read()).toMatchObject({ value: "Alice's answer" });
        await parentCompletion;
        const spans = runtime.exporter.getFinishedSpans();
        const model = spans.find((span) => span.name === "chat model")!;
        expect(model.status.code).toBe(outcome === "completed" ? 0 : 2);
        if (outcome === "completed") {
          expect(model.attributes["gen_ai.output.messages"]).toContain("Alice's answer");
          expect(
            spans.find((span) => span.name.startsWith("invoke_agent"))?.attributes[
              "gen_ai.usage.input_tokens"
            ],
          ).toBe(3);
        } else
          expect(model.attributes["error.type"]).toBe(
            outcome === "cancelled" ? "AbortError" : "TypeError",
          );
        expect(spans.map((span) => span.name)).toEqual([
          "chat model",
          "agent.step",
          "invoke_agent",
        ]);
      } finally {
        await runtime.provider.shutdown();
      }
    },
  );
});
