import type { CaptureDecision } from "#tracing/lib/core/types.js";

export interface PointcutOperation<R> {
  run<T>(execute: () => T, ceiling?: CaptureDecision): T;
  complete(result: R): Promise<void>;
}

export async function aroundOperation<T, R>(input: {
  start: () => Promise<PointcutOperation<R> | undefined> | PointcutOperation<R> | undefined;
  execute: () => T | PromiseLike<T>;
  completed: (value: T) => R;
  failed: (error: unknown) => R;
  fallback: R;
  diagnostic?: (code: string) => void;
}): Promise<T> {
  const report = () => {
    try {
      input.diagnostic?.("agent.tracing.pointcut.failed");
    } catch {}
  };
  let operation: PointcutOperation<R> | undefined;
  try {
    operation = await input.start();
  } catch {
    report();
  }
  let completion = input.fallback;
  try {
    const value = await (operation === undefined ? input.execute() : operation.run(input.execute));
    try {
      completion = input.completed(value);
    } catch {
      report();
    }
    return value;
  } catch (error) {
    completion = input.failed(error);
    throw error;
  } finally {
    try {
      await operation?.complete(completion);
    } catch {
      report();
    }
  }
}
