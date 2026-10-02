import type {
  RuntimeScope,
  ScopeRecord,
  ScopeTerminal,
  ModelOptions,
  ModelResult,
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
  readonly type: K;
  readonly reference: RuntimeScope["reference"];
  readonly finished: boolean;
  readonly capture: CaptureDecision;
  run<T>(execute: () => T, ceiling?: CaptureDecision): T;
  complete(result: R): Promise<void>;
}
export type TurnOperation = Operation<"activation", TurnCompletion>;
export interface AttemptOperation extends Operation<
  "step",
  { outcome: "completed" | "cancelled" } | Failure
> {
  cost(input: import("#tracing/lib/core/scope-lifecycle.js").ScopeCost): void;
  modelCall(input: ModelOptions, key: string): Promise<ModelOperation>;
}
export interface ActionOperation extends Operation<
  "action",
  (ActionResult | { outcome: "abandoned" }) & { usage?: ScopeTerminal["usage"]; endTimeMs?: number }
> {}
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
  switch (runtime.type) {
    case "activation":
      return {
        ...common,
        type: "activation",
      };
    case "step":
      return {
        ...common,
        type: "step",
        cost: (input) => runtime.cost(input),
        modelCall: async (options, key) =>
          operationHandle(await runtime.model(options, { key })) as ModelOperation,
      };
    case "action":
      return {
        ...common,
        type: "action",
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
