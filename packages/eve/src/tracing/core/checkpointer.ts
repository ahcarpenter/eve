import type { TraceCheckpointer } from "#tracing/core/scope-lifecycle.js";

export function guardedCheckpointer(
  checkpointer: TraceCheckpointer | undefined,
  diagnostic?: (code: string) => void,
): TraceCheckpointer | undefined {
  if (checkpointer === undefined) return undefined;
  async function perform<T>(execute: () => Promise<T>): Promise<T | undefined> {
    try {
      return await execute();
    } catch {
      try {
        diagnostic?.("agent.tracing.checkpoint.failed");
      } catch {}
      return undefined;
    }
  }
  return {
    load: (key) => perform(() => checkpointer.load(key)),
    save: async (record) => {
      await perform(() => checkpointer.save(record));
    },
    remove: async (key) => {
      await perform(() => checkpointer.remove(key));
    },
  };
}
