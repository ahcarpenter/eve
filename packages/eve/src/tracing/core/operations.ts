import type {
  RuntimeScope,
  ScopeRecord,
  ScopeTerminal,
  ActionOptions,
  ModelOptions,
  ApprovalOptions,
  StepOptions,
  ModelResult,
} from "#tracing/core/scopes.js";
import type { CaptureDecision } from "#tracing/core/types.js";
import type { ActionResult, ToolResult } from "#tracing/core/scopes.js";

type Failure = { outcome: "failed"; errorType: string; error?: unknown };
type TurnCompletion =
  | { outcome: "completed" | "cancelled"; usage?: ScopeTerminal["usage"] }
  | Failure;
export interface Operation<K extends ScopeRecord["data"]["type"], R> {
  readonly type: K;
  readonly reference: RuntimeScope["reference"];
  readonly finished: boolean;
  readonly capture: CaptureDecision;
  snapshot(): ScopeRecord;
  run<T>(execute: () => T, ceiling?: CaptureDecision): T;
  complete(result: R): Promise<void>;
}
export interface TurnOperation extends Operation<"activation", TurnCompletion> {
  attempt(input: StepOptions, key: string): Promise<AttemptOperation>;
}
export interface AttemptOperation extends Operation<
  "step",
  { outcome: "completed" | "cancelled" } | Failure
> {
  cost(input: import("#tracing/core/scope-lifecycle.js").ScopeCost): void;
  modelCall(input: ModelOptions, key: string): Promise<ModelOperation>;
  action(input: ActionOptions, key: string): Promise<ActionOperation>;
}
export interface ActionOperation extends Operation<
  "action",
  ActionResult | { outcome: "abandoned" }
> {
  approval(input: ApprovalOptions, key: string): Promise<ApprovalOperation>;
  toolExecution(input: { executionId: string }): Promise<ToolOperation>;
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
    reference: runtime.reference,
    get finished() {
      return runtime.finished;
    },
    get capture() {
      return runtime.capture;
    },
    snapshot: () => runtime.snapshot(),
    run: <T>(execute: () => T, ceiling?: CaptureDecision) => runtime.run(execute, ceiling),
    complete: async (result: Completion) => {
      await runtime.finish({
        ...result,
        model: "result" in result ? result.result : undefined,
        failed: result.outcome === "failed",
        errorCode: "errorType" in result ? result.errorType : undefined,
      });
    },
  };
  switch (runtime.type) {
    case "activation":
      return {
        ...common,
        type: "activation",
        attempt: async (options, key) =>
          operationHandle(await runtime.step(options, { key })) as AttemptOperation,
      };
    case "step":
      return {
        ...common,
        type: "step",
        cost: (input) => runtime.cost(input),
        modelCall: async (options, key) =>
          operationHandle(await runtime.model(options, { key })) as ModelOperation,
        action: async (options, key) =>
          operationHandle(await runtime.action(options, { key })) as ActionOperation,
      };
    case "action":
      return {
        ...common,
        type: "action",
        approval: async (options, key) =>
          operationHandle(await runtime.approval(options, { key })) as ApprovalOperation,
        toolExecution: async (input) =>
          operationHandle(await runtime.tool({ key: input.executionId })) as ToolOperation,
      };
    case "model":
      return { ...common, type: "model" };
    case "tool":
      return { ...common, type: "tool" };
    case "approval":
      return { ...common, type: "approval" };
    case "memory":
      return { ...common, type: "memory" };
  }
}
