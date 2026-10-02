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
  attempt(input: { stepIndex: number; attempt: number }): Promise<AttemptOperation>;
  memory(input: MemoryOptions): Promise<MemoryOperation>;
}
export interface AttemptOperation extends Operation<
  "step",
  { outcome: "completed" | "cancelled" } | Failure
> {
  cost(input: import("#tracing/lib/core/scope-lifecycle.js").ScopeCost): void;
  modelCall(input: ModelOptions, key?: string): Promise<ModelOperation>;
  action(input: ActionOptions): Promise<ActionOperation>;
  memory(input: MemoryOptions): Promise<MemoryOperation>;
}
export interface ActionOperation extends Operation<
  "action",
  (ActionResult | { outcome: "abandoned" }) & { usage?: ScopeTerminal["usage"]; endTimeMs?: number }
> {
  approval(input: ApprovalOptions): Promise<ApprovalOperation>;
  toolExecution(): Promise<ToolOperation>;
  memory(input: MemoryOptions): Promise<MemoryOperation>;
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
  const memory = async (options: MemoryOptions) =>
    operationHandle(await runtime.child({ type: "memory", options })) as MemoryOperation;
  if (runtime.type === "activation")
    return {
      ...common,
      type: "activation",
      memory,
      attempt: async (input) =>
        operationHandle(
          await runtime.child({
            type: "step",
            options: { index: input.stepIndex, attempt: input.attempt },
          }),
        ) as AttemptOperation,
    };
  if (runtime.type === "step")
    return {
      ...common,
      type: "step",
      cost: (input) => runtime.cost(input),
      modelCall: async (options, key) =>
        operationHandle(await runtime.child({ type: "model", options }, key)) as ModelOperation,
      action: async (options) =>
        operationHandle(await runtime.child({ type: "action", options })) as ActionOperation,
      memory,
    };
  if (runtime.type === "action") {
    const action = runtime.description;
    if (action.type !== "action") throw new Error("Invalid action operation.");
    return {
      ...common,
      type: "action",
      memory,
      approval: async (options) =>
        operationHandle(
          await runtime.child({
            type: "approval",
            options: { ...options, callId: action.options.callId, actionName: action.options.name },
          }),
        ) as ApprovalOperation,
      toolExecution: async () =>
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
    };
  }
  return { ...common, type: runtime.type };
}
