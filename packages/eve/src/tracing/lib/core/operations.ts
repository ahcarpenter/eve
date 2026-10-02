import type {
  RuntimeScope,
  ScopeRecord,
  ScopeTerminal,
  ModelOptions,
  ModelResult,
  ActionOptions,
  ApprovalOptions,
  MemoryOptions,
} from "#tracing/lib/core/scopes.js";
import type { CaptureDecision } from "#tracing/lib/core/types.js";
import { aroundOperation } from "#tracing/lib/core/pointcut.js";
import type { ModelCallReturn, ModelStreamReturn } from "#tracing/lib/core/model.js";

type Handle = { run<T>(execute: () => T): T; complete(result: never): Promise<void> };
export interface Pointcut<I, H extends Handle> {
  (input: I): Promise<H>;
  <T>(
    input: I & { describe?: (value: T) => Parameters<H["complete"]>[0] },
    execute: (operation: H) => T | PromiseLike<T>,
  ): Promise<T>;
}

function pointcut<I, H extends Handle>(
  start: (input: I) => Promise<H>,
  fallback: Parameters<H["complete"]>[0],
): Pointcut<I, H> {
  function invoke(input: I): Promise<H>;
  function invoke<T>(
    input: I & { describe?: (value: T) => Parameters<H["complete"]>[0] },
    execute: (operation: H) => T | PromiseLike<T>,
  ): Promise<T>;
  function invoke<T>(
    input: I,
    execute?: (operation: H) => T | PromiseLike<T>,
  ): Promise<H> | Promise<T> {
    if (execute === undefined) return start(input);
    let handle: H;
    const describe = (input as I & { describe?: (value: T) => Parameters<H["complete"]>[0] })
      .describe;
    return aroundOperation({
      start: async () => {
        handle = await start(input);
        return handle;
      },
      execute: () => execute(handle),
      completed: (value) => describe?.(value) ?? fallback,
      failed: (error) => ({
        outcome: "failed",
        errorType: error instanceof Error ? error.name : "_OTHER",
        error,
      }),
      fallback,
    });
  }
  return invoke;
}
export type ToolResult =
  | { outcome: "completed"; output?: unknown }
  | { outcome: "failed"; errorType: string; error?: unknown };
export type ActionResult = ToolResult | { outcome: "rejected" | "cancelled" };

type Failure = {
  outcome: "failed";
  errorType: string;
  error?: unknown;
  usage?: ScopeTerminal["usage"];
  endTimeMs?: number;
};
type TurnCompletion =
  | { outcome: "completed" | "cancelled"; usage?: ScopeTerminal["usage"] }
  | Failure;
export interface Operation<K extends ScopeRecord["data"]["type"], R> {
  readonly startTimeMs: number;
  readonly parent?: RuntimeScope["reference"];
  readonly type: K;
  readonly reference: RuntimeScope["reference"];
  readonly finished: boolean;
  readonly capture: CaptureDecision;
  run<T>(execute: () => T, ceiling?: CaptureDecision): T;
  complete(result: R): Promise<void>;
}
export interface TurnOperation extends Operation<"activation", TurnCompletion> {
  attempt: Pointcut<{ stepIndex: number; attempt: number }, AttemptOperation>;
  memory: Pointcut<MemoryOptions, MemoryOperation>;
}
export interface AttemptOperation extends Operation<
  "step",
  { outcome: "completed" | "cancelled" } | Failure
> {
  cost(input: import("#tracing/lib/core/scope-lifecycle.js").ScopeCost): void;
  modelCall(input: ModelOptions, key?: string): Promise<ModelOperation>;
  modelCall<T>(
    input: ModelOptions,
    execute: () => ModelCallReturn<T> | PromiseLike<ModelCallReturn<T>>,
  ): Promise<T>;
  modelStream<T>(
    input: ModelOptions,
    execute: () => ModelStreamReturn<T> | PromiseLike<ModelStreamReturn<T>>,
  ): Promise<T>;
  action: Pointcut<ActionOptions, ActionOperation>;
  memory: Pointcut<MemoryOptions, MemoryOperation>;
}
export interface ActionOperation extends Operation<
  "action",
  (ActionResult | { outcome: "abandoned" }) & { usage?: ScopeTerminal["usage"]; endTimeMs?: number }
> {
  approval: Pointcut<ApprovalOptions, ApprovalOperation>;
  toolExecution(input?: {}): Promise<ToolOperation>;
  toolExecution<T>(
    input: { describe?: (value: T) => ToolResult },
    execute: (operation: ToolOperation) => T | PromiseLike<T>,
  ): Promise<T>;
  memory: Pointcut<MemoryOptions, MemoryOperation>;
}
export type ModelOperation = Operation<
  "model",
  { outcome: "completed"; result: ModelResult } | Failure
>;
export type ToolOperation = Operation<"tool", ToolResult>;
export type ApprovalOperation = Operation<
  "approval",
  | { outcome: "approved" | "denied" | "cancelled" | "ignored" | "invalid"; response?: unknown }
  | Failure
>;
export type MemoryOperation = Operation<
  "memory",
  | {
      outcome: "completed";
      recordCount?: number;
      records?: readonly { id?: string; content: string }[];
    }
  | Failure
>;
export type RestoredOperation =
  | TurnOperation
  | AttemptOperation
  | ActionOperation
  | ModelOperation
  | ToolOperation
  | ApprovalOperation
  | MemoryOperation;

export type Completion = (
  | TurnCompletion
  | ActionResult
  | { outcome: "abandoned" | "approved" | "denied" | "ignored" | "invalid"; response?: unknown }
  | {
      outcome: "completed";
      result?: ModelResult;
      output?: unknown;
      recordCount?: number;
      records?: readonly { id?: string; content: string }[];
    }
) & { endTimeMs?: number; usage?: ScopeTerminal["usage"] };

function modelPointcut(runtime: RuntimeScope): AttemptOperation["modelCall"] {
  const start = (options: ModelOptions, key?: string) =>
    runtime
      .child({ type: "model", options }, key)
      .then((operation) => operationHandle(operation) as ModelOperation);
  function modelCall(input: ModelOptions, key?: string): Promise<ModelOperation>;
  function modelCall<T>(
    input: ModelOptions,
    execute: () => ModelCallReturn<T> | PromiseLike<ModelCallReturn<T>>,
  ): Promise<T>;
  function modelCall<T>(
    input: ModelOptions,
    execute?: string | (() => ModelCallReturn<T> | PromiseLike<ModelCallReturn<T>>),
  ): Promise<ModelOperation> | Promise<T> {
    if (typeof execute !== "function") return start(input, execute);
    let handle: ModelOperation;
    return aroundOperation<ModelCallReturn<T>, Parameters<ModelOperation["complete"]>[0]>({
      start: async () => {
        handle = await start(input);
        return handle;
      },
      execute,
      completed: (value) => ({ outcome: "completed", result: value }),
      failed: modelFailure,
      fallback: { outcome: "failed", errorType: "completion_unavailable" },
    }).then<T>((value) => value.result);
  }
  return modelCall;
}

function modelFailure(error: unknown): Failure {
  return { outcome: "failed", errorType: error instanceof Error ? error.name : "_OTHER", error };
}

function modelStream(runtime: RuntimeScope): AttemptOperation["modelStream"] {
  return async (input, execute) => {
    const handle = operationHandle(
      await runtime.child({ type: "model", options: input }),
    ) as ModelOperation;
    try {
      const value = await handle.run(execute);
      const completion = Promise.resolve(value.completion).then(
        (result) => handle.complete({ outcome: "completed", result }),
        (error) => handle.complete(modelFailure(error)),
      );
      runtime.waitUntil(completion);
      return value.result;
    } catch (error) {
      await handle.complete(modelFailure(error));
      throw error;
    }
  };
}

export function operationHandle(runtime: RuntimeScope): RestoredOperation {
  const common = {
    startTimeMs: runtime.startTimeMs,
    parent: runtime.parent,
    reference: runtime.reference,
    get finished() {
      return runtime.finished;
    },
    get capture() {
      return runtime.capture;
    },
    run: <T>(execute: () => T, ceiling?: CaptureDecision) => runtime.run(execute, ceiling),
    complete: async (result: Completion) => {
      try {
        await runtime.finish({
          ...result,
          model: "result" in result ? result.result : undefined,
          failed: result.outcome === "failed",
          errorCode: "errorType" in result ? result.errorType : undefined,
        });
      } catch {}
    },
  };
  const memory = pointcut(
    async (options: MemoryOptions) =>
      operationHandle(await runtime.child({ type: "memory", options })) as MemoryOperation,
    { outcome: "completed" },
  );
  if (runtime.type === "activation")
    return {
      ...common,
      type: "activation",
      memory,
      attempt: pointcut(
        async (input: { stepIndex: number; attempt: number }) =>
          operationHandle(
            await runtime.child({
              type: "step",
              options: { index: input.stepIndex, attempt: input.attempt },
            }),
          ) as AttemptOperation,
        { outcome: "completed" },
      ),
    };
  if (runtime.type === "step")
    return {
      ...common,
      type: "step",
      cost: (input) => runtime.cost(input),
      modelCall: modelPointcut(runtime),
      modelStream: modelStream(runtime),
      action: pointcut(
        async (options: ActionOptions) =>
          operationHandle(await runtime.child({ type: "action", options })) as ActionOperation,
        { outcome: "completed" },
      ),
      memory,
    };
  if (runtime.type === "action") {
    const action = runtime.description;
    if (action.type !== "action") throw new Error("Invalid action operation.");
    return {
      ...common,
      type: "action",
      memory,
      approval: pointcut(
        async (options: ApprovalOptions) =>
          operationHandle(
            await runtime.child({
              type: "approval",
              options: {
                ...options,
                callId: action.options.callId,
                actionName: action.options.name,
              },
            }),
          ) as ApprovalOperation,
        { outcome: "ignored" },
      ),
      toolExecution: pointcut(
        async (_input: {} = {}) =>
          operationHandle(
            await runtime.child({
              type: "tool",
              options: {
                callId: action.options.callId,
                name: action.options.name,
                arguments: action.options.arguments,
              },
            }),
          ) as ToolOperation,
        { outcome: "completed" },
      ),
    };
  }
  return { ...common, type: runtime.type };
}
