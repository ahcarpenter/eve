import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { defineAgent } from "eve";

// Answers "ok" in process, so the reproduction needs no model credential.
const model = new MockLanguageModelV4({
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "ok" },
        { type: "text-end", id: "text-1" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: undefined },
          logprobs: undefined,
          usage: {
            inputTokens: {
              total: 1,
              noCache: 1,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        },
      ],
    }),
  }),
});

export default defineAgent({
  model,
  // Stated, so the build does not ask the AI Gateway catalog about a model
  // that is not in it.
  modelContextWindowTokens: 100_000,
  // Only for the local run (`npm run repro`). On Vercel this stays unset and
  // eve uses its Vercel Workflow world.
  experimental:
    process.env.REPRO_LOOPBACK === "1"
      ? { workflow: { world: "#loopback-world" } }
      : undefined,
});
